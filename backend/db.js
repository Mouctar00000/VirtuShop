/**
 * GetVirtu — Data layer (backend/db.js)
 *
 * The shop state is one JSON document stored by a transactional adapter (see backend/store.js).
 * Usage from the API layer:
 *
 *     await db.read(() => { ...read db.data / call getters... });
 *     await db.tx(async () => { ...call mutating model methods... });   // atomic, all-or-nothing
 *
 * Model methods mutate `db.data` and call `this.persist()`, which only marks the transaction as dirty:
 * the adapter commits the whole change set at the end of `tx()` (or nothing at all if an error is thrown).
 */

'use strict';

// Message shown to a customer whose purchases are suspended (deliberately neutral)
const PURCHASES_UNAVAILABLE_MESSAGE = 'Nous rencontrons actuellement un problème technique lié au traitement des commandes. Merci de réessayer un peu plus tard. Nous vous prions de nous excuser pour ce désagrément.';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

loadLocalEnv();

const { createStore, IS_SERVERLESS } = require('./store');

const SCHEMA_VERSION = 2;
const DATA_DIR = process.env.GV_DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULT_ADMIN_ID = 'admin-001';
const DEFAULT_ADMIN_EMAIL = 'admin@getvirtu.shop';
// Password hashes that were published in the public repository (admin123 / admin / legacy). They are never accepted.
const KNOWN_PUBLIC_HASHES = new Set([
  'e1ef6864bfd0e96c37fa33f3de4ceff20f93b236fc292b9e6440310d88f27902',
  '78c3dc6ad802ec87ba0b8333e41869ef13b168d63c8e09f189b34c4906dd5771',
  '7bdd3fd0f0123548f0c15f8ca94f91b90799cbe476669fbd544784d4c3a2f1dc'
]);
const LEGACY_ADMIN_EMAILS = new Set(['admin@virtushop.com', 'admin@admin.com']);

const ORDER_STATUS = { PENDING: 'En attente', DONE: 'Complété', DELIVERED: 'Livré', CANCELLED: 'Annulé' };
const MAX_MONEY = 100000;

const DEFAULT_PAYMENT_METHODS = [
  {
    id: 1,
    name: 'Mobile Money Instantané (Wave, Orange, MTN, Moov)',
    type: 'mobile_money',
    provider: 'saspay',
    network: 'all',
    isBinance: false,
    address: 'Passerelle SasPay Officielle',
    instructions: 'Paiement direct sécurisé : validation automatique par Wave, Orange Money ou notification USSD push instantanée sur votre smartphone.',
    qrCode: null,
    enabled: true
  }
];

// The Trybit crypto gateway was retired (2026-11-16): Mobile Money (SasPay) is the only automatic gateway.
function isRetiredTrybitMethod(pm) {
  return Boolean(pm) && (String(pm.provider || '').toLowerCase() === 'trybit' || String(pm.type || '').toLowerCase() === 'crypto_trybit');
}

const DEFAULT_SETTINGS = { min_recharge: 5.0 };

// --------------------------------------------------------------------------------------------- helpers
function loadLocalEnv() {
  // Local development only: Vercel injects environment variables itself.
  if (process.env.VERCEL || process.env.GV_SKIP_DOTENV === '1') return;
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (e) {}
}

function nowIso() { return new Date().toISOString(); }
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function randomId(prefix, bytes = 6) {
  return prefix + crypto.randomBytes(bytes).toString('hex').toUpperCase();
}
function normalizeProductName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
function cleanText(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
// Product sheet lists (features, benefits, important notices): an array or one item per line; leading bullets removed.
function cleanList(v, maxItems = 20, maxLen = 300) {
  const raw = Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(/\r?\n/);
  return raw
    .map(x => cleanText(String(x === undefined || x === null ? '' : x).replace(/^\s*(?:[-*•·✓✔]|\d+[.)])\s+/, ''), maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}
function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
function isScryptHash(h) {
  return typeof h === 'string' && /^scrypt:[0-9a-f]{16,}:[0-9a-f]{128}$/i.test(h);
}
function fingerprint(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
}
function isAdminUser(u) {
  return Boolean(u && u.role === 'admin');
}

// Binary upload validation (data URL -> Buffer) with magic-number checks. SVG is never accepted (script injection).
const IMAGE_SIGNATURES = [
  { mime: 'image/png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: b => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/gif', test: b => b.length > 6 && (b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a') }
];
function decodeDataUrl(dataUrl) {
  const m = /^data:([a-zA-Z0-9.+/-]+)?(;[a-zA-Z0-9=.-]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  return { declaredMime: (m[1] || '').toLowerCase(), buffer: Buffer.from(m[3].replace(/\s+/g, ''), 'base64') };
}
function parseImageDataUrl(dataUrl, maxBytes) {
  const d = decodeDataUrl(dataUrl);
  if (!d) throw httpError(400, "Format d'image invalide (PNG, JPEG, WebP ou GIF attendu).");
  if (d.buffer.length === 0) throw httpError(400, 'Image vide.');
  if (d.buffer.length > maxBytes) throw httpError(413, `Image trop lourde (maximum ${Math.round(maxBytes / 1024)} Ko).`);
  const sig = IMAGE_SIGNATURES.find(s => s.test(d.buffer));
  if (!sig) throw httpError(400, 'Fichier image non reconnu : seules les vraies images PNG, JPEG, WebP ou GIF sont acceptées.');
  return { mime: sig.mime, buffer: d.buffer };
}
const BLOCKED_FILE_EXT = /\.(exe|bat|cmd|sh|msi|ps1|vbs|scr|dll|com|js|jar|apk|html?|svg|php)$/i;
function parseDeliveryFile(dataUrl, fileName, maxBytes) {
  const d = decodeDataUrl(dataUrl);
  if (!d) throw httpError(400, 'Fichier de livraison invalide.');
  if (d.buffer.length === 0) throw httpError(400, 'Fichier de livraison vide.');
  if (d.buffer.length > maxBytes) throw httpError(413, `Fichier trop lourd (maximum ${Math.round(maxBytes / (1024 * 1024))} Mo).`);
  const name = cleanText(fileName || 'livraison.txt', 120).replace(/[\\/:*?"<>|]+/g, '_') || 'livraison.txt';
  if (BLOCKED_FILE_EXT.test(name)) throw httpError(400, 'Type de fichier non autorisé pour une livraison.');
  return { mime: 'application/octet-stream', buffer: d.buffer, fileName: name };
}
function isSafeHttpUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch (e) { return false; }
}

/**
 * External "Buy" link of a product sold outside the shop (WhatsApp, another platform...).
 * Accepts https/http (a missing scheme gets https://), mailto: and tel:. Returns '' for an empty value
 * and null for an invalid one (javascript:, data:, credentials in the URL, no domain...).
 */
function normalizeRedirectUrl(raw) {
  let s = cleanText(raw, 2000);
  if (!s) return '';
  if (/^tel:/i.test(s)) {
    const digits = s.slice(4).replace(/[\s.()-]/g, '');
    return /^\+?\d{4,20}$/.test(digits) ? 'tel:' + digits : null;
  }
  if (/^mailto:/i.test(s)) {
    return /^mailto:[^\s@<>"'?]+@[^\s@<>"'?]+\.[a-z]{2,}(\?[^\s<>"']*)?$/i.test(s) ? s : null;
  }
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i.test(u.hostname)) return null;
  return u.href.length <= 2000 ? u.href : null;
}

class SimpleMutex {
  constructor() { this._queue = Promise.resolve(); }
  runExclusive(callback) {
    const res = this._queue.then(() => callback());
    this._queue = res.catch(() => {});
    return res;
  }
}

// --------------------------------------------------------------------------------------------- state
function createInitialState() {
  const now = nowIso();
  return {
    schema: SCHEMA_VERSION,
    users: [],
    products: [],
    vault: {},
    orders: [],
    transactions: [],
    tickets: [],
    payment_methods: clone(DEFAULT_PAYMENT_METHODS).map(m => ({ ...m, created_at: now, updated_at: now })),
    settings: { ...DEFAULT_SETTINGS, updated_at: now },
    sessions_revoked: {},
    password_resets: {},
    meta: { created_at: now, next_product_id: 1, next_method_id: 3, owner_admin_id: null, admin_hash_fp: null, last_reset: null }
  };
}

/** Brings any stored document (including legacy formats) to the current schema. Mutates in place, returns changed flag. */
function normalizeState(s) {
  let changed = false;
  const ensureArr = k => { if (!Array.isArray(s[k])) { s[k] = []; changed = true; } };
  const ensureObj = k => { if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) { s[k] = {}; changed = true; } };
  ['users', 'products', 'orders', 'transactions', 'tickets', 'payment_methods'].forEach(ensureArr);
  ['vault', 'settings', 'sessions_revoked', 'password_resets', 'meta'].forEach(ensureObj);
  for (const legacyKey of ['deleted', 'visitor_logs', 'recharges']) {
    if (legacyKey in s) { delete s[legacyKey]; changed = true; }
  }
  if (s.schema !== SCHEMA_VERSION) { s.schema = SCHEMA_VERSION; changed = true; }
  const m = s.meta;
  if (!m.created_at) { m.created_at = nowIso(); changed = true; }

  // Users
  const seenIds = new Set();
  s.users = s.users.filter(u => {
    if (!u || typeof u !== 'object' || !u.id || seenIds.has(String(u.id))) { changed = true; return false; }
    seenIds.add(String(u.id));
    return true;
  });
  for (const u of s.users) {
    if (typeof u.balance !== 'number' || !isFinite(u.balance)) { u.balance = roundMoney(parseFloat(u.balance) || 0); changed = true; }
    if (typeof u.session_version !== 'number') { u.session_version = 0; changed = true; }
    if (!u.role) { u.role = 'client'; changed = true; }
    if (u.email && typeof u.email === 'string' && u.email !== u.email.trim().toLowerCase()) { u.email = u.email.trim().toLowerCase(); changed = true; }
    if (isAdminUser(u)) {
      if (u.email && LEGACY_ADMIN_EMAILS.has(String(u.email).toLowerCase())) { u.email = DEFAULT_ADMIN_EMAIL; changed = true; }
      if (u.balance !== 0) { u.balance = 0; changed = true; }
    }
    // Published default hashes are never valid credentials
    if (typeof u.password_hash === 'string' && KNOWN_PUBLIC_HASHES.has(u.password_hash)) { u.password_hash = null; changed = true; }
  }

  // Products & vault
  let maxPid = 0;
  for (const p of s.products) {
    if (!p) continue;
    const n = parseInt(p.id, 10);
    if (!isNaN(n)) {
      if (p.id !== n) { p.id = n; changed = true; }
      maxPid = Math.max(maxPid, n);
    }
    if (typeof p.price !== 'number') { p.price = roundMoney(parseFloat(p.price) || 0); changed = true; }
    if (p.deliveryMode !== 'manual' && p.deliveryMode !== 'auto') { p.deliveryMode = 'auto'; changed = true; }
    if (typeof p.published !== 'boolean') { p.published = p.published !== false; changed = true; }
  }
  if (!(m.next_product_id > maxPid)) { m.next_product_id = maxPid + 1; changed = true; }
  for (const [pid, v] of Object.entries(s.vault)) {
    if (!s.products.some(p => p && String(p.id) === String(pid))) { delete s.vault[pid]; changed = true; continue; }
    if (!v || typeof v !== 'object') { s.vault[pid] = { type: 'text', keys: [] }; changed = true; continue; }
    if (!Array.isArray(v.keys)) { v.keys = []; changed = true; }
    v.keys.forEach((k, idx) => {
      if (k && !k.id) { k.id = 'KEY-' + crypto.randomBytes(5).toString('hex').toUpperCase() + idx; changed = true; }
    });
  }

  // Payment methods (the retired Trybit gateway is removed from existing data)
  const keptMethods = s.payment_methods.filter(pm => !isRetiredTrybitMethod(pm));
  if (keptMethods.length !== s.payment_methods.length) { s.payment_methods = keptMethods; changed = true; }
  let maxMid = 0;
  for (const pm of s.payment_methods) {
    const n = parseInt(pm && pm.id, 10);
    if (!isNaN(n)) { if (pm.id !== n) { pm.id = n; changed = true; } maxMid = Math.max(maxMid, n); }
  }
  if (s.payment_methods.length === 0) {
    s.payment_methods = clone(DEFAULT_PAYMENT_METHODS).map(x => ({ ...x, created_at: nowIso(), updated_at: nowIso() }));
    maxMid = 2;
    changed = true;
  }
  if (!(m.next_method_id > maxMid)) { m.next_method_id = maxMid + 1; changed = true; }

  // Settings
  if (!(typeof s.settings.min_recharge === 'number' && s.settings.min_recharge > 0)) { s.settings.min_recharge = DEFAULT_SETTINGS.min_recharge; changed = true; }
  for (const legacy of ['reset_password_hash', 'website_reset_at']) {
    if (legacy in s.settings) { delete s.settings[legacy]; changed = true; }
  }

  // Expired revocations / reset tokens
  const t = Date.now();
  for (const [sid, exp] of Object.entries(s.sessions_revoked)) if (!(exp > t)) { delete s.sessions_revoked[sid]; changed = true; }
  for (const [h, r] of Object.entries(s.password_resets)) if (!r || !(r.exp > t)) { delete s.password_resets[h]; changed = true; }

  if (ensureAdmin(s)) changed = true;
  return changed;
}

/**
 * Guarantees exactly one owner administrator.
 * ADMIN_PASSWORD_HASH (scrypt, server environment) is applied once per distinct value: it bootstraps the first
 * password and acts as a break-glass recovery when changed; password changes made in the dashboard are kept.
 */
function ensureAdmin(s) {
  let changed = false;
  const m = s.meta;
  let admins = s.users.filter(isAdminUser);
  if (admins.length === 0) {
    const now = nowIso();
    const admin = {
      id: DEFAULT_ADMIN_ID,
      email: (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase(),
      username: 'admin',
      password_hash: null,
      name: 'Administrateur GetVirtu',
      profile_picture: null,
      google_id: null,
      auth_provider: 'email',
      email_verified: true,
      role: 'admin',
      balance: 0,
      session_version: 0,
      must_change_password: false,
      created_at: now,
      updated_at: now
    };
    if (s.users.some(u => u.id === DEFAULT_ADMIN_ID)) admin.id = randomId('admin-', 4);
    s.users.unshift(admin);
    admins = [admin];
    changed = true;
  }
  let owner = admins.find(a => a.id === m.owner_admin_id) || admins.find(a => a.id === DEFAULT_ADMIN_ID) || admins[0];
  if (m.owner_admin_id !== owner.id) { m.owner_admin_id = owner.id; changed = true; }

  const envHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (isScryptHash(envHash)) {
    const fp = fingerprint(envHash);
    if (m.admin_hash_fp !== fp || !owner.password_hash) {
      if (owner.password_hash !== envHash) {
        owner.password_hash = envHash;
        owner.session_version = (owner.session_version || 0) + 1;
        owner.updated_at = nowIso();
      }
      m.admin_hash_fp = fp;
      changed = true;
    }
  }
  if (!owner.username) { owner.username = 'admin'; changed = true; }
  return changed;
}

// --------------------------------------------------------------------------------------------- Database
class Database {
  constructor() {
    this.store = createStore({ dataDir: DATA_DIR });
    this.isServerless = IS_SERVERLESS;
    this._lock = new SimpleMutex();
    // Tracks, per async call chain, whether we are already inside read()/tx(): only genuinely nested calls
    // (same request) bypass the lock; concurrent requests always wait for it.
    this._als = new AsyncLocalStorage();
    this._dirty = false;
    this._ctx = null;
    this._readyPromise = null;
    this._migrationsDone = false;
    this.data = null;
    this.mutex = { runExclusive: (cb) => Promise.resolve().then(cb) }; // compatibility shim (locking happens in tx())

    if (this.store.kind === 'file') {
      // Synchronous availability for local tools and tests
      this.data = this.store.loadSync(createInitialState);
      if (normalizeState(this.data)) this.store._writeFile(this.data);
    }
  }

  storageInfo() {
    const d = this.store.describe();
    return {
      ...d,
      warning: d.kind === 'edge-config'
        ? 'Stockage temporaire Edge Config (sans transactions). Créez une base Postgres (Vercel > Storage), puis remplacez la variable GV_STORE=edge-config par GV_STORE=postgres et redéployez : les données seront importées automatiquement.'
        : (!d.durable ? 'Stockage NON durable : aucune base de données configurée, les données seront perdues.' : null)
    };
  }

  ready() {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        await this.store.init(createInitialState);
        // Normalisation / bootstrap admin / migration d'images une seule fois par instance
        await this._runTx(async () => {
          // normalizeState already ran (and marked dirty) inside _runTx
          await this._migrateInlineMedia();
        });
        this._migrationsDone = true;
      })().catch(err => {
        this._readyPromise = null;
        throw err;
      });
    }
    return this._readyPromise;
  }

  persist() { this._dirty = true; }
  // Compatibility no-ops (the old remote-sync API): durability is now guaranteed by tx()
  async flushRemoteIfServerless() {}
  async persistToRemote() { return true; }
  async syncFromRemote() {}
  async flushRemoteWithRetry() { return true; }

  /** Consistent read: fn sees the latest committed state. */
  async read(fn) {
    if (this._als.getStore()) return fn();
    await this.ready();
    return this._lock.runExclusive(() => this._als.run({ kind: 'read' }, async () => {
      this.data = await this.store.load();
      normalizeState(this.data);
      this._dirty = false;
      return await fn();
    }));
  }

  /** Atomic read-modify-write: everything done in fn is committed together, or not at all. */
  async tx(fn) {
    const current = this._als.getStore();
    if (current) {
      if (current.kind !== 'tx') throw new Error('db.tx() cannot be nested inside db.read()');
      return fn(this._ctx);
    }
    await this.ready();
    return this._runTx(fn);
  }

  _runTx(fn) {
    return this._lock.runExclusive(() => this._als.run({ kind: 'tx' }, async () => {
      const previous = this.data;
      try {
        return await this.store.transaction(async (working, ctx) => {
          this.data = working;
          this._ctx = ctx;
          this._dirty = normalizeState(working);
          const result = await fn(ctx);
          return { changed: this._dirty, result };
        });
      } catch (err) {
        // Rollback of the in-memory view (the store wrote nothing)
        if (this.store.kind === 'file') this.data = this.store.committed;
        else this.data = previous;
        throw err;
      } finally {
        if (this.store.kind === 'file') this.data = this.store.committed;
        this._ctx = null;
        this._dirty = false;
      }
    }));
  }

  // One-time migration: inline data: URL images (several MB in the JSON document) -> blob storage
  async _migrateInlineMedia() {
    if (this._migrationsDone) return;
    for (const p of this.data.products) {
      if (p && typeof p.image === 'string' && p.image.startsWith('data:')) {
        try {
          p.image = await this.saveImageDataUrl(p.image, { maxBytes: 8 * 1024 * 1024 });
        } catch (e) {
          p.image = null;
        }
        this.persist();
      }
    }
    for (const m of this.data.payment_methods) {
      if (m && typeof m.qrCode === 'string' && m.qrCode.startsWith('data:')) {
        try { m.qrCode = await this.saveImageDataUrl(m.qrCode, { maxBytes: 8 * 1024 * 1024 }); } catch (e) { m.qrCode = null; }
        this.persist();
      }
    }
  }

  // ============================================================ MEDIA (images, payment proofs, delivery files)
  async saveImageDataUrl(dataUrl, { isPrivate = false, maxBytes = 2 * 1024 * 1024 } = {}) {
    const img = parseImageDataUrl(dataUrl, maxBytes);
    const id = (isPrivate ? 'prv_' : 'pub_') + crypto.randomBytes(12).toString('hex');
    await this.store.putBlob(id, img.mime, img.buffer);
    return isPrivate ? id : '/media/' + id;
  }

  async saveDeliveryFile(dataUrl, fileName) {
    const f = parseDeliveryFile(dataUrl, fileName, 3 * 1024 * 1024);
    const id = 'prv_' + crypto.randomBytes(12).toString('hex');
    await this.store.putBlob(id, f.mime, f.buffer);
    return { blobId: id, fileName: f.fileName, size: f.buffer.length };
  }

  async getBlob(id) {
    if (!/^(pub|prv)_[a-f0-9]{24}$/.test(String(id || ''))) return null;
    return this.store.getBlob(id);
  }

  blobIdFromUrl(url) {
    const m = /^\/media\/(pub_[a-f0-9]{24})$/.exec(String(url || ''));
    return m ? m[1] : null;
  }

  _discardBlobs(ids) {
    const list = (ids || []).filter(Boolean);
    if (list.length && this._ctx) this._ctx.deleteBlobs(list);
  }

  // ============================================================ USERS
  getUsers() { return this.data.users; }

  getUserById(id) {
    if (id === undefined || id === null || id === '') return null;
    return this.data.users.find(u => String(u.id) === String(id)) || null;
  }

  getUserByEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const clean = email.trim().toLowerCase();
    return this.data.users.find(u => u.email && u.email.toLowerCase() === clean) || null;
  }

  getUserByUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const clean = username.trim().toLowerCase();
    return this.data.users.find(u => u.username && u.username.toLowerCase() === clean) || null;
  }

  getUserByIdentifier(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const clean = identifier.trim().toLowerCase();
    return this.data.users.find(u => (u.email && u.email.toLowerCase() === clean) || (u.username && u.username.toLowerCase() === clean)) || null;
  }

  getUserByGoogleId(googleId) {
    if (!googleId) return null;
    return this.data.users.find(u => u.google_id && String(u.google_id) === String(googleId)) || null;
  }

  getOwnerAdmin() {
    return this.getUserById(this.data.meta.owner_admin_id) || this.data.users.find(isAdminUser) || null;
  }

  isOwnerAdmin(user) {
    return Boolean(user && isAdminUser(user) && String(user.id) === String(this.data.meta.owner_admin_id));
  }

  createUser({ email, password_hash, name, username, profile_picture, google_id, auth_provider, email_verified }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw httpError(400, 'Adresse e-mail requise.');
    if (this.getUserByEmail(cleanEmail)) throw httpError(409, 'Un compte est déjà associé à cette adresse e-mail. Veuillez vous connecter.');
    let uname = (username || cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') || 'client').trim().toLowerCase().slice(0, 30);
    if (uname.length < 3) uname = (uname + '_user').slice(0, 30);
    if (this.getUserByUsername(uname)) {
      if (username) throw httpError(409, "Ce nom d'utilisateur est déjà utilisé par un autre compte.");
      uname = (uname.slice(0, 22) + '_' + crypto.randomBytes(3).toString('hex'));
    }
    const now = nowIso();
    const newUser = {
      id: 'usr_' + crypto.randomBytes(9).toString('hex'),
      email: cleanEmail,
      username: uname,
      password_hash: password_hash || null,
      name: cleanText(name || cleanEmail.split('@')[0], 80) || 'Client',
      profile_picture: profile_picture || null,
      google_id: google_id || null,
      auth_provider: auth_provider || (google_id ? 'google' : 'email'),
      email_verified: Boolean(email_verified),
      role: 'client', // the API can never create administrators
      balance: 0,
      session_version: 0,
      must_change_password: false,
      created_at: now,
      updated_at: now
    };
    this.data.users.push(newUser);
    this.persist();
    return newUser;
  }

  updateUser(id, updates) {
    const u = this.getUserById(id);
    if (!u) return null;
    const allowed = ['name', 'password_hash', 'balance', 'profile_picture', 'google_id', 'email_verified', 'session_version', 'must_change_password', 'auth_provider'];
    for (const k of Object.keys(updates || {})) {
      if (allowed.includes(k)) u[k] = updates[k];
    }
    if (typeof u.balance === 'number') u.balance = roundMoney(u.balance);
    u.updated_at = nowIso();
    this.persist();
    return u;
  }

  /** Individual purchase suspension (administrator). Stored on the customer record: survives logout / login. */
  arePurchasesSuspended(u) {
    return Boolean(u && u.purchasesSuspended === true);
  }

  setPurchaseSuspension(userId, suspended, { adminName = 'Administrateur' } = {}) {
    const u = this.getUserById(userId);
    if (!u) throw httpError(404, 'Client introuvable.');
    if (isAdminUser(u)) throw httpError(400, "Les achats d'un compte administrateur ne peuvent pas être suspendus.");
    const now = nowIso();
    u.purchasesSuspended = Boolean(suspended);
    u.purchasesSuspensionUpdatedAt = now;
    u.purchasesSuspensionUpdatedBy = cleanText(adminName, 80) || 'Administrateur';
    if (u.purchasesSuspended) u.purchasesSuspendedAt = now;
    u.updated_at = now;
    this.persist();
    return u;
  }

  /** Global purchase suspension (administrator): blocks purchases for ALL customers without touching the
   *  individual settings, which stay intact when the global suspension is turned off. Stored in the shop settings. */
  isGlobalPurchaseSuspensionOn() {
    const s = this.data.settings || {};
    return s.purchasesSuspendedGlobal === true;
  }

  getPurchaseControl() {
    const s = this.data.settings || {};
    return {
      globalSuspended: s.purchasesSuspendedGlobal === true,
      globalUpdatedAt: s.purchasesSuspendedGlobalUpdatedAt || null,
      globalUpdatedBy: s.purchasesSuspendedGlobalUpdatedBy || null
    };
  }

  setGlobalPurchaseSuspension(suspended, { adminName = 'Administrateur' } = {}) {
    const s = this.data.settings;
    const now = nowIso();
    s.purchasesSuspendedGlobal = Boolean(suspended);
    s.purchasesSuspendedGlobalUpdatedAt = now;
    s.purchasesSuspendedGlobalUpdatedBy = cleanText(adminName, 80) || 'Administrateur';
    s.updated_at = now;
    this.persist();
    return this.getPurchaseControl();
  }

  bumpSessionVersion(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.session_version = (u.session_version || 0) + 1;
    u.updated_at = nowIso();
    this.persist();
    return u.session_version;
  }

  deleteUser(id) {
    if (!id) throw httpError(400, 'ID utilisateur requis.');
    const u = this.getUserById(id) || this.getUserByEmail(String(id));
    if (!u) throw httpError(404, 'Utilisateur introuvable.');
    if (isAdminUser(u)) throw httpError(403, 'Action refusée : un compte administrateur ne peut pas être supprimé.');
    this.data.users = this.data.users.filter(x => String(x.id) !== String(u.id));
    this.persist();
    return { success: true, deletedUser: { id: u.id, email: u.email, name: u.name } };
  }

  linkGoogleAccount(userId, { google_id, profile_picture, name }) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (isAdminUser(u)) throw httpError(403, "La connexion Google n'est pas disponible pour ce compte.");
    u.google_id = google_id;
    if (profile_picture && !u.profile_picture) u.profile_picture = profile_picture;
    if (name && !u.name) u.name = cleanText(name, 80);
    u.email_verified = true;
    u.updated_at = nowIso();
    this.persist();
    return u;
  }

  /** Administrator balance operations, always traced in the transaction ledger. */
  adjustUserBalance(userId, { amount, action = 'add', reason = '', adminName = 'Administrateur' }) {
    const u = this.getUserById(userId) || this.getUserByEmail(String(userId || ''));
    if (!u) throw httpError(404, 'Utilisateur introuvable.');
    if (isAdminUser(u)) throw httpError(400, "Le solde d'un compte administrateur ne peut pas être modifié.");
    const validActions = ['add', 'credit', 'gift', 'bonus', 'refund', 'deduct', 'set', 'reset'];
    if (!validActions.includes(action)) throw httpError(400, 'Action de solde inconnue.');
    const numAmount = roundMoney(amount);
    if (!isFinite(numAmount) || numAmount < 0 || numAmount > MAX_MONEY) throw httpError(400, `Montant invalide (0 à ${MAX_MONEY} $).`);
    if (['add', 'credit', 'gift', 'bonus', 'refund', 'deduct'].includes(action) && numAmount === 0) throw httpError(400, 'Le montant doit être supérieur à 0.');

    const oldBal = roundMoney(u.balance);
    let newBal;
    if (action === 'set') newBal = numAmount;
    else if (action === 'reset') newBal = 0;
    else if (action === 'deduct') newBal = Math.max(0, oldBal - numAmount);
    else newBal = oldBal + numAmount;
    newBal = roundMoney(newBal);
    if (newBal > MAX_MONEY) throw httpError(400, `Le solde ne peut pas dépasser ${MAX_MONEY} $.`);
    const diff = roundMoney(newBal - oldBal);

    u.balance = newBal;
    u.updated_at = nowIso();
    this.persist();

    const isGift = action === 'gift' || action === 'bonus';
    const isReset = action === 'reset' || (action === 'set' && numAmount === 0);
    let type = diff >= 0 ? 'credit_manuel_admin' : 'debit_manuel_admin';
    let paymentMethod = 'Ajustement Manuel Administrateur';
    let provider = 'admin_manual';
    let defaultReason = `Ajustement manuel par ${adminName} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} $)`;
    if (isReset) { type = 'debit_manuel_admin'; paymentMethod = 'Réinitialisation de Solde'; provider = 'admin_reset'; defaultReason = `Remise à zéro du solde par ${adminName}`; }
    else if (isGift) { type = 'gift'; paymentMethod = 'Cadeau Promotionnel Administrateur'; provider = 'admin_gift'; defaultReason = `Don de solde offert par ${adminName} (+${diff.toFixed(2)} $)`; }
    else if (action === 'deduct') { type = 'debit_manuel_admin'; paymentMethod = 'Débit Manuel Administrateur'; defaultReason = `Débit manuel par ${adminName} (${diff.toFixed(2)} $)`; }
    else if (action === 'refund') { type = 'refund'; paymentMethod = 'Remboursement'; provider = 'admin_refund'; defaultReason = `Remboursement par ${adminName} (+${diff.toFixed(2)} $)`; }

    const cleanReason = cleanText(reason, 200);
    const tx = this.createTransaction({
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      amount: Math.abs(diff),
      currency: 'USD',
      paymentMethod,
      provider,
      status: 'completed',
      type,
      notes: cleanReason ? `${cleanReason} (Par : ${adminName})` : defaultReason,
      balanceBefore: oldBal,
      balanceAfter: newBal,
      adminResponsible: adminName
    });
    return { user: u, transaction: tx, diff, oldBalance: oldBal, newBalance: newBal };
  }

  // ============================================================ SESSIONS (revocation) & PASSWORD RESET TOKENS
  revokeSession(sid, expMs) {
    if (!sid) return;
    this.data.sessions_revoked[String(sid)] = Number(expMs) || (Date.now() + 31 * 24 * 3600 * 1000);
    this.persist();
  }
  isSessionRevoked(sid) {
    const exp = this.data.sessions_revoked[String(sid)];
    return Boolean(exp && exp > Date.now());
  }
  createPasswordResetToken(userId, ttlMs = 30 * 60 * 1000) {
    const token = crypto.randomBytes(32).toString('base64url');
    const h = crypto.createHash('sha256').update(token).digest('hex');
    // one active token per user
    for (const [k, r] of Object.entries(this.data.password_resets)) if (r && r.userId === userId) delete this.data.password_resets[k];
    this.data.password_resets[h] = { userId, exp: Date.now() + ttlMs };
    this.persist();
    return token;
  }
  consumePasswordResetToken(token) {
    const h = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    const r = this.data.password_resets[h];
    if (!r || !(r.exp > Date.now())) return null;
    delete this.data.password_resets[h];
    this.persist();
    return r.userId;
  }

  // ============================================================ PRODUCTS & KEYS
  normalizeDeliveryMode(mode) { return mode === 'manual' ? 'manual' : 'auto'; }

  /**
   * Purchase mode of a product:
   *  - 'site'     : bought on the shop (balance / Mobile Money), real stock, sold out at 0;
   *  - 'redirect' : the "Buy" button opens the external link set by the administrator (WhatsApp...).
   *    Its stock is informative only: it never makes the product unavailable.
   * A product without a valid link always behaves as 'site'.
   */
  purchaseModeOf(p) {
    return p && p.purchaseMode === 'redirect' && typeof p.redirectUrl === 'string' && p.redirectUrl ? 'redirect' : 'site';
  }

  /** Real availability (site purchase: stock > 0) vs. external-link product (always available). */
  isProductAvailable(p) {
    if (!p) return false;
    return this.purchaseModeOf(p) === 'redirect' || (parseInt(p.stock, 10) || 0) > 0;
  }

  getProducts() {
    for (const p of this.data.products) {
      if (!p || p.deliveryMode === 'manual' || this.purchaseModeOf(p) === 'redirect') continue;
      const v = this.data.vault[p.id];
      if (v && Array.isArray(v.keys) && !(v.type === 'file' && v.keys.length === 0)) {
        p.stock = v.keys.filter(k => !k.used).length;
      }
    }
    return this.data.products;
  }

  getPublicProducts() {
    return this.getProducts().filter(p => p && p.published === true).map(p => {
      const purchaseMode = this.purchaseModeOf(p);
      const showStock = p.showStock !== false;
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        price: p.price,
        // Quantity hidden from the public when the administrator chose not to display it
        stock: showStock ? p.stock : null,
        showStock,
        available: this.isProductAvailable(p),
        purchaseMode,
        redirectUrl: purchaseMode === 'redirect' ? p.redirectUrl : null,
        description: p.description,
        image: p.image || null,
        published: true,
        deliveryMode: p.deliveryMode,
        compareAtPrice: typeof p.compareAtPrice === 'number' && p.compareAtPrice > p.price ? p.compareAtPrice : null,
        features: Array.isArray(p.features) ? p.features : [],
        benefits: Array.isArray(p.benefits) ? p.benefits : [],
        notices: Array.isArray(p.notices) ? p.notices : [],
        deliveryInfo: typeof p.deliveryInfo === 'string' ? p.deliveryInfo : '',
        created_at: p.created_at,
        updated_at: p.updated_at
      };
    });
  }

  /** Reuses the spelling of an existing category typed with a different case ("e-mail" -> "E-mail"). */
  _canonicalCategory(raw, selfId) {
    const c = cleanText(raw, 60) || 'Général';
    const low = c.toLowerCase();
    const other = this.data.products.find(x => x && x.id !== selfId && typeof x.category === 'string' && x.category.toLowerCase() === low);
    return other ? other.category : c;
  }

  getProductById(id) {
    if (id === undefined || id === null || id === '') return null;
    const numId = parseInt(id, 10);
    return this.data.products.find(p => p && (p.id === id || (!isNaN(numId) && p.id === numId))) || null;
  }

  findProductByNormalizedName(name) {
    const norm = normalizeProductName(name);
    if (!norm) return null;
    return this.data.products.find(p => p && normalizeProductName(p.name) === norm) || null;
  }

  _vaultFor(productId, typeHint) {
    if (!this.data.vault[productId] || typeof this.data.vault[productId] !== 'object') {
      this.data.vault[productId] = { type: typeHint || 'text', content: '', fileName: 'livraison.txt', keys: [] };
    }
    if (!Array.isArray(this.data.vault[productId].keys)) this.data.vault[productId].keys = [];
    return this.data.vault[productId];
  }

  _recomputeStock(p, declaredStock) {
    const v = this._vaultFor(p.id);
    // Declared stock: manual delivery, file without keys, and external-link products (informative quantity)
    if (p.deliveryMode === 'manual' || this.purchaseModeOf(p) === 'redirect' || (v.type === 'file' && v.keys.length === 0)) {
      if (declaredStock !== undefined) p.stock = Math.max(0, Math.min(1000000, parseInt(declaredStock, 10) || 0));
      else if (typeof p.stock !== 'number') p.stock = 0;
    } else {
      p.stock = v.keys.filter(k => !k.used).length;
    }
  }

  /**
   * Create or update a product (admin). `prod.image` may be an existing URL, an https URL, a data: URL
   * (already converted to a blob URL by the API layer), or null/'' to remove it.
   */
  saveProduct(prod, options = {}) {
    const now = nowIso();
    let target = prod.id !== undefined && prod.id !== null && prod.id !== '' ? this.getProductById(prod.id) : null;
    if (prod.id && !target) throw httpError(404, 'Produit introuvable (il a peut-être été supprimé).');

    const name = cleanText(prod.name !== undefined ? prod.name : (target ? target.name : ''), 120);
    if (!name) throw httpError(400, 'Le nom du produit est requis.');
    const sameName = this.findProductByNormalizedName(name);
    if (sameName && target && sameName.id !== target.id) throw httpError(409, 'Un autre produit porte déjà ce nom.');
    if (!target && sameName) target = sameName; // "un seul produit par nom" : mise à jour de l'existant

    let price;
    if (prod.price !== undefined) {
      price = roundMoney(prod.price);
      if (!isFinite(price) || price < 0 || price > MAX_MONEY) throw httpError(400, `Prix invalide (0 à ${MAX_MONEY} $).`);
    }
    const incomingType = ['text', 'link', 'file'].includes(prod.vaultType) ? prod.vaultType : (prod.vault && ['text', 'link', 'file'].includes(prod.vault.type) ? prod.vault.type : null);
    const incomingContent = prod.vaultContent !== undefined ? prod.vaultContent : (prod.vault ? prod.vault.content : undefined);
    const incomingFileName = prod.fileName || (prod.vault && prod.vault.fileName) || undefined;
    const image = prod.image === undefined ? undefined : (prod.image ? String(prod.image).slice(0, 1000) : null);
    if (image && !(image.startsWith('/media/pub_') || /^https:\/\//i.test(image))) throw httpError(400, "URL d'image invalide.");

    // Detailed product sheet (all optional; only the fields sent are changed)
    const sheet = {};
    if (prod.features !== undefined) sheet.features = cleanList(prod.features);
    if (prod.benefits !== undefined) sheet.benefits = cleanList(prod.benefits);
    if (prod.notices !== undefined) sheet.notices = cleanList(prod.notices);
    if (prod.deliveryInfo !== undefined) sheet.deliveryInfo = cleanText(prod.deliveryInfo, 1000);
    // Promotion: "compare-at" price shown struck through; the customer always pays `price`
    let compareAtPrice;
    if (prod.compareAtPrice !== undefined) {
      const cap = prod.compareAtPrice === null || prod.compareAtPrice === '' ? 0 : roundMoney(prod.compareAtPrice);
      if (!isFinite(cap) || cap < 0 || cap > MAX_MONEY) throw httpError(400, `Prix barré invalide (0 à ${MAX_MONEY} $).`);
      compareAtPrice = cap > 0 ? cap : null;
    }
    const effPrice = price !== undefined ? price : (target ? target.price : 0);
    const effCompareAt = compareAtPrice !== undefined ? compareAtPrice : (target ? target.compareAtPrice : null);
    if (typeof effCompareAt === 'number' && effCompareAt <= effPrice && (compareAtPrice !== undefined || price !== undefined)) {
      throw httpError(400, 'Le prix barré (avant promotion) doit être supérieur au prix de vente. Laissez-le vide s\'il n\'y a pas de promotion.');
    }
    // Purchase mode: on the shop (real stock) or external "Buy" link (WhatsApp, other platform) never sold out
    let purchaseMode;
    if (prod.purchaseMode !== undefined) purchaseMode = prod.purchaseMode === 'redirect' ? 'redirect' : 'site';
    let redirectUrl;
    if (prod.redirectUrl !== undefined) {
      redirectUrl = normalizeRedirectUrl(prod.redirectUrl);
      if (redirectUrl === null) throw httpError(400, 'Lien de redirection invalide. Exemples : https://wa.me/2250700000000 ou https://votre-site.com/produit');
    }
    const effMode = purchaseMode !== undefined ? purchaseMode : (target && target.purchaseMode === 'redirect' ? 'redirect' : 'site');
    const effRedirect = redirectUrl !== undefined ? redirectUrl : (target && typeof target.redirectUrl === 'string' ? target.redirectUrl : '');
    if (effMode === 'redirect' && !effRedirect) {
      throw httpError(400, 'Indiquez le lien de redirection du bouton « Acheter » (par exemple https://wa.me/2250700000000).');
    }
    let showStock;
    if (prod.showStock !== undefined) showStock = !(prod.showStock === false || prod.showStock === 0 || prod.showStock === '0' || prod.showStock === 'false');

    let p = target;
    const removedBlobs = [];
    if (!p) {
      const id = Math.max(this.data.meta.next_product_id || 1, 1);
      this.data.meta.next_product_id = id + 1;
      p = {
        id,
        name,
        category: this._canonicalCategory(prod.category, id),
        price: price !== undefined ? price : 0,
        compareAtPrice: compareAtPrice !== undefined ? compareAtPrice : null,
        stock: 0,
        description: cleanText(prod.description, 2000),
        features: sheet.features || [],
        benefits: sheet.benefits || [],
        notices: sheet.notices || [],
        deliveryInfo: sheet.deliveryInfo || '',
        image: image || null,
        published: prod.published !== undefined ? Boolean(prod.published) : true,
        deliveryMode: this.normalizeDeliveryMode(prod.deliveryMode),
        purchaseMode: effMode,
        redirectUrl: effRedirect || '',
        showStock: showStock !== undefined ? showStock : true,
        created_at: now,
        updated_at: now
      };
      this.data.products.push(p);
    } else {
      p.name = name;
      if (prod.category !== undefined) p.category = this._canonicalCategory(prod.category, p.id);
      if (price !== undefined) p.price = price;
      if (compareAtPrice !== undefined) p.compareAtPrice = compareAtPrice;
      Object.assign(p, sheet);
      if (prod.description !== undefined) p.description = cleanText(prod.description, 2000);
      if (image !== undefined && image !== p.image) {
        const old = this.blobIdFromUrl(p.image);
        if (old) removedBlobs.push(old);
        p.image = image;
      }
      if (prod.published !== undefined) p.published = Boolean(prod.published);
      if (prod.deliveryMode !== undefined) p.deliveryMode = this.normalizeDeliveryMode(prod.deliveryMode);
      if (purchaseMode !== undefined) p.purchaseMode = purchaseMode;
      if (redirectUrl !== undefined) p.redirectUrl = redirectUrl;
      if (showStock !== undefined) p.showStock = showStock;
      p.updated_at = now;
    }

    const v = this._vaultFor(p.id, incomingType);
    if (incomingType) v.type = incomingType;
    if (incomingType === 'link' && incomingContent && !isSafeHttpUrl(String(incomingContent).trim())) {
      throw httpError(400, 'Le lien de livraison doit commencer par https:// ou http://');
    }
    if (incomingContent !== undefined && v.type !== 'file') v.content = cleanText(incomingContent, 20000);
    if (incomingFileName !== undefined) v.fileName = cleanText(incomingFileName, 120) || 'livraison.txt';
    if (options.deliveryFile) { // {blobId, fileName}
      if (v.blobId && v.blobId !== options.deliveryFile.blobId) removedBlobs.push(v.blobId);
      v.type = 'file';
      v.blobId = options.deliveryFile.blobId;
      v.fileName = options.deliveryFile.fileName;
      v.content = '';
    }

    const rawReplace = options.replaceAvailableKeys !== undefined ? options.replaceAvailableKeys : prod.replaceAvailableKeys;
    if (rawReplace !== undefined && v.type !== 'file') {
      this._replaceAvailableKeysInProductVault(p.id, rawReplace);
    } else {
      let newKeys = options.newKeys !== undefined ? options.newKeys : prod.newKeys;
      if (typeof newKeys === 'string') newKeys = newKeys.split(/\r?\n/);
      if (Array.isArray(newKeys)) {
        const list = newKeys.map(s => String(s || '').trim()).filter(Boolean);
        if (list.length) this._addKeysToProductVault(p.id, list);
      }
    }
    this._recomputeStock(p, prod.stock);
    this._discardBlobs(removedBlobs);
    this.persist();
    return p;
  }

  _addKeysToProductVault(productId, keysList) {
    const v = this._vaultFor(productId);
    if (keysList.length > 5000) throw httpError(400, 'Maximum 5000 clés par ajout.');
    const existing = new Set(v.keys.map(k => String(k.content || '').trim().toLowerCase()));
    for (const raw of keysList) {
      const clean = cleanText(raw, 2000);
      if (!clean) continue;
      const lower = clean.toLowerCase();
      if (existing.has(lower)) throw httpError(409, `La clé '${clean.slice(0, 60)}' est déjà présente dans le produit (doublon refusé).`);
      existing.add(lower);
      v.keys.push({ id: 'KEY-' + crypto.randomBytes(6).toString('hex').toUpperCase(), content: clean, used: false, orderId: null, soldTo: null, userId: null, soldAt: null });
    }
    if (v.type !== 'file') v.content = v.keys.filter(k => !k.used).map(k => k.content).join('\n');
  }

  addKeysToProduct(productId, keysList) {
    const p = this.getProductById(productId);
    if (!p) throw httpError(404, 'Produit introuvable.');
    let list = keysList;
    if (typeof list === 'string') list = list.split(/\r?\n/);
    list = (Array.isArray(list) ? list : []).map(s => String(s || '').trim()).filter(Boolean);
    if (!list.length) throw httpError(400, 'Veuillez insérer au moins une clé.');
    this._addKeysToProductVault(p.id, list);
    this._recomputeStock(p);
    p.updated_at = nowIso();
    this.persist();
    return { product: p, addedCount: list.length, stock: p.stock };
  }

  _replaceAvailableKeysInProductVault(productId, keysList) {
    const v = this._vaultFor(productId);
    let rawArr = typeof keysList === 'string' ? keysList.split(/\r?\n/) : (Array.isArray(keysList) ? keysList : []);
    const lines = rawArr.map(s => cleanText(s, 2000)).filter(Boolean);
    const seen = new Set();
    for (const l of lines) {
      const low = l.toLowerCase();
      if (seen.has(low)) throw httpError(409, `La clé '${l.slice(0, 60)}' apparaît plusieurs fois dans votre saisie.`);
      seen.add(low);
    }
    const sold = v.keys.filter(k => k.used);
    const soldSet = new Set(sold.map(k => String(k.content || '').trim().toLowerCase()));
    for (const l of lines) if (soldSet.has(l.toLowerCase())) throw httpError(409, `La clé '${l.slice(0, 60)}' a déjà été vendue et ne peut pas être remise en stock.`);
    const oldUnused = v.keys.filter(k => !k.used);
    const pool = oldUnused.slice();
    const now = nowIso();
    const next = lines.map((line, idx) => {
      const i = pool.findIndex(k => String(k.content || '').trim().toLowerCase() === line.toLowerCase());
      if (i !== -1) { const k = pool.splice(i, 1)[0]; k.content = line; return k; }
      return null;
    });
    const result = next.map((k, idx) => {
      if (k) return k;
      if (pool.length) { const r = pool.shift(); r.content = lines[idx]; r.updatedAt = now; return r; }
      return { id: 'KEY-' + crypto.randomBytes(6).toString('hex').toUpperCase(), content: lines[idx], used: false, orderId: null, soldTo: null, userId: null, soldAt: null };
    });
    v.keys = sold.concat(result);
    if (v.type !== 'file') v.content = result.map(k => k.content).join('\n');
  }

  updateProductKey(productId, keyId, newContent, keyIndex = null) {
    const p = this.getProductById(productId);
    if (!p) throw httpError(404, 'Produit introuvable.');
    const clean = cleanText(newContent, 2000);
    if (!clean) throw httpError(400, 'Le contenu de la clé ne peut pas être vide.');
    const v = this._vaultFor(p.id);
    let key = keyId ? v.keys.find(k => k && String(k.id) === String(keyId)) : null;
    if (!key && Number.isInteger(keyIndex) && keyIndex >= 0 && keyIndex < v.keys.length) key = v.keys[keyIndex];
    if (!key) throw httpError(404, "Clé introuvable dans l'inventaire de ce produit.");
    if (v.keys.some(k => k !== key && String(k.content || '').trim().toLowerCase() === clean.toLowerCase())) {
      throw httpError(409, `La clé '${clean.slice(0, 60)}' est déjà présente dans ce produit (doublon refusé).`);
    }
    const oldContent = key.content;
    const now = nowIso();
    key.content = clean;
    key.updatedAt = now;
    if (key.used && key.orderId) {
      const order = this.getOrderById(key.orderId);
      if (order && order.vaultContent && Array.isArray(order.vaultContent.keys)) {
        order.vaultContent.keys.forEach(ok => { if (ok && (String(ok.id) === String(key.id) || ok.content === oldContent)) ok.content = clean; });
        order.vaultContent.content = order.vaultContent.keys.map(ok => ok.content).join('\n');
        order.updatedAt = now;
      }
    }
    if (v.type !== 'file') v.content = v.keys.filter(k => !k.used).map(k => k.content).join('\n');
    this._recomputeStock(p);
    p.updated_at = now;
    this.persist();
    return { product: p, key, stock: p.stock, inventory: this.getProductVaultKeys(p.id) };
  }

  deleteProductKey(productId, keyId, keyIndex = null) {
    const p = this.getProductById(productId);
    if (!p) throw httpError(404, 'Produit introuvable.');
    const v = this._vaultFor(p.id);
    let idx = keyId ? v.keys.findIndex(k => k && String(k.id) === String(keyId)) : -1;
    if (idx === -1 && Number.isInteger(keyIndex) && keyIndex >= 0 && keyIndex < v.keys.length) idx = keyIndex;
    if (idx === -1) throw httpError(404, "Clé introuvable dans l'inventaire de ce produit.");
    if (v.keys[idx].used) throw httpError(409, 'Cette clé a déjà été vendue : elle reste dans l\'historique de la commande.');
    const [deletedKey] = v.keys.splice(idx, 1);
    if (v.type !== 'file') v.content = v.keys.filter(k => !k.used).map(k => k.content).join('\n');
    this._recomputeStock(p);
    p.updated_at = nowIso();
    this.persist();
    return { product: p, deletedKey, stock: p.stock, inventory: this.getProductVaultKeys(p.id) };
  }

  getProductVaultKeys(productId) {
    const p = this.getProductById(productId);
    if (!p) return null;
    const v = this.data.vault[p.id] || { keys: [] };
    const keys = Array.isArray(v.keys) ? v.keys : [];
    return {
      productId: p.id,
      productName: p.name,
      type: v.type || 'text',
      fileName: v.fileName || null,
      hasFile: Boolean(v.blobId),
      stock: keys.filter(k => !k.used).length,
      sold: keys.filter(k => k.used).length,
      total: keys.length,
      keys: keys.map(k => ({ id: k.id, content: k.content, used: !!k.used, revoked: !!k.revoked, soldTo: k.soldTo || null, orderId: k.orderId || null, soldAt: k.soldAt || null, updatedAt: k.updatedAt || null }))
    };
  }

  /** Admin view of the vault without key contents (key contents are fetched per product). */
  getVaultSummary() {
    const out = {};
    for (const [pid, v] of Object.entries(this.data.vault)) {
      out[pid] = {
        type: v.type || 'text',
        fileName: v.fileName || null,
        hasFile: Boolean(v.blobId),
        content: v.type === 'link' ? (v.content || '') : undefined,
        total: (v.keys || []).length,
        available: (v.keys || []).filter(k => !k.used).length
      };
    }
    return out;
  }

  deleteProduct(id) {
    const p = this.getProductById(id);
    if (!p) throw httpError(404, 'Produit introuvable.');
    const v = this.data.vault[p.id];
    const blobs = [this.blobIdFromUrl(p.image), v && v.blobId && !this._blobReferencedByOrders(v.blobId) ? v.blobId : null];
    this.data.products = this.data.products.filter(x => x !== p);
    delete this.data.vault[p.id];
    this._discardBlobs(blobs);
    this.persist();
    return { success: true, deletedProduct: { id: p.id, name: p.name } };
  }

  _blobReferencedByOrders(blobId) {
    return this.data.orders.some(o => o && o.vaultContent && o.vaultContent.blobId === blobId);
  }

  /** Reserve N units of a product for an order (keys for automatic delivery, declared stock otherwise). */
  allocateKeysForProduct(productId, quantity, { orderId, userId, userEmail }) {
    const p = this.getProductById(productId);
    if (!p) throw httpError(404, 'Produit introuvable.');
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw httpError(400, 'Quantité invalide (1 à 100).');
    const v = this._vaultFor(p.id);
    const now = nowIso();
    const insufficient = (avail) => {
      const e = httpError(409, `Stock insuffisant pour ${p.name} : ${avail} disponible(s), ${qty} demandée(s).`, 'INSUFFICIENT_STOCK');
      e.availableStock = avail;
      return e;
    };

    if (p.deliveryMode === 'manual') {
      const declared = parseInt(p.stock, 10) || 0;
      if (declared < qty) throw insufficient(declared);
      p.stock = declared - qty;
      p.updated_at = now;
      this.persist();
      return { product: p, allocatedKeys: [], remainingStock: p.stock, manualDelivery: true };
    }

    if (v.type === 'file' && v.keys.length === 0) {
      const declared = parseInt(p.stock, 10) || 0;
      if (!v.blobId && !v.content) { const e = insufficient(0); e.message = `Le fichier de livraison de ${p.name} n'est pas configuré.`; throw e; }
      if (declared < qty) throw insufficient(declared);
      p.stock = declared - qty;
      p.updated_at = now;
      this.persist();
      return {
        product: p,
        allocatedKeys: [],
        remainingStock: p.stock,
        fileDelivery: v.blobId ? { type: 'file', blobId: v.blobId, fileName: v.fileName || 'livraison.txt' } : { type: 'file', content: v.content, fileName: v.fileName || 'livraison.txt' }
      };
    }

    const available = v.keys.filter(k => !k.used);
    if (available.length < qty) throw insufficient(available.length);
    const allocated = available.slice(0, qty);
    allocated.forEach(k => {
      k.used = true;
      k.orderId = orderId;
      k.soldTo = userEmail || userId;
      k.userId = userId;
      k.soldAt = now;
    });
    if (v.type !== 'file') v.content = v.keys.filter(k => !k.used).map(k => k.content).join('\n');
    this._recomputeStock(p);
    p.updated_at = now;
    this.persist();
    return { product: p, allocatedKeys: allocated, remainingStock: p.stock, vaultType: v.type };
  }

  // ============================================================ ORDERS
  getOrders() { return this.data.orders; }

  getOrderById(id) {
    if (!id) return null;
    return this.data.orders.find(o => o && String(o.id) === String(id)) || null;
  }

  createOrder(order) {
    const newOrder = {
      ...order,
      id: order.id || randomId('ORD-', 5),
      status: order.status || ORDER_STATUS.PENDING,
      date: order.date || nowIso()
    };
    if (this.getOrderById(newOrder.id)) throw httpError(409, 'Identifiant de commande déjà utilisé.');
    this.data.orders.unshift(newOrder);
    this.persist();
    return newOrder;
  }

  updateOrder(id, updates) {
    const o = this.getOrderById(id);
    if (!o) return null;
    Object.assign(o, updates, { updatedAt: nowIso() });
    this.persist();
    return o;
  }

  /**
   * Complete purchase with the customer balance — a single atomic unit:
   * stock/keys reservation + balance debit + order + ledger entry (+ idempotency).
   */
  purchaseWithBalance(user, { productId, productName, quantity, contactInfo, idempotencyKey, paymentLabel }) {
    const u = this.getUserById(user.id);
    if (!u) throw httpError(401, 'Compte client introuvable.', 'SESSION_INVALID');
    if (isAdminUser(u)) throw httpError(403, 'Un compte administrateur ne peut pas passer de commande. Utilisez un compte client.');

    const idem = cleanText(idempotencyKey, 80);
    if (idem) {
      const existing = this.data.orders.find(o => o && o.userId === u.id && o.idempotencyKey === idem);
      if (existing) return { order: existing, newBalance: u.balance, remainingStock: (this.getProductById(existing.productId) || {}).stock, duplicate: true };
    }

    let prod = this.getProductById(productId);
    if (!prod && productName) prod = this.findProductByNormalizedName(productName);
    if (!prod || prod.published !== true) throw httpError(404, "Ce produit n'est plus disponible dans la boutique.", 'PRODUCT_UNAVAILABLE');
    // External-link product: bought from the seller through the configured link, never on the site
    // (no order, no balance debit, no stock change).
    if (this.purchaseModeOf(prod) === 'redirect') {
      const e = httpError(409, "Ce produit s'achète directement auprès du vendeur : utilisez le bouton « Acheter » de la fiche produit.", 'EXTERNAL_PURCHASE');
      e.extra = { redirectUrl: prod.redirectUrl };
      throw e;
    }

    const qty = (quantity === undefined || quantity === null || quantity === '') ? 1 : Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw httpError(400, 'La quantité doit être un nombre entier compris entre 1 et 100.');
    const total = roundMoney(prod.price * qty);
    const balance = roundMoney(u.balance);
    if (balance < total) {
      const e = httpError(400, `Solde insuffisant ($${balance.toFixed(2)} disponible, $${total.toFixed(2)} requis). Veuillez recharger votre compte.`, 'INSUFFICIENT_BALANCE');
      e.extra = { currentBalance: balance, requiredAmount: total, missingAmount: roundMoney(total - balance) };
      throw e;
    }
    // Purchases suspended (globally, or for this customer) by the administrator. Checked only once the balance is
    // sufficient (an insufficient balance keeps the usual "please top up" flow), and BEFORE any debit, order or
    // delivery. Top-ups, Mobile Money confirmations and the wallet are not affected (they never go through here).
    if (this.isGlobalPurchaseSuspensionOn() || this.arePurchasesSuspended(u)) throw httpError(409, PURCHASES_UNAVAILABLE_MESSAGE, 'PURCHASES_UNAVAILABLE');

    const orderId = randomId('ORD-', 5);
    const alloc = this.allocateKeysForProduct(prod.id, qty, { orderId, userId: u.id, userEmail: u.email });
    const newBalance = roundMoney(balance - total);
    u.balance = newBalance;
    u.updated_at = nowIso();

    const isManual = Boolean(alloc.manualDelivery);
    let vaultContent = null;
    if (alloc.fileDelivery) vaultContent = alloc.fileDelivery;
    else if (!isManual) {
      const keys = alloc.allocatedKeys.map(k => ({ id: k.id, content: k.content }));
      vaultContent = { type: alloc.vaultType === 'link' ? 'link' : 'text', content: keys.map(k => k.content).join('\n'), keys, fileName: 'licences.txt' };
    }

    const order = this.createOrder({
      id: orderId,
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      productId: prod.id,
      productName: prod.name,
      unitPrice: prod.price,
      quantity: qty,
      amount: total,
      remainingBalance: newBalance,
      userBalanceAfter: newBalance,
      contactInfo: cleanText(contactInfo, 120),
      method: cleanText(paymentLabel, 60) || 'Solde GetVirtu',
      deliveryMode: isManual ? 'manual' : 'auto',
      status: isManual ? ORDER_STATUS.PENDING : ORDER_STATUS.DONE,
      vaultContent,
      idempotencyKey: idem || null,
      refunded: false
    });
    this.createTransaction({
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      amount: total,
      currency: 'USD',
      type: 'purchase',
      paymentMethod: 'Solde GetVirtu',
      provider: 'balance',
      status: 'completed',
      balanceBefore: balance,
      balanceAfter: newBalance,
      notes: `Achat ${prod.name} (x${qty}) — commande ${orderId}`,
      metadata: { orderId }
    });
    this.persist();
    return { order, newBalance, remainingStock: alloc.remainingStock };
  }

  /** Admin: deliver a pending order (manual delivery) with the content entered in the dashboard. */
  deliverOrder(orderId, { content, type = 'text', fileName, deliveryFile } = {}) {
    const o = this.getOrderById(orderId);
    if (!o) throw httpError(404, 'Commande introuvable.');
    if (o.status === ORDER_STATUS.CANCELLED) throw httpError(409, 'Une commande annulée (et remboursée) ne peut pas être livrée.');
    const kind = ['text', 'link', 'file'].includes(type) ? type : 'text';
    let vc;
    if (deliveryFile) vc = { type: 'file', blobId: deliveryFile.blobId, fileName: deliveryFile.fileName };
    else if (kind === 'file' && o.vaultContent && o.vaultContent.blobId) vc = { type: 'file', blobId: o.vaultContent.blobId, fileName: cleanText(fileName, 120) || o.vaultContent.fileName };
    else {
      const clean = cleanText(content, 20000);
      if (!clean) throw httpError(400, 'Veuillez renseigner le contenu à livrer (clé, identifiants ou lien).');
      if (kind === 'link' && !isSafeHttpUrl(clean)) throw httpError(400, 'Le lien doit commencer par https:// ou http://');
      vc = { type: kind === 'file' ? 'text' : kind, content: clean, fileName: cleanText(fileName, 120) || 'livraison.txt' };
    }
    vc.customized = true;
    vc.updatedAt = nowIso();
    // Keep the per-key mapping in sync when an auto-delivered order's keys are corrected
    if (o.vaultContent && Array.isArray(o.vaultContent.keys) && vc.content) {
      const lines = vc.content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const v = this.data.vault[o.productId];
      if (v && Array.isArray(v.keys)) {
        const orderKeys = v.keys.filter(k => k && k.orderId === o.id);
        if (orderKeys.length && orderKeys.length === lines.length) {
          orderKeys.forEach((k, i) => { k.content = lines[i]; k.updatedAt = vc.updatedAt; });
          vc.keys = orderKeys.map(k => ({ id: k.id, content: k.content }));
        }
      }
    }
    o.vaultContent = vc;
    o.status = ORDER_STATUS.DONE;
    o.validatedAt = o.validatedAt || nowIso();
    o.updatedAt = nowIso();
    this.persist();
    return o;
  }

  /**
   * Admin: cancel an order. Refunds the customer exactly once (balance + ledger), restores the declared
   * stock of manual products, and handles allocated keys: keys that were already delivered are revoked
   * (never resold) unless the administrator explicitly asks to put them back on sale.
   */
  cancelOrder(orderId, { restockKeys = false, refund = true, reason = '', adminName = 'Administrateur' } = {}) {
    const o = this.getOrderById(orderId);
    if (!o) throw httpError(404, 'Commande introuvable.');
    if (o.status === ORDER_STATUS.CANCELLED) throw httpError(409, 'Cette commande est déjà annulée.');
    const wasDelivered = o.status === ORDER_STATUS.DONE || o.status === ORDER_STATUS.DELIVERED;
    const now = nowIso();
    const p = this.getProductById(o.productId);
    const v = this.data.vault[o.productId];
    let keysReturned = 0;
    let keysRevoked = 0;
    if (v && Array.isArray(v.keys)) {
      v.keys.forEach(k => {
        if (k && k.orderId === o.id) {
          if (restockKeys) {
            k.used = false; k.orderId = null; k.soldTo = null; k.userId = null; k.soldAt = null; delete k.revoked;
            keysReturned++;
          } else {
            k.revoked = true;
            keysRevoked++;
          }
        }
      });
      if (v.type !== 'file') v.content = v.keys.filter(k => !k.used).map(k => k.content).join('\n');
    }
    if (p && !wasDelivered && (o.deliveryMode === 'manual' || (v && v.type === 'file' && v.keys.length === 0))) {
      // Units reserved but never delivered go back on sale
      p.stock = (parseInt(p.stock, 10) || 0) + (parseInt(o.quantity, 10) || 1);
      p.updated_at = now;
    } else if (p) {
      this._recomputeStock(p);
    }

    let refundTx = null;
    const refundAmount = roundMoney(o.amount);
    const buyer = this.getUserById(o.userId);
    if (refund && refundAmount > 0 && !o.refunded) {
      if (buyer && !isAdminUser(buyer)) {
        const before = roundMoney(buyer.balance);
        buyer.balance = roundMoney(before + refundAmount);
        buyer.updated_at = now;
        refundTx = this.createTransaction({
          userId: buyer.id, userEmail: buyer.email, userName: buyer.name,
          amount: refundAmount, currency: 'USD', type: 'refund', paymentMethod: 'Remboursement Commande', provider: 'admin_refund',
          status: 'completed', balanceBefore: before, balanceAfter: buyer.balance,
          notes: `Remboursement de la commande ${o.id}${reason ? ' — ' + cleanText(reason, 150) : ''} (Par : ${adminName})`,
          metadata: { orderId: o.id }
        });
        o.refunded = true;
        o.refundedAt = now;
      }
    }
    o.status = ORDER_STATUS.CANCELLED;
    o.cancelledAt = now;
    o.wasDeliveredBeforeCancel = wasDelivered;
    o.vaultContent = null; // access revoked
    o.updatedAt = now;
    this.persist();
    return { order: o, refundTransaction: refundTx, keysReturned, keysRevoked, newBalance: buyer ? buyer.balance : null };
  }

  deleteOrder(id) {
    const o = this.getOrderById(id);
    if (!o) throw httpError(404, 'Commande introuvable.');
    this.data.orders = this.data.orders.filter(x => x !== o);
    if (o.vaultContent && o.vaultContent.blobId) {
      const stillUsed = this._blobReferencedByOrders(o.vaultContent.blobId) || Object.values(this.data.vault).some(v => v && v.blobId === o.vaultContent.blobId);
      if (!stillUsed) this._discardBlobs([o.vaultContent.blobId]);
    }
    this.persist();
    return { success: true, deletedOrder: { id: o.id } };
  }

  // ============================================================ TRANSACTIONS
  getTransactions(filter = {}) {
    let list = this.data.transactions;
    if (filter.userId) list = list.filter(t => t.userId === filter.userId);
    if (filter.status) list = list.filter(t => t.status === filter.status);
    return list;
  }

  getTransactionById(id) {
    if (!id) return null;
    return this.data.transactions.find(t => t && String(t.id) === String(id)) || null;
  }

  getTransactionByProviderTxId(providerTxId) {
    if (!providerTxId) return null;
    return this.data.transactions.find(t => t && t.providerTxId && String(t.providerTxId) === String(providerTxId)) || null;
  }

  createTransaction(tx) {
    const now = nowIso();
    const newTx = {
      id: tx.id || randomId('TXN-', 6),
      userId: tx.userId,
      userEmail: tx.userEmail || null,
      userName: tx.userName || null,
      amount: roundMoney(tx.amount),
      currency: tx.currency || 'USD',
      type: tx.type || 'deposit',
      paymentMethod: tx.paymentMethod || 'Inconnu',
      provider: tx.provider || 'manual',
      providerTxId: tx.providerTxId || null,
      status: tx.status || 'pending',
      idempotencyKey: tx.idempotencyKey || null,
      proofImage: tx.proofImage || null,
      notes: tx.notes || null,
      balanceBefore: tx.balanceBefore !== undefined ? tx.balanceBefore : null,
      balanceAfter: tx.balanceAfter !== undefined ? tx.balanceAfter : null,
      metadata: tx.metadata || null,
      adminResponsible: tx.adminResponsible || undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: tx.status === 'completed' ? now : null,
      failureReason: null
    };
    if (this.getTransactionById(newTx.id)) throw httpError(409, 'Identifiant de transaction déjà utilisé.');
    this.data.transactions.unshift(newTx);
    this.persist();
    return newTx;
  }

  updateTransaction(id, updates) {
    const t = this.getTransactionById(id);
    if (!t) return null;
    Object.assign(t, updates, { updatedAt: nowIso() });
    this.persist();
    return t;
  }

  /** Credits a deposit exactly once (status check + balance + ledger in the same transaction). */
  creditDeposit(transactionId, { providerTxId, extra } = {}) {
    const t = this.getTransactionById(transactionId);
    if (!t) throw httpError(404, 'Transaction introuvable.');
    const user = this.getUserById(t.userId);
    if (t.status === 'completed') return { alreadyCompleted: true, transaction: t, newBalance: user ? user.balance : null };
    if (!user) throw httpError(404, 'Client de la transaction introuvable.');
    const before = roundMoney(user.balance);
    user.balance = roundMoney(before + roundMoney(t.amount));
    user.updated_at = nowIso();
    Object.assign(t, {
      status: 'completed',
      providerTxId: providerTxId || t.providerTxId,
      completedAt: nowIso(),
      updatedAt: nowIso(),
      balanceBefore: before,
      balanceAfter: user.balance,
      failureReason: null
    });
    if (extra) t.metadata = { ...(t.metadata || {}), completedDetails: extra };
    this.persist();
    return { transaction: t, newBalance: user.balance, creditedAmount: t.amount };
  }

  deleteTransaction(id) {
    const t = this.getTransactionById(id);
    if (!t) throw httpError(404, 'Transaction introuvable.');
    this.data.transactions = this.data.transactions.filter(x => x !== t);
    if (t.proofImage && /^prv_/.test(t.proofImage)) this._discardBlobs([t.proofImage]);
    this.persist();
    return { success: true, deletedTransaction: { id: t.id } };
  }

  // ============================================================ VAULT
  getVault() { return this.data.vault || {}; }

  // ============================================================ TICKETS
  getTickets() { return this.data.tickets || []; }

  createTicket(ticket) {
    const now = nowIso();
    const t = {
      id: randomId('TCK-', 5),
      userId: ticket.userId || null,
      userName: cleanText(ticket.userName, 80) || 'Client',
      userContact: cleanText(ticket.userContact, 120),
      subject: cleanText(ticket.subject, 120) || 'Support Client',
      message: cleanText(ticket.message, 3000),
      status: 'Ouvert',
      date: now,
      createdAt: now
    };
    if (!t.message) throw httpError(400, 'Le message est requis.');
    this.data.tickets.unshift(t);
    if (this.data.tickets.length > 2000) this.data.tickets = this.data.tickets.slice(0, 2000);
    this.persist();
    return t;
  }

  updateTicket(id, updates) {
    const t = this.data.tickets.find(x => x && String(x.id) === String(id));
    if (!t) throw httpError(404, 'Ticket introuvable.');
    if (updates.status !== undefined) t.status = updates.status === 'Ouvert' ? 'Ouvert' : 'Résolu';
    t.updatedAt = nowIso();
    this.persist();
    return t;
  }

  deleteTicket(id) {
    if (!id) throw httpError(400, 'ID ticket requis.');
    const before = this.data.tickets.length;
    this.data.tickets = this.data.tickets.filter(x => String(x.id) !== String(id));
    if (this.data.tickets.length === before) throw httpError(404, 'Ticket introuvable.');
    this.persist();
    return { success: true };
  }

  // ============================================================ PAYMENT METHODS
  getPaymentMethods() { return this.data.payment_methods; }

  getPublicPaymentMethods() {
    return this.data.payment_methods.filter(m => m && m.enabled !== false).map(m => ({
      id: m.id, name: m.name, type: m.type, provider: m.provider, network: m.network, isBinance: Boolean(m.isBinance),
      address: m.address, instructions: m.instructions, qrCode: m.qrCode || null, enabled: true
    }));
  }

  savePaymentMethod(method) {
    const now = nowIso();
    const fields = {};
    if (method.name !== undefined) fields.name = cleanText(method.name, 100);
    if (method.type !== undefined) fields.type = cleanText(method.type, 40) || 'crypto';
    if (method.provider !== undefined) fields.provider = cleanText(method.provider, 40);
    if (method.network !== undefined) fields.network = cleanText(method.network, 60);
    if (method.address !== undefined) fields.address = cleanText(method.address, 300);
    if (method.instructions !== undefined) fields.instructions = cleanText(method.instructions, 1500);
    if (method.isBinance !== undefined) fields.isBinance = Boolean(method.isBinance);
    if (method.enabled !== undefined) fields.enabled = Boolean(method.enabled);
    if (method.qrCode !== undefined) {
      const q = method.qrCode ? String(method.qrCode) : null;
      if (q && !(q.startsWith('/media/pub_') || /^https:\/\//i.test(q))) throw httpError(400, 'QR code invalide.');
      fields.qrCode = q;
    }
    if (isRetiredTrybitMethod(fields)) throw httpError(400, "Le paiement crypto Trybit n'est plus pris en charge. Utilisez le Mobile Money.");
    const id = method.id !== undefined && method.id !== null && method.id !== '' ? parseInt(method.id, 10) : null;
    let saved = id ? this.data.payment_methods.find(m => m.id === id) : null;
    if (id && !saved) throw httpError(404, 'Moyen de paiement introuvable.');
    if (saved) {
      if (fields.qrCode !== undefined && saved.qrCode !== fields.qrCode) this._discardBlobs([this.blobIdFromUrl(saved.qrCode)]);
      Object.assign(saved, fields, { updated_at: now });
    } else {
      if (!fields.name) throw httpError(400, 'Le nom du moyen de paiement est requis.');
      const newId = Math.max(this.data.meta.next_method_id || 3, 3);
      this.data.meta.next_method_id = newId + 1;
      saved = { id: newId, type: 'crypto', provider: 'manual', network: '', address: '', instructions: '', isBinance: false, qrCode: null, enabled: true, ...fields, created_at: now, updated_at: now };
      this.data.payment_methods.push(saved);
    }
    this.persist();
    return saved;
  }

  deletePaymentMethod(id) {
    const numId = parseInt(id, 10);
    const m = this.data.payment_methods.find(x => x.id === numId);
    if (!m) throw httpError(404, 'Moyen de paiement introuvable.');
    this.data.payment_methods = this.data.payment_methods.filter(x => x !== m);
    this._discardBlobs([this.blobIdFromUrl(m.qrCode)]);
    this.persist();
    return true;
  }

  // ============================================================ VISITS & STATISTICS
  async trackVisitor({ vid, isNew }) {
    const clean = cleanText(vid, 80);
    if (!clean) return;
    await this.store.recordVisit({ vid: clean, isNew: Boolean(isNew) });
  }

  _periodCutoff(period) {
    const now = new Date();
    if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (period === 'week') return now.getTime() - 7 * 24 * 3600 * 1000;
    if (period === 'month') return now.getTime() - 30 * 24 * 3600 * 1000;
    if (period === 'year') return now.getTime() - 365 * 24 * 3600 * 1000;
    return 0;
  }

  async getVisitorStats(period = 'all') {
    try {
      return await this.store.visitStats(this._periodCutoff(period));
    } catch (e) {
      return { totalVisits: 0, uniqueVisitors: 0 };
    }
  }

  async resetVisitorStats() {
    await this.store.clearVisits();
    return { success: true };
  }

  async getLiveStatistics(period = 'all') {
    const orders = this.data.orders;
    const now = new Date();
    const cutoff = this._periodCutoff(period);
    const periodOrders = orders.filter(o => { const t = Date.parse(o.date); return isNaN(t) || t >= cutoff; });
    const completed = periodOrders.filter(o => o.status === ORDER_STATUS.DONE || o.status === ORDER_STATUS.DELIVERED);
    const totalRevenue = completed.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const totalUnitsSold = completed.reduce((s, o) => s + (Number(o.quantity) || 1), 0);
    const avgCart = completed.length > 0 ? totalRevenue / completed.length : 0;
    const visitorStats = await this.getVisitorStats(period);

    const labels = [], rev = [], vol = [];
    const push = (label, list) => {
      labels.push(label);
      rev.push(roundMoney(list.reduce((s, o) => s + (Number(o.amount) || 0), 0)));
      vol.push(list.reduce((s, o) => s + (Number(o.quantity) || 1), 0));
    };
    if (period === 'day') {
      for (let h = 0; h < 24; h += 2) push((h < 10 ? '0' : '') + h + 'h', completed.filter(o => { const d = new Date(o.date); return d.getHours() >= h && d.getHours() < h + 2; }));
    } else if (period === 'week') {
      const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(now.getDate() - i);
        const key = d.toDateString();
        push(days[d.getDay()], completed.filter(o => new Date(o.date).toDateString() === key));
      }
    } else if (period === 'month') {
      for (let i = 25; i >= 0; i -= 5) {
        const start = new Date(now); start.setDate(now.getDate() - i); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setDate(start.getDate() + 5);
        push(String(start.getDate()).padStart(2, '0') + '/' + String(start.getMonth() + 1).padStart(2, '0'), completed.filter(o => { const d = new Date(o.date); return d >= start && d < end; }));
      }
    } else {
      const names = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
      for (let mIdx = 11; mIdx >= 0; mIdx--) {
        const t = new Date(now.getFullYear(), now.getMonth() - mIdx, 1);
        push(names[t.getMonth()], completed.filter(o => { const d = new Date(o.date); return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth(); }));
      }
    }

    return {
      period,
      totalUsers: this.data.users.filter(u => !isAdminUser(u)).length,
      totalProducts: this.data.products.length,
      publishedProducts: this.data.products.filter(p => p.published).length,
      totalRevenue: roundMoney(totalRevenue),
      totalOrders: periodOrders.length,
      totalUnitsSold,
      avgCart: roundMoney(avgCart),
      totalVisitors: visitorStats.totalVisits,
      uniqueVisitors: visitorStats.uniqueVisitors,
      visitors: visitorStats,
      summary: {
        revenue: roundMoney(totalRevenue),
        orders: periodOrders.length,
        unitsSold: totalUnitsSold,
        avgCart: roundMoney(avgCart),
        totalVisitors: visitorStats.totalVisits,
        uniqueVisitors: visitorStats.uniqueVisitors
      },
      pendingOrders: orders.filter(o => o.status === ORDER_STATUS.PENDING).length,
      pendingDeposits: this.data.transactions.filter(t => t.status === 'pending').length,
      openTickets: this.data.tickets.filter(t => t.status !== 'Résolu').length,
      chartLabels: labels,
      chartRevenue: rev,
      chartVolume: vol
    };
  }

  // ============================================================ SETTINGS
  getPublicSettings() {
    const s = this.data.settings || {};
    return {
      min_recharge: typeof s.min_recharge === 'number' && s.min_recharge > 0 ? s.min_recharge : DEFAULT_SETTINGS.min_recharge,
      whatsapp_number: String(s.whatsapp_number || process.env.WHATSAPP_NUMBER || '237692960840').replace(/[^0-9]/g, ''),
      passwordResetByEmail: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM)
    };
  }

  updateCustomizableSettings(updates = {}) {
    const s = this.data.settings;
    if (updates.min_recharge !== undefined) {
      const val = roundMoney(updates.min_recharge);
      if (!(val > 0 && val <= 10000)) throw httpError(400, 'Montant minimum de recharge invalide (0.01 à 10000 $).');
      s.min_recharge = val;
    }
    if (updates.whatsapp_number !== undefined) {
      const digits = String(updates.whatsapp_number || '').replace(/[^0-9]/g, '');
      if (digits && (digits.length < 8 || digits.length > 15)) throw httpError(400, 'Numéro WhatsApp invalide (format international, sans +).');
      if (digits) s.whatsapp_number = digits; else delete s.whatsapp_number;
    }
    s.updated_at = nowIso();
    this.persist();
    return this.getPublicSettings();
  }

  // ============================================================ BACKUP & RESET
  createBackup() {
    const data = clone(this.data);
    return {
      version: this.getDeploymentVersion(),
      exportedAt: nowIso(),
      storage: this.store.kind,
      counts: {
        users: data.users.length,
        products: data.products.length,
        orders: data.orders.length,
        transactions: data.transactions.length,
        tickets: data.tickets.length,
        paymentMethods: data.payment_methods.length
      },
      data
    };
  }

  /** What a reset would delete (shown in the confirmation dialog). */
  getResetPreview() {
    const customers = this.data.users.filter(u => !isAdminUser(u));
    return {
      products: this.data.products.length,
      keys: Object.values(this.data.vault).reduce((s, v) => s + ((v && v.keys) || []).length, 0),
      categories: new Set(this.data.products.map(p => p.category).filter(Boolean)).size,
      customers: customers.length,
      customerBalances: roundMoney(customers.reduce((s, u) => s + (Number(u.balance) || 0), 0)),
      orders: this.data.orders.length,
      transactions: this.data.transactions.length,
      tickets: this.data.tickets.length,
      paymentMethods: this.data.payment_methods.length,
      storage: this.store.kind
    };
  }

  /**
   * Store reset (owner administrator only — authorization is enforced by the API layer).
   *  mode 'demo' : removes catalogue, keys, images, customers, orders, transactions, tickets, visits, sessions
   *                of customers; KEEPS administrator account, payment methods and shop settings.
   *  mode 'full' : same as 'demo' + payment methods and shop settings back to factory defaults, and every
   *                session (including other administrator sessions) is revoked.
   * Always keeps: the owner administrator account and its password, database structure, environment
   * variables and security configuration. Runs inside one transaction: all or nothing.
   */
  resetStore(mode, adminUser) {
    if (mode !== 'demo' && mode !== 'full') throw httpError(400, 'Mode de réinitialisation inconnu.');
    const ctx = this._ctx;
    if (!ctx) throw new Error('resetStore must run inside db.tx()');
    const before = this.getResetPreview();
    const now = nowIso();
    ctx.backup('pre_reset_' + mode, clone(this.data));

    const owner = this.getOwnerAdmin();
    const keptAdmins = this.data.users.filter(isAdminUser).map(u => ({ ...u, balance: 0, updated_at: now }));
    if (!owner || !keptAdmins.some(a => a.id === owner.id)) throw new Error('Owner administrator missing — reset aborted.');
    for (const a of keptAdmins) {
      if (mode === 'full' && a.id !== (adminUser && adminUser.id)) a.session_version = (a.session_version || 0) + 1;
    }

    this.data.users = keptAdmins;
    this.data.products = [];
    this.data.vault = {};
    this.data.orders = [];
    this.data.transactions = [];
    this.data.tickets = [];
    this.data.password_resets = {};
    if (mode === 'full') {
      this.data.payment_methods = clone(DEFAULT_PAYMENT_METHODS).map(m => ({ ...m, created_at: now, updated_at: now }));
      this.data.settings = { ...DEFAULT_SETTINGS, updated_at: now };
      this.data.meta.next_method_id = 3;
    } else {
      // payment methods kept, but uploaded QR codes stay (they are configuration)
    }
    // keep sessions of administrators only; customers do not exist anymore
    this.data.meta.next_product_id = 1;
    this.data.meta.last_reset = { mode, at: now, by: adminUser ? adminUser.email : null };
    // Uploaded files go too (product images, delivery files, payment proofs); demo mode keeps payment QR codes
    const keepBlobIds = mode === 'demo' ? this.data.payment_methods.map(m => this.blobIdFromUrl(m.qrCode)).filter(Boolean) : [];
    ctx.deleteAllBlobsExcept(keepBlobIds);
    ctx.clearVisits();
    this.persist();
    return { mode, resetAt: now, removed: before, kept: { administrators: keptAdmins.length, paymentMethods: this.data.payment_methods.length } };
  }

  getDeploymentVersion() {
    try {
      const vFile = path.join(__dirname, '..', 'version.json');
      if (fs.existsSync(vFile)) return JSON.parse(fs.readFileSync(vFile, 'utf8'));
    } catch (e) {}
    return { version: 'dev', buildTime: nowIso(), timestamp: Date.now(), env: 'development' };
  }
}

const db = new Database();
db.ORDER_STATUS = ORDER_STATUS;
db.httpError = httpError;
db.helpers = { roundMoney, cleanText, isSafeHttpUrl, isScryptHash, normalizeState, createInitialState, KNOWN_PUBLIC_HASHES };
module.exports = db;
