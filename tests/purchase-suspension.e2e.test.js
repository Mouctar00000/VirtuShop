/**
 * GetVirtu — individual purchase suspension (administrator) end-to-end tests.
 * Real HTTP server + isolated temporary database + local SasPay double (Mobile Money top-ups keep working).
 * Run: node --test tests/purchase-suspension.e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-suspend-'));
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'SASPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'CRON_SECRET']) delete process.env[k];
process.env.GV_DATA_DIR = TMP;
process.env.GV_STORE = 'file';
process.env.GV_SKIP_DOTENV = '1';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SASPAY_API_KEY = 'sk_test_double_' + crypto.randomBytes(6).toString('hex');
const ADMIN_PASSWORD = 'Admin-Test-' + crypto.randomBytes(6).toString('hex');
{
  const salt = crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;
}
const MESSAGE = 'Nous rencontrons actuellement un problème technique lié au traitement des commandes. Merci de réessayer un peu plus tard. Nous vous prions de nous excuser pour ce désagrément.';

// ---- minimal SasPay double (documented envelope); each operator answer is set by the test
const payments = new Map();
const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/api\/v1\//, '');
    const body = raw ? JSON.parse(raw) : null;
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    let m;
    if (req.method === 'POST' && p === 'payments/softpay/') {
      const id = crypto.randomUUID();
      payments.set(id, { id, status: 'PENDING', requested_amount: body.amount, debited_amount: body.amount, currency: body.currency, metadata: body.metadata, status_logs: [] });
      return send(201, { success: true, data: { id, status: 'PENDING', checkout_url: '', instructions: [] }, code: 201 });
    }
    if (req.method === 'GET' && (m = p.match(/^payments\/([^/]+)\/verify\/$/))) {
      const pay = payments.get(m[1]);
      return pay ? send(200, { success: true, data: pay, code: 200 }) : send(404, { success: false, error: { message: 'introuvable', code: 'not_found' }, code: 404 });
    }
    return send(404, { success: false, error: { message: 'route inconnue', code: 'not_found' }, code: 404 });
  });
});

let server, base;
function call(method, url, body, token) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(url, base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (u, t) => call('GET', u, undefined, t);
const post = (u, b, t) => call('POST', u, b, t);
const me = async t => (await get('/api/auth/me', t)).body.user;
const ctx = {};

test.before(async () => {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  process.env.SASPAY_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/api/v1`;
  server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.admin = (await post('/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD })).body.session.token;
  for (const [k, email] of [['zoe', 'zoe@example.com'], ['yan', 'yan@example.com']]) {
    const r = await post('/api/auth/register', { email, password: 'Client-Pass-12', confirmPassword: 'Client-Pass-12', name: k });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ctx[k] = r.body.session.token;
    ctx[k + 'Id'] = r.body.user.id;
    await post('/api/data/users', { userId: r.body.user.id, amount: 30, action: 'gift', reason: 'test' }, ctx.admin);
  }
  const auto = await post('/api/data/products', { name: 'Licence Auto', price: 4, newKeys: ['K-1', 'K-2', 'K-3', 'K-4', 'K-5'] }, ctx.admin);
  ctx.autoId = auto.body.product.id;
  const manual = await post('/api/data/products', { name: 'Service Manuel', price: 5, deliveryMode: 'manual', stock: 5 }, ctx.admin);
  ctx.manualId = manual.body.product.id;
});
test.after(() => { server.close(); mockServer.close(); });

test('1. administrator suspends the purchases of ONE customer (status visible, persisted)', async () => {
  const r = await post('/api/data/users', { userId: ctx.zoeId, action: 'suspend_purchases' }, ctx.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.purchasesSuspended, true);
  assert.equal(r.body.user.balance, 30, 'the balance is not touched');
  const list = (await get('/api/data/users', ctx.admin)).body.users;
  assert.equal(list.find(u => u.id === ctx.zoeId).purchasesSuspended, true);
  assert.equal(list.find(u => u.id === ctx.yanId).purchasesSuspended, false, 'other customers unaffected');
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'database.json'), 'utf8'));
  assert.equal(db.users.find(u => u.id === ctx.zoeId).purchasesSuspended, true, 'stored in the database');
});

test('only the administrator can change it; admin accounts cannot be suspended', async () => {
  assert.equal((await post('/api/data/users', { userId: ctx.zoeId, action: 'resume_purchases' }, ctx.zoe)).status, 403);
  assert.equal((await post('/api/data/users', { userId: ctx.yanId, action: 'suspend_purchases' }, ctx.yan)).status, 403);
  assert.equal((await post('/api/data/users', { userId: ctx.zoeId, action: 'resume_purchases' })).status, 403);
  const adminId = (await me(ctx.admin)).id;
  assert.equal((await post('/api/data/users', { userId: adminId, action: 'suspend_purchases' }, ctx.admin)).status, 400);
  assert.equal((await post('/api/data/users', { userId: 'nobody', action: 'suspend_purchases' }, ctx.admin)).status, 404);
});

test('2-4. suspended customer: every purchase refused server-side with the neutral message, nothing debited', async () => {
  const stockBefore = (await get('/api/data/products')).body.products.find(p => p.id === ctx.autoId).stock;
  for (const body of [
    { productId: ctx.autoId, quantity: 1 },
    { productId: ctx.manualId, quantity: 2 },
    { productName: 'Licence Auto', quantity: 1 },
    { productId: ctx.autoId, quantity: 1, idempotencyKey: 'retry-1' }
  ]) {
    const r = await post('/api/data/orders', body, ctx.zoe);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PURCHASES_UNAVAILABLE');
    assert.equal(r.body.error, MESSAGE, 'exact message, no mention of a suspension');
    assert.doesNotMatch(JSON.stringify(r.body), /suspen|admin|bloqu/i);
  }
  assert.equal((await me(ctx.zoe)).balance, 30, 'no debit');
  assert.equal((await get('/api/data/orders', ctx.zoe)).body.orders.length, 0, 'no order');
  assert.equal((await get('/api/data/products')).body.products.find(p => p.id === ctx.autoId).stock, stockBefore, 'no key delivered');
  const ledger = (await get('/api/data/users', ctx.admin)).body.transactions.filter(t => t.userId === ctx.zoeId && t.type === 'purchase');
  assert.equal(ledger.length, 0, 'no purchase transaction');
});

test('the customer is not told about the suspension and keeps the session after logout / login', async () => {
  const u = await me(ctx.zoe);
  assert.equal(u.purchasesSuspended, undefined, 'not exposed to the customer');
  const login = await post('/api/auth/login', { identifier: 'zoe@example.com', password: 'Client-Pass-12' });
  assert.equal(login.status, 200, 'login still works');
  ctx.zoe = login.body.session.token;
  const r = await post('/api/data/orders', { productId: ctx.autoId, quantity: 1 }, ctx.zoe);
  assert.equal(r.body.code, 'PURCHASES_UNAVAILABLE', 'suspension survives a new login');
});

test('5-6. suspended customer can still top up by Mobile Money and is credited after confirmation', async () => {
  const c = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'orange_cm', phone: '699123440' }, ctx.zoe);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  payments.get(c.body.providerTxId).status = 'SUCCESS';
  const v = await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.zoe);
  assert.equal(v.body.status, 'completed');
  assert.equal((await me(ctx.zoe)).balance, 35, 'wallet credited normally');
  const hist = await get('/api/payments/transactions', ctx.zoe);
  assert.equal(hist.status, 200, 'history visible');
  assert.ok(hist.body.transactions.some(t => t.id === c.body.transactionId && t.status === 'completed'));

  // Top-up started from a product: the payment is credited, the automatic order is refused with the same message
  const c2 = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'orange_cm', phone: '699123440', purchase: { productId: ctx.autoId, quantity: 1 } }, ctx.zoe);
  assert.equal(c2.status, 201);
  payments.get(c2.body.providerTxId).status = 'SUCCESS';
  const v2 = await get('/api/payments/saspay/verify?transactionId=' + c2.body.transactionId, ctx.zoe);
  assert.equal(v2.body.status, 'completed');
  assert.equal(v2.body.order, null);
  assert.equal(v2.body.orderError, MESSAGE);
  assert.equal((await me(ctx.zoe)).balance, 40, 'credited, nothing debited');
  assert.equal((await get('/api/data/orders', ctx.zoe)).body.orders.length, 0);
});

test('7. the other customers keep buying normally', async () => {
  const r = await post('/api/data/orders', { productId: ctx.autoId, quantity: 1 }, ctx.yan);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.newBalance, 26);
  assert.match(JSON.stringify(r.body.order.vaultContent), /K-/);
});

test('8-9. administrator reactivates the purchases: the customer buys again normally', async () => {
  const r = await post('/api/data/users', { userId: ctx.zoeId, action: 'resume_purchases' }, ctx.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.purchasesSuspended, false);
  const o = await post('/api/data/orders', { productId: ctx.autoId, quantity: 1 }, ctx.zoe);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(o.body.newBalance, 36);
  const m = await post('/api/data/orders', { productId: ctx.manualId, quantity: 1 }, ctx.zoe);
  assert.equal(m.status, 201);
  assert.equal((await get('/api/data/orders', ctx.zoe)).body.orders.length, 2);
});

test('suspend again then resume: switch works repeatedly, existing balance adjustments unaffected', async () => {
  assert.equal((await post('/api/data/users', { userId: ctx.yanId, action: 'suspend_purchases' }, ctx.admin)).body.user.purchasesSuspended, true);
  const gift = await post('/api/data/users', { userId: ctx.yanId, amount: 10, action: 'gift', reason: 'test' }, ctx.admin);
  assert.equal(gift.status, 200, 'balance gifts still work for a suspended customer');
  assert.equal((await post('/api/data/orders', { productId: ctx.autoId, quantity: 1 }, ctx.yan)).body.code, 'PURCHASES_UNAVAILABLE');
  assert.equal((await post('/api/data/users', { userId: ctx.yanId, action: 'resume_purchases' }, ctx.admin)).body.user.purchasesSuspended, false);
  assert.equal((await post('/api/data/orders', { productId: ctx.autoId, quantity: 1 }, ctx.yan)).status, 201);
});
