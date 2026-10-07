/**
 * GetVirtu Production Payment & Transaction Service (backend/payments.js)
 * Intégration officielle de l'API SasPay (Mobile Money en direct en Afrique de l'Ouest & Centrale)
 * Documentation officielle : https://docs.saspay.me/
 * Base URL : https://api.saspay.me/api/v1
 */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const trybitService = require('./trybit');

// Chargement sécurisé des variables d'environnement locales si présentes
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (e) {}

// Configuration officielle SasPay (Credentials serveur uniquement via variables d'environnement)
const SASPAY_API_KEY = process.env.SASPAY_API_KEY || '';
const SASPAY_BASE_URL = process.env.SASPAY_BASE_URL || 'https://api.saspay.me/api/v1';
const SASPAY_WEBHOOK_SECRET = process.env.SASPAY_WEBHOOK_SECRET || '';

// Taux de change indicatif pour la conversion USD -> FCFA (Zone Franc UEMOA / CEMAC)
const USD_TO_XOF_RATE = 620; // 1 USD = 620 XOF / XAF
const USD_TO_GNF_RATE = 8600; // 1 USD = 8600 GNF

class PaymentService {
  /**
   * Envoi d'une requête HTTP sécurisée vers l'API SasPay
   */
  requestSasPay(endpoint, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
      const cleanBase = SASPAY_BASE_URL.endsWith('/') ? SASPAY_BASE_URL : SASPAY_BASE_URL + '/';
      const url = new URL(cleanEndpoint, cleanBase);
      const postData = body ? JSON.stringify(body) : null;

      const reqHeaders = {
        'Authorization': `Bearer ${SASPAY_API_KEY}`,
        'Content-Type': 'application/json',
        ...headers
      };

      if (postData) {
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request(url, {
        method,
        headers: reqHeaders,
        timeout: 25000 // Timeout 25s selon recommandations SasPay
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              data: parsed
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              raw
            });
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error('Erreur de communication avec SasPay: ' + err.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Délai d\'attente dépassé avec SasPay (Timeout).'));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * 1. INITIATION D'UN PAIEMENT MOBILE MONEY RÉEL VIA SASPAY
   * Crée une transaction en statut STRICT 'pending' dans la base de données.
   * Le solde du client n'est JAMAIS crédité à cette étape.
   */
  async createSasPayDeposit({ userId, amountUsd, country, network, phone, customerName, customerEmail, returnUrl }) {
    if (!userId) throw new Error('Utilisateur non authentifié.');

    let user = db.getUserById(userId);
    if (!user && customerEmail) {
      user = db.getUserByEmail(customerEmail);
    }
    if (!user) {
      user = db.createUser({
        id: userId,
        email: customerEmail || `client_${userId}@getvirtu.shop`,
        name: customerName || 'Client GetVirtu',
        role: 'client',
        balance: 0.00
      });
    }

    const parsedUsd = parseFloat(amountUsd);
    const minRecharge = db.data.settings?.min_recharge || 5.0;

    if (isNaN(parsedUsd) || parsedUsd < minRecharge) {
      throw new Error(`Le montant minimum de recharge est de ${minRecharge.toFixed(2)} USD.`);
    }

    if (!SASPAY_API_KEY) {
      throw new Error('Clé API SasPay non configurée sur le serveur.');
    }

    // Déterminer la devise et le montant local selon le pays
    const countryCode = (country || 'CI').toUpperCase();
    let currency = 'XOF';
    let localRate = USD_TO_XOF_RATE;

    if (countryCode === 'CM' || countryCode === 'CG' || countryCode === 'GA') {
      currency = 'XAF';
      localRate = USD_TO_XOF_RATE;
    } else if (countryCode === 'GN') {
      currency = 'GNF';
      localRate = USD_TO_GNF_RATE;
    } else if (network === 'card' || network === 'crypto') {
      currency = 'USD';
      localRate = 1;
    }

    // Calcul du montant décimal formatté (règle SasPay : chaîne décimale stricte "2500.00")
    const calculatedLocalAmount = Math.round(parsedUsd * localRate);
    const formattedAmount = calculatedLocalAmount.toFixed(2);

    // Formatage et validation du téléphone (ex: +225..., +237...)
    let cleanPhone = (phone || '').replace(/\s+/g, '');
    if (cleanPhone && !cleanPhone.startsWith('+')) {
      const prefixes = { CI: '+225', CM: '+237', BJ: '+229', SN: '+221', BF: '+226', TG: '+228', GN: '+224', ML: '+223' };
      const pfx = prefixes[countryCode] || '+225';
      if (!cleanPhone.startsWith(pfx.replace('+', ''))) {
        cleanPhone = pfx + cleanPhone;
      } else {
        cleanPhone = '+' + cleanPhone;
      }
    }

    const txId = 'TXN-SP-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const idempotencyKey = crypto.randomUUID();

    // Enregistrement initial dans la base locale en statut 'pending'
    const transaction = db.createTransaction({
      id: txId,
      userId: user.id,
      amount: Math.round(parsedUsd * 100) / 100, // Montant USD à créditer après succès réel
      currency: 'USD',
      paymentMethod: `Mobile Money (${network || countryCode})`,
      provider: 'saspay',
      providerTxId: null,
      status: 'pending', // Strictement pending
      idempotencyKey: idempotencyKey,
      metadata: {
        localAmount: formattedAmount,
        localCurrency: currency,
        country: countryCode,
        network: network || 'direct',
        phone: cleanPhone,
        customerName: customerName || user.name,
        customerEmail: customerEmail || user.email
      }
    });

    console.log(`[SasPay] Nouvelle transaction initiée : ${txId} (${parsedUsd} USD -> ${formattedAmount} ${currency}) par ${user.email}`);

    // Appel à l'API SasPay
    try {
      let saspayResult = null;

      if (!network || network === 'checkout_hosted') {
        // Option A : Création d'une session de checkout hébergée SasPay
        const sessionPayload = {
          amount: formattedAmount,
          currency: currency,
          description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD - ${user.email}`,
          country: countryCode,
          customer_email: (customerEmail && !customerEmail.includes('admin@')) ? customerEmail.trim() : (user.role !== 'admin' && !user.email.includes('admin@') ? user.email.trim() : `client_${user.id}@getvirtu.shop`),
          customer_name: customerName || user.name,
          customer_phone: cleanPhone || '',
          return_url: returnUrl || 'https://getvirtu.shop/#deposit_success',
          metadata: {
            internalTxId: txId,
            userId: user.id,
            amountUsd: parsedUsd.toFixed(2)
          }
        };

        const res = await this.requestSasPay('/checkout-sessions/', 'POST', sessionPayload);
        if (!res.ok || !res.data?.success) {
          const errMsg = res.data?.error?.message || res.data?.message || 'Échec de création de la session SasPay.';
          db.updateTransaction(txId, { status: 'failed', failureReason: errMsg });
          throw new Error(errMsg);
        }

        saspayResult = res.data.data;
        db.updateTransaction(txId, { providerTxId: saspayResult.id });

        return {
          success: true,
          transactionId: txId,
          providerTxId: saspayResult.id,
          status: 'pending',
          checkoutUrl: saspayResult.checkout_url,
          mode: 'checkout',
          amountUsd: parsedUsd,
          localAmount: formattedAmount,
          currency: currency,
          instructions: 'Redirection vers la page de paiement sécurisée Mobile Money...'
        };
      } else {
        // Option B : Softpay direct (push sur téléphone ou lien direct opérateur comme Wave)
        const nameParts = (customerName || user.name || 'Client GetVirtu').trim().split(' ');
        const firstName = nameParts[0] || 'Client';
        const lastName = nameParts.slice(1).join(' ') || 'GetVirtu';

        const softpayPayload = {
          amount: formattedAmount,
          currency: currency,
          country: countryCode,
          network: network,
          customer: {
            email: (customerEmail && !customerEmail.includes('admin@')) ? customerEmail.trim() : (user.role !== 'admin' && !user.email.includes('admin@') ? user.email.trim() : `client_${user.id}@getvirtu.shop`),
            first_name: firstName,
            last_name: lastName,
            phone: cleanPhone || '+2250700000000'
          },
          description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD`,
          return_url: returnUrl || 'https://getvirtu.shop/#deposit_success',
          metadata: {
            internalTxId: txId,
            userId: user.id,
            amountUsd: parsedUsd.toFixed(2)
          }
        };

        const res = await this.requestSasPay('/payments/softpay/', 'POST', softpayPayload, {
          'Idempotency-Key': idempotencyKey
        });

        if (!res.ok || !res.data?.success) {
          const errMsg = res.data?.error?.message || res.data?.message || 'Erreur lors de l\'initiation Mobile Money.';
          db.updateTransaction(txId, { status: 'failed', failureReason: errMsg });
          throw new Error(errMsg);
        }

        saspayResult = res.data.data;
        db.updateTransaction(txId, { providerTxId: saspayResult.id });

        return {
          success: true,
          transactionId: txId,
          providerTxId: saspayResult.id,
          status: 'pending',
          checkoutUrl: saspayResult.checkout_url || null,
          instructions: saspayResult.instructions || ['Demande de paiement envoyée sur votre téléphone. Veuillez valider le prompt avec votre code secret.'],
          mode: saspayResult.checkout_url ? 'redirect' : 'push',
          amountUsd: parsedUsd,
          localAmount: formattedAmount,
          currency: currency
        };
      }
    } catch (err) {
      console.error('[SasPay Error]', err.message);
      db.updateTransaction(txId, { status: 'failed', failureReason: err.message });
      throw err;
    }
  }

  /**
   * 2. VÉRIFICATION OFFICIELLE EN TEMPS RÉEL DU STATUT DU PAIEMENT (GET /payments/{id}/verify/)
   * Conforme aux règles d'or SasPay :
   * - Ne crédite le compte que si le statut officiel est 'SUCCESS'.
   * - Idempotent : protège contre tout double crédit.
   */
  async verifySasPayPayment({ transactionId, providerTxId }) {
    let tx = null;
    if (transactionId) tx = db.getTransactionById(transactionId);
    if (!tx && providerTxId) tx = db.getTransactionByProviderTxId(providerTxId);

    if (!tx) {
      if (providerTxId) {
        tx = {
          id: transactionId || `TXN-${providerTxId.substring(0, 8).toUpperCase()}`,
          providerTxId: providerTxId,
          amount: 0,
          status: 'pending'
        };
      } else {
        throw new Error('Transaction introuvable dans la base de données.');
      }
    }

    const effectiveProviderTxId = providerTxId || tx.providerTxId;
    if (!effectiveProviderTxId) {
      return { success: false, status: tx.status, message: 'Identifiant SasPay manquant.' };
    }

    // Protection Idempotence : si la transaction a déjà été validée avec succès
    let user = tx.userId ? db.getUserById(tx.userId) : null;
    if (!user && tx.userEmail) {
      user = db.getUserByEmail(tx.userEmail);
    }
    if (tx.status === 'completed') {
      return {
        success: true,
        status: 'completed',
        alreadyCompleted: true,
        transaction: tx,
        newBalance: user ? user.balance : 0
      };
    }

    if (tx.status === 'failed' || tx.status === 'cancelled') {
      return {
        success: false,
        status: tx.status,
        message: tx.failureReason || 'Cette transaction a été annulée ou a échoué.'
      };
    }

    // Appel de vérification officielle auprès de l'API SasPay
    try {
      const verifyRes = await this.requestSasPay(`/payments/${effectiveProviderTxId}/verify/`, 'GET');

      if (!verifyRes.ok) {
        // Tentative de vérification par statut de session de checkout si c'était une session
        const sessionRes = await this.requestSasPay(`/checkout-sessions/${effectiveProviderTxId}/status/`, 'GET');
        if (sessionRes.ok && sessionRes.data?.success) {
          const sData = sessionRes.data.data;
          if (sData.transaction_id) {
            // S'il y a une transaction associée, la vérifier
            return await this.verifySasPayPayment({ transactionId: tx.id, providerTxId: sData.transaction_id });
          }
        }
        return { success: true, status: 'pending', message: 'Vérification en cours auprès de l\'opérateur...' };
      }

      const pData = verifyRes.data?.data || verifyRes.data;
      const officialStatus = (pData?.status || '').toUpperCase();

      console.log(`[SasPay Verify] Statut officiel pour ${tx.id} (${effectiveProviderTxId}) : ${officialStatus}`);

      if (officialStatus === 'SUCCESS') {
        // CRÉDIT ATOMIQUE SÉCURISÉ DU SOLDE UTILISATEUR
        // Revérification anti-race condition
        const freshTx = db.getTransactionById(tx.id);
        if (freshTx && freshTx.status === 'completed') {
          return { success: true, status: 'completed', newBalance: user.balance, transaction: freshTx };
        }

        if (!user) {
          user = db.createUser({
            id: tx.userId || `user-${Date.now()}`,
            email: tx.userEmail || `client_${tx.id}@getvirtu.shop`,
            name: tx.userName || 'Client GetVirtu',
            role: 'client',
            balance: 0.00
          });
        }

        const creditAmount = tx.amount || 0; // Montant en USD
        const newBalance = Math.round(((user.balance || 0) + creditAmount) * 100) / 100;

        db.updateUser(user.id, { balance: newBalance });

        const completedTx = db.updateTransaction(tx.id, {
          status: 'completed',
          providerTxId: effectiveProviderTxId,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Mise à jour de l'historique de recharge du client
        var recharges = db.data.recharges || [];
        var rIdx = recharges.findIndex(r => r.id === tx.id);
        if (rIdx !== -1) {
          recharges[rIdx].status = 'Validé';
          db.persist();
        }

        console.log(`[SasPay Confirmation] Transaction ${tx.id} confirmée avec succès. Solde de ${user.email} crédité de +${creditAmount} USD. Nouveau solde : ${newBalance} USD.`);

        return {
          success: true,
          status: 'completed',
          newBalance: newBalance,
          creditedAmount: creditAmount,
          transaction: completedTx,
          message: 'Paiement confirmé avec succès ! Votre solde a été crédité.'
        };
      } else if (officialStatus === 'FAILED' || officialStatus === 'CANCELLED' || officialStatus === 'EXPIRED') {
        // Marquage de la transaction comme échouée
        const failedTx = db.updateTransaction(tx.id, {
          status: 'failed',
          failureReason: pData?.message || `Paiement rejeté par l'opérateur (Statut: ${officialStatus}).`,
          updatedAt: new Date().toISOString()
        });
        return {
          success: false,
          status: 'failed',
          message: failedTx.failureReason,
          transaction: failedTx
        };
      } else {
        // Toujours en attente (PENDING / PROCESSING)
        return {
          success: true,
          status: 'pending',
          message: 'En attente de validation sur votre téléphone portable.'
        };
      }
    } catch (err) {
      console.warn('[SasPay Verify Warning]', err.message);
      return { success: true, status: 'pending', message: 'Vérification en cours...' };
    }
  }

  /**
   * 3. GESTION DU WEBHOOK OFFICIEL SASPAY
   * Format documenté : https://docs.saspay.me/api-reference/webhooks
   * Headers : X-Webhook-Signature, X-Webhook-Timestamp, X-Webhook-Event
   * Vérification de signature HMAC SHA-256 avec tolérance d'horloge de 300 secondes.
   */
  async handleWebhook({ headers = {}, rawBody, payload }) {
    console.log('[SasPay Webhook] Réception notification webhook...');

    const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
    const timestamp = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];
    const eventType = headers['x-webhook-event'] || headers['X-Webhook-Event'] || payload?.event;

    // 1. Contrôle de signature cryptographique (si secret configuré)
    if (SASPAY_WEBHOOK_SECRET) {
      if (!signature || !timestamp) {
        throw new Error('Headers de signature webhook manquants.');
      }

      // Contrôle de l'âge du webhook (tolérance de 300 secondes)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        throw new Error('Horodatage du webhook hors tolérance (> 300s).');
      }

      // Calcul de la signature HMAC SHA-256 sur timestamp.rawBody
      const bodyToSign = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload);
      const expectedSignature = crypto
        .createHmac('sha256', SASPAY_WEBHOOK_SECRET)
        .update(`${timestamp}.${bodyToSign}`)
        .digest('hex');

      const sigBuffer = Buffer.from(signature);
      const expBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
        throw new Error('Signature du webhook SasPay invalide.');
      }
    }

    // 2. Traitement de l'événement
    const eventData = payload?.data || {};
    const saspayId = eventData.id;
    const ref = eventData.reference;
    const internalTxId = eventData.metadata?.internalTxId;

    if (!saspayId && !internalTxId && !ref) {
      return { success: false, message: 'Identifiant de transaction introuvable dans le webhook.' };
    }

    // Recherche de la transaction locale
    let tx = null;
    if (internalTxId) tx = db.getTransactionById(internalTxId);
    if (!tx && saspayId) tx = db.getTransactionByProviderTxId(saspayId);
    if (!tx && ref) {
      tx = db.data.transactions.find(t => t.id === ref || t.providerTxId === ref);
    }

    if (!tx) {
      console.warn(`[SasPay Webhook] Transaction non répertoriée pour saspayId: ${saspayId}`);
      return { success: true, message: 'Transaction non locale reçue.' };
    }

    if (eventType === 'transaction.success' || eventData.status === 'SUCCESS') {
      // Protection d'idempotence : ne créditer qu'une seule fois
      if (tx.status === 'completed') {
        console.log(`[SasPay Webhook] Transaction ${tx.id} déjà complétée (Idempotence).`);
        return { success: true, message: 'Déjà traitée.' };
      }

      const user = db.getUserById(tx.userId);
      if (!user) throw new Error('Utilisateur associé introuvable.');

      const newBalance = Math.round(((user.balance || 0) + tx.amount) * 100) / 100;
      db.updateUser(user.id, { balance: newBalance });

      db.updateTransaction(tx.id, {
        status: 'completed',
        providerTxId: saspayId || tx.providerTxId,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      console.log(`[SasPay Webhook] Transaction ${tx.id} validée. Utilisateur ${user.email} crédité de +${tx.amount} USD. Nouveau solde : ${newBalance} USD.`);
      return { success: true, message: 'Transaction complétée avec succès.' };
    } else if (eventType === 'transaction.failed' || eventData.status === 'FAILED') {
      db.updateTransaction(tx.id, {
        status: 'failed',
        failureReason: eventData.message || 'Paiement échoué via webhook.'
      });
      return { success: true, message: 'Transaction marquée comme échouée.' };
    }

    return { success: true, message: 'Événement traité.' };
  }

  /**
   * 4. MÉTHODES DE PAIEMENT & CRYPTO (CONSERVATION DU SYSTÈME EXISTANT)
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
      status: 'pending', // Début strict en pending
      idempotencyKey: idempotencyKey,
      proofImage: proofImage || null
    });

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

  async verifyAndCompleteTransaction({ transactionId, providerTxId, failureReason = null, isApproval = true }) {
    const transaction = db.getTransactionById(transactionId);
    if (!transaction) throw new Error('Transaction introuvable.');

    if (transaction.status === 'completed') {
      return { success: true, alreadyProcessed: true, transaction };
    }

    const user = db.getUserById(transaction.userId);
    if (!user) throw new Error('Utilisateur associé introuvable.');

    if (!isApproval) {
      const updated = db.updateTransaction(transactionId, {
        status: 'failed',
        failureReason: failureReason || 'Paiement rejeté lors de la vérification.',
        completedAt: new Date().toISOString()
      });
      return { success: true, transaction: updated };
    }

    const newBalance = Math.round(((user.balance || 0) + transaction.amount) * 100) / 100;
    db.updateUser(user.id, { balance: newBalance });

    const completedTx = db.updateTransaction(transactionId, {
      status: 'completed',
      providerTxId: providerTxId || transaction.providerTxId,
      completedAt: new Date().toISOString()
    });

    return { success: true, transaction: completedTx, newBalance };
  }

  getUserTransactions(userId) {
    return db.getTransactions({ userId });
  }

  // ========== INTÉGRATION OFFICIELLE CRYPTO TRYBIT ==========

  /**
   * Création d'une recharge de solde par Crypto Instantané via Trybit
   */
  async createTrybitDeposit({ userId, amountUsd, customerEmail, customerName, cryptocurrency, returnUrl }) {
    if (!userId) throw new Error('Utilisateur non authentifié.');
    let user = db.getUserById(userId);
    if (!user) throw new Error('Compte utilisateur introuvable.');

    const parsedUsd = parseFloat(amountUsd);
    const minRecharge = db.data.settings?.min_recharge || 5.0;

    if (isNaN(parsedUsd) || parsedUsd < minRecharge) {
      throw new Error(`Le montant minimum de recharge est de ${minRecharge.toFixed(2)} USD.`);
    }

    const idempotencyKey = crypto.randomBytes(16).toString('hex');
    const txId = 'TXN-TB-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    // Création de la transaction en statut strict 'pending'
    const tx = db.createTransaction({
      id: txId,
      userId: user.id,
      amount: Math.round(parsedUsd * 100) / 100,
      currency: 'USD',
      paymentMethod: 'Crypto Instantané (Trybit)',
      provider: 'trybit',
      providerTxId: null,
      status: 'pending',
      idempotencyKey: idempotencyKey,
      metadata: {
        customerEmail: customerEmail || user.email,
        customerName: customerName || user.name,
        cryptocurrency: cryptocurrency || null,
        returnUrl: returnUrl || 'https://getvirtu.shop/#deposit_success'
      }
    });

    console.log(`[Trybit] Initiation de paiement : ${txId} (${parsedUsd} USD) pour ${user.email}`);

    try {
      const isClientEmail = (em) => {
        if (!em || typeof em !== 'string' || !em.includes('@')) return false;
        const low = em.toLowerCase().trim();
        return !low.includes('admin@virtushop.com') && !low.includes('admin@getvirtu.shop') && !low.startsWith('admin@');
      };
      const safeEmail = isClientEmail(customerEmail) ? customerEmail.trim() : (isClientEmail(user.email) && user.role !== 'admin' ? user.email.trim() : null);

      const invoice = await trybitService.createInvoice({
        amount: parsedUsd,
        currency: 'USD',
        orderId: txId,
        email: safeEmail,
        cryptocurrency: cryptocurrency || null
      });

      // Mettre à jour la transaction avec l'identifiant Trybit (INV-XXXX) et le lien de paiement
      db.updateTransaction(txId, {
        providerTxId: invoice.uuid,
        metadata: {
          ...tx.metadata,
          invoiceUuid: invoice.uuid,
          paymentUrl: invoice.link,
          amountCrypto: invoice.amountCrypto,
          cryptoCurrency: invoice.currency,
          address: invoice.address,
          expiryDate: invoice.expiryDate
        }
      });

      return {
        success: true,
        transactionId: txId,
        invoiceUuid: invoice.uuid,
        paymentUrl: invoice.link,
        amountUsd: parsedUsd,
        amountCrypto: invoice.amountCrypto,
        currency: invoice.currency,
        address: invoice.address,
        status: 'pending',
        instructions: 'Redirection vers la page de paiement sécurisée Trybit...'
      };
    } catch (err) {
      db.updateTransaction(txId, {
        status: 'failed',
        failureReason: err.message
      });
      throw err;
    }
  }

  /**
   * Vérification du statut d'une transaction Trybit (requête active auprès de l'API Trybit)
   */
  async verifyTrybitPayment({ transactionId, invoiceUuid }) {
    let tx = null;
    if (transactionId) tx = db.getTransactionById(transactionId);
    if (!tx && invoiceUuid) tx = db.getTransactionByProviderTxId(invoiceUuid);
    if (!tx && invoiceUuid) {
      tx = db.data.transactions.find(t => t.metadata?.invoiceUuid === invoiceUuid || t.providerTxId === invoiceUuid);
    }

    if (!tx) {
      throw new Error('Transaction Trybit introuvable.');
    }

    if (tx.status === 'completed') {
      const user = db.getUserById(tx.userId);
      return { success: true, status: 'completed', newBalance: user ? user.balance : null, transaction: tx };
    }

    const effectiveUuid = invoiceUuid || tx.providerTxId || tx.metadata?.invoiceUuid;
    if (!effectiveUuid) {
      return { success: true, status: 'pending', message: 'En attente de paiement sur Trybit...' };
    }

    const infos = await trybitService.getInvoiceInfo(effectiveUuid);
    const invoiceData = Array.isArray(infos) && infos.length > 0 ? infos[0] : null;

    if (!invoiceData) {
      return { success: true, status: 'pending', message: 'Vérification Trybit en cours...' };
    }

    const invStatus = (invoiceData.status || '').toLowerCase();
    const invInvoiceStatus = (invoiceData.invoice_status || '').toLowerCase();

    console.log(`[Trybit Verify] Statut pour ${tx.id} (${effectiveUuid}) : status=${invStatus}, invoice_status=${invInvoiceStatus}`);

    if (invStatus === 'paid' || invStatus === 'overpaid' || invInvoiceStatus === 'success') {
      return this._creditUserForTransaction(tx, effectiveUuid, invoiceData);
    } else if (invStatus === 'canceled' || invStatus === 'cancelled') {
      const failedTx = db.updateTransaction(tx.id, {
        status: 'failed',
        failureReason: 'Paiement annulé ou expiré sur Trybit.'
      });
      return { success: false, status: 'failed', transaction: failedTx };
    }

    return {
      success: true,
      status: 'pending',
      message: 'Facture en attente de paiement ou de confirmation blockchain...'
    };
  }

  /**
   * Traitement officiel du POSTBACK webhook Trybit avec vérification JWT HS256
   */
  async handleTrybitWebhook(payload) {
    console.log('[Trybit POSTBACK] Traitement notification webhook...');
    if (!payload || typeof payload !== 'object') {
      throw new Error('Payload webhook Trybit invalide.');
    }

    const token = payload.token;
    if (token) {
      const isValid = trybitService.verifyWebhookToken(token);
      if (!isValid) {
        console.warn('[Trybit POSTBACK] Jeton JWT invalide ou expiré !');
        throw new Error('Jeton JWT du webhook Trybit invalide.');
      }
    }

    const orderId = payload.order_id;
    const invoiceId = payload.invoice_id;
    const invoiceInfo = payload.invoice_info || {};
    const uuid = invoiceInfo.uuid || (invoiceId ? (invoiceId.startsWith('INV-') ? invoiceId : `INV-${invoiceId}`) : null);

    let tx = null;
    if (orderId) tx = db.getTransactionById(orderId);
    if (!tx && uuid) tx = db.getTransactionByProviderTxId(uuid);
    if (!tx && uuid) {
      tx = db.data.transactions.find(t => t.metadata?.invoiceUuid === uuid || t.providerTxId === uuid);
    }

    if (!tx) {
      console.warn(`[Trybit POSTBACK] Transaction introuvable pour order_id: ${orderId}, uuid: ${uuid}`);
      return { success: true, message: 'Notification reçue (transaction non locale).' };
    }

    if (tx.status === 'completed') {
      console.log(`[Trybit POSTBACK] Transaction ${tx.id} déjà traitée (Idempotence).`);
      return { success: true, message: 'Déjà traitée.' };
    }

    const status = (payload.status || invoiceInfo.status || '').toLowerCase();
    const invoiceStatus = (invoiceInfo.invoice_status || '').toLowerCase();

    if (status === 'success' || status === 'paid' || status === 'overpaid' || invoiceStatus === 'success' || invoiceStatus === 'paid') {
      return this._creditUserForTransaction(tx, uuid, invoiceInfo);
    } else if (status === 'canceled' || status === 'cancelled') {
      db.updateTransaction(tx.id, {
        status: 'failed',
        failureReason: 'Annulé sur Trybit.'
      });
      return { success: true, message: 'Transaction marquée annulée.' };
    }

    return { success: true, message: 'Statut Trybit enregistré.' };
  }

  /**
   * Crédit atomique et sécurisé du solde utilisateur avec protection anti-race condition
   */
  _creditUserForTransaction(tx, providerTxId, extraData = {}) {
    const freshTx = db.getTransactionById(tx.id);
    if (freshTx && freshTx.status === 'completed') {
      const u = db.getUserById(freshTx.userId);
      return { success: true, status: 'completed', newBalance: u ? u.balance : null, transaction: freshTx };
    }

    let user = db.getUserById(tx.userId);
    if (!user) {
      user = db.createUser({
        id: tx.userId || `user-${Date.now()}`,
        email: tx.metadata?.customerEmail || `client_${tx.id}@getvirtu.shop`,
        name: tx.metadata?.customerName || 'Client GetVirtu',
        role: 'client',
        balance: 0.00
      });
    }

    const creditAmount = tx.amount || 0;
    const newBalance = Math.round(((user.balance || 0) + creditAmount) * 100) / 100;

    db.updateUser(user.id, { balance: newBalance });

    const completedTx = db.updateTransaction(tx.id, {
      status: 'completed',
      providerTxId: providerTxId || tx.providerTxId,
      completedAt: new Date().toISOString(),
      metadata: {
        ...tx.metadata,
        completedDetails: extraData
      }
    });

    var recharges = db.data.recharges || [];
    var rIdx = recharges.findIndex(r => r.id === tx.id);
    if (rIdx !== -1) {
      recharges[rIdx].status = 'Validé';
      db.persist();
    }

    console.log(`[Paiement Validé] Transaction ${tx.id} complétée. Solde ${user.email} crédité de +${creditAmount} USD. Nouveau solde : ${newBalance} USD.`);

    return {
      success: true,
      status: 'completed',
      newBalance: newBalance,
      creditedAmount: creditAmount,
      transaction: completedTx,
      message: 'Paiement confirmé avec succès ! Votre solde a été crédité.'
    };
  }
}

module.exports = new PaymentService();
