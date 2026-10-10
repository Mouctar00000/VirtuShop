/**
 * Vercel Serverless Function: /api/payments
 * Point d'entrée pour les opérations de paiement et de rechargement (SasPay Mobile Money & Trybit Crypto).
 */

const paymentService = require('../backend/payments');
const authService = require('../backend/auth');
const db = require('../backend/db');

module.exports = async function handler(req, res) {
  // CORS & Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Signature, X-Webhook-Timestamp, X-Webhook-Event');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const rawUrl = req.url || '';
  const urlParts = rawUrl.split('?')[0].split('/').filter(Boolean);
  const action = urlParts[urlParts.length - 1]; // ex: 'create', 'verify', 'webhook', 'methods', 'deposit'
  const isSasPayRoute = rawUrl.includes('/saspay');
  const isTrybitRoute = rawUrl.includes('/trybit');

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    // 1. Liste des moyens de paiement actifs
    if (req.method === 'GET' && (action === 'methods' || action === 'payments')) {
      const methods = db.getPaymentMethods().filter(m => m.enabled);
      return res.status(200).json({ methods });
    }

    // 2. Historique des transactions de l'utilisateur
    if (req.method === 'GET' && action === 'transactions') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const verified = authService.verifySession(token);
      if (!verified) {
        return res.status(401).json({ error: 'Session non authentifiée.' });
      }
      const transactions = paymentService.getUserTransactions(verified.user.id);
      return res.status(200).json({ transactions });
    }

    // 3. Vérification du statut d'une transaction SasPay (GET ou POST)
    if (isSasPayRoute && action === 'verify') {
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const transactionId = parsedUrl.searchParams.get('transactionId') || parsedUrl.searchParams.get('txId') || body.transactionId || body.txId;
      const providerTxId = parsedUrl.searchParams.get('providerTxId') || parsedUrl.searchParams.get('id') || body.providerTxId;

      if (!transactionId && !providerTxId) {
        return res.status(400).json({ error: 'transactionId ou providerTxId requis.' });
      }

      const result = await paymentService.verifySasPayPayment({ transactionId, providerTxId });
      return res.status(200).json(result);
    }

    // 4. Vérification du statut d'une transaction Trybit Crypto (GET ou POST)
    if (isTrybitRoute && (action === 'verify' || action === 'status')) {
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const transactionId = parsedUrl.searchParams.get('transactionId') || parsedUrl.searchParams.get('txId') || body.transactionId || body.txId;
      const invoiceUuid = parsedUrl.searchParams.get('invoiceUuid') || parsedUrl.searchParams.get('uuid') || body.invoiceUuid || body.uuid;

      if (!transactionId && !invoiceUuid) {
        return res.status(400).json({ error: 'transactionId ou invoiceUuid requis.' });
      }

      const result = await paymentService.verifyTrybitPayment({ transactionId, invoiceUuid });
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      // 5. Initiation d'un paiement Crypto Instantané via Trybit
      if (isTrybitRoute && (action === 'create' || action === 'initiate' || action === 'deposit')) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const verified = authService.verifySession(token);
        const effectiveUserId = (verified && verified.user) ? verified.user.id : (body.userId || (body.user && body.user.id));

        if (!effectiveUserId) {
          return res.status(401).json({ error: 'Veuillez vous connecter pour initier une recharge.' });
        }

        const result = await paymentService.createTrybitDeposit({
          userId: effectiveUserId,
          amountUsd: body.amount,
          customerEmail: body.customerEmail || body.email,
          customerName: body.customerName || body.name,
          cryptocurrency: body.cryptocurrency,
          returnUrl: body.returnUrl,
          productId: body.productId,
          quantity: body.quantity,
          contactInfo: body.contactInfo
        });

        return res.status(201).json(result);
      }

      // 6. Initiation d'un paiement Mobile Money réel via SasPay
      if (isSasPayRoute && (action === 'create' || action === 'initiate' || action === 'deposit')) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const verified = authService.verifySession(token);
        const effectiveUserId = (verified && verified.user) ? verified.user.id : body.userId;

        if (!effectiveUserId) {
          return res.status(401).json({ error: 'Veuillez vous connecter pour initier une recharge.' });
        }

        const result = await paymentService.createSasPayDeposit({
          userId: effectiveUserId,
          amountUsd: body.amount,
          country: body.country,
          network: body.network,
          phone: body.phone,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          returnUrl: body.returnUrl,
          isPurchase: body.isPurchase,
          productId: body.productId,
          quantity: body.quantity
        });

        return res.status(201).json(result);
      }

      // 7. Initiation d'une recharge manuelle (TRC20, BTC manuel)
      if (action === 'deposit' && !isSasPayRoute && !isTrybitRoute) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const verified = authService.verifySession(token);
        const effectiveUserId = (verified && verified.user) ? verified.user.id : body.userId;

        if (!effectiveUserId) {
          return res.status(401).json({ error: 'Veuillez vous connecter pour initier une recharge.' });
        }

        const result = await paymentService.createDepositRequest({
          userId: effectiveUserId,
          amount: body.amount,
          currency: body.currency || 'USD',
          paymentMethodId: body.paymentMethodId,
          proofImage: body.proofImage
        });

        return res.status(201).json(result);
      }

      // 8. Vérification manuelle administrateur
      if (action === 'verify' && !isSasPayRoute && !isTrybitRoute) {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const verified = authService.verifySession(token);

        if (!verified || verified.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur pour la validation manuelle.' });
        }

        const result = await paymentService.verifyAndCompleteTransaction({
          transactionId: body.transactionId,
          providerTxId: body.providerTxId,
          failureReason: body.failureReason,
          isApproval: body.isApproval !== false
        });

        return res.status(200).json(result);
      }

      // 9. Webhook POSTBACK Trybit (dédié ou détection de signature JWT Trybit)
      if ((isTrybitRoute && (action === 'webhook' || action === 'postback')) || (action === 'webhook' && (body.invoice_id || body.invoice_info || body.token))) {
        const result = await paymentService.handleTrybitWebhook(body, req.headers);
        return res.status(200).json(result);
      }

      // 10. Webhook officiel SasPay
      if (action === 'webhook') {
        const result = await paymentService.handleWebhook({
          headers: req.headers,
          rawBody: req.rawBody,
          payload: body
        });

        return res.status(200).json(result);
      }
    }

    return res.status(404).json({ error: 'Action paiement non reconnue.' });
  } catch (error) {
    console.error('[API Payments Error]', error.message);
    return res.status(400).json({ error: error.message });
  }
};
