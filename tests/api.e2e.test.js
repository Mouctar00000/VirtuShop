/**
 * GetVirtu — end-to-end API tests (real HTTP server, isolated temporary database).
 * Run: node --test tests/api.e2e.test.js     (never touches the local data/ folder nor production)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- isolation: temporary file store (or a DISPOSABLE Postgres via TEST_DATABASE_URL), no .env, no provider credentials
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-e2e-'));
const PG_URL = process.env.TEST_DATABASE_URL || '';
const EDGE_MODE = !PG_URL && process.env.TEST_STORE === 'edge-config';
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'SASPAY_API_KEY', 'TRYBIT_API_KEY', 'TRYBIT_SHOP_ID', 'TRYBIT_SECRET_KEY', 'SASPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'GV_EDGE_API_BASE']) delete process.env[k];
process.env.GV_DATA_DIR = TMP;
process.env.GV_STORE = PG_URL ? 'postgres' : (EDGE_MODE ? 'edge-config' : 'file');
let edgeMock = null;
if (PG_URL) process.env.DATABASE_URL = PG_URL;
process.env.GV_SKIP_DOTENV = '1';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = 'Admin-Test-' + crypto.randomBytes(6).toString('hex');
{
  const salt = crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;
}

const server = require('../server');
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let base;
function call(method, url, body, token, extraHeaders) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(url, base);
    const req = http.request({
      host: u.hostname, port: u.port, method, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, extraHeaders || {})
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
      });
    });
    req.on('error', e => resolve({ status: 0, body: null, raw: Buffer.from(e.message), headers: {} }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (u, t) => call('GET', u, undefined, t);
const post = (u, b, t) => call('POST', u, b, t);
const put = (u, b, t) => call('PUT', u, b, t);
const del = (u, b, t) => call('DELETE', u, b, t);

const ctx = {};

test.before(async () => {
  if (EDGE_MODE) {
    const { createEdgeConfigMock } = require('./helpers/edge-config-mock');
    edgeMock = createEdgeConfigMock();
    process.env.GV_EDGE_API_BASE = await edgeMock.listen();
    process.env.EDGE_CONFIG_ID = 'ecfg_test';
    process.env.VERCEL_TOKEN = 'test-token';
  }
  if (PG_URL) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: PG_URL });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS getvirtu CASCADE');
    await c.end();
  }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (PG_URL) { try { await require('../backend/db').store.pool.end(); } catch (e) {} }
  if (edgeMock) await edgeMock.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

async function register(email, password = 'Passw0rd-ok', extra = {}) {
  const r = await post('/api/auth/register', { email, password, confirmPassword: password, name: extra.name || email.split('@')[0], ...extra });
  return r;
}
async function login(identifier, password) {
  const r = await post('/api/auth/login', { identifier, password });
  return r;
}

// ------------------------------------------------------------------------------------------------ public surface
test('static files: public pages served, private files never exposed', async () => {
  for (const p of ['/', '/admin', '/app.js', '/style.css', '/security.js']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  for (const p of ['/.env', '/.env.example', '/backend/db.js', '/data/database.json', '/server.js', '/package.json', '/tests/api.e2e.test.js', '/deploy_to_vercel.js', '/.git/config', '/api/../backend/db.js', '/%2e%2e/.env']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, `must not serve ${p}`);
  }
});

test('security headers present on pages and API', async () => {
  const page = await get('/');
  assert.match(page.headers['content-security-policy'] || '', /object-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.ok(page.headers['x-frame-options']);
  const api = await get('/api/data/products');
  assert.equal(api.headers['access-control-allow-origin'], undefined, 'no wildcard CORS');
  assert.match(api.headers['cache-control'] || '', /no-store/);
});

test('public endpoints: version, empty catalogue, settings, payment methods', async () => {
  assert.equal((await get('/api/version')).status, 200);
  const p = await get('/api/data/products');
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.products, []);
  const s = await get('/api/data/settings');
  assert.equal(s.status, 200);
  assert.equal(typeof s.body.settings.min_recharge, 'number');
  const m = await get('/api/data/methods');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.methods.map(x => x.provider), ['saspay'], 'Mobile Money is the only default payment method');
});

// ------------------------------------------------------------------------------------------------ admin auth
test('admin: published default passwords are rejected, real password works', async () => {
  for (const pw of ['admin123', 'admin', 'Admin123', '']) {
    const r = await login('admin', pw);
    assert.notEqual(r.status, 200, `password "${pw}" must be rejected`);
  }
  assert.notEqual((await login('admin@admin.com', ADMIN_PASSWORD)).status, 200, 'legacy alias e-mails are not admin identifiers');
  const r = await login('admin@getvirtu.shop', ADMIN_PASSWORD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.user.password_hash, undefined);
  const ttl = r.body.session.expiresAt - Date.now();
  assert.ok(ttl > 11 * 3600e3 && ttl <= 12 * 3600e3 + 5000, 'admin session lasts 12h');
  ctx.admin = r.body.session.token;
  const me = await get('/api/auth/me', ctx.admin);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
  assert.equal((await login('admin', ADMIN_PASSWORD)).status, 200, 'username login');
});

// ------------------------------------------------------------------------------------------------ customers
test('registration validation and account creation', async () => {
  assert.equal((await register('not-an-email')).status, 400);
  assert.equal((await register('weak@example.com', 'short1')).status, 400);
  assert.equal((await register('nodigit@example.com', 'onlyletters')).status, 400);
  assert.equal((await post('/api/auth/register', { email: 'mm@example.com', password: 'Passw0rd-ok', confirmPassword: 'other-Passw0rd' })).status, 400);
  assert.equal((await register('reserved@example.com', 'Passw0rd-ok', { username: 'admin' })).status, 400);

  const r = await register('alice@example.com', 'Alice-Pass-1', { role: 'admin', balance: 9999, name: 'Alice' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'client', 'role cannot be chosen by the client');
  assert.equal(r.body.user.balance, 0, 'balance cannot be chosen by the client');
  ctx.alice = r.body.session.token;
  ctx.aliceId = r.body.user.id;
  assert.equal((await register('ALICE@example.com')).status, 409, 'duplicate e-mail (case-insensitive)');

  const b = await register('bob@example.com', 'Bob-Pass-12', { name: 'Bob' });
  assert.equal(b.status, 201);
  ctx.bob = b.body.session.token;
  ctx.bobId = b.body.user.id;

  const bad = await login('alice@example.com', 'wrong-pass-1');
  assert.equal(bad.status, 401);
  const unknown = await login('nobody@example.com', 'wrong-pass-1');
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error, unknown.body.error, 'same error for unknown account and wrong password');
  assert.equal((await login('alice@example.com', 'Alice-Pass-1')).status, 200);
});

test('authorization: customers and anonymous users cannot reach admin features', async () => {
  const checks = [
    ['GET', '/api/data/users'], ['GET', '/api/data/stats'], ['GET', '/api/data/transactions'], ['GET', '/api/data/tickets'],
    ['GET', '/api/data/backup'], ['GET', '/api/data/reset-preview'], ['GET', '/api/data/system'],
    ['POST', '/api/data/products', { name: 'Hack', price: 0 }], ['DELETE', '/api/data/products', { id: 1 }],
    ['POST', '/api/data/users', { userId: 'x', amount: 1000 }], ['POST', '/api/data/settings', { min_recharge: 1 }],
    ['POST', '/api/data/methods', { name: 'Evil' }], ['POST', '/api/data/reset', { mode: 'full', password: 'x', confirmation: 'RESET WEBSITE' }],
    ['POST', '/api/payments/verify', { transactionId: 'x' }], ['GET', '/api/data/keys?productId=1']
  ];
  for (const [m, u, b] of checks) {
    const asCustomer = await call(m, u, b, ctx.alice);
    assert.ok(asCustomer.status === 403 || asCustomer.status === 401, `${m} ${u} as customer -> ${asCustomer.status}`);
    const anon = await call(m, u, b);
    assert.ok(anon.status === 403 || anon.status === 401, `${m} ${u} anonymous -> ${anon.status}`);
  }
  assert.equal((await get('/api/data/orders')).status, 401);
  // tampered token
  const [p, s] = ctx.alice.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.uid = 'admin-001';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + s;
  assert.equal((await get('/api/data/users', forged)).status, 403);
  assert.equal((await get('/api/auth/me', forged)).status, 401);
});

// ------------------------------------------------------------------------------------------------ catalogue
test('admin product management: create, image upload, validation, publish state', async () => {
  const c = await post('/api/data/products', { name: 'Compte Gmail USA', category: 'Gmail', price: 10, description: 'Compte vérifié', newKeys: ['user1@x.com|pass1', 'user2@x.com|pass2', 'user3@x.com|pass3'], image: PNG_1PX }, ctx.admin);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.product.stock, 3);
  assert.match(c.body.product.image, /^\/media\/pub_[a-f0-9]{24}$/);
  ctx.gmailId = c.body.product.id;
  ctx.gmailImage = c.body.product.image;
  const img = await get(c.body.product.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');

  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
  assert.equal((await post('/api/data/products', { name: 'SVG', price: 1, image: svg }, ctx.admin)).status, 400, 'SVG rejected');
  const fakePng = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await post('/api/data/products', { name: 'Fake', price: 1, image: fakePng }, ctx.admin)).status, 400, 'fake PNG rejected');
  assert.equal((await post('/api/data/products', { name: 'Neg', price: -5 }, ctx.admin)).status, 400, 'negative price rejected');
  assert.equal((await post('/api/data/products', { name: '', price: 5 }, ctx.admin)).status, 400, 'empty name rejected');
  assert.equal((await post('/api/data/products', { name: 'JS image', price: 5, image: 'javascript:alert(1)' }, ctx.admin)).status, 400);

  const dup = await post('/api/data/keys', { productId: ctx.gmailId, keys: ['user1@x.com|pass1'] }, ctx.admin);
  assert.equal(dup.status, 409, 'duplicate key refused');
  const add = await post('/api/data/keys', { productId: ctx.gmailId, keys: ['user4@x.com|pass4'] }, ctx.admin);
  assert.equal(add.status, 200);
  assert.equal(add.body.stock, 4);

  const manual = await post('/api/data/products', { name: 'Service Sur Mesure', category: 'Services', price: 5, deliveryMode: 'manual', stock: 2 }, ctx.admin);
  assert.equal(manual.status, 200);
  assert.equal(manual.body.product.stock, 2);
  ctx.manualId = manual.body.product.id;

  const hidden = await post('/api/data/products', { name: 'Produit Caché', price: 1, newKeys: ['HID-1'], published: false }, ctx.admin);
  ctx.hiddenId = hidden.body.product.id;

  const pub = await get('/api/data/products');
  const names = pub.body.products.map(p => p.name);
  assert.ok(names.includes('Compte Gmail USA') && names.includes('Service Sur Mesure'));
  assert.ok(!names.includes('Produit Caché'), 'unpublished products are not public');
  assert.equal(pub.body.vault, undefined, 'vault never public');
  assert.ok(!JSON.stringify(pub.body).includes('user1@x.com'), 'keys never public');

  const upd = await put('/api/data/products', { id: ctx.gmailId, price: 12.5 }, ctx.admin);
  assert.equal(upd.status, 200);
  const pub2 = await get('/api/data/products');
  assert.equal(pub2.body.products.find(p => p.id === ctx.gmailId).price, 12.5, 'price update visible on storefront');
  await put('/api/data/products', { id: ctx.gmailId, price: 10 }, ctx.admin);
});

// ------------------------------------------------------------------------------------------------ purchases
test('purchase with balance: server-side price, balance and stock, no client-chosen ids', async () => {
  const poor = await post('/api/data/orders', { productId: ctx.gmailId, quantity: 1 }, ctx.alice);
  assert.equal(poor.status, 400);
  assert.equal(poor.body.code, 'INSUFFICIENT_BALANCE');

  const gift = await post('/api/data/users', { userId: ctx.aliceId, amount: 25, action: 'gift' }, ctx.admin);
  assert.equal(gift.status, 200);
  assert.equal(gift.body.newBalance, 25);

  for (const q of [0, -1, 101, 'abc', 1.5]) {
    const r = await post('/api/data/orders', { productId: ctx.gmailId, quantity: q }, ctx.alice);
    assert.equal(r.status, 400, `quantity ${q}`);
  }
  const meBefore = await get('/api/auth/me', ctx.alice);
  const balBefore = meBefore.body.user.balance;

  const buy = await post('/api/data/orders', { productId: ctx.gmailId, quantity: 1, orderId: 'ORD-<img src=x onerror=alert(1)>', price: 0.01, amount: 0.01, total: 0.01 }, ctx.alice);
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  assert.notEqual(buy.body.order.id, 'ORD-<img src=x onerror=alert(1)>', 'order id generated by the server');
  assert.match(buy.body.order.id, /^ORD-[A-F0-9]+$/);
  assert.equal(buy.body.order.amount, 10, 'price from catalogue');
  assert.equal(buy.body.newBalance, Math.round((balBefore - 10) * 100) / 100);
  assert.equal(buy.body.order.status, 'Complété');
  assert.match(buy.body.order.vaultContent.content, /user\d@x\.com\|pass\d/);
  ctx.aliceOrder = buy.body.order.id;

  const hidden = await post('/api/data/orders', { productId: ctx.hiddenId, quantity: 1 }, ctx.alice);
  assert.equal(hidden.status, 404, 'unpublished product cannot be bought');

  const adminBuy = await post('/api/data/orders', { productId: ctx.gmailId, quantity: 1 }, ctx.admin);
  assert.equal(adminBuy.status, 403, 'admin accounts do not buy');
});

test('purchase idempotency: same idempotencyKey charges once', async () => {
  await post('/api/data/users', { userId: ctx.bobId, amount: 50, action: 'add' }, ctx.admin);
  const key = crypto.randomUUID();
  const a = await post('/api/data/orders', { productId: ctx.gmailId, quantity: 1, idempotencyKey: key }, ctx.bob);
  const b = await post('/api/data/orders', { productId: ctx.gmailId, quantity: 1, idempotencyKey: key }, ctx.bob);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(a.body.order.id, b.body.order.id);
  const me = await get('/api/auth/me', ctx.bob);
  assert.equal(me.body.user.balance, 40);
});

test('concurrency: parallel purchases never oversell the last units nor double-charge', async () => {
  const p = await post('/api/data/products', { name: 'Dernières Unités', price: 3, newKeys: ['LAST-1', 'LAST-2'] }, ctx.admin);
  const pid = p.body.product.id;
  const before = (await get('/api/auth/me', ctx.bob)).body.user.balance;
  const results = await Promise.all(Array.from({ length: 8 }, () => post('/api/data/orders', { productId: pid, quantity: 1 }, ctx.bob)));
  const ok = results.filter(r => r.status === 201);
  const refused = results.filter(r => r.status === 409);
  assert.equal(ok.length, 2, 'exactly the 2 available units are sold');
  assert.equal(refused.length, 6);
  const delivered = ok.map(r => r.body.order.vaultContent.content).sort();
  assert.deepEqual(delivered, ['LAST-1', 'LAST-2'], 'each key delivered once');
  const after = (await get('/api/auth/me', ctx.bob)).body.user.balance;
  assert.equal(Math.round((before - after) * 100) / 100, 6, 'charged exactly twice');
});

test('customers only see their own orders', async () => {
  const a = await get('/api/data/orders', ctx.alice);
  const b = await get('/api/data/orders', ctx.bob);
  assert.ok(a.body.orders.every(o => o.userId === ctx.aliceId));
  assert.ok(b.body.orders.every(o => o.userId === ctx.bobId));
  assert.ok(!b.body.orders.some(o => o.id === ctx.aliceOrder));
  const all = await get('/api/data/orders', ctx.admin);
  assert.ok(all.body.orders.some(o => o.id === ctx.aliceOrder));
});

// ------------------------------------------------------------------------------------------------ order lifecycle
test('manual delivery order: pending -> delivered by admin -> visible to customer', async () => {
  const buy = await post('/api/data/orders', { productId: ctx.manualId, quantity: 1, contactInfo: '+237 6 99 00 00 00' }, ctx.bob);
  assert.equal(buy.status, 201);
  assert.equal(buy.body.order.status, 'En attente');
  ctx.manualOrder = buy.body.order.id;
  const empty = await put('/api/data/orders', { id: ctx.manualOrder, action: 'deliver', vaultContent: { type: 'text', content: '' } }, ctx.admin);
  assert.equal(empty.status, 400, 'delivery requires content');
  const badLink = await put('/api/data/orders', { id: ctx.manualOrder, action: 'deliver', vaultContent: { type: 'link', content: 'javascript:alert(1)' } }, ctx.admin);
  assert.equal(badLink.status, 400, 'javascript: links refused');
  const ok = await put('/api/data/orders', { id: ctx.manualOrder, action: 'deliver', vaultContent: { type: 'text', content: 'Identifiants: demo / secret' } }, ctx.admin);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const mine = await get('/api/data/orders', ctx.bob);
  const o = mine.body.orders.find(x => x.id === ctx.manualOrder);
  assert.equal(o.status, 'Complété');
  assert.equal(o.vaultContent.content, 'Identifiants: demo / secret');
});

test('cancellation: refund exactly once, cancelled orders are final, delivered keys are not resold', async () => {
  const before = (await get('/api/auth/me', ctx.alice)).body.user.balance;
  const stockBefore = (await get('/api/data/products')).body.products.find(p => p.id === ctx.gmailId).stock;
  const c1 = await put('/api/data/orders', { id: ctx.aliceOrder, action: 'cancel' }, ctx.admin);
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.order.status, 'Annulé');
  assert.equal(c1.body.keysRevoked, 1);
  const c2 = await put('/api/data/orders', { id: ctx.aliceOrder, action: 'cancel' }, ctx.admin);
  assert.equal(c2.status, 409, 'second cancel refused');
  const legacy = await put('/api/data/orders', { id: ctx.aliceOrder, status: 'En attente' }, ctx.admin);
  assert.equal(legacy.status, 409, 'cancelled order cannot go back to pending');
  const redeliver = await put('/api/data/orders', { id: ctx.aliceOrder, action: 'deliver', vaultContent: { type: 'text', content: 'x' } }, ctx.admin);
  assert.equal(redeliver.status, 409, 'cancelled order cannot be delivered again');
  const after = (await get('/api/auth/me', ctx.alice)).body.user.balance;
  assert.equal(Math.round((after - before) * 100) / 100, 10, 'refunded once');
  const stockAfter = (await get('/api/data/products')).body.products.find(p => p.id === ctx.gmailId).stock;
  assert.equal(stockAfter, stockBefore, 'revealed keys are not put back on sale');
  const mine = (await get('/api/data/orders', ctx.alice)).body.orders.find(o => o.id === ctx.aliceOrder);
  assert.equal(mine.vaultContent, null, 'access revoked');
});

// ------------------------------------------------------------------------------------------------ payments
test('payments: session required, forged webhooks never credit, foreign transactions hidden', async () => {
  assert.equal((await post('/api/payments/deposit', { userId: ctx.aliceId, amount: 50, paymentMethodId: 1 })).status, 401);
  assert.equal((await post('/api/payments/saspay/create', { userId: ctx.aliceId, amount: 50 })).status, 401);

  const noProof = await post('/api/payments/deposit', { amount: 20, paymentMethodId: 1 }, ctx.alice);
  assert.equal(noProof.status, 400, 'proof required');
  const dep = await post('/api/payments/deposit', { amount: 20, paymentMethodId: 1, proofImage: PNG_1PX, userId: ctx.bobId }, ctx.alice);
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  assert.equal(dep.body.transaction.userId, ctx.aliceId, 'deposit belongs to the session user');
  assert.equal(dep.body.transaction.proofImage, undefined);
  ctx.depositTx = dep.body.transaction.id;

  const before = (await get('/api/auth/me', ctx.alice)).body.user.balance;
  await post('/api/payments/webhook', { event: 'transaction.success', data: { status: 'SUCCESS', metadata: { internalTxId: ctx.depositTx } } });
  await post('/api/payments/saspay/webhook', { event: 'transaction.success', data: { status: 'SUCCESS', reference: ctx.depositTx } });
  await post('/api/payments/webhook', { invoice_id: 'X', order_id: ctx.depositTx, status: 'success' });
  const after = (await get('/api/auth/me', ctx.alice)).body.user.balance;
  assert.equal(after, before, 'forged webhooks must not credit anything');

  const foreign = await post('/api/payments/saspay/verify', { transactionId: ctx.depositTx }, ctx.bob);
  assert.equal(foreign.status, 404, "cannot query another customer's transaction");

  // private payment proof: admin only
  const txs = (await get('/api/data/transactions', ctx.admin)).body.transactions;
  assert.ok(txs.find(t => t.id === ctx.depositTx).hasProof);

  const approve = await post('/api/payments/verify', { transactionId: ctx.depositTx, isApproval: true }, ctx.admin);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const again = await post('/api/payments/verify', { transactionId: ctx.depositTx, isApproval: true }, ctx.admin);
  assert.equal(again.body.alreadyProcessed, true);
  const credited = (await get('/api/auth/me', ctx.alice)).body.user.balance;
  assert.equal(Math.round((credited - before) * 100) / 100, 20, 'credited exactly once');
});

test('Trybit gateway retired: only Mobile Money is offered and the old routes are closed', async () => {
  const closed = [['POST', '/api/payments/trybit/create', 410], ['POST', '/api/payments/trybit/webhook', 410],
    ['GET', '/api/payments/trybit/verify?transactionId=x', 410], ['POST', '/api/trybit/create', 404]];
  for (const [method, url, expected] of closed) {
    const r = method === 'GET' ? await get(url, ctx.bob) : await post(url, { productId: ctx.gmailId, quantity: 2, amount: 0.01 }, ctx.bob);
    assert.equal(r.status, expected, `${method} ${url} -> ${r.status}`);
  }
  const pub = (await get('/api/data/methods')).body.methods;
  assert.ok(pub.some(m => m.provider === 'saspay'), 'Mobile Money still offered');
  assert.ok(!pub.some(m => m.provider === 'trybit' || m.type === 'crypto_trybit'), 'no Trybit method');
  const recreate = await post('/api/data/methods', { name: 'Crypto', type: 'crypto_trybit', provider: 'trybit' }, ctx.admin);
  assert.equal(recreate.status, 400, 'the admin cannot re-create the retired gateway');
  const txs = (await get('/api/data/transactions', ctx.admin)).body.transactions;
  assert.ok(!txs.some(t => t.provider === 'trybit'), 'no Trybit transaction was created');
});

test('legacy data: an existing Trybit payment method is removed on load', async () => {
  const { normalizeState, createInitialState } = require('../backend/db').helpers;
  const s = createInitialState();
  assert.ok(!s.payment_methods.some(m => m.provider === 'trybit'), 'defaults contain only Mobile Money');
  s.payment_methods.push({ id: 2, name: 'Crypto Instantané (Trybit)', type: 'crypto_trybit', provider: 'trybit', enabled: true });
  assert.equal(normalizeState(s), true, 'state marked as changed');
  assert.deepEqual(s.payment_methods.map(m => m.provider), ['saspay']);
});

test('admin balance adjustments are validated and ledgered', async () => {
  assert.equal((await post('/api/data/users', { userId: ctx.bobId, amount: -50, action: 'add' }, ctx.admin)).status, 400);
  assert.equal((await post('/api/data/users', { userId: ctx.bobId, amount: 1e9, action: 'add' }, ctx.admin)).status, 400);
  assert.equal((await post('/api/data/users', { userId: ctx.bobId, amount: 5, action: 'steal' }, ctx.admin)).status, 400);
  const users = (await get('/api/data/users', ctx.admin)).body.users;
  const admin = users.find(u => u.role === 'admin');
  assert.equal((await post('/api/data/users', { userId: admin.id, amount: 100, action: 'add' }, ctx.admin)).status, 400, 'admin balance immutable');
  assert.equal((await del('/api/data/users', { id: admin.id }, ctx.admin)).status, 403, 'admin cannot be deleted');
  assert.ok(users.every(u => u.password_hash === undefined), 'no password hashes in the admin user list');
});

// ------------------------------------------------------------------------------------------------ tickets
test('support tickets: anonymous submission, server-side ids, admin management', async () => {
  const xss = '<img src=x onerror=alert(document.cookie)>';
  const t = await post('/api/data/tickets', { id: 'TCK-HACK', userName: xss, userContact: xss, subject: xss, message: xss + ' besoin d\'aide' });
  assert.equal(t.status, 201);
  assert.notEqual(t.body.ticket.id, 'TCK-HACK');
  assert.equal((await post('/api/data/tickets', { message: '' })).status, 400);
  const list = await get('/api/data/tickets', ctx.admin);
  assert.ok(list.body.tickets.some(x => x.id === t.body.ticket.id));
  assert.equal((await put('/api/data/tickets', { id: t.body.ticket.id, status: 'Résolu' }, ctx.admin)).status, 200);
});

// ------------------------------------------------------------------------------------------------ password flows
test('password change invalidates other sessions; admin-assisted reset forces a change', async () => {
  const s2 = (await login('alice@example.com', 'Alice-Pass-1')).body.session.token;
  assert.equal((await post('/api/auth/change-password', { currentPassword: 'wrong-1', newPassword: 'Alice-Pass-2' }, ctx.alice)).status, 401);
  const ch = await post('/api/auth/change-password', { currentPassword: 'Alice-Pass-1', newPassword: 'Alice-Pass-2', confirmPassword: 'Alice-Pass-2' }, ctx.alice);
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal((await get('/api/auth/me', s2)).status, 401, 'old sessions revoked');
  assert.equal((await get('/api/auth/me', ctx.alice)).status, 401, 'old sessions revoked');
  ctx.alice = ch.body.session.token;
  assert.equal((await get('/api/auth/me', ctx.alice)).status, 200, 'new session works');
  assert.equal((await login('alice@example.com', 'Alice-Pass-1')).status, 401);

  const reset = await post('/api/data/users', { userId: ctx.bobId, action: 'reset_password' }, ctx.admin);
  assert.equal(reset.status, 200);
  const temp = reset.body.temporaryPassword;
  assert.match(temp, /^Tmp-/);
  assert.equal((await get('/api/auth/me', ctx.bob)).status, 401, 'bob logged out everywhere');
  const l = await login('bob@example.com', temp);
  assert.equal(l.status, 200);
  assert.equal(l.body.user.mustChangePassword, true);
  const ch2 = await post('/api/auth/change-password', { newPassword: 'Bob-Pass-New-9' }, l.body.session.token);
  assert.equal(ch2.status, 200, JSON.stringify(ch2.body));
  ctx.bob = ch2.body.session.token;

  const fp = await post('/api/auth/forgot-password', { email: 'alice@example.com' });
  const fp2 = await post('/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.equal(fp.status, 200);
  assert.deepEqual(fp.body, fp2.body, 'no account enumeration');
});

test('logout revokes the session server-side', async () => {
  const s = (await login('alice@example.com', 'Alice-Pass-2')).body.session.token;
  assert.equal((await get('/api/auth/me', s)).status, 200);
  assert.equal((await post('/api/auth/logout', {}, s)).status, 200);
  assert.equal((await get('/api/auth/me', s)).status, 401);
});

// ------------------------------------------------------------------------------------------------ System Management: reset
test('reset safeguards: owner admin, password re-authentication and exact phrase required', async () => {
  const pv = await get('/api/data/reset-preview', ctx.admin);
  assert.equal(pv.status, 200);
  assert.ok(pv.body.preview.products >= 3);
  assert.ok(pv.body.preview.customers >= 2);
  assert.equal(pv.body.isOwner, true);

  const cases = [
    [{ mode: 'demo', password: ADMIN_PASSWORD }, 400, 'missing phrase'],
    [{ mode: 'demo', password: ADMIN_PASSWORD, confirmation: 'reset website' }, 400, 'phrase is case-sensitive'],
    [{ mode: 'demo', confirmation: 'RESET WEBSITE' }, 400, 'missing password'],
    [{ mode: 'nuke', password: ADMIN_PASSWORD, confirmation: 'RESET WEBSITE' }, 400, 'unknown mode'],
    [{ mode: 'demo', password: 'wrong-password-1', confirmation: 'RESET WEBSITE' }, 401, 'wrong password']
  ];
  for (const [b, status, label] of cases) {
    const r = await post('/api/data/reset', b, ctx.admin);
    assert.equal(r.status, status, label + ' -> ' + JSON.stringify(r.body));
  }
  assert.equal((await post('/api/data/reset', { mode: 'demo', password: 'Alice-Pass-2', confirmation: 'RESET WEBSITE' }, ctx.alice)).status, 403);
  assert.equal((await post('/api/data/reset', { mode: 'demo', password: ADMIN_PASSWORD, confirmation: 'RESET WEBSITE' })).status, 403);
  assert.ok((await get('/api/data/products')).body.products.length >= 2, 'nothing was deleted by refused attempts');
});

test('demo reset: removes demo content, keeps admin, payment methods and settings', async () => {
  const custom = await post('/api/data/methods', { name: 'USDT TRC20 (manuel)', type: 'crypto', address: 'TXYZ', instructions: 'Envoyez puis joignez la preuve', qrCode: PNG_1PX }, ctx.admin);
  assert.equal(custom.status, 200, JSON.stringify(custom.body));
  const qr = custom.body.method.qrCode;
  await post('/api/data/settings', { min_recharge: 7 }, ctx.admin);
  await post('/api/data/visitors', { vid: 'v-test', isNew: true });

  const r = await post('/api/data/reset', { mode: 'demo', password: ADMIN_PASSWORD, confirmation: 'RESET WEBSITE' }, ctx.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'demo');
  assert.ok(r.body.backup && r.body.backup.data && r.body.backup.data.products.length >= 3, 'pre-reset backup returned');
  assert.ok(r.body.removed.customers >= 2);

  assert.deepEqual((await get('/api/data/products')).body.products, [], 'storefront empty');
  assert.equal((await get(ctx.gmailImage)).status, 404, 'product images deleted');
  assert.equal((await get(qr)).status, 200, 'payment QR code kept');
  const users = (await get('/api/data/users', ctx.admin)).body.users;
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'admin');
  assert.equal((await get('/api/data/orders', ctx.admin)).body.orders.length, 0);
  assert.equal((await get('/api/data/transactions', ctx.admin)).body.transactions.length, 0);
  assert.equal((await get('/api/data/tickets', ctx.admin)).body.tickets.length, 0);
  assert.ok((await get('/api/data/methods', ctx.admin)).body.methods.some(m => m.name === 'USDT TRC20 (manuel)'), 'payment methods kept');
  assert.equal((await get('/api/data/settings')).body.settings.min_recharge, 7, 'settings kept');
  assert.equal((await get('/api/data/stats?period=all', ctx.admin)).body.totalVisitors, 0, 'visits cleared');
  assert.equal((await get('/api/auth/me', ctx.bob)).status, 401, 'deleted customers are logged out');
  assert.equal((await get('/api/auth/me', ctx.admin)).status, 200, 'admin session still valid');
  assert.equal((await login('admin', ADMIN_PASSWORD)).status, 200, 'admin can still log in');
  if (PG_URL) {
    const n = await require('../backend/db').store.pool.query(`SELECT count(*)::int AS n FROM getvirtu.backups WHERE reason = 'pre_reset_demo'`);
    assert.equal(n.rows[0].n, 1, 'server-side backup written');
  } else if (EDGE_MODE) {
    assert.ok(edgeMock.items.has('gv_state'), 'state stored under gv_state');
    assert.ok(![...edgeMock.items.keys()].some(k => k.startsWith('gv_blob_') && k !== 'gv_blob_' + qr.replace('/media/', '')), 'product images purged from Edge Config');
  } else {
    const backups = fs.readdirSync(path.join(TMP, 'backups'));
    assert.ok(backups.some(f => f.includes('pre_reset_demo')), 'server-side backup written');
  }

  // the shop works again after the reset
  const np = await post('/api/data/products', { name: 'Nouveau Produit', price: 2, newKeys: ['N-1'] }, ctx.admin);
  assert.equal(np.status, 200);
  assert.equal(np.body.product.id, 1, 'catalogue numbering restarts');
  const reg = await register('carol@example.com', 'Carol-Pass-1');
  assert.equal(reg.status, 201);
});

test('full reset: also restores payment methods and settings to factory defaults', async () => {
  const r = await post('/api/data/reset', { mode: 'full', password: ADMIN_PASSWORD, confirmation: 'RESET WEBSITE' }, ctx.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const methods = (await get('/api/data/methods', ctx.admin)).body.methods;
  assert.deepEqual(methods.map(m => m.provider), ['saspay'], 'full reset restores the single default gateway (Mobile Money)');
  assert.equal((await get('/api/data/settings')).body.settings.min_recharge, 5);
  assert.deepEqual((await get('/api/data/products')).body.products, []);
  assert.equal((await get('/api/data/users', ctx.admin)).body.users.length, 1);
  assert.equal((await login('admin', ADMIN_PASSWORD)).status, 200, 'admin password preserved');
});

// ------------------------------------------------------------------------------------------------ robustness
test('malformed requests are rejected cleanly', async () => {
  assert.equal((await call('POST', '/api/auth/login', '{not json')).status, 400);
  assert.equal((await get('/api/data/does-not-exist')).status, 404);
  const big = 'x'.repeat(5 * 1024 * 1024);
  const r = await call('POST', '/api/data/tickets', JSON.stringify({ message: big }));
  assert.equal(r.status, 413);
});
