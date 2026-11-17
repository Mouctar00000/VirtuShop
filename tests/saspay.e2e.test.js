/**
 * GetVirtu — Mobile Money (SasPay) end-to-end tests.
 * Real HTTP server + isolated temporary database + a local SasPay double that follows the documented API
 * (https://docs.saspay.me: { success, data | error, code } envelope, softpay, verify, checkout sessions,
 * transactions/status_logs, signed webhooks). The double never decides a payment on its own: each test sets
 * the operator's answer explicitly, and the shop must only credit what "SasPay" confirms server-to-server.
 * Run: node --test tests/saspay.e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- isolation (never .env, never production)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-saspay-'));
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'SASPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'CRON_SECRET']) delete process.env[k];
process.env.GV_DATA_DIR = TMP;
process.env.GV_STORE = 'file';
process.env.GV_SKIP_DOTENV = '1';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SASPAY_API_KEY = 'sk_test_double_' + crypto.randomBytes(6).toString('hex');
process.env.SASPAY_TIMEOUT_MS = '1500';
const ADMIN_PASSWORD = 'Admin-Test-' + crypto.randomBytes(6).toString('hex');
{
  const salt = crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;
}

// ------------------------------------------------------------------------------------------------ SasPay double
const mock = {
  calls: [], payments: new Map(), sessions: new Map(), idem: new Map(), mode: null, webhooks: [],
  ok(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data, code: status })); },
  err(res, status, error) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error, code: status })); },
  newPayment({ amount, currency, network, metadata, session = null, msisdn = '' }) {
    const id = crypto.randomUUID();
    const p = { id, reference: crypto.randomBytes(8).toString('hex'), status: 'PENDING', requested_amount: amount, debited_amount: (parseFloat(amount) * 1.0475).toFixed(2), net_amount: amount, currency, network_code: network, metadata: metadata || {}, checkout_session: session, operation_msisdn: msisdn, status_logs: [{ from_status: null, to_status: 'PENDING', reason: '', triggered_by: 'SYSTEM' }], attempts: [{ status: 'SUCCESS', error_message: '' }] };
    this.payments.set(id, p);
    return p;
  },
  setStatus(id, status, reason = '') {
    const p = this.payments.get(id);
    p.status_logs.push({ from_status: p.status, to_status: status, reason, triggered_by: 'SYSTEM' });
    p.status = status;
  }
};
const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/v1\//, '');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) {}
    mock.calls.push({ method: req.method, path: p, body, headers: req.headers });
    if (req.headers.authorization !== 'Bearer ' + process.env.SASPAY_API_KEY || mock.mode === 'auth') return mock.err(res, 401, { message: 'Clé API invalide.', code: 'authentication_failed' });

    if (req.method === 'POST' && p === 'payments/softpay/') {
      const key = req.headers['idempotency-key'];
      if (key && mock.idem.has(key)) return mock.ok(res, 201, mock.idem.get(key));
      if (mock.mode === 'no_route') return mock.err(res, 422, { message: "Aucun fournisseur actif pour ce réseau.", code: 'no_route_available' });
      if (mock.mode === 'validation') return mock.err(res, 400, { customer: { phone: ['Numéro de téléphone invalide.'] } });
      if (mock.mode === 'server_error') return mock.err(res, 500, { message: 'Internal error', code: 'server_error' });
      if (body.network === 'orange_ci' && !body.otp) return mock.err(res, 422, { message: 'OTP pré-paiement manquant.', code: 'prepayment_otp_missing' });
      const pay = mock.newPayment({ amount: body.amount, currency: body.currency, network: body.network, metadata: body.metadata, msisdn: body.customer.phone });
      const out = { message: 'Payment pushed successfully', id: pay.id, status: 'PENDING', checkout_url: body.network === 'wave_ci' ? 'https://pay.wave.example/c/' + pay.id : '', instructions: ['Payment pushed successfully'] };
      if (key) mock.idem.set(key, out);
      if (mock.mode === 'slow_once') { mock.mode = null; return setTimeout(() => mock.ok(res, 201, out), 2600); }
      return mock.ok(res, 201, out);
    }
    let m;
    if (req.method === 'GET' && (m = p.match(/^payments\/([^/]+)\/verify\/$/))) {
      const pay = mock.payments.get(m[1]);
      if (!pay) return mock.err(res, 404, { message: 'Transaction introuvable.', code: 'not_found' });
      const { status_logs, attempts, ...rest } = pay;
      return mock.ok(res, 200, { message: 'Payment transaction fetched successfully', ...rest, instructions: ['Payment pushed successfully'] });
    }
    if (req.method === 'GET' && (m = p.match(/^transactions\/([^/]+)\/$/))) {
      const pay = mock.payments.get(m[1]);
      if (!pay) return mock.err(res, 404, { message: 'Transaction introuvable.', code: 'not_found' });
      return mock.ok(res, 200, pay);
    }
    if (req.method === 'POST' && p === 'checkout-sessions/') {
      const s = { id: crypto.randomUUID(), slug: 'slug' + mock.sessions.size, checkout_url: 'https://pay.saspay.example/checkout/' + mock.sessions.size, status: 'PENDING', amount: body.amount, currency: body.currency, metadata: body.metadata, return_url: body.return_url, expires_at: body.expires_at, transaction: null };
      mock.sessions.set(s.id, s);
      return mock.ok(res, 201, s);
    }
    if (req.method === 'GET' && (m = p.match(/^checkout-sessions\/([^/]+)\/status\/$/))) {
      const s = mock.sessions.get(m[1]);
      if (!s) return mock.err(res, 404, { message: 'Session introuvable.', code: 'not_found' });
      const pay = s.transaction ? mock.payments.get(s.transaction) : null;
      return mock.ok(res, 200, { id: s.id, slug: s.slug, status: s.status, transaction_id: pay ? pay.id : null, transaction_status: pay ? pay.status : null });
    }
    if (req.method === 'GET' && p === 'pricing/my-rates/') return mock.ok(res, 200, [{ country_code: 'CM', network_code: 'orange_cm', payin: { available: true, otp_required: false } }, { country_code: 'CI', network_code: 'orange_ci', payin: { available: true, otp_required: true } }]);
    if (req.method === 'GET' && p === 'merchant-webhooks/') return mock.ok(res, 200, { count: mock.webhooks.length, results: mock.webhooks });
    if (req.method === 'GET' && p === 'merchant-webhook-subscriptions/') return mock.ok(res, 200, { count: 0, results: [] });
    if (req.method === 'GET' && p === 'webhook-logs/') return mock.ok(res, 200, { count: 0, results: [] });
    return mock.err(res, 404, { message: 'Route inconnue du double SasPay: ' + p, code: 'not_found' });
  });
});

let server;
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
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (u, t) => call('GET', u, undefined, t);
const post = (u, b, t, h) => call('POST', u, b, t, h);
const balanceOf = async (t) => (await get('/api/auth/me', t)).body.user.balance;
const lastSoftpay = () => mock.calls.filter(c => c.path === 'payments/softpay/').pop();
const softpayCount = () => mock.calls.filter(c => c.path === 'payments/softpay/').length;

const ctx = {};
function momo(extra = {}) {
  return { amount: 5, country: 'CM', network: 'orange_cm', phone: '0699123440', customerName: 'Awa Client', ...extra };
}
function signedHeaders(secret, rawBody, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { 'X-Webhook-Signature': sig, 'X-Webhook-Timestamp': String(ts), 'X-Webhook-Event': 'transaction.success' };
}

test.before(async () => {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  process.env.SASPAY_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/api/v1`;
  server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const a = await post('/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  ctx.admin = a.body.session.token;
  const c = await post('/api/auth/register', { email: 'awa@example.com', password: 'Awa-Pass-12', confirmPassword: 'Awa-Pass-12', name: 'Awa' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  ctx.awa = c.body.session.token;
  const d = await post('/api/auth/register', { email: 'eve@example.com', password: 'Eve-Pass-123', confirmPassword: 'Eve-Pass-123', name: 'Eve' });
  ctx.eve = d.body.session.token;
  const prod = await post('/api/data/products', { name: 'Licence Test', category: 'Logiciels', price: 3, newKeys: ['KEY-AAA-1', 'KEY-AAA-2', 'KEY-AAA-3'] }, ctx.admin);
  assert.equal(prod.status, 200, JSON.stringify(prod.body));
  ctx.prodId = prod.body.product.id;
  const prod2 = await post('/api/data/products', { name: 'Pack Test', category: 'Logiciels', price: 3, newKeys: Array.from({ length: 10 }, (_, i) => 'PACK-' + i) }, ctx.admin);
  ctx.prod2Id = prod2.body.product.id;
});
test.after(async () => {
  server.close();
  mockServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

// ------------------------------------------------------------------------------------------------ creation
test('invalid number, missing OTP, unknown operator: clear reason and no request sent to the operator', async () => {
  const before = softpayCount();
  const ci = await post('/api/payments/saspay/create', momo({ country: 'CI', network: 'mtn_ci', phone: '07070707' }), ctx.awa);
  assert.equal(ci.status, 400);
  assert.equal(ci.body.code, 'INVALID_PHONE');
  assert.match(ci.body.error, /10 chiffres/);
  const otp = await post('/api/payments/saspay/create', momo({ country: 'CI', network: 'orange_ci', phone: '0707070707' }), ctx.awa);
  assert.equal(otp.status, 400);
  assert.equal(otp.body.code, 'OTP_REQUIRED');
  assert.match(otp.body.error, /#144\*82#/);
  const unknown = await post('/api/payments/saspay/create', momo({ network: 'wave_ml' }), ctx.awa);
  assert.equal(unknown.status, 400);
  const badCountry = await post('/api/payments/saspay/create', momo({ country: 'ZZ' }), ctx.awa);
  assert.equal(badCountry.status, 400);
  const anon = await post('/api/payments/saspay/create', momo());
  assert.equal(anon.status, 401);
  assert.equal(softpayCount(), before, 'nothing pushed to any phone');
});

test('push payment: normalized number, idempotency key, operator-specific instructions (Orange CM #150*50#)', async () => {
  const r = await post('/api/payments/saspay/create', momo(), ctx.awa);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'push');
  assert.equal(r.body.status, 'pending');
  assert.ok(r.body.instructions.some(s => s.includes('#150*50#')), 'Orange Money Cameroon confirmation code shown');
  assert.ok(!r.body.instructions.some(s => /payment pushed successfully/i.test(s)), 'generic provider text filtered');
  assert.equal(r.body.validationWindowSec, 180);
  assert.ok(!r.body.phone.includes('699123'), 'phone number masked in the response');
  const sent = lastSoftpay();
  assert.equal(sent.body.customer.phone, '+237699123440', 'local number converted to the international format');
  assert.equal(sent.body.amount, '3100.00');
  assert.equal(sent.body.currency, 'XAF');
  assert.equal(sent.body.metadata.internalTxId, r.body.transactionId);
  assert.match(sent.headers['idempotency-key'] || '', /^[0-9a-f-]{36}$/);
  ctx.pushTx = r.body.transactionId;
  ctx.pushPay = r.body.providerTxId;
});

test('operator refusal: exact reason displayed, transaction closed, balance untouched', async () => {
  const before = await balanceOf(ctx.awa);
  const pending = await get('/api/payments/saspay/verify?transactionId=' + ctx.pushTx, ctx.awa);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, 'pending');
  assert.match(pending.body.message, /validez le paiement sur votre téléphone/);
  assert.match(pending.body.charged || '', /^3 247 XAF$/, 'amount debited by the operator, fees included');

  mock.setStatus(ctx.pushPay, 'FAILED', "Refusé par l'opérateur.");
  const failed = await get('/api/payments/saspay/verify?transactionId=' + ctx.pushTx, ctx.awa);
  assert.equal(failed.body.status, 'failed');
  assert.match(failed.body.message, /Motif communiqué par l’opérateur : « Refusé par l'opérateur »/);
  assert.match(failed.body.message, /#150\*50#/, 'actionable hint for Orange Money Cameroon');
  assert.equal(await balanceOf(ctx.awa), before);

  const calls = mock.calls.length;
  const again = await get('/api/payments/saspay/verify?transactionId=' + ctx.pushTx, ctx.awa);
  assert.equal(again.body.status, 'failed', 'final state is kept');
  assert.equal(mock.calls.length, calls, 'a closed payment is not re-queried');
  const list = await get('/api/payments/transactions', ctx.awa);
  const t = list.body.transactions.find(x => x.id === ctx.pushTx);
  assert.equal(t.status, 'failed');
  assert.match(t.failureReason, /Refusé par l'opérateur/);
  const foreign = await get('/api/payments/saspay/verify?transactionId=' + ctx.pushTx, ctx.eve);
  assert.equal(foreign.status, 404, "another customer cannot read this payment");
});

test('payment confirmed: balance credited once and the order is validated automatically', async () => {
  const before = await balanceOf(ctx.awa);
  const r = await post('/api/payments/saspay/create', momo({ purchase: { productId: ctx.prodId, quantity: 1, contactInfo: 'awa@example.com' } }), ctx.awa);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.autoPurchase, true);
  assert.equal(lastSoftpay().body.description, 'GetVirtu Licence Test');

  mock.setStatus(r.body.providerTxId, 'SUCCESS');
  const ok = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.awa);
  assert.equal(ok.body.status, 'completed', JSON.stringify(ok.body));
  assert.ok(ok.body.order && ok.body.order.id, 'order created by the server');
  assert.equal(ok.body.order.productId, ctx.prodId);
  assert.equal(ok.body.order.status, 'Complété');
  assert.match(JSON.stringify(ok.body.order.vaultContent), /KEY-AAA-/);
  assert.equal(ok.body.newBalance, Math.round((before + 5 - 3) * 100) / 100);

  const again = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.awa);
  assert.equal(again.body.order.id, ok.body.order.id, 'same order, never a second one');
  assert.equal(await balanceOf(ctx.awa), ok.body.newBalance, 'credited exactly once');
  const orders = (await get('/api/data/orders', ctx.awa)).body.orders.filter(o => o.productId === ctx.prodId);
  assert.equal(orders.length, 1);
  const stock = (await get('/api/data/products')).body.products.find(p => p.id === ctx.prodId).stock;
  assert.equal(stock, 2);
});

test('order impossible after payment (out of stock): money kept on the balance with the exact reason', async () => {
  const r = await post('/api/payments/saspay/create', momo({ purchase: { productId: ctx.prodId, quantity: 1 } }), ctx.eve);
  assert.equal(r.status, 201);
  const before = await balanceOf(ctx.eve);
  // The last licences are sold to someone else before the operator confirms
  await post('/api/data/users', { userId: (await get('/api/auth/me', ctx.awa)).body.user.id, amount: 20, action: 'add', reason: 'test' }, ctx.admin);
  const buy = await post('/api/data/orders', { productId: ctx.prodId, quantity: 2 }, ctx.awa);
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  mock.setStatus(r.body.providerTxId, 'SUCCESS');
  const v = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.eve);
  assert.equal(v.body.status, 'completed');
  assert.equal(v.body.order, null);
  assert.match(v.body.orderError, /stock|disponible/i);
  assert.equal(await balanceOf(ctx.eve), before + 5, 'payment credited, nothing lost');
});

// ------------------------------------------------------------------------------------------------ webhooks
test('signed webhook (raw body, Python-style JSON): credits exactly once; bad or old signatures rejected', async () => {
  process.env.SASPAY_WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(4).toString('hex');
  try {
    const before = await balanceOf(ctx.eve);
    const r = await post('/api/payments/saspay/create', momo(), ctx.eve);
    mock.setStatus(r.body.providerTxId, 'SUCCESS');
    const raw = `{"event": "transaction.success", "data": {"id": "${r.body.providerTxId}", "status": "SUCCESS", "amount": "3100.00", "currency": "XAF", "network": "orange_cm"}}`;

    const forged = await post('/api/payments/webhook', raw, null, { 'X-Webhook-Signature': 'a'.repeat(64), 'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)) });
    assert.equal(forged.status, 401);
    const old = await post('/api/payments/webhook', raw, null, signedHeaders(process.env.SASPAY_WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000) - 900));
    assert.equal(old.status, 401, 'replayed (old) notification rejected');
    const missing = await post('/api/payments/webhook', raw);
    assert.equal(missing.status, 401);
    assert.equal(await balanceOf(ctx.eve), before);

    const good = await post('/api/payments/webhook', raw, null, signedHeaders(process.env.SASPAY_WEBHOOK_SECRET, raw));
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.status, 'completed');
    const again = await post('/api/payments/webhook', raw, null, signedHeaders(process.env.SASPAY_WEBHOOK_SECRET, raw));
    assert.equal(again.status, 200);
    assert.equal(await balanceOf(ctx.eve), before + 5, 'credited once');

    const test = '{"event": "webhook.test", "data": {}}';
    const t = await post('/api/payments/webhook', test, null, signedHeaders(process.env.SASPAY_WEBHOOK_SECRET, test));
    assert.equal(t.status, 200);
    assert.match(t.body.message, /opérationnel/);
  } finally {
    delete process.env.SASPAY_WEBHOOK_SECRET;
  }
});

test('forged notifications never credit: the shop only trusts SasPay server-to-server', async () => {
  const r = await post('/api/payments/saspay/create', momo(), ctx.eve);
  const before = await balanceOf(ctx.eve);
  await post('/api/payments/webhook', { event: 'transaction.success', data: { id: r.body.providerTxId, status: 'SUCCESS' } });
  await post('/api/payments/webhook', { event: 'transaction.success', data: { id: crypto.randomUUID(), status: 'SUCCESS', metadata: { internalTxId: r.body.transactionId } } });
  await post('/api/payments/saspay/webhook', { event: 'transaction.success', data: { status: 'SUCCESS', reference: r.body.transactionId } });
  assert.equal(await balanceOf(ctx.eve), before, 'SasPay still says PENDING: nothing credited');
  const v = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.eve);
  assert.equal(v.body.status, 'pending');
  mock.setStatus(r.body.providerTxId, 'FAILED', 'INSUFFICIENT_BALANCE');
  const f = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.eve);
  assert.equal(f.body.status, 'failed');
  assert.match(f.body.message, /solde de votre compte Mobile Money ne couvre pas/);
});

test('hosted payment page: expiry sent, return URL tracked, payment resolved through SasPay from the webhook', async () => {
  const r = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'checkout_hosted', returnUrl: 'https://getvirtu.shop/' }, ctx.eve);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'checkout');
  assert.match(r.body.checkoutUrl, /^https:\/\/pay\.saspay\.example\//);
  const sess = mock.sessions.get(r.body.providerTxId);
  const ttlMin = (Date.parse(sess.expires_at) - Date.now()) / 60000;
  assert.ok(ttlMin > 25 && ttlMin <= 30, 'session expires after 30 minutes');
  assert.equal(sess.return_url, `https://getvirtu.shop/?momo_return=${r.body.transactionId}`);
  assert.equal((await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.eve)).body.status, 'pending');

  // The customer pays on the hosted page: SasPay creates a payment linked to the session
  const before = await balanceOf(ctx.eve);
  const pay = mock.newPayment({ amount: sess.amount, currency: sess.currency, network: 'mtn_cm', metadata: sess.metadata, session: sess.id });
  sess.transaction = pay.id;
  sess.status = 'PAID';
  mock.setStatus(pay.id, 'SUCCESS');
  const wh = await post('/api/payments/webhook', { event: 'transaction.success', data: { id: pay.id, status: 'SUCCESS' } });
  assert.equal(wh.status, 200);
  assert.equal(wh.body.status, 'completed', JSON.stringify(wh.body));
  assert.equal(await balanceOf(ctx.eve), before + 5);

  // An unpaid page that expires is closed with a clear message
  const r2 = await post('/api/payments/saspay/create', { amount: 5, country: 'CM', network: 'checkout_hosted' }, ctx.eve);
  mock.sessions.get(r2.body.providerTxId).status = 'EXPIRED';
  const ex = await get('/api/payments/saspay/verify?transactionId=' + r2.body.transactionId, ctx.eve);
  assert.equal(ex.body.status, 'failed');
  assert.match(ex.body.message, /expirée/);
});

test('Wave / Orange CI style answer with checkout_url: the customer is sent to the payment page', async () => {
  const r = await post('/api/payments/saspay/create', momo({ country: 'CI', network: 'wave_ci', phone: '0707070707' }), ctx.eve);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'redirect');
  assert.match(r.body.checkoutUrl, /^https:\/\/pay\.wave\.example\//);
  assert.ok(r.body.instructions.some(s => /Aucune demande n’arrivera sur votre téléphone/.test(s)));
  assert.equal(lastSoftpay().body.customer.phone, '+2250707070707', 'leading 0 of Ivorian numbers kept');
});

// ------------------------------------------------------------------------------------------------ provider problems
test('provider problems: exact reason, safe retry with the same idempotency key, never left pending', async () => {
  mock.mode = 'no_route';
  const noRoute = await post('/api/payments/saspay/create', momo(), ctx.eve);
  assert.equal(noRoute.status, 503);
  assert.match(noRoute.body.error, /Orange Money \(Cameroun\) est momentanément indisponible.*Aucun fournisseur actif/);
  mock.mode = 'validation';
  const val = await post('/api/payments/saspay/create', momo(), ctx.eve);
  assert.equal(val.status, 400);
  assert.match(val.body.error, /Numéro de téléphone invalide/);
  mock.mode = 'auth';
  const auth = await post('/api/payments/saspay/create', momo(), ctx.eve);
  assert.equal(auth.status, 503);
  assert.equal(auth.body.code, 'PROVIDER_CONFIG');
  mock.mode = null;

  const txs = (await get('/api/payments/transactions', ctx.eve)).body.transactions;
  for (const id of [noRoute.body.transactionId, val.body.transactionId, auth.body.transactionId]) {
    const t = txs.find(x => x.id === id);
    assert.ok(t, 'refused attempt is recorded');
    assert.equal(t.status, 'failed', 'never left pending');
  }

  mock.mode = 'slow_once';
  const before = mock.payments.size;
  const slow = await post('/api/payments/saspay/create', momo(), ctx.eve);
  assert.equal(slow.status, 201, JSON.stringify(slow.body));
  const tries = mock.calls.filter(c => c.path === 'payments/softpay/').slice(-2);
  assert.equal(tries[0].headers['idempotency-key'], tries[1].headers['idempotency-key'], 'retry reuses the idempotency key');
  assert.equal(mock.payments.size, before + 1, 'a single payment pushed to the phone');
});

test('amount paid different from the amount asked: never credited automatically', async () => {
  const r = await post('/api/payments/saspay/create', momo(), ctx.eve);
  const before = await balanceOf(ctx.eve);
  const p = mock.payments.get(r.body.providerTxId);
  p.requested_amount = '100.00';
  mock.setStatus(p.id, 'SUCCESS');
  const v = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.eve);
  assert.equal(v.body.status, 'pending');
  assert.match(v.body.message, /Montant payé différent/);
  assert.equal(await balanceOf(ctx.eve), before);
});

// ------------------------------------------------------------------------------------------------ reconciliation & admin
test('reconciliation: a payment confirmed while the browser was closed is credited without the browser', async () => {
  const r = await post('/api/payments/saspay/create', momo({ purchase: { productId: ctx.prod2Id, quantity: 1 } }), ctx.eve);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const before = await balanceOf(ctx.eve);
  mock.setStatus(r.body.providerTxId, 'SUCCESS');
  // Customer comes back later: the history is reconciled with SasPay first
  const list = await get('/api/payments/transactions', ctx.eve);
  const t = list.body.transactions.find(x => x.id === r.body.transactionId);
  assert.equal(t.status, 'completed');
  assert.ok(t.metadata.purchase.orderId, 'order placed by the server');
  assert.equal(await balanceOf(ctx.eve), before + 5 - 3);

  assert.equal((await get('/api/payments/saspay/reconcile')).status, 401, 'anonymous reconciliation refused');
  const adm = await get('/api/payments/saspay/reconcile', ctx.admin);
  assert.equal(adm.status, 200);
  assert.equal(adm.body.success, true);

  // Customer coming back on another device: own pending payments only
  const r2 = await post('/api/payments/saspay/create', momo(), ctx.awa);
  mock.setStatus(r2.body.providerTxId, 'SUCCESS');
  const mine = await post('/api/payments/saspay/reconcile', {}, ctx.awa);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.results.some(x => x.id === r2.body.transactionId && x.status === 'completed'), JSON.stringify(mine.body));
  assert.ok(mine.body.results.every(x => x.id !== r.body.transactionId), "never another customer's payments");
  // Vercel cron without CRON_SECRET: accepted once, then throttled
  const cron1 = await get('/api/payments/saspay/reconcile', null).then(() => call('GET', '/api/payments/saspay/reconcile', undefined, null, { 'User-Agent': 'vercel-cron/1.0' }));
  assert.equal(cron1.status, 200);
  assert.notEqual(cron1.body.skipped, true);
  const cron2 = await call('GET', '/api/payments/saspay/reconcile', undefined, null, { 'User-Agent': 'vercel-cron/1.0' });
  assert.equal(cron2.body.skipped, true, 'cron calls are throttled');
});

test('admin diagnostic: key, operators, missing webhook detected; customers cannot run it', async () => {
  assert.equal((await get('/api/payments/saspay/health', ctx.eve)).status, 403);
  const h = await get('/api/payments/saspay/health', ctx.admin);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.saspay.keyValid, true);
  assert.equal(h.body.saspay.activeNetworks, 2);
  assert.deepEqual(h.body.saspay.otpNetworks, ['orange_ci']);
  assert.equal(h.body.saspay.webhookPointsHere, false);
  assert.equal(h.body.saspay.expectedWebhookUrl, 'https://getvirtu.shop/api/payments/webhook');
  assert.ok(h.body.saspay.lastWebhook && h.body.saspay.lastWebhook.lastWebhookAt, 'last notification recorded');
  mock.webhooks.push({ id: 'w1', url: 'https://getvirtu.shop/api/payments/webhook', environment: 'LIVE', is_active: true });
  const h2 = await get('/api/payments/saspay/health', ctx.admin);
  assert.equal(h2.body.saspay.webhookPointsHere, true);
});

test('admin can check any payment with SasPay; operator timeout explained', async () => {
  const r = await post('/api/payments/saspay/create', momo({ purchase: { productId: ctx.prod2Id, quantity: 1 } }), ctx.eve);
  mock.setStatus(r.body.providerTxId, 'FAILED', 'TIMED_OUT');
  const v = await get('/api/payments/saspay/verify?transactionId=' + r.body.transactionId, ctx.admin);
  assert.equal(v.body.status, 'failed');
  assert.match(v.body.message, /pas été validée à temps/);
});
