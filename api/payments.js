/**
 * Vercel Serverless Function: /api/payments
 */

const paymentService = require('../backend/payments');
const authService = require('../backend/auth');
const db = require('../backend/db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-webhook-signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const action = urlParts[urlParts.length - 1];

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

    // 2. Historique des transactions de l'utilisateur authentifié
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

    if (req.method === 'POST') {
      // 3. Initier une demande de recharge (statut pending obligatoire)
      if (action === 'deposit') {
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

      // 4. Vérification d'une transaction (réservée à l'administrateur ou webhook sécurisé)
      if (action === 'verify') {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const verified = authService.verifySession(token);

        if (!verified || verified.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur pour la vérification.' });
        }

        const result = await paymentService.verifyAndCompleteTransaction({
          transactionId: body.transactionId,
          providerTxId: body.providerTxId,
          failureReason: body.failureReason,
          isApproval: body.isApproval !== false
        });

        return res.status(200).json(result);
      }

      // 5. Réception webhook prestataire de paiement (Crypto / Mobile Money)
      if (action === 'webhook') {
        const signature = req.headers['x-webhook-signature'] || req.headers['x-signature'];
        const provider = req.headers['x-provider'] || body.provider || 'generic';

        const result = await paymentService.handleWebhook({
          provider,
          payload: body,
          signature
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
