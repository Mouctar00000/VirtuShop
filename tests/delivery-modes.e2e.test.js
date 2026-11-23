/**
 * GetVirtu — configurable delivery per product, end-to-end tests:
 * instant (unchanged), WhatsApp (unchanged), delayed-then-manual, manual by the administrator, manual stock.
 * Real HTTP server + isolated temporary database + local SasPay double. No real payment.
 * Run: node --test tests/delivery-modes.e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-delivery-'));
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

// ---- minimal SasPay double
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

let server, base, db;
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
const put = (u, b, t) => call('PUT', u, b, t);
const me = async t => (await get('/api/auth/me', t)).body.user;
const myOrder = async (t, id) => (await get('/api/data/orders', t)).body.orders.find(o => o.id === id);
const ctx = {};
const SECRET_RE = /SECRET-|ACC-|K-INST/;

/** Test-only time travel: ends the waiting period of an order in the committed state (no production hook). */
function endWaitingPeriod(orderId) {
  const o = db.store.committed.orders.find(x => x.id === orderId);
  o.delivery.eligibleAt = new Date(Date.now() - 1000).toISOString();
}
async function buy(token, productId, extra = {}) {
  return post('/api/data/orders', Object.assign({ productId, quantity: 1 }, extra), token);
}

test.before(async () => {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  process.env.SASPAY_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/api/v1`;
  server = require('../server');
  db = require('../backend/db');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.admin = (await post('/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD })).body.session.token;
  for (const k of ['ana', 'bob']) {
    const r = await post('/api/auth/register', { email: k + '@example.com', password: 'Client-Pass-12', confirmPassword: 'Client-Pass-12', name: k });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ctx[k] = r.body.session.token;
    ctx[k + 'Id'] = r.body.user.id;
    await post('/api/data/users', { userId: r.body.user.id, amount: 200, action: 'gift', reason: 'test' }, ctx.admin);
  }
  ctx.instantId = (await post('/api/data/products', { name: 'Gmail USA Instant', price: 3, newKeys: ['K-INST-1', 'K-INST-2', 'K-INST-3'] }, ctx.admin)).body.product.id;
  ctx.waId = (await post('/api/data/products', { name: 'Gmail Europe WhatsApp', price: 4, deliveryMode: 'manual', stock: 5 }, ctx.admin)).body.product.id;
});
test.after(() => { server.close(); mockServer.close(); });

test('1. instant delivery works exactly as before (keys delivered immediately)', async () => {
  const r = await buy(ctx.ana, ctx.instantId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'Complété');
  assert.match(r.body.order.vaultContent.content, /K-INST-/);
  assert.equal(r.body.order.delivery.method, 'instant');
  assert.equal(r.body.order.delivery.status, 'delivered');
  assert.equal(r.body.order.contentLocked, undefined);
});

test('2. WhatsApp delivery works exactly as before', async () => {
  const r = await buy(ctx.ana, ctx.waId);
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, 'En attente');
  assert.equal(r.body.order.deliveryMode, 'manual');
  assert.equal(r.body.order.delivery.method, 'whatsapp');
  const d = await put('/api/data/orders', { id: r.body.order.id, action: 'deliver', vaultContent: { type: 'text', content: 'SECRET-WA-1' } }, ctx.admin);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await myOrder(ctx.ana, r.body.order.id)).vaultContent.content, 'SECRET-WA-1');
});

test('product configuration: delayed (default 15 min), custom 2 h, manual by admin; invalid values refused', async () => {
  const p15 = await post('/api/data/products', { name: 'YouTube Premium', price: 5, deliveryMode: 'manual', deliveryTiming: 'delayed', stock: 10 }, ctx.admin);
  assert.equal(p15.status, 200, JSON.stringify(p15.body));
  assert.equal(p15.body.product.deliveryTiming, 'delayed');
  assert.equal(p15.body.product.deliveryDelayMinutes, 15, 'default 15 minutes');
  ctx.delayedId = p15.body.product.id;
  const p2h = await post('/api/data/products', { name: 'Netflix 2h', price: 5, deliveryMode: 'manual', deliveryTiming: 'delayed', deliveryDelayMinutes: 120, stock: 10 }, ctx.admin);
  assert.equal(p2h.body.product.deliveryDelayMinutes, 120);
  ctx.delayed2hId = p2h.body.product.id;
  const pa = await post('/api/data/products', { name: 'CapCut Pro Admin', price: 6, deliveryMode: 'manual', deliveryTiming: 'admin_release', stock: 10 }, ctx.admin);
  assert.equal(pa.body.product.deliveryTiming, 'admin_release');
  ctx.adminRelId = pa.body.product.id;
  for (const bad of [0, -5, 1.5, 'abc', 43201]) {
    const r = await post('/api/data/products', { id: ctx.delayedId, name: 'YouTube Premium', deliveryMode: 'manual', deliveryTiming: 'delayed', deliveryDelayMinutes: bad }, ctx.admin);
    assert.equal(r.status, 400, 'delay ' + bad + ' refused');
  }
  assert.equal((await post('/api/data/products', { id: ctx.delayedId, name: 'YouTube Premium', deliveryTiming: 'teleport' }, ctx.admin)).status, 400);
  const pub = (await get('/api/data/products')).body.products.find(p => p.id === ctx.delayedId);
  assert.equal(pub.deliveryTiming, 'delayed');
  assert.equal(pub.deliveryDelayMinutes, 15);
  assert.equal((await post('/api/data/products', { name: 'Hack', price: 1, deliveryMode: 'manual', deliveryTiming: 'delayed' }, ctx.ana)).status, 403, 'customers cannot configure');
});

test('3-5. delayed 15 min: order paid, waiting period from payment time, nothing accessible', async () => {
  const before = Date.now();
  const r = await buy(ctx.ana, ctx.delayedId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = r.body.order;
  ctx.delayedOrder = o.id;
  assert.equal(o.status, 'En attente');
  assert.equal(o.delivery.method, 'delayed');
  assert.equal(o.delivery.delaySeconds, 900);
  assert.equal(o.delivery.phase, 'waiting');
  const wait = Date.parse(o.delivery.eligibleAt) - Date.parse(o.delivery.paymentConfirmedAt);
  assert.equal(wait, 15 * 60000, 'eligibleAt = payment confirmation + 15 min');
  assert.ok(Date.parse(o.delivery.paymentConfirmedAt) >= before - 1000);
  assert.ok(o.delivery.remainingSeconds > 890 && o.delivery.remainingSeconds <= 900);
  assert.equal(o.vaultContent, null);
  assert.equal(o.contentLocked, true);
  assert.equal((await me(ctx.ana)).balance, 200 - 3 - 4 - 5, 'paid normally');
  // 4. other duration
  const r2 = await buy(ctx.ana, ctx.delayed2hId);
  assert.equal(Date.parse(r2.body.order.delivery.eligibleAt) - Date.parse(r2.body.order.delivery.paymentConfirmedAt), 120 * 60000);
  ctx.delayed2hOrder = r2.body.order.id;
});

test('6. the administrator cannot deliver before the end of the waiting period (server clock)', async () => {
  const r = await put('/api/data/orders', { id: ctx.delayedOrder, action: 'deliver', vaultContent: { type: 'text', content: 'SECRET-EARLY' } }, ctx.admin);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'DELIVERY_WAITING');
  const o = await myOrder(ctx.ana, ctx.delayedOrder);
  assert.equal(o.vaultContent, null);
  assert.doesNotMatch(JSON.stringify(o), SECRET_RE);
});

test('7-8. refresh and logout/login never restart the timer', async () => {
  const first = (await myOrder(ctx.ana, ctx.delayedOrder)).delivery.eligibleAt;
  const login = await post('/api/auth/login', { identifier: 'ana@example.com', password: 'Client-Pass-12' });
  assert.equal(login.status, 200);
  ctx.ana = login.body.session.token;
  for (let i = 0; i < 3; i++) assert.equal((await myOrder(ctx.ana, ctx.delayedOrder)).delivery.eligibleAt, first);
});

test('countdown expiry never reveals anything: order becomes "to deliver" for the administrator only', async () => {
  endWaitingPeriod(ctx.delayedOrder);
  const o = await myOrder(ctx.ana, ctx.delayedOrder);
  assert.equal(o.delivery.phase, 'awaiting_delivery');
  assert.equal(o.status, 'En attente');
  assert.equal(o.vaultContent, null, 'still nothing for the customer');
  const adminView = (await get('/api/data/orders', ctx.admin)).body.orders.find(x => x.id === ctx.delayedOrder);
  assert.equal(adminView.status, 'En attente');
});

test('9-10. tampering: customers cannot deliver, read others\' orders, the manual stock or the files', async () => {
  assert.equal((await put('/api/data/orders', { id: ctx.delayedOrder, action: 'deliver', vaultContent: { content: 'x' } }, ctx.ana)).status, 403);
  assert.equal((await put('/api/data/orders', { id: ctx.delayedOrder, action: 'deliver', vaultContent: { content: 'x' } })).status, 403);
  assert.ok(!(await get('/api/data/orders', ctx.bob)).body.orders.some(o => o.id === ctx.delayedOrder), "not in another customer's list");
  assert.equal((await get('/api/data/download?orderId=' + ctx.delayedOrder, ctx.bob)).status, 404);
  assert.equal((await get('/api/data/download?orderId=' + ctx.delayedOrder, ctx.ana)).status, 404);
  assert.equal((await get('/api/data/manual-stock?productId=' + ctx.delayedId, ctx.ana)).status, 403);
  assert.equal((await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'add', items: 'x' }, ctx.ana)).status, 403);
  assert.equal((await get('/api/data/manual-stock?productId=' + ctx.delayedId)).status, 403);
});

test('manual stock: added items are never distributed automatically; one item can never serve two orders', async () => {
  const add = await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'add', items: 'ACC-1 | pass1\nACC-2 | pass2\n\nACC-3 | pass3' }, ctx.admin);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.added, 3);
  assert.equal(add.body.counts.available, 3);
  ctx.items = add.body.items.map(i => i.id);
  // a purchase never takes a stock item
  const r = await buy(ctx.bob, ctx.delayedId);
  ctx.delayedOrderBob = r.body.order.id;
  const st = (await get('/api/data/manual-stock?productId=' + ctx.delayedId, ctx.admin)).body;
  assert.equal(st.counts.available, 3, 'nothing assigned automatically');
  assert.doesNotMatch(JSON.stringify((await get('/api/data/products')).body), /ACC-/, 'stock never in the public catalogue');
  assert.doesNotMatch(JSON.stringify(await myOrder(ctx.bob, ctx.delayedOrderBob)), /ACC-/);
  // reserve / edit / delete an available item
  const res = await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'update', itemId: ctx.items[2], status: 'reserved' }, ctx.admin);
  assert.equal(res.body.counts.reserved, 1);
  const ed = await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'update', itemId: ctx.items[1], content: 'ACC-2 | pass2-new' }, ctx.admin);
  assert.equal(ed.body.item.content, 'ACC-2 | pass2-new');
  assert.equal((await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'update', itemId: ctx.items[0], status: 'assigned' }, ctx.admin)).status, 400, 'assignment only through a delivery');
});

test('11-12. delivery after the waiting period: stock item + extra fields + private note, then visible to the customer', async () => {
  const d = await put('/api/data/orders', {
    id: ctx.delayedOrder, action: 'deliver', vaultContent: { type: 'text', content: 'Instructions : changez le mot de passe' },
    stockItemIds: [ctx.items[0]], adminNote: 'NOTE-PRIVEE fournisseur X'
  }, ctx.admin);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const o = await myOrder(ctx.ana, ctx.delayedOrder);
  assert.equal(o.status, 'Complété');
  assert.equal(o.delivery.status, 'delivered');
  assert.equal(o.delivery.phase, 'delivered');
  assert.ok(o.delivery.deliveredAt);
  assert.equal(o.vaultContent.content, 'ACC-1 | pass1\n\nInstructions : changez le mot de passe');
  assert.doesNotMatch(JSON.stringify(o), /NOTE-PRIVEE|deliveredBy|stockItemIds/, 'private admin data never sent to the customer');
  const st = (await get('/api/data/manual-stock?productId=' + ctx.delayedId, ctx.admin)).body;
  const it = st.items.find(i => i.id === ctx.items[0]);
  assert.equal(it.status, 'assigned');
  assert.equal(it.orderId, ctx.delayedOrder);
  assert.equal(st.counts.available, 1);
  // the same item can never be given to another order
  endWaitingPeriod(ctx.delayedOrderBob);
  const dup = await put('/api/data/orders', { id: ctx.delayedOrderBob, action: 'deliver', vaultContent: { content: '' }, stockItemIds: [ctx.items[0]] }, ctx.admin);
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.equal(dup.body.code, 'STOCK_ITEM_TAKEN');
  assert.equal((await myOrder(ctx.bob, ctx.delayedOrderBob)).vaultContent, null, 'nothing delivered on refusal');
  assert.equal((await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'update', itemId: ctx.items[0], content: 'x' }, ctx.admin)).status, 409);
  assert.equal((await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'delete', itemId: ctx.items[0] }, ctx.admin)).status, 409);
  // new credentials typed directly (no stock)
  const typed = await put('/api/data/orders', { id: ctx.delayedOrderBob, action: 'deliver', vaultContent: { type: 'text', content: 'Email : new@x.com\nMot de passe : SECRET-NEW' } }, ctx.admin);
  assert.equal(typed.status, 200);
  assert.match((await myOrder(ctx.bob, ctx.delayedOrderBob)).vaultContent.content, /SECRET-NEW/);
  assert.equal((await get('/api/data/manual-stock?productId=' + ctx.delayedId, ctx.admin)).body.counts.available, 1, 'stock untouched');
  // deleting an available item
  const del = await post('/api/data/manual-stock', { productId: ctx.delayedId, action: 'delete', itemId: ctx.items[1] }, ctx.admin);
  assert.equal(del.status, 200);
  assert.equal(del.body.counts.total, 2);
});

test('manual by the administrator: no waiting period, inaccessible until delivered', async () => {
  const r = await buy(ctx.bob, ctx.adminRelId);
  const o = r.body.order;
  assert.equal(o.delivery.method, 'admin_release');
  assert.equal(o.delivery.phase, 'awaiting_delivery');
  assert.equal(o.vaultContent, null);
  const d = await put('/api/data/orders', { id: o.id, action: 'deliver', vaultContent: { type: 'text', content: 'SECRET-CAPCUT' } }, ctx.admin);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await myOrder(ctx.bob, o.id)).vaultContent.content, 'SECRET-CAPCUT');
});

test('delivery issue: flagged by the administrator only, invisible to the customer', async () => {
  const r = await put('/api/data/orders', { id: ctx.delayed2hOrder, action: 'delivery_issue', issue: true, note: 'ISSUE-NOTE compte bloqué' }, ctx.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.delivery.issue.note, 'ISSUE-NOTE compte bloqué');
  assert.doesNotMatch(JSON.stringify(await myOrder(ctx.ana, ctx.delayed2hOrder)), /ISSUE-NOTE/);
  assert.equal((await put('/api/data/orders', { id: ctx.delayed2hOrder, action: 'delivery_issue', issue: true }, ctx.ana)).status, 403);
});

test('13-14. changing a product affects future orders only', async () => {
  const before = (await myOrder(ctx.ana, ctx.delayed2hOrder)).delivery;
  await post('/api/data/products', { id: ctx.delayed2hId, name: 'Netflix 2h', deliveryMode: 'manual', deliveryTiming: 'delayed', deliveryDelayMinutes: 5 }, ctx.admin);
  const after = (await myOrder(ctx.ana, ctx.delayed2hOrder)).delivery;
  assert.equal(after.eligibleAt, before.eligibleAt, 'existing order keeps 2 h');
  assert.equal(after.delaySeconds, 7200);
  const n = await buy(ctx.ana, ctx.delayed2hId);
  assert.equal(n.body.order.delivery.delaySeconds, 300, 'new order uses 5 min');
  // switching the product to WhatsApp does not change the existing delayed order either
  await post('/api/data/products', { id: ctx.delayed2hId, name: 'Netflix 2h', deliveryMode: 'manual', deliveryTiming: 'whatsapp' }, ctx.admin);
  assert.equal((await myOrder(ctx.ana, n.body.order.id)).delivery.method, 'delayed');
  assert.equal((await buy(ctx.ana, ctx.delayed2hId)).body.order.delivery.method, 'whatsapp');
});

test('15-16. Mobile Money: confirmed payment creates ONE order even if verified twice; failed payment never creates one', async () => {
  const c = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'orange_cm', phone: '699123450', purchase: { productId: ctx.delayedId, quantity: 1 } }, ctx.bob);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  payments.get(c.body.providerTxId).status = 'SUCCESS';
  const v1 = await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.bob);
  const v2 = await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.bob);
  assert.equal(v1.body.status, 'completed');
  assert.ok(v1.body.order, JSON.stringify(v1.body));
  assert.equal(v1.body.order.id, v2.body.order.id, 'same order');
  assert.equal(v1.body.order.delivery.method, 'delayed');
  assert.equal(v1.body.order.vaultContent, null);
  const count = (await get('/api/data/orders', ctx.bob)).body.orders.filter(o => o.id === v1.body.order.id).length;
  assert.equal(count, 1);
  const ordersBefore = (await get('/api/data/orders', ctx.bob)).body.orders.length;
  const f = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'orange_cm', phone: '699123450', purchase: { productId: ctx.delayedId, quantity: 1 } }, ctx.bob);
  payments.get(f.body.providerTxId).status = 'FAILED';
  await get('/api/payments/saspay/verify?transactionId=' + f.body.transactionId, ctx.bob);
  assert.equal((await get('/api/data/orders', ctx.bob)).body.orders.length, ordersBefore, 'no order for a failed payment');
});

test('cancel a paid order awaiting delivery: refunded once, declared stock restored, history kept', async () => {
  const r = await buy(ctx.bob, ctx.adminRelId);
  const stockBefore = (await get('/api/data/products')).body.products.find(p => p.id === ctx.adminRelId).stock;
  const bal = (await me(ctx.bob)).balance;
  const c = await put('/api/data/orders', { id: r.body.order.id, action: 'cancel', reason: 'test' }, ctx.admin);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await me(ctx.bob)).balance, bal + 6);
  assert.equal((await get('/api/data/products')).body.products.find(p => p.id === ctx.adminRelId).stock, stockBefore + 1);
  const o = await myOrder(ctx.bob, r.body.order.id);
  assert.equal(o.status, 'Annulé');
  assert.equal(o.delivery.phase, 'cancelled');
  assert.equal((await put('/api/data/orders', { id: r.body.order.id, action: 'deliver', vaultContent: { content: 'x' } }, ctx.admin)).status, 409);
});
