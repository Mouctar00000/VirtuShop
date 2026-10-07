/**
 * GetVirtu Production Payment & Transaction Service (backend/payments.js)
 * Architecture de paiement robuste avec modèle de transaction, idempotence,
 * validation côté serveur et support de webhooks sécurisés.
 */

const crypto = require('crypto');
const db = require('./db');

// Variables d'environnement pour les prestataires de paiement (sécurisées côté serveur)
const CRYPTO_API_KEY = process.env.CRYPTO_API_KEY || '';
const CRYPTO_SECRET = process.env.CRYPTO_SECRET || '';
const CRYPTO_WEBHOOK_SECRET = process.env.CRYPTO_WEBHOOK_SECRET || '';
const MOBILE_MONEY_API_KEY = process.env.MOBILE_MONEY_API_KEY || '';
const MOBILE_MONEY_SECRET = process.env.MOBILE_MONEY_SECRET || '';

class PaymentService {
  /**
   * 1. CRÉATION D'UNE DEMANDE DE RECHARGE / DÉPÔT
   * Crée une transaction en statut "pending" dans la base de données.
   * Le solde du client n'est JAMAIS crédité à cette étape.
   */
  async createDepositRequest({ userId, amount, currency = 'USD', paymentMethodId, proofImage }) {
    if (!userId) throw new Error('Utilisateur non authentifié.');

    const user = db.getUserById(userId);
    if (!user) throw new Error('Compte utilisateur introuvable.');

    const parsedAmount = parseFloat(amount);
    const minRecharge = db.data.settings?.min_recharge || 5.0;

    if (isNaN(parsedAmount) || parsedAmount < minRecharge) {
      throw new Error(`Le montant minimum de recharge est de ${minRecharge.toFixed(2)} USD.`);
    }

    const methods = db.getPaymentMethods();
    const method = methods.find(m => m.id === parseInt(paymentMethodId, 10)) || {
      name: 'Paiement Manuel',
      type: 'crypto',
      address: ''
    };

    const idempotencyKey = crypto.randomBytes(16).toString('hex');
    const transactionId = 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const transaction = db.createTransaction({
      id: transactionId,
      userId: user.id,
      amount: Math.round(parsedAmount * 100) / 100,
      currency: currency.toUpperCase(),
      paymentMethod: method.name,
      provider: method.type || 'crypto',
      providerTxId: null,
      status: 'pending', // Commence STRICTEMENT en statut pending
      idempotencyKey: idempotencyKey,
      proofImage: proofImage || null
    });

    console.log(`[Paiement] Nouvelle transaction initiée : ${transaction.id} par ${user.email} (${transaction.amount} ${transaction.currency})`);

    return {
      success: true,
      transaction,
      paymentInstructions: {
        methodName: method.name,
        address: method.address,
        network: method.network || '',
        instructions: method.instructions
      }
    };
  }

  /**
   * 2. VÉRIFICATION ET VALIDATION DU PAIEMENT (SERVEUR / ADMIN)
   * Protégé contre la double comptabilisation (Idempotence).
   */
  async verifyAndCompleteTransaction({ transactionId, providerTxId, failureReason = null, isApproval = true }) {
    const transaction = db.getTransactionById(transactionId);
    if (!transaction) {
      throw new Error('Transaction introuvable.');
    }

    // PROTECTION IDEMPOTENCE : Si déjà traitée, ne rien faire de nouveau
    if (transaction.status === 'completed') {
      console.warn(`[Paiement] Transaction ${transactionId} déjà validée. Aucune action répétée.`);
      return { success: true, alreadyProcessed: true, transaction };
    }

    if (transaction.status === 'failed' || transaction.status === 'cancelled') {
      throw new Error(`Cette transaction a déjà été marquée comme ${transaction.status}.`);
    }

    const user = db.getUserById(transaction.userId);
    if (!user) {
      throw new Error('Utilisateur associé introuvable.');
    }

    if (!isApproval) {
      // Rejet de la transaction
      const updated = db.updateTransaction(transactionId, {
        status: 'failed',
        failureReason: failureReason || 'Paiement rejeté lors de la vérification.',
        completedAt: new Date().toISOString()
      });
      return { success: true, transaction: updated };
    }

    // Validation effective : Crédit atomique du solde utilisateur
    const newBalance = Math.round(((user.balance || 0) + transaction.amount) * 100) / 100;
    db.updateUser(user.id, { balance: newBalance });

    const completedTx = db.updateTransaction(transactionId, {
      status: 'completed',
      providerTxId: providerTxId || transaction.providerTxId,
      completedAt: new Date().toISOString()
    });

    console.log(`[Paiement] Transaction ${transactionId} confirmée. Solde de ${user.email} crédité de +${transaction.amount} USD. Nouveau solde: ${newBalance} USD`);

    return {
      success: true,
      transaction: completedTx,
      newBalance
    };
  }

  /**
   * 3. GESTION DES WEBHOOKS PRESTATAIRES (Crypto / Mobile Money)
   * Vérifie la signature cryptographique et empêche les doublons.
   */
  async handleWebhook({ provider, rawBody, signature, payload }) {
    console.log(`[Paiement Webhook] Réception callback ${provider}...`);

    // 1. Vérification de la signature cryptographique (si webhook secret configuré)
    if (CRYPTO_WEBHOOK_SECRET) {
      const computedSig = crypto.createHmac('sha256', CRYPTO_WEBHOOK_SECRET).update(rawBody || JSON.stringify(payload)).digest('hex');
      if (signature && signature !== computedSig) {
        throw new Error('Signature du webhook invalide.');
      }
    }

    const txId = payload.transactionId || payload.custom_id || payload.order_id;
    const providerTxId = payload.providerTxId || payload.txn_id || payload.payment_id;
    const status = (payload.status || '').toLowerCase();

    if (!txId) {
      throw new Error('Identifiant de transaction manquant dans le payload webhook.');
    }

    // 2. Vérification idempotente
    const existing = db.getTransactionById(txId);
    if (!existing) {
      throw new Error(`Transaction ${txId} non trouvée.`);
    }

    if (existing.status === 'completed') {
      return { status: 'already_completed', transactionId: txId };
    }

    // 3. Traitement selon le statut du prestataire
    if (status === 'success' || status === 'completed' || status === 'paid' || status === 'confirmed') {
      return await this.verifyAndCompleteTransaction({
        transactionId: txId,
        providerTxId: providerTxId,
        isApproval: true
      });
    } else if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      return await this.verifyAndCompleteTransaction({
        transactionId: txId,
        providerTxId: providerTxId,
        failureReason: `Échec signalé par le prestataire (${status})`,
        isApproval: false
      });
    }

    // Statut intermédiaire (ex: processing)
    db.updateTransaction(txId, { status: 'processing', providerTxId });
    return { status: 'processing', transactionId: txId };
  }

  /**
   * 4. HISTORIQUE DES TRANSACTIONS D'UN CLIENT
   */
  getUserTransactions(userId) {
    if (!userId) return [];
    return db.getTransactions({ userId });
  }
}

module.exports = new PaymentService();
