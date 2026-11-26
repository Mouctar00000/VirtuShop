/**
 * GetVirtu — administrator control, statistics, activity log, account suspension, financial integrity and
 * extra payment scenarios. Real HTTP server + isolated temporary database + local SasPay double. No real payment.
 * Run: node --test tests/admin-control.e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-admin-'));
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

// ---- SasPay double (documented envelope { success, data | error, code })
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
    if (req.method === 'GET' && (m = p.match(/^transactions\/([^/]+)\/$/))) {
      const pay = payments.get(m[1]);
      return pay ? send(200, { success: true, data: { ...pay, status_logs: pay.status === 'CANCELLED' ? [{ to_status: 'CANCELLED', reason: 'Cancelled by user' }] : [] }, code: 200 }) : send(404, { success: false, error: { message: 'introuvable' }, code: 404 });
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
const del = (u, b, t) => call('DELETE', u, b, t);
const me = async t => (await get('/api/auth/me', t)).body.user;
const ctx = {};
const auditOf = async (q) => (await get('/api/data/audit?' + q, ctx.admin)).body;
const todayLocal = (tz) => new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);

async function register(key) {
  const r = await post('/api/auth/register', { email: key + '@example.com', password: 'Client-Pass-12', confirmPassword: 'Client-Pass-12', name: key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ctx[key] = r.body.session.token;
  ctx[key + 'Id'] = r.body.user.id;
}

test.before(async () => {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  process.env.SASPAY_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/api/v1`;
  server = require('../server');
  db = require('../backend/db');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.admin = (await post('/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD })).body.session.token;
  for (const k of ['ana', 'bob', 'cleo']) await register(k);
});
test.after(() => { server.close(); mockServer.close(); });

// ============================================================ catalogue ordering
test('out-of-stock products always come last in the public catalogue and climb back when restocked', async () => {
  const mk = async (name, keys) => (await post('/api/data/products', { name, price: 2, newKeys: keys }, ctx.admin)).body.product.id;
  ctx.pA = await mk('Produit A (rupture)', []);
  ctx.pB = await mk('Produit B', ['B-1', 'B-2']);
  ctx.pC = await mk('Produit C', ['C-1']);
  const order = async () => (await get('/api/data/products')).body.products.map(p => p.id);
  assert.deepEqual(await order(), [ctx.pB, ctx.pC, ctx.pA], 'A (stock 0) moved after the available products');
  assert.equal((await get('/api/data/products')).body.products.find(p => p.id === ctx.pA).available, false);
  // purchase of the last unit of C: C goes to the bottom too (stable order kept)
  await post('/api/data/users', { userId: ctx.anaId, amount: 100, action: 'gift', reason: 'test' }, ctx.admin);
  const buy = await post('/api/data/orders', { productId: ctx.pC, quantity: 1 }, ctx.ana);
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  assert.deepEqual(await order(), [ctx.pB, ctx.pA, ctx.pC]);
  // restock A: it climbs back to its normal rank
  await post('/api/data/keys', { productId: ctx.pA, keys: ['A-1'] }, ctx.admin);
  assert.deepEqual(await order(), [ctx.pA, ctx.pB, ctx.pC]);
  // a sold-out product cannot be bought
  const refused = await post('/api/data/orders', { productId: ctx.pC, quantity: 1 }, ctx.ana);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'INSUFFICIENT_STOCK');
});

// ============================================================ purchase cost & privacy
test('purchase cost: administrator only, never in the catalogue nor in the customer order', async () => {
  const p = await post('/api/data/products', { id: ctx.pB, name: 'Produit B', costPrice: 0.5 }, ctx.admin);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.product.costPrice, 0.5);
  assert.equal((await post('/api/data/products', { id: ctx.pB, name: 'Produit B', costPrice: -1 }, ctx.admin)).status, 400);
  assert.equal((await post('/api/data/products', { id: ctx.pB, name: 'Produit B', costPrice: 'abc' }, ctx.admin)).status, 400);
  assert.doesNotMatch(JSON.stringify((await get('/api/data/products')).body), /costPrice/);
  const r = await post('/api/data/orders', { productId: ctx.pB, quantity: 1 }, ctx.ana);
  assert.equal(r.status, 201);
  ctx.orderB1 = r.body.order.id;
  assert.equal(r.body.order.unitCost, undefined, 'cost hidden from the customer');
  assert.equal(r.body.order.history, undefined);
  const adminOrder = (await get('/api/data/orders', ctx.admin)).body.orders.find(o => o.id === ctx.orderB1);
  assert.equal(adminOrder.unitCost, 0.5, 'cost frozen on the order for the statistics');
  assert.ok(adminOrder.ledgerTransactionId, 'payment (ledger) reference kept on the order');
});

// ============================================================ activity log
test('activity log: every administrator change is recorded with who / when / what, readable by administrators only', async () => {
  const pr = await post('/api/data/products', { id: ctx.pB, name: 'Produit B', price: 3 }, ctx.admin);
  assert.equal(pr.status, 200);
  const upd = await auditOf('targetType=product&targetId=' + ctx.pB);
  const priceEntry = upd.entries.find(e => e.action === 'product.updated' && /prix 2\.00 \$ → 3\.00 \$/.test(e.summary));
  assert.ok(priceEntry, JSON.stringify(upd.entries.map(e => e.summary)));
  assert.equal(priceEntry.actorEmail, 'admin@getvirtu.shop');
  assert.ok(Date.parse(priceEntry.at) > Date.now() - 60000, 'timestamp');
  assert.deepEqual(priceEntry.details.changes.price, { before: 2, after: 3 });
  // keys, wallet, settings, customer purchase suspension
  await post('/api/data/keys', { productId: ctx.pB, keys: ['B-3', 'B-4'] }, ctx.admin);
  await post('/api/data/users', { userId: ctx.bobId, amount: 7, action: 'gift', reason: 'geste commercial' }, ctx.admin);
  await post('/api/data/settings', { min_recharge: 6 }, ctx.admin);
  await post('/api/data/users', { userId: ctx.cleoId, action: 'suspend_purchases' }, ctx.admin);
  await post('/api/data/users', { userId: ctx.cleoId, action: 'resume_purchases' }, ctx.admin);
  const all = await auditOf('limit=200');
  const actions = all.entries.map(e => e.action);
  for (const a of ['product.created', 'product.updated', 'keys.added', 'wallet.adjusted', 'settings.updated', 'customer.purchases_suspended', 'customer.purchases_resumed', 'admin.login']) {
    assert.ok(actions.includes(a), a + ' missing in ' + actions.join(','));
  }
  const wallet = all.entries.find(e => e.action === 'wallet.adjusted' && e.targetId === ctx.bobId);
  assert.match(wallet.summary, /0\.00 \$ → 7\.00 \$/);
  assert.equal(wallet.details.reason, 'geste commercial');
  // newest first, filters work
  assert.ok(Date.parse(all.entries[0].at) >= Date.parse(all.entries[all.entries.length - 1].at));
  assert.ok((await auditOf('action=customer')).entries.every(e => e.action.startsWith('customer.')));
  assert.ok((await auditOf('q=geste')).entries.length >= 1);
  // read-only for administrators, invisible to customers and anonymous visitors
  assert.equal((await get('/api/data/audit', ctx.ana)).status, 403);
  assert.equal((await get('/api/data/audit')).status, 403);
  assert.equal((await del('/api/data/audit', {}, ctx.admin)).status, 404, 'no API can delete the log');
  assert.equal((await put('/api/data/audit', {}, ctx.admin)).status, 404, 'no API can modify the log');
  // failed administrator login attempts are kept
  assert.equal((await post('/api/auth/login', { identifier: 'admin@getvirtu.shop', password: 'wrong-password-1' })).status, 401);
  assert.ok((await auditOf('action=admin.login_failed')).entries.length >= 1);
  // the log file is append-only JSON lines
  const lines = fs.readFileSync(path.join(TMP, 'audit-log.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= all.total);
});

// ============================================================ customers: account suspension & profile
test('account suspension: login and sessions refused, balance and orders kept, reactivation restores access', async () => {
  const balBefore = (await me(ctx.ana)).balance;
  const s = await post('/api/data/users', { userId: ctx.anaId, action: 'suspend_account', reason: 'fraude suspectée' }, ctx.admin);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.user.accountSuspended, true);
  assert.equal((await get('/api/auth/me', ctx.ana)).status, 401, 'open session closed');
  const login = await post('/api/auth/login', { identifier: 'ana@example.com', password: 'Client-Pass-12' });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'ACCOUNT_SUSPENDED');
  const wrong = await post('/api/auth/login', { identifier: 'ana@example.com', password: 'Wrong-Pass-99' });
  assert.equal(wrong.status, 401, 'suspension never revealed without the right password');
  assert.equal((await post('/api/data/users', { userId: 'admin-001', action: 'suspend_account' }, ctx.admin)).status, 400, 'administrators cannot be suspended');
  assert.equal((await post('/api/data/users', { userId: ctx.bobId, action: 'suspend_account' }, ctx.ana)).status, 403);
  const users = (await get('/api/data/users', ctx.admin)).body.users;
  const ana = users.find(u => u.id === ctx.anaId);
  assert.equal(ana.accountSuspended, true);
  assert.equal(ana.accountSuspensionReason, 'fraude suspectée');
  assert.equal(ana.balance, balBefore, 'balance untouched');
  // reactivation
  assert.equal((await post('/api/data/users', { userId: ctx.anaId, action: 'reactivate_account' }, ctx.admin)).status, 200);
  const relog = await post('/api/auth/login', { identifier: 'ana@example.com', password: 'Client-Pass-12' });
  assert.equal(relog.status, 200);
  ctx.ana = relog.body.session.token;
  assert.equal((await me(ctx.ana)).balance, balBefore);
  assert.equal((await me(ctx.ana)).accountSuspended, undefined, 'never sent to the customer');
  const log = await auditOf('targetType=customer&targetId=' + ctx.anaId);
  assert.ok(log.entries.some(e => e.action === 'customer.account_suspended' && /fraude suspectée/.test(e.summary)));
  assert.ok(log.entries.some(e => e.action === 'customer.account_reactivated'));
});

test('administrator edits a customer profile (name, e-mail) with validation', async () => {
  const r = await post('/api/data/users', { userId: ctx.cleoId, action: 'update_profile', name: 'Cléo Martin', email: 'cleo.martin@example.com' }, ctx.admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email, 'cleo.martin@example.com');
  assert.equal((await post('/api/auth/login', { identifier: 'cleo.martin@example.com', password: 'Client-Pass-12' })).status, 200);
  assert.equal((await post('/api/data/users', { userId: ctx.cleoId, action: 'update_profile', email: 'bob@example.com' }, ctx.admin)).status, 409);
  assert.equal((await post('/api/data/users', { userId: ctx.cleoId, action: 'update_profile', email: 'pas-un-email' }, ctx.admin)).status, 400);
  assert.equal((await post('/api/data/users', { userId: ctx.cleoId, action: 'update_profile', name: 'x' }, ctx.admin)).status, 400);
  const e = (await auditOf('action=customer.updated')).entries[0];
  assert.deepEqual(e.details.before, { name: 'cleo', email: 'cleo@example.com' });
});

// ============================================================ financial integrity
test('financial records: confirmed transactions and paid orders cannot be deleted; deletions keep a full copy', async () => {
  const txs = (await get('/api/data/transactions', ctx.admin)).body.transactions;
  const completed = txs.find(t => t.status === 'completed');
  const r1 = await del('/api/data/transactions', { id: completed.id }, ctx.admin);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'TX_PROTECTED');
  // pending top-up: must be verified / rejected first
  const c = await post('/api/payments/saspay/create', { amount: 10, country: 'CM', network: 'orange_cm', phone: '699123450' }, ctx.bob);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r2 = await del('/api/data/transactions', { id: c.body.transactionId }, ctx.admin);
  assert.equal(r2.body.code, 'TX_PENDING');
  // rejected by the administrator -> can be deleted, copy kept in the log
  assert.equal((await post('/api/payments/verify', { transactionId: c.body.transactionId, isApproval: false, failureReason: 'test' }, ctx.admin)).status, 200);
  const r3 = await del('/api/data/transactions', { id: c.body.transactionId }, ctx.admin);
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  const tLog = (await auditOf('action=transaction.deleted')).entries[0];
  assert.equal(tLog.details.id, c.body.transactionId);
  assert.equal(tLog.details.amount, 10);
  assert.ok((await auditOf('action=deposit.rejected')).entries.some(e => e.targetId === c.body.transactionId));
  // paid order: cancel first, then delete
  const o = await post('/api/data/orders', { productId: ctx.pB, quantity: 1 }, ctx.bob);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const d1 = await del('/api/data/orders', { id: o.body.order.id }, ctx.admin);
  assert.equal(d1.status, 409);
  assert.equal(d1.body.code, 'ORDER_NOT_CANCELLED');
  const bal = (await me(ctx.bob)).balance;
  assert.equal((await put('/api/data/orders', { id: o.body.order.id, action: 'cancel', reason: 'erreur' }, ctx.admin)).status, 200);
  assert.equal((await me(ctx.bob)).balance, Math.round((bal + 3) * 100) / 100, 'refunded once');
  const d2 = await del('/api/data/orders', { id: o.body.order.id }, ctx.admin);
  assert.equal(d2.status, 200, JSON.stringify(d2.body));
  const oLog = (await auditOf('action=order.deleted')).entries[0];
  assert.equal(oLog.details.id, o.body.order.id);
  assert.ok(oLog.details.history.some(h => h.type === 'cancelled'), 'order timeline kept in the copy');
});

test('customer deletion refused while money or deliveries are owed; allowed once settled (copy kept)', async () => {
  await register('dan');
  await post('/api/data/users', { userId: ctx.danId, amount: 5, action: 'gift', reason: 'test' }, ctx.admin);
  const r1 = await del('/api/data/users', { id: ctx.danId }, ctx.admin);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'BALANCE_NOT_ZERO');
  const wa = (await post('/api/data/products', { name: 'Service WhatsApp', price: 5, deliveryMode: 'manual', stock: 3 }, ctx.admin)).body.product.id;
  const o = await post('/api/data/orders', { productId: wa, quantity: 1 }, ctx.dan);
  assert.equal(o.status, 201);
  const r2 = await del('/api/data/users', { id: ctx.danId }, ctx.admin);
  assert.equal(r2.body.code, 'PENDING_ORDERS');
  await put('/api/data/orders', { id: o.body.order.id, action: 'deliver', vaultContent: { type: 'text', content: 'ACCES-DAN' } }, ctx.admin);
  const r3 = await del('/api/data/users', { id: ctx.danId }, ctx.admin);
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  const log = (await auditOf('action=customer.deleted')).entries[0];
  assert.equal(log.details.email, 'dan@example.com');
  assert.equal(log.details.password_hash, undefined, 'no password hash in the log');
  assert.equal((await post('/api/auth/login', { identifier: 'dan@example.com', password: 'Client-Pass-12' })).status, 401);
});

test('order private note and timeline: administrator only', async () => {
  const n = await put('/api/data/orders', { id: ctx.orderB1, action: 'update_note', adminNote: 'NOTE-INTERNE fournisseur' }, ctx.admin);
  assert.equal(n.status, 200, JSON.stringify(n.body));
  assert.equal(n.body.order.adminNote, 'NOTE-INTERNE fournisseur');
  assert.ok(n.body.order.history.some(h => h.type === 'note_updated'));
  const mine = (await get('/api/data/orders', ctx.ana)).body.orders.find(o => o.id === ctx.orderB1);
  assert.doesNotMatch(JSON.stringify(mine), /NOTE-INTERNE|history|unitCost|ledgerTransactionId/);
  assert.equal((await put('/api/data/orders', { id: ctx.orderB1, action: 'update_note', adminNote: 'x' }, ctx.ana)).status, 403);
});

// ============================================================ extra payment scenarios
test('payments: cancelled at the operator -> failed, never credited', async () => {
  const bal = (await me(ctx.cleo)).balance;
  const c = await post('/api/payments/saspay/create', { amount: 8, country: 'CM', network: 'orange_cm', phone: '699123451' }, ctx.cleo);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  payments.get(c.body.providerTxId).status = 'CANCELLED';
  const v = await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.cleo);
  assert.equal(v.body.status, 'failed', JSON.stringify(v.body));
  assert.equal((await me(ctx.cleo)).balance, bal);
  // a later "success" notification for a closed payment is re-checked with SasPay, which still says CANCELLED
  await post('/api/payments/webhook', { event: 'transaction.success', data: { id: c.body.providerTxId, status: 'SUCCESS' } });
  assert.equal((await me(ctx.cleo)).balance, bal, 'forged / late success never credits a cancelled payment');
});

test('payments: wrong currency at the provider -> never credited automatically', async () => {
  const bal = (await me(ctx.cleo)).balance;
  const c = await post('/api/payments/saspay/create', { amount: 8, country: 'CM', network: 'orange_cm', phone: '699123451' }, ctx.cleo);
  Object.assign(payments.get(c.body.providerTxId), { status: 'SUCCESS', currency: 'EUR' });
  const v = await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.cleo);
  assert.equal(v.body.status, 'pending', JSON.stringify(v.body));
  assert.match(v.body.message, /vérification manuelle/);
  assert.equal((await me(ctx.cleo)).balance, bal);
});

test('payments: delayed webhook credits once; duplicate webhooks and webhook after manual approval never double-credit', async () => {
  const bal = (await me(ctx.cleo)).balance;
  const c = await post('/api/payments/saspay/create', { amount: 9, country: 'CM', network: 'orange_cm', phone: '699123451' }, ctx.cleo);
  // still pending at the operator: nothing credited
  assert.equal((await get('/api/payments/saspay/verify?transactionId=' + c.body.transactionId, ctx.cleo)).body.status, 'pending');
  assert.equal((await me(ctx.cleo)).balance, bal);
  // confirmed much later: the (delayed) webhook triggers the server-to-server check
  payments.get(c.body.providerTxId).status = 'SUCCESS';
  const w1 = await post('/api/payments/webhook', { event: 'transaction.success', data: { id: c.body.providerTxId } });
  const w2 = await post('/api/payments/webhook', { event: 'transaction.success', data: { id: c.body.providerTxId } });
  assert.equal(w1.status, 200);
  assert.equal(w2.status, 200);
  assert.equal((await me(ctx.cleo)).balance, Math.round((bal + 9) * 100) / 100, 'credited exactly once');
  // manual approval by an administrator, then the provider confirms: still one credit only
  const bal2 = (await me(ctx.cleo)).balance;
  const c2 = await post('/api/payments/saspay/create', { amount: 7, country: 'CM', network: 'orange_cm', phone: '699123451' }, ctx.cleo);
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  const appr = await post('/api/payments/verify', { transactionId: c2.body.transactionId, isApproval: true }, ctx.admin);
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  payments.get(c2.body.providerTxId).status = 'SUCCESS';
  await post('/api/payments/webhook', { event: 'transaction.success', data: { id: c2.body.providerTxId } });
  await get('/api/payments/saspay/verify?transactionId=' + c2.body.transactionId, ctx.cleo);
  assert.equal((await me(ctx.cleo)).balance, Math.round((bal2 + 7) * 100) / 100);
  const log = (await auditOf('action=deposit.approved_manually')).entries.find(e => e.targetId === c2.body.transactionId);
  assert.ok(log, 'manual approval traced');
  assert.match(log.summary, /NON confirmé par SasPay/);
});

// ============================================================ statistics
test('statistics: real records only, exact amounts per category and date range', async () => {
  // every figure below is checked as a difference with the state before this test's activity
  const tz = -60; // administrator in UTC+1
  const before = (await get(`/api/data/stats?from=all&to=${todayLocal(tz)}&tz=${tz}`, ctx.admin)).body;
  await register('eve');
  // eve: 50 $ confirmed Mobile Money top-up, 1 failed, 1 pending
  const ok = await post('/api/payments/saspay/create', { amount: 50, country: 'CM', network: 'orange_cm', phone: '699123452' }, ctx.eve);
  payments.get(ok.body.providerTxId).status = 'SUCCESS';
  await get('/api/payments/saspay/verify?transactionId=' + ok.body.transactionId, ctx.eve);
  const ko = await post('/api/payments/saspay/create', { amount: 20, country: 'CM', network: 'orange_cm', phone: '699123452' }, ctx.eve);
  payments.get(ko.body.providerTxId).status = 'FAILED';
  await get('/api/payments/saspay/verify?transactionId=' + ko.body.transactionId, ctx.eve);
  await post('/api/payments/saspay/create', { amount: 30, country: 'CM', network: 'orange_cm', phone: '699123452' }, ctx.eve);
  // purchases: 2 units at 10 $ (cost 4 $) delivered instantly, then 1 unit ordered and cancelled (refunded)
  const prod = (await post('/api/data/products', { name: 'Produit Stats', price: 10, costPrice: 4, newKeys: ['S-1', 'S-2', 'S-3'] }, ctx.admin)).body.product.id;
  const o1 = await post('/api/data/orders', { productId: prod, quantity: 2 }, ctx.eve);
  assert.equal(o1.status, 201, JSON.stringify(o1.body));
  const o2 = await post('/api/data/orders', { productId: prod, quantity: 1 }, ctx.eve);
  await put('/api/data/orders', { id: o2.body.order.id, action: 'cancel', reason: 'test stats' }, ctx.admin);
  // administrator gift (not money received)
  await post('/api/data/users', { userId: ctx.eveId, amount: 2, action: 'gift', reason: 'stats' }, ctx.admin);
  // visits
  await post('/api/data/visitors', { vid: 'v_stats_1', isNew: true });
  await post('/api/data/visitors', { vid: 'v_stats_1', isNew: false });
  await post('/api/data/visitors', { vid: 'v_stats_2', isNew: true });

  const s = (await get(`/api/data/stats?from=all&to=${todayLocal(tz)}&tz=${tz}`, ctx.admin)).body;
  const d = (k1, k2) => Math.round(((k2 ? s[k1][k2] : s[k1]) - (k2 ? before[k1][k2] : before[k1])) * 100) / 100;
  assert.equal(d('collected', 'total'), 50, 'only the confirmed top-up counts as money received');
  assert.equal(d('collected', 'mobileMoney'), 50);
  assert.equal(d('failedPayments', 'total'), 20);
  assert.equal(d('pendingPayments', 'total'), 30, 'pending payment not counted as collected');
  assert.equal(d('sales', 'gross'), 30, 'every order placed (2x10 + 1x10)');
  assert.equal(d('sales', 'cancelled'), 10);
  assert.equal(d('sales', 'net'), 20);
  assert.equal(d('refunds', 'total'), 10);
  assert.equal(d('adminAdjustments', 'credits'), 2);
  assert.equal(d('orders', 'total'), 2);
  assert.equal(d('orders', 'cancelled'), 1);
  assert.equal(d('profit', 'amount'), 12, '(10 - 4) x 2 on the non-cancelled order');
  assert.equal(d('visitors', 'totalVisits'), 3);
  assert.equal(d('visitors', 'uniqueVisitors'), 2);
  assert.equal(d('visitors', 'newVisitors'), 2);
  assert.equal(d('customers', 'total'), 1);
  const best = s.products.best.find(p => p.productId === prod);
  assert.equal(best.units, 2);
  assert.equal(best.revenue, 20);
  // series: the totals of the buckets match the KPIs
  const seriesSales = s.series.reduce((x, b) => x + b.sales, 0);
  assert.equal(Math.round(seriesSales * 100) / 100, s.sales.net);
  assert.equal(s.series.reduce((x, b) => x + b.visits, 0), s.visitors.totalVisits);
  // a range in the past contains none of today's activity
  const past = (await get(`/api/data/stats?from=2020-01-01&to=2020-01-31&tz=${tz}`, ctx.admin)).body;
  assert.equal(past.orders.total, 0);
  assert.equal(past.collected.total, 0);
  assert.equal(past.visitors.totalVisits, 0);
  assert.equal(past.range.granularity, 'day');
  assert.equal(past.series.length, 31);
  // today only: hourly buckets
  const today = (await get(`/api/data/stats?from=${todayLocal(tz)}&to=${todayLocal(tz)}&tz=${tz}`, ctx.admin)).body;
  assert.equal(today.range.granularity, 'hour');
  assert.equal(today.series.length, 24);
  assert.ok(today.orders.total >= 2);
  // out-of-stock list follows the catalogue
  assert.ok(s.products.outOfStock.some(p => p.productId === ctx.pC));
  // invalid ranges and permissions
  assert.equal((await get(`/api/data/stats?from=2026-02-10&to=2026-02-01`, ctx.admin)).status, 400);
  assert.equal((await get(`/api/data/stats?from=all`, ctx.eve)).status, 403);
  assert.equal((await get(`/api/data/stats?period=week`, ctx.admin)).status, 200, 'former answer kept for compatibility');
});
