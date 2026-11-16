/**
 * Vercel Serverless Function: /api/payments
 * SasPay (Mobile Money) deposits, manual deposits, verification and provider webhooks.
 * The Trybit (crypto) gateway was retired: its former routes answer 410 Gone.
 */

'use strict';

const paymentService = require('../backend/payments');
const db = require('../backend/db');
const { httpError, apiHeaders, parseBody, queryParam, pathParts, requireUser, requireAdmin, sendError } = require('../backend/http');

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
      return res.status(200).json({ transactions: await paymentService.getUserTransactions(user.id) });
    }

    // Status checks (owner or administrator only)
    if (isSasPay && action === 'verify') {
      const user = await caller(req);
      const transactionId = queryParam(req, 'transactionId') || queryParam(req, 'txId') || body.transactionId || body.txId;
      if (!transactionId) throw httpError(400, 'transactionId requis.');
      return res.status(200).json(await paymentService.verifySasPayPayment({ transactionId, caller: user }));
    }

    if (req.method !== 'POST') throw httpError(404, 'Action paiement non reconnue.');

    // Provider webhook (public, but only triggers a server-to-server verification)
    if (action === 'webhook') {
      return res.status(200).json(await paymentService.handleWebhook({ headers: req.headers || {}, rawBody: req.rawBody, payload: body }));
    }

    if (isSasPay && ['create', 'initiate', 'deposit'].includes(action)) {
      const user = await caller(req);
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
        productId: body.productId
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
      const admin = await db.read(() => { const a = requireAdmin(req); return { name: a.user.name || 'Administrateur' }; });
      const r = await paymentService.verifyAndCompleteTransaction({
        transactionId: body.transactionId,
        failureReason: body.failureReason,
        isApproval: body.isApproval !== false,
        adminName: admin.name
      });
      return res.status(200).json(r);
    }

    throw httpError(404, 'Action paiement non reconnue.');
  } catch (err) {
    return sendError(res, err, 'API Payments');
  }
};
