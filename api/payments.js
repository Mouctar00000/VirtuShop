/**
 * Vercel Serverless Function: /api/payments
 * SasPay (Mobile Money) payments, manual deposits, verification, reconciliation and provider webhooks.
 * The Trybit (crypto) gateway was retired: its former routes answer 410 Gone.
 */

'use strict';

const crypto = require('crypto');
const paymentService = require('../backend/payments');
const db = require('../backend/db');
const { httpError, apiHeaders, parseBody, queryParam, pathParts, clientIp, currentAuth, requireUser, requireAdmin, sendError } = require('../backend/http');

const CRON_MIN_INTERVAL_MS = 10 * 60 * 1000;

function route(req) {
  const p = queryParam(req, 'path');
  const parts = p ? String(p).split('/').filter(Boolean) : pathParts(req).filter(x => x !== 'api' && x !== 'payments');
  const raw = String(req.url || '');
  const isTrybit = parts.includes('trybit') || raw.startsWith('/api/trybit');
  const isSasPay = parts.includes('saspay');
  const action = parts.filter(x => x !== 'trybit' && x !== 'saspay').pop() || '';
  return { action, isTrybit, isSasPay };
}

/** Authenticated caller (plain object copy, usable outside the read lock). */
async function caller(req) {
  return db.read(() => {
    const auth = requireUser(req);
    return { id: auth.user.id, email: auth.user.email, name: auth.user.name, role: auth.user.role };
  });
}

/**
 * Exact bytes of the request body (the webhook signature is computed on them, never on re-serialized JSON).
 * Local server: req.rawBody. Vercel: the runtime replays the buffered body on the 'data'/'end' events.
 */
function readRawBody(req, timeoutMs = 2500) {
  if (typeof req.rawBody === 'string') return Promise.resolve(req.rawBody);
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(chunks.length ? Buffer.concat(chunks).toString('utf8') : null), timeoutMs);
    try {
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
    } catch (e) { finish(null); }
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Who may trigger a reconciliation: administrator (all), Vercel cron (all), customer (own payments). */
async function reconcileScope(req) {
  const who = await db.read(() => {
    const auth = currentAuth(req);
    return auth ? { id: auth.user.id, role: auth.user.role } : null;
  });
  if (who && who.role === 'admin') return { all: true };
  const cronSecret = process.env.CRON_SECRET || '';
  const authz = String((req.headers && req.headers.authorization) || '');
  if (cronSecret && safeEqual(authz, `Bearer ${cronSecret}`)) return { all: true, cron: true };
  if (!cronSecret && /vercel-cron/i.test(String((req.headers && req.headers['user-agent']) || ''))) return { all: true, cron: true, throttled: true };
  if (who) return { userId: who.id };
  throw httpError(401, 'Session non authentifiée ou expirée. Veuillez vous reconnecter.', 'SESSION_INVALID');
}

module.exports = async function handler(req, res) {
  apiHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const { action, isTrybit, isSasPay } = route(req);

  try {
    if (isTrybit) throw httpError(410, "Le paiement crypto (Trybit) n'est plus proposé. Utilisez le Mobile Money.");
    const body = req.method === 'GET' ? {} : parseBody(req);

    if (req.method === 'GET' && action === 'countries') {
      return res.status(200).json({ success: true, countries: paymentService.getCountries() });
    }
    if (req.method === 'GET' && (action === 'methods' || action === 'payments' || action === '')) {
      return res.status(200).json(await db.read(() => ({ methods: db.getPublicPaymentMethods() })));
    }
    if (req.method === 'GET' && action === 'transactions') {
      const user = await caller(req);
      // Pending Mobile Money payments of this customer are re-checked with SasPay first (never left blocked)
      await paymentService.reconcilePending({ userId: user.id, limit: 3, budgetMs: 8000 }).catch(() => null);
      return res.status(200).json({ transactions: await paymentService.getUserTransactions(user.id) });
    }

    // Status checks (owner or administrator only)
    if (isSasPay && action === 'verify') {
      const user = await caller(req);
      const transactionId = queryParam(req, 'transactionId') || queryParam(req, 'txId') || body.transactionId || body.txId;
      if (!transactionId) throw httpError(400, 'transactionId requis.');
      return res.status(200).json(await paymentService.verifySasPayPayment({ transactionId: String(transactionId).slice(0, 80), caller: user }));
    }

    // Administrator diagnostic of the SasPay connection (key, operators, webhooks, last notifications)
    if (isSasPay && action === 'health' && req.method === 'GET') {
      await db.read(() => requireAdmin(req));
      return res.status(200).json({ success: true, saspay: await paymentService.sasPayHealth() });
    }

    // Re-check pending payments (admin dashboard, daily Vercel cron, customer coming back to the site)
    if (isSasPay && action === 'reconcile') {
      const scope = await reconcileScope(req);
      if (scope.throttled) {
        const last = await db.read(() => Date.parse(((db.data.meta || {}).saspay || {}).lastCronAt || 0) || 0);
        if (Date.now() - last < CRON_MIN_INTERVAL_MS) return res.status(200).json({ success: true, skipped: true });
      }
      if (scope.cron) {
        await db.tx(() => { const m = db.data.meta || (db.data.meta = {}); m.saspay = { ...(m.saspay || {}), lastCronAt: new Date().toISOString() }; db.persist(); }).catch(() => {});
      }
      const r = scope.all
        ? await paymentService.reconcilePending({ limit: 10, budgetMs: 22000 })
        : await paymentService.reconcilePending({ userId: scope.userId, limit: 3, budgetMs: 9000 });
      return res.status(200).json({ success: true, ...r });
    }

    if (req.method !== 'POST') throw httpError(404, 'Action paiement non reconnue.');

    // Provider webhook (public, but only triggers a server-to-server verification)
    if (action === 'webhook') {
      const rawBody = await readRawBody(req);
      return res.status(200).json(await paymentService.handleWebhook({ headers: req.headers || {}, rawBody, payload: body }));
    }

    if (isSasPay && ['create', 'initiate', 'deposit'].includes(action)) {
      const user = await caller(req);
      const purchase = body.purchase && typeof body.purchase === 'object'
        ? { productId: body.purchase.productId, quantity: body.purchase.quantity, contactInfo: body.purchase.contactInfo }
        : null;
      const r = await paymentService.createSasPayDeposit({
        user,
        amountUsd: body.amount,
        country: body.country,
        network: body.network,
        phone: body.phone,
        otp: body.otp,
        preferredMode: body.preferredMode || body.mode,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        returnUrl: body.returnUrl,
        isPurchase: body.isPurchase,
        productId: body.productId,
        quantity: body.quantity,
        contactInfo: body.contactInfo,
        purchase
      });
      return res.status(201).json(r);
    }

    if (action === 'deposit') {
      const user = await caller(req);
      const r = await paymentService.createDepositRequest({ user, amount: body.amount, currency: body.currency || 'USD', paymentMethodId: body.paymentMethodId, proofImage: body.proofImage });
      return res.status(201).json(r);
    }

    // Administrator approval / rejection of a pending deposit
    if (action === 'verify') {
      const admin = await db.read(() => { const a = requireAdmin(req); return { id: a.user.id, name: a.user.name || 'Administrateur', email: a.user.email }; });
      const r = await paymentService.verifyAndCompleteTransaction({
        transactionId: body.transactionId,
        failureReason: body.failureReason,
        isApproval: body.isApproval !== false,
        adminName: admin.name,
        adminUser: admin,
        ip: clientIp(req)
      });
      return res.status(200).json(r);
    }

    throw httpError(404, 'Action paiement non reconnue.');
  } catch (err) {
    return sendError(res, err, 'API Payments');
  }
};
