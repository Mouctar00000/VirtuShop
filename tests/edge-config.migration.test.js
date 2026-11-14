/**
 * GetVirtu — migration of the legacy production Edge Config layout (db_users, db_products, ...) to the new
 * transactional document "gv_state", against a local mock of the Vercel API (never a real store).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createEdgeConfigMock } = require('./helpers/edge-config-mock');

const ADMIN123_HASH = 'e1ef6864bfd0e96c37fa33f3de4ceff20f93b236fc292b9e6440310d88f27902'; // published default
const ADMIN_PASSWORD = 'Rotated-' + crypto.randomBytes(5).toString('hex');
const salt = crypto.randomBytes(16).toString('hex');
const ADMIN_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

// Same shape as the production Edge Config observed during the audit (values are synthetic)
const legacy = {
  db_users: [
    { id: 'admin-001', email: 'admin@virtushop.com', username: 'admin', password_hash: ADMIN123_HASH, name: 'Administrateur', role: 'admin', balance: 0, updated_at: '2026-10-07T10:00:00.000Z' },
    { id: 'usr_legacy_1', email: 'client@example.com', username: 'client', password_hash: crypto.createHash('sha256').update('getvirtu_sec_salt_2026:Client-Pass-1').digest('hex'), name: 'Client', role: 'client', balance: 4.5 }
  ],
  db_products: [{ id: 3, name: 'Gmail(USA)', category: 'gmail', price: '3.99', stock: 2, published: true, image: null }],
  db_vault: { 3: { type: 'text', keys: [{ id: 'K1', content: 'mail1@x.com|p1', used: false }, { id: 'K2', content: 'mail2@x.com|p2', used: false }] } },
  db_orders: [],
  db_transactions: [{ id: 'TXN-OLD', userId: 'usr_legacy_1', amount: 4.5, status: 'completed', type: 'deposit' }],
  db_payment_methods: [{ id: 1, name: 'Mobile Money', type: 'mobile_money', provider: 'saspay', enabled: true }],
  db_settings: { min_recharge: 5 },
  test_key: 'x', test_ping: 1, balance_test_user: { a: 1 }, test_connectivity: { ok: true }
};

let mock, server, base;
function call(method, url, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url, base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  mock = createEdgeConfigMock(legacy);
  const apiBase = await mock.listen();
  for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL']) delete process.env[k];
  Object.assign(process.env, {
    GV_SKIP_DOTENV: '1', GV_STORE: 'edge-config', GV_EDGE_API_BASE: apiBase, EDGE_CONFIG_ID: 'ecfg_test', VERCEL_TOKEN: 'test-token',
    GV_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gv-edge-')), SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_PASSWORD_HASH: ADMIN_HASH
  });
  server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await mock.close(); });

test('legacy production layout is migrated safely', async () => {
  // published default password no longer works, the rotated one does
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'admin', password: 'admin123' })).status, 401);
  const admin = await call('POST', '/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.user.email, 'admin@getvirtu.shop', 'legacy admin e-mail normalized');

  // data preserved
  const prods = (await call('GET', '/api/data/products')).body.products;
  assert.equal(prods.length, 1);
  assert.equal(prods[0].price, 3.99);
  assert.equal(prods[0].stock, 2);
  const users = (await call('GET', '/api/data/users', null, admin.body.session.token)).body.users;
  assert.equal(users.find(u => u.id === 'usr_legacy_1').balance, 4.5);

  // legacy customer password (salted SHA-256) still works once and is upgraded to scrypt
  const c = await call('POST', '/api/auth/login', { identifier: 'client@example.com', password: 'Client-Pass-1' });
  assert.equal(c.status, 200);
  const st = mock.items.get('gv_state');
  assert.ok(st, 'new document written');
  assert.match(st.users.find(u => u.id === 'usr_legacy_1').password_hash, /^scrypt:/);
  assert.ok(!JSON.stringify(st).includes(ADMIN123_HASH), 'published hash removed');

  // legacy keys and test leftovers cleaned up
  for (const k of Object.keys(legacy)) assert.equal(mock.items.has(k), false, `${k} removed`);
});

test('full reset on the Edge Config store leaves a clean shop with the admin account', async () => {
  const admin = await call('POST', '/api/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD });
  const r = await call('POST', '/api/data/reset', { mode: 'full', password: ADMIN_PASSWORD, confirmation: 'RESET WEBSITE' }, admin.body.session.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.backup.data.products.length, 1, 'backup contains the previous data');
  const st = mock.items.get('gv_state');
  assert.equal(st.products.length, 0);
  assert.equal(st.users.length, 1);
  assert.equal(st.users[0].role, 'admin');
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD })).status, 200);
});
