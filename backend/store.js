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
  async visitStats(sinceMs) {
    const list = this._readVisits().filter(x => x.t >= (sinceMs || 0));
    return { totalVisits: list.length, uniqueVisitors: new Set(list.map(x => x.v)).size };
  }
  async clearVisits() {
    try { fs.unlinkSync(this._visitsFile()); } catch (e) {}
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

  async applyFile(store) {
    for (const o of this.ops) {
      if (o.op === 'deleteAllBlobs') store._deleteAllBlobs(o.keep);
      else if (o.op === 'deleteBlobs') for (const id of o.ids) await store.deleteBlob(id);
      else if (o.op === 'clearVisits') await store.clearVisits();
      else if (o.op === 'backup') await store.saveBackup(o.reason, o.snapshot);
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

  init(seedFactory) {
    if (!this._initPromise) {
      this._initPromise = this._init(seedFactory).catch(err => {
        this._initPromise = null; // retry on next request
        throw err;
      });
    }
    return this._initPromise;
  }

  async _init(seedFactory) {
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
    const existing = await this.pool.query(`SELECT 1 FROM ${S}.state WHERE id = 1`);
    if (existing.rowCount === 0) {
      let seed = null;
      if (this.legacyImporter) {
        try {
          seed = await this.legacyImporter();
          if (seed) console.log('[Store:pg] Initial data imported from the legacy Edge Config store.');
        } catch (e) {
          console.warn('[Store:pg] Legacy import failed, starting from a clean store:', e.message);
        }
      }
      if (!seed) seed = seedFactory ? seedFactory() : {};
      await this.pool.query(`INSERT INTO ${S}.state (id, data, version) VALUES (1, $1::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(seed)]);
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

  async visitStats(sinceMs) {
    const r = await this.pool.query(
      `SELECT count(*)::int AS total, count(DISTINCT visitor)::int AS uniq FROM ${PG_SCHEMA}.visits WHERE created_at >= to_timestamp($1 / 1000.0)`,
      [Number(sinceMs || 0)]
    );
    return { totalVisits: r.rows[0].total, uniqueVisitors: r.rows[0].uniq };
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
  async readLegacyState() {
    const map = await this._readLegacyItems();
    if (!map) return null;
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
  async visitStats(sinceMs) {
    const list = (this._visits || []).filter(x => x.t >= (sinceMs || 0));
    return { totalVisits: list.length, uniqueVisitors: new Set(list.map(x => x.v)).size };
  }
  async clearVisits() { this._visits = []; }
  async saveBackup() { return null; } // backup is downloaded by the administrator instead
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
      ? () => new EdgeConfigStore({ edgeConfigId: edgeId, token: vercelToken, teamId: process.env.VERCEL_TEAM_ID }).readLegacyState()
      : null;
    return new PostgresStore(dbUrl, { legacyImporter });
  }
  if (forced === 'postgres' && !dbUrl) throw new Error('GV_STORE=postgres but no DATABASE_URL/POSTGRES_URL configured');
  if ((forced === 'edge-config' || (!forced && IS_SERVERLESS)) && edgeAvailable) {
    return new EdgeConfigStore({ edgeConfigId: edgeId, token: vercelToken, teamId: process.env.VERCEL_TEAM_ID });
  }
  return new FileStore(IS_SERVERLESS ? path.join(os.tmpdir(), 'getvirtu-data') : dataDir);
}

module.exports = { createStore, FileStore, PostgresStore, EdgeConfigStore, TxContext, buildPgConfig, IS_SERVERLESS, clone, todayKey };
