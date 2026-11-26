/**
 * GetVirtu — Storage adapters (backend/store.js)
 *
 * The whole shop state (users, catalogue, key vault, orders, transactions, tickets, settings) is a single JSON
 * document. What matters is HOW it is read and written:
 *
 *   - PostgresStore  (production, when DATABASE_URL / POSTGRES_URL is set)
 *       Every write runs inside a real SQL transaction that locks the state row (SELECT ... FOR UPDATE):
 *       concurrent serverless instances can never overwrite each other (no lost update, no key sold twice).
 *       Large binaries (product images, payment proofs) and visit logs live in their own tables.
 *       Tables are created in a private schema with Row Level Security enabled (never exposed by PostgREST).
 *
 *   - FileStore      (local development and automated tests)
 *       JSON file written atomically (temp file + rename), single process.
 *
 *   - EdgeConfigStore (temporary legacy fallback on Vercel until Postgres is configured)
 *       Vercel Edge Config has no transactions: writes are serialized per instance only.
 *
 * Every adapter implements:
 *   kind, durable, init(), load(), transaction(fn), putBlob(), getBlob(), deleteBlob(), recordVisit(),
 *   visitStats(), clearVisits(), saveBackup(), describe()
 * transaction(fn) calls fn(state, ctx) on a private copy; when fn resolves, the copy is committed atomically
 * (and ctx side effects are applied); when fn throws, nothing is written.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function clone(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function hashVisitor(vid) {
  return crypto.createHash('sha256').update('gv-visit:' + String(vid || '')).digest('hex').slice(0, 24);
}

// ---- statistics helpers shared by the adapters (local wall-clock buckets: tzOffsetMin = Date#getTimezoneOffset())
const STAT_GRANULARITIES = ['hour', 'day', 'month'];
function clampTz(tzOffsetMin) {
  const n = Math.round(Number(tzOffsetMin) || 0);
  return Math.max(-840, Math.min(840, n));
}
/** Bucket key of a UTC timestamp in the administrator's local time: 'YYYY-MM-DD HH' | 'YYYY-MM-DD' | 'YYYY-MM'. */
function bucketKey(ms, granularity, tzOffsetMin) {
  const local = new Date(ms - clampTz(tzOffsetMin) * 60000).toISOString(); // shifted so that UTC fields = local fields
  if (granularity === 'hour') return local.slice(0, 10) + ' ' + local.slice(11, 13);
  if (granularity === 'month') return local.slice(0, 7);
  return local.slice(0, 10);
}

// ---- administrator activity log (append-only): one normalized entry shape for every adapter
const AUDIT_MAX_DETAILS = 60000;
function normalizeAuditEntry(e) {
  const x = e && typeof e === 'object' ? e : {};
  let details = x.details === undefined ? null : x.details;
  if (details !== null) {
    try {
      const s = JSON.stringify(details);
      if (s.length > AUDIT_MAX_DETAILS) details = { truncated: true, preview: s.slice(0, 2000) };
    } catch (err) { details = { unserializable: true }; }
  }
  const str = (v, max) => (v === undefined || v === null || v === '') ? null : String(v).slice(0, max);
  return {
    at: str(x.at, 40) || new Date().toISOString(),
    actorId: str(x.actorId, 80),
    actorName: str(x.actorName, 120) || 'Système',
    actorEmail: str(x.actorEmail, 200),
    action: str(x.action, 80) || 'unknown',
    targetType: str(x.targetType, 40),
    targetId: str(x.targetId, 120),
    summary: str(x.summary, 500) || '',
    ip: str(x.ip, 80),
    details
  };
}
function auditMatches(e, f) {
  if (!f) return true;
  if (f.action && !(e.action === f.action || String(e.action || '').startsWith(f.action + '.'))) return false;
  if (f.targetType && e.targetType !== f.targetType) return false;
  if (f.targetId && String(e.targetId) !== String(f.targetId)) return false;
  if (f.actorId && String(e.actorId) !== String(f.actorId)) return false;
  if (f.q) {
    const q = String(f.q).toLowerCase();
    const hay = [e.summary, e.action, e.targetId, e.actorName, e.actorEmail].join(' ').toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  const t = Date.parse(e.at);
  if (f.fromMs && !(t >= f.fromMs)) return false;
  if (f.toMs && !(t < f.toMs)) return false;
  return true;
}

// ============================================================================================ FileStore
class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.durable = !IS_SERVERLESS; // /tmp on a serverless platform is NOT durable
    this.dir = dir;
    this.file = path.join(dir, 'database.json');
    this.blobDir = path.join(dir, 'blobs');
    this.backupDir = path.join(dir, 'backups');
    this.committed = null;
  }

  describe() {
    return { kind: this.kind, durable: this.durable, location: this.durable ? 'local file' : 'ephemeral /tmp' };
  }

  _ensureDir(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // Synchronous load (lets local tools/tests use db.data right after require)
  loadSync(seedFactory) {
    if (this.committed) return this.committed;
    this._ensureDir(this.dir);
    let state = null;
    if (fs.existsSync(this.file)) {
      try {
        state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        // Never silently replace a corrupted database: keep a copy for manual recovery
        const bad = this.file + '.corrupted-' + Date.now();
        try { fs.copyFileSync(this.file, bad); } catch (_) {}
        console.error('[Store] database.json unreadable, copy kept at', bad, '-', e.message);
        state = null;
      }
    }
    if (!state) {
      state = seedFactory ? seedFactory() : {};
      this._writeFile(state);
    }
    this.committed = state;
    return state;
  }

  _writeFile(state) {
    this._ensureDir(this.dir);
    const tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  async init(seedFactory) {
    this.loadSync(seedFactory);
  }

  async load() {
    return this.committed;
  }

  async transaction(fn) {
    const working = clone(this.committed);
    const ctx = new TxContext();
    const out = await fn(working, ctx);
    if (out && out.changed) {
      this._writeFile(working);
      this.committed = working;
    }
    await ctx.applyFile(this);
    return out ? out.result : undefined;
  }

  async putBlob(id, mime, buffer) {
    this._ensureDir(this.blobDir);
    fs.writeFileSync(path.join(this.blobDir, id + '.bin'), buffer);
    fs.writeFileSync(path.join(this.blobDir, id + '.meta'), JSON.stringify({ mime }), 'utf8');
  }

  async getBlob(id) {
    if (!/^[a-zA-Z0-9_-]{6,80}$/.test(String(id || ''))) return null;
    const bin = path.join(this.blobDir, id + '.bin');
    if (!fs.existsSync(bin)) return null;
    let mime = 'application/octet-stream';
    try { mime = JSON.parse(fs.readFileSync(path.join(this.blobDir, id + '.meta'), 'utf8')).mime || mime; } catch (e) {}
    return { mime, data: fs.readFileSync(bin) };
  }

  async deleteBlob(id) {
    for (const ext of ['.bin', '.meta']) {
      try { fs.unlinkSync(path.join(this.blobDir, id + ext)); } catch (e) {}
    }
  }

  _deleteAllBlobs(keep = []) {
    if (!fs.existsSync(this.blobDir)) return;
    const keepSet = new Set(keep);
    for (const f of fs.readdirSync(this.blobDir)) {
      const id = f.replace(/\.(bin|meta)$/, '');
      if (!keepSet.has(id)) { try { fs.unlinkSync(path.join(this.blobDir, f)); } catch (e) {} }
    }
  }

  // Visits are kept in a side file so that page views never rewrite the main database
  _visitsFile() { return path.join(this.dir, 'visits.json'); }
  _readVisits() {
    try { return JSON.parse(fs.readFileSync(this._visitsFile(), 'utf8')); } catch (e) { return []; }
  }
  async recordVisit({ vid, isNew }) {
    const list = this._readVisits();
    list.push({ v: hashVisitor(vid), n: Boolean(isNew), t: Date.now() });
    const trimmed = list.slice(-20000);
    this._ensureDir(this.dir);
    fs.writeFileSync(this._visitsFile(), JSON.stringify(trimmed), 'utf8');
  }
  async visitStats(sinceMs, untilMs) {
    const list = this._readVisits().filter(x => x.t >= (sinceMs || 0) && (!untilMs || x.t < untilMs));
    return { totalVisits: list.length, uniqueVisitors: new Set(list.map(x => x.v)).size, newVisitors: list.filter(x => x.n).length };
  }
  async visitSeries(sinceMs, untilMs, granularity, tzOffsetMin) {
    const gran = STAT_GRANULARITIES.includes(granularity) ? granularity : 'day';
    const out = {};
    for (const x of this._readVisits()) {
      if (x.t < (sinceMs || 0) || (untilMs && x.t >= untilMs)) continue;
      const k = bucketKey(x.t, gran, tzOffsetMin);
      if (!out[k]) out[k] = { visits: 0, set: new Set() };
      out[k].visits++;
      out[k].set.add(x.v);
    }
    const res = {};
    for (const [k, v] of Object.entries(out)) res[k] = { visits: v.visits, unique: v.set.size };
    return res;
  }
  async clearVisits() {
    try { fs.unlinkSync(this._visitsFile()); } catch (e) {}
  }

  // Administrator activity log: append-only side file (JSON lines), never rewritten by the application
  _auditFile() { return path.join(this.dir, 'audit-log.jsonl'); }
  appendAudit(entry) {
    this._ensureDir(this.dir);
    const e = normalizeAuditEntry(entry);
    this._auditSeq = (this._auditSeq || this._readAudit().length) + 1;
    e.id = this._auditSeq;
    fs.appendFileSync(this._auditFile(), JSON.stringify(e) + '\n', 'utf8');
  }
  _readAudit() {
    let raw = '';
    try { raw = fs.readFileSync(this._auditFile(), 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* a torn line is skipped, never deleted */ }
    }
    return out;
  }
  async listAudit({ limit = 50, offset = 0, filter = null } = {}) {
    const all = this._readAudit().filter(e => auditMatches(e, filter)).reverse();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return { entries: all.slice(off, off + lim), total: all.length, available: true };
  }

  async saveBackup(reason, state) {
    this._ensureDir(this.backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.backupDir, `backup_${stamp}_${String(reason || 'manual').replace(/[^a-z0-9_-]/gi, '')}.json`);
    fs.writeFileSync(file, JSON.stringify({ reason, createdAt: new Date().toISOString(), data: state }, null, 2), 'utf8');
    // keep the 15 most recent backups
    const files = fs.readdirSync(this.backupDir).filter(f => /^backup_.*\.json$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - 15)).forEach(f => { try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (e) {} });
    return path.basename(file);
  }
}

// ============================================================================================ Tx context
// Side effects requested by a transaction (blob purge, visit purge, backup) — applied atomically with the
// state in Postgres, right after the state write for the file store.
class TxContext {
  constructor() {
    this.ops = [];
  }
  deleteAllBlobs() { this.ops.push({ op: 'deleteAllBlobs', keep: [] }); }
  deleteAllBlobsExcept(keepIds) { this.ops.push({ op: 'deleteAllBlobs', keep: (keepIds || []).map(String) }); }
  deleteBlobs(ids) { if (Array.isArray(ids) && ids.length) this.ops.push({ op: 'deleteBlobs', ids }); }
  clearVisits() { this.ops.push({ op: 'clearVisits' }); }
  backup(reason, snapshot) { this.ops.push({ op: 'backup', reason, snapshot }); }
  // Administrator activity log entry, written in the same transaction as the change it describes
  audit(entry) { this.ops.push({ op: 'audit', entry }); }

  async applyFile(store) {
    for (const o of this.ops) {
      if (o.op === 'deleteAllBlobs') store._deleteAllBlobs(o.keep);
      else if (o.op === 'deleteBlobs') for (const id of o.ids) await store.deleteBlob(id);
      else if (o.op === 'clearVisits') await store.clearVisits();
      else if (o.op === 'backup') await store.saveBackup(o.reason, o.snapshot);
      else if (o.op === 'audit') { try { store.appendAudit(o.entry); } catch (e) { console.error('[Store] audit log write failed', e.message); } }
    }
  }
}

// ============================================================================================ PostgresStore
const PG_SCHEMA = 'getvirtu';

function buildPgConfig(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (e) { throw new Error('Invalid database URL'); }
  const host = url.hostname || '';
  const sslmode = (url.searchParams.get('sslmode') || '').toLowerCase();
  // pg treats sslmode in the URL inconsistently across versions: SSL is configured explicitly below
  ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'supa', 'pgbouncer', 'connection_limit'].forEach(k => url.searchParams.delete(k));
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  let ssl = false;
  if (!isLocal && sslmode !== 'disable') {
    if (process.env.PG_SSL_CA) {
      ssl = { ca: process.env.PG_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
    } else if (/supabase\.(co|com)$/.test(host) || process.env.PG_SSL_NO_VERIFY === '1') {
      // Supabase poolers present a certificate signed by Supabase's own CA (not in Node's trust store).
      // Traffic stays encrypted; set PG_SSL_CA to the Supabase CA certificate to also verify it.
      ssl = { rejectUnauthorized: false };
    } else {
      ssl = { rejectUnauthorized: true };
    }
  }
  return {
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true
  };
}

class PostgresStore {
  constructor(url, { legacyImporter } = {}) {
    this.kind = 'postgres';
    this.durable = true;
    const { Pool } = require('pg');
    const cfg = buildPgConfig(url);
    this.host = (() => { try { return new URL(cfg.connectionString).hostname; } catch (e) { return '?'; } })();
    this.pool = new Pool(cfg);
    this.pool.on('error', (err) => console.error('[Store:pg] idle client error', err.message));
    this.legacyImporter = legacyImporter || null;
    this._initPromise = null;
  }

  describe() {
    return { kind: this.kind, durable: true, location: this.host.replace(/^[^.]+\./, '*.') };
  }

  init(seedFactory, options = {}) {
    if (!this._initPromise) {
      this._initPromise = this._init(seedFactory, options).catch(err => {
        this._initPromise = null; // retry on next request
        throw err;
      });
    }
    return this._initPromise;
  }

  async _init(seedFactory, options = {}) {
    const S = PG_SCHEMA;
    // Several serverless instances may cold-start at once: concurrent "IF NOT EXISTS" DDL can still collide
    // in Postgres, so schema setup is serialized with a transaction-scoped advisory lock.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724100317)');
      await this._createSchema(client, S);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
    // Optional additions (activity log table, pre-upgrade snapshot): never able to stop the shop from starting
    await this._ensureAuditSchema();
    await this._snapshotBeforeUpgrade(options.version);
    const existing = await this.pool.query(`SELECT 1 FROM ${S}.state WHERE id = 1`);
    if (existing.rowCount === 0) {
      // An importer error propagates on purpose: init() is retried on the next request instead of silently
      // starting an empty shop because the legacy store was briefly unreachable.
      let seed = null;
      let blobs = [];
      if (this.legacyImporter) {
        const imported = await this.legacyImporter();
        if (imported && Object.prototype.hasOwnProperty.call(imported, 'state') && Array.isArray(imported.blobs)) {
          seed = imported.state || null;
          blobs = imported.blobs;
        } else {
          seed = imported || null;
        }
      }
      const fromLegacy = Boolean(seed);
      if (!seed) seed = seedFactory ? seedFactory() : {};
      // State and files are written together: a crash in between can never leave a shop without its images.
      const tx = await this.pool.connect();
      try {
        await tx.query('BEGIN');
        const ins = await tx.query(`INSERT INTO ${S}.state (id, data, version) VALUES (1, $1::jsonb, 1) ON CONFLICT (id) DO NOTHING RETURNING id`, [JSON.stringify(seed)]);
        if (ins.rowCount) {
          for (const b of blobs) {
            await tx.query(`INSERT INTO ${S}.blobs (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [String(b.id), b.mime || 'application/octet-stream', b.data]);
          }
        }
        await tx.query('COMMIT');
        if (ins.rowCount && fromLegacy) console.log(`[Store:pg] Initial data imported from the legacy Edge Config store (${blobs.length} file(s)).`);
      } catch (e) {
        try { await tx.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        tx.release();
      }
    }
  }

  async _createSchema(client, S) {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS ${S};
      CREATE TABLE IF NOT EXISTS ${S}.state (
        id smallint PRIMARY KEY,
        data jsonb NOT NULL,
        version bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${S}.blobs (
        id text PRIMARY KEY,
        mime text NOT NULL,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${S}.visits (
        id bigserial PRIMARY KEY,
        visitor text NOT NULL,
        is_new boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS visits_created_at_idx ON ${S}.visits (created_at);
      CREATE TABLE IF NOT EXISTS ${S}.backups (
        id bigserial PRIMARY KEY,
        reason text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE ${S}.state ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${S}.blobs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${S}.visits ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${S}.backups ENABLE ROW LEVEL SECURITY;
    `);
  }

  /**
   * Administrator activity log: its own append-only table (UPDATE / DELETE / TRUNCATE refused by triggers).
   * Additive DDL only (IF NOT EXISTS). A failure here is logged and only disables the log: the shop keeps working.
   */
  async _ensureAuditSchema() {
    const S = PG_SCHEMA;
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724100318)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${S}.audit_log (
          id bigserial PRIMARY KEY,
          created_at timestamptz NOT NULL DEFAULT now(),
          actor_id text,
          actor_name text,
          actor_email text,
          action text NOT NULL,
          target_type text,
          target_id text,
          summary text NOT NULL DEFAULT '',
          ip text,
          details jsonb
        );
        CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON ${S}.audit_log (created_at);
        CREATE INDEX IF NOT EXISTS audit_log_target_idx ON ${S}.audit_log (target_type, target_id);
        ALTER TABLE ${S}.audit_log ENABLE ROW LEVEL SECURITY;
        CREATE OR REPLACE FUNCTION ${S}.audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $gvfn$
        BEGIN
          RAISE EXCEPTION 'getvirtu.audit_log is append-only';
        END
        $gvfn$;
      `);
      const trg = await client.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = '${S}.audit_log'::regclass AND tgname IN ('audit_log_no_update_delete', 'audit_log_no_truncate')`);
      const have = new Set(trg.rows.map(r => r.tgname));
      if (!have.has('audit_log_no_update_delete')) {
        await client.query(`CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON ${S}.audit_log FOR EACH ROW EXECUTE FUNCTION ${S}.audit_log_append_only()`);
      }
      if (!have.has('audit_log_no_truncate')) {
        await client.query(`CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON ${S}.audit_log FOR EACH STATEMENT EXECUTE FUNCTION ${S}.audit_log_append_only()`);
      }
      await client.query('COMMIT');
      this._auditReady = true;
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
      this._auditReady = false;
      console.error('[Store:pg] administrator activity log unavailable (the shop keeps working):', e.message);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Rollback point: the first time a new application version starts, a copy of the whole shop state is kept in
   * the backups table (5 most recent versions). Read-only on the shop data; a failure never blocks the start.
   */
  async _snapshotBeforeUpgrade(version) {
    const v = String(version || '').trim();
    if (!v || v === 'dev') return;
    const S = PG_SCHEMA;
    const reason = ('pre_upgrade_' + v).slice(0, 120);
    try {
      const r = await this.pool.query(
        `INSERT INTO ${S}.backups (reason, data)
         SELECT $1, s.data FROM ${S}.state s
         WHERE s.id = 1 AND NOT EXISTS (SELECT 1 FROM ${S}.backups b WHERE b.reason = $1)
         RETURNING id`, [reason]);
      if (r.rowCount) {
        await this.pool.query(
          `DELETE FROM ${S}.backups WHERE left(reason, 12) = 'pre_upgrade_'
             AND id NOT IN (SELECT id FROM ${S}.backups WHERE left(reason, 12) = 'pre_upgrade_' ORDER BY id DESC LIMIT 5)`);
        console.log(`[Store:pg] Snapshot of the shop data kept before upgrade (${reason}, backup #${r.rows[0].id}).`);
      }
    } catch (e) {
      console.error('[Store:pg] pre-upgrade snapshot failed (the shop keeps working):', e.message);
    }
  }

  async _insertAudit(client, entry) {
    const e = normalizeAuditEntry(entry);
    if (!this._auditReady) {
      console.warn('[Store:pg] activity log unavailable, entry not stored:', e.action, e.targetType, e.targetId);
      return;
    }
    // Savepoint: a logging problem can never cancel the business operation it describes
    await client.query('SAVEPOINT gv_audit');
    try {
      await client.query(
        `INSERT INTO ${PG_SCHEMA}.audit_log (created_at, actor_id, actor_name, actor_email, action, target_type, target_id, summary, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [e.at, e.actorId, e.actorName, e.actorEmail, e.action, e.targetType, e.targetId, e.summary, e.ip, e.details === null ? null : JSON.stringify(e.details)]);
      await client.query('RELEASE SAVEPOINT gv_audit');
    } catch (err) {
      try { await client.query('ROLLBACK TO SAVEPOINT gv_audit'); } catch (_) {}
      console.error('[Store:pg] activity log insert failed:', err.message);
    }
  }

  async listAudit({ limit = 50, offset = 0, filter = null } = {}) {
    if (!this._auditReady) return { entries: [], total: 0, available: false };
    const f = filter || {};
    const where = [];
    const vals = [];
    const p = (v) => { vals.push(v); return '$' + vals.length; };
    if (f.action) where.push(`(action = ${p(f.action)} OR action LIKE ${p(f.action + '.%')})`);
    if (f.targetType) where.push(`target_type = ${p(f.targetType)}`);
    if (f.targetId) where.push(`target_id = ${p(String(f.targetId))}`);
    if (f.actorId) where.push(`actor_id = ${p(String(f.actorId))}`);
    if (f.q) { const q = '%' + String(f.q).slice(0, 100) + '%'; const n = p(q); where.push(`(summary ILIKE ${n} OR action ILIKE ${n} OR target_id ILIKE ${n} OR actor_name ILIKE ${n} OR actor_email ILIKE ${n})`); }
    if (f.fromMs) where.push(`created_at >= to_timestamp(${p(Number(f.fromMs))}::double precision / 1000.0)`);
    if (f.toMs) where.push(`created_at < to_timestamp(${p(Number(f.toMs))}::double precision / 1000.0)`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM ${PG_SCHEMA}.audit_log ${w}`, vals);
    const rows = await this.pool.query(
      `SELECT id, created_at, actor_id, actor_name, actor_email, action, target_type, target_id, summary, ip, details
       FROM ${PG_SCHEMA}.audit_log ${w} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`, vals);
    return {
      available: true,
      total: total.rows[0].n,
      entries: rows.rows.map(r => ({
        id: Number(r.id), at: new Date(r.created_at).toISOString(), actorId: r.actor_id, actorName: r.actor_name, actorEmail: r.actor_email,
        action: r.action, targetType: r.target_type, targetId: r.target_id, summary: r.summary, ip: r.ip, details: r.details
      }))
    };
  }

  async load() {
    const r = await this.pool.query(`SELECT data FROM ${PG_SCHEMA}.state WHERE id = 1`);
    if (!r.rowCount) throw new Error('Database state row missing');
    return r.rows[0].data;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query(`SET LOCAL lock_timeout = '10s'`);
      await client.query(`SET LOCAL statement_timeout = '20s'`);
      const r = await client.query(`SELECT data FROM ${PG_SCHEMA}.state WHERE id = 1 FOR UPDATE`);
      if (!r.rowCount) throw new Error('Database state row missing');
      const working = r.rows[0].data;
      const ctx = new TxContext();
      const out = await fn(working, ctx);
      for (const o of ctx.ops) {
        if (o.op === 'backup') {
          await client.query(`INSERT INTO ${PG_SCHEMA}.backups (reason, data) VALUES ($1, $2::jsonb)`, [String(o.reason || 'manual'), JSON.stringify(o.snapshot)]);
          await client.query(`DELETE FROM ${PG_SCHEMA}.backups WHERE id NOT IN (SELECT id FROM ${PG_SCHEMA}.backups ORDER BY id DESC LIMIT 15)`);
        } else if (o.op === 'deleteAllBlobs') {
          await client.query(`DELETE FROM ${PG_SCHEMA}.blobs WHERE NOT (id = ANY($1::text[]))`, [o.keep || []]);
        } else if (o.op === 'deleteBlobs') {
          await client.query(`DELETE FROM ${PG_SCHEMA}.blobs WHERE id = ANY($1::text[])`, [o.ids.map(String)]);
        } else if (o.op === 'clearVisits') {
          await client.query(`DELETE FROM ${PG_SCHEMA}.visits`);
        } else if (o.op === 'audit') {
          await this._insertAudit(client, o.entry);
        }
      }
      if (out && out.changed) {
        await client.query(`UPDATE ${PG_SCHEMA}.state SET data = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1`, [JSON.stringify(working)]);
      }
      await client.query('COMMIT');
      began = false;
      return out ? out.result : undefined;
    } catch (err) {
      if (began) { try { await client.query('ROLLBACK'); } catch (e) {} }
      throw err;
    } finally {
      client.release();
    }
  }

  async putBlob(id, mime, buffer) {
    await this.pool.query(`INSERT INTO ${PG_SCHEMA}.blobs (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`, [id, mime, buffer]);
  }

  async getBlob(id) {
    const r = await this.pool.query(`SELECT mime, data FROM ${PG_SCHEMA}.blobs WHERE id = $1`, [String(id)]);
    return r.rowCount ? { mime: r.rows[0].mime, data: r.rows[0].data } : null;
  }

  async deleteBlob(id) {
    await this.pool.query(`DELETE FROM ${PG_SCHEMA}.blobs WHERE id = $1`, [String(id)]);
  }

  async recordVisit({ vid, isNew }) {
    await this.pool.query(`INSERT INTO ${PG_SCHEMA}.visits (visitor, is_new) VALUES ($1, $2)`, [hashVisitor(vid), Boolean(isNew)]);
  }

  async visitStats(sinceMs, untilMs) {
    const vals = [Number(sinceMs || 0)];
    let until = '';
    if (untilMs) { vals.push(Number(untilMs)); until = ' AND created_at < to_timestamp($2::double precision / 1000.0)'; }
    const r = await this.pool.query(
      `SELECT count(*)::int AS total, count(DISTINCT visitor)::int AS uniq, count(*) FILTER (WHERE is_new)::int AS fresh
       FROM ${PG_SCHEMA}.visits WHERE created_at >= to_timestamp($1::double precision / 1000.0)${until}`,
      vals
    );
    return { totalVisits: r.rows[0].total, uniqueVisitors: r.rows[0].uniq, newVisitors: r.rows[0].fresh };
  }

  /** Visits per local hour / day / month (one aggregated query, served by the created_at index). */
  async visitSeries(sinceMs, untilMs, granularity, tzOffsetMin) {
    const gran = STAT_GRANULARITIES.includes(granularity) ? granularity : 'day';
    const fmt = gran === 'hour' ? 'YYYY-MM-DD HH24' : (gran === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD');
    const r = await this.pool.query(
      `SELECT to_char(date_trunc($3::text, (created_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int)), $5::text) AS k,
              count(*)::int AS visits, count(DISTINCT visitor)::int AS uniq
       FROM ${PG_SCHEMA}.visits
       WHERE created_at >= to_timestamp($1::double precision / 1000.0) AND created_at < to_timestamp($2::double precision / 1000.0)
       GROUP BY 1`,
      [Number(sinceMs || 0), Number(untilMs || Date.now()), gran, clampTz(tzOffsetMin), fmt]
    );
    const out = {};
    for (const row of r.rows) out[row.k] = { visits: row.visits, unique: row.uniq };
    return out;
  }

  async clearVisits() {
    await this.pool.query(`DELETE FROM ${PG_SCHEMA}.visits`);
  }

  async saveBackup(reason, state) {
    const r = await this.pool.query(`INSERT INTO ${PG_SCHEMA}.backups (reason, data) VALUES ($1, $2::jsonb) RETURNING id`, [String(reason || 'manual'), JSON.stringify(state)]);
    return 'pg-backup-' + r.rows[0].id;
  }
}

// ============================================================================================ EdgeConfigStore
// Temporary fallback. Data lives under the single item "gv_state"; binaries under "gv_blob_<id>".
const EDGE_STATE_KEY = 'gv_state';
const EDGE_LEGACY_KEYS = ['db_users', 'db_products', 'db_vault', 'db_orders', 'db_transactions', 'db_payment_methods', 'db_settings', 'db_deleted',
  'test_key', 'test_ping', 'test_connectivity', 'balance_test_user'];

class EdgeConfigStore {
  constructor({ edgeConfigId, token, teamId }) {
    this.kind = 'edge-config';
    this.durable = true;
    this.edgeConfigId = edgeConfigId;
    this.token = token;
    this.teamId = teamId || '';
    this._cache = null;
    this._cacheAt = 0;
    this._legacyCleaned = false;
  }

  describe() {
    return { kind: this.kind, durable: true, location: 'Vercel Edge Config (legacy, no cross-instance transactions)' };
  }

  _request(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const qs = (p.includes('?') ? '&' : '?') + (this.teamId ? 'teamId=' + encodeURIComponent(this.teamId) : '');
      // GV_EDGE_API_BASE is only used by the automated tests (local mock of the Vercel API)
      const base = new URL(process.env.GV_EDGE_API_BASE || 'https://api.vercel.com');
      const transport = base.protocol === 'http:' ? require('http') : https;
      const req = transport.request({
        host: base.hostname,
        port: base.port || undefined,
        method,
        path: p + qs,
        headers: Object.assign({ Authorization: 'Bearer ' + this.token, 'User-Agent': 'GetVirtu/2.0', Accept: 'application/json' },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (e) {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: parsed, raw });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Edge Config request timeout')); });
      if (data) req.write(data);
      req.end();
    });
  }

  async _getItem(key) {
    const r = await this._request('GET', `/v1/edge-config/${this.edgeConfigId}/item/${encodeURIComponent(key)}`);
    if (r.status === 404 || r.status === 204) return undefined; // the Vercel API answers 204 for a missing item
    if (!r.ok) throw new Error('Edge Config read failed (HTTP ' + r.status + ')');
    return r.data ? r.data.value : undefined;
  }

  async _readLegacyItems() {
    const r = await this._request('GET', `/v1/edge-config/${this.edgeConfigId}/items`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    const map = {};
    for (const it of r.data) if (it && it.key) map[it.key] = it.value;
    return map;
  }

  // Legacy layout (db_users, db_products, ...) -> raw state (normalized later by the Database layer)
  static stateFromItems(map) {
    if (map[EDGE_STATE_KEY]) return map[EDGE_STATE_KEY];
    if (!map.db_users && !map.db_products) return null;
    return {
      users: map.db_users || [],
      products: map.db_products || [],
      vault: map.db_vault || {},
      orders: map.db_orders || [],
      transactions: map.db_transactions || [],
      payment_methods: map.db_payment_methods || [],
      settings: map.db_settings || {}
    };
  }

  async readLegacyState() {
    const map = await this._readLegacyItems();
    return map ? EdgeConfigStore.stateFromItems(map) : null;
  }

  // One-time export when a Postgres database replaces Edge Config: the state AND the binary files
  // (product images, delivery files, payment proofs). Throws when Edge Config cannot be read.
  async exportForMigration() {
    const map = await this._readLegacyItems();
    if (!map) throw new Error('Edge Config export failed: items could not be read');
    const blobs = Object.keys(map)
      .filter(k => k.startsWith('gv_blob_') && map[k] && typeof map[k].b64 === 'string')
      .map(k => ({ id: k.slice('gv_blob_'.length), mime: map[k].mime || 'application/octet-stream', data: Buffer.from(map[k].b64, 'base64') }));
    return { state: EdgeConfigStore.stateFromItems(map), blobs };
  }

  async init(seedFactory) {
    if (this._cache) return;
    let state = await this._getItem(EDGE_STATE_KEY);
    if (!state) {
      state = (await this.readLegacyState()) || (seedFactory ? seedFactory() : {});
      this._needsFirstWrite = true;
    }
    this._cache = state;
    this._cacheAt = Date.now();
  }

  async load() {
    if (!this._cache || Date.now() - this._cacheAt > 1500) {
      const s = await this._getItem(EDGE_STATE_KEY);
      if (s) { this._cache = s; this._cacheAt = Date.now(); }
    }
    return this._cache;
  }

  async transaction(fn) {
    const fresh = (await this._getItem(EDGE_STATE_KEY)) || this._cache;
    const working = clone(fresh);
    const ctx = new TxContext();
    const out = await fn(working, ctx);
    const items = [];
    if ((out && out.changed) || this._needsFirstWrite) {
      items.push({ operation: 'upsert', key: EDGE_STATE_KEY, value: working });
    }
    for (const o of ctx.ops) {
      if (o.op === 'deleteBlobs') o.ids.forEach(id => items.push({ operation: 'delete', key: 'gv_blob_' + id }));
    }
    const purge = ctx.ops.find(o => o.op === 'deleteAllBlobs');
    if ((!this._legacyCleaned && items.length) || purge) {
      const map = await this._readLegacyItems().catch(() => null);
      if (map) {
        const keep = new Set(((purge && purge.keep) || []).map(id => 'gv_blob_' + id));
        Object.keys(map).filter(k => (!this._legacyCleaned && EDGE_LEGACY_KEYS.includes(k)) || (purge && k.startsWith('gv_blob_') && !keep.has(k)))
          .forEach(k => items.push({ operation: 'delete', key: k }));
      }
    }
    if (items.length) {
      const r = await this._request('PATCH', `/v1/edge-config/${this.edgeConfigId}/items`, { items });
      if (!r.ok) {
        console.error('[Store:edge-config] write refused', r.status, (r.raw || '').slice(0, 300));
        const e = new Error("L'enregistrement a été refusé par le stockage temporaire (limite ou quota Edge Config atteint). Aucune donnée n'a été modifiée. Configurez la base Postgres (Vercel > Storage) pour lever cette limite.");
        e.status = 503;
        throw e;
      }
      this._needsFirstWrite = false;
      this._legacyCleaned = true;
      this._cache = working;
      this._cacheAt = Date.now();
    }
    if (ctx.ops.some(o => o.op === 'clearVisits')) this._visits = [];
    for (const o of ctx.ops) if (o.op === 'audit') this.appendAudit(o.entry);
    return out ? out.result : undefined;
  }

  async putBlob(id, mime, buffer) {
    const tooBig = () => {
      const e = new Error('Fichier trop lourd pour le stockage temporaire Edge Config (environ 180 Ko maximum). Configurez la base Postgres (Vercel > Storage) pour lever cette limite.');
      e.status = 413;
      return e;
    };
    if (buffer.length > 180 * 1024) throw tooBig();
    const r = await this._request('PATCH', `/v1/edge-config/${this.edgeConfigId}/items`, {
      items: [{ operation: 'upsert', key: 'gv_blob_' + id, value: { mime, b64: buffer.toString('base64') } }]
    });
    if (!r.ok) {
      console.error('[Store:edge-config] blob write refused', r.status, (r.raw || '').slice(0, 300));
      throw tooBig();
    }
  }

  async getBlob(id) {
    const v = await this._getItem('gv_blob_' + id);
    return v && v.b64 ? { mime: v.mime || 'application/octet-stream', data: Buffer.from(v.b64, 'base64') } : null;
  }

  async deleteBlob(id) {
    await this._request('PATCH', `/v1/edge-config/${this.edgeConfigId}/items`, { items: [{ operation: 'delete', key: 'gv_blob_' + id }] });
  }

  // Page views are never written to Edge Config (write quota): in-memory, per instance only.
  async recordVisit({ vid, isNew }) {
    this._visits = (this._visits || []).concat([{ v: hashVisitor(vid), n: Boolean(isNew), t: Date.now() }]).slice(-5000);
  }
  async visitStats(sinceMs, untilMs) {
    const list = (this._visits || []).filter(x => x.t >= (sinceMs || 0) && (!untilMs || x.t < untilMs));
    return { totalVisits: list.length, uniqueVisitors: new Set(list.map(x => x.v)).size, newVisitors: list.filter(x => x.n).length };
  }
  async visitSeries(sinceMs, untilMs, granularity, tzOffsetMin) {
    const gran = STAT_GRANULARITIES.includes(granularity) ? granularity : 'day';
    const out = {};
    for (const x of (this._visits || [])) {
      if (x.t < (sinceMs || 0) || (untilMs && x.t >= untilMs)) continue;
      const k = bucketKey(x.t, gran, tzOffsetMin);
      if (!out[k]) out[k] = { visits: 0, set: new Set() };
      out[k].visits++;
      out[k].set.add(x.v);
    }
    const res = {};
    for (const [k, v] of Object.entries(out)) res[k] = { visits: v.visits, unique: v.set.size };
    return res;
  }
  async clearVisits() { this._visits = []; }
  async saveBackup() { return null; } // backup is downloaded by the administrator instead
  // Legacy store (no database): activity log kept per instance only
  appendAudit(entry) {
    const e = normalizeAuditEntry(entry);
    this._audit = (this._audit || []).concat([{ ...e, id: (this._auditSeq = (this._auditSeq || 0) + 1) }]).slice(-2000);
  }
  async listAudit({ limit = 50, offset = 0, filter = null } = {}) {
    const all = (this._audit || []).filter(e => auditMatches(e, filter)).reverse();
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return { entries: all.slice(off, off + lim), total: all.length, available: true, volatile: true };
  }
}

// ============================================================================================ factory
function resolveDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

function createStore({ dataDir } = {}) {
  const forced = (process.env.GV_STORE || '').toLowerCase();
  const dbUrl = resolveDatabaseUrl();
  const edgeId = process.env.EDGE_CONFIG_ID || '';
  const vercelToken = process.env.VERCEL_TOKEN || '';
  const edgeAvailable = Boolean(edgeId && vercelToken);

  if (forced === 'file') return new FileStore(dataDir);
  // Safety: a LOCAL process (dev server, scripts, tests) never touches a remote production database
  // unless explicitly asked with GV_STORE=postgres.
  if (!IS_SERVERLESS && forced !== 'postgres' && forced !== 'edge-config') return new FileStore(dataDir);
  if ((forced === 'postgres' || !forced) && dbUrl) {
    const legacyImporter = edgeAvailable
      ? () => new EdgeConfigStore({ edgeConfigId: edgeId, token: vercelToken, teamId: process.env.VERCEL_TEAM_ID }).exportForMigration()
      : null;
    return new PostgresStore(dbUrl, { legacyImporter });
  }
  if (forced === 'postgres' && !dbUrl) throw new Error('GV_STORE=postgres but no DATABASE_URL/POSTGRES_URL configured');
  if ((forced === 'edge-config' || (!forced && IS_SERVERLESS)) && edgeAvailable) {
    return new EdgeConfigStore({ edgeConfigId: edgeId, token: vercelToken, teamId: process.env.VERCEL_TEAM_ID });
  }
  return new FileStore(IS_SERVERLESS ? path.join(os.tmpdir(), 'getvirtu-data') : dataDir);
}

module.exports = { createStore, FileStore, PostgresStore, EdgeConfigStore, TxContext, buildPgConfig, IS_SERVERLESS, clone, todayKey, bucketKey, clampTz, normalizeAuditEntry };
