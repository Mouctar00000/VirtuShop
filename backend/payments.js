/**
 * GetVirtu — Payments (backend/payments.js)
 * SasPay (Mobile Money) and Trybit (crypto) deposits, manual deposits with proof, direct crypto purchases.
 *
 * Security rules applied everywhere:
 *  - A deposit always belongs to the authenticated user (never to a userId sent by the browser).
 *  - A balance is credited ONLY after a server-to-server check with the provider, using the provider id stored
 *    when the payment was created (webhooks are just triggers; client-supplied provider ids are ignored).
 *  - Crediting happens inside a database transaction and exactly once (idempotent).
 *  - The price of a direct purchase is computed by the server from the catalogue, never by the browser.
 *  - Network calls to providers are never made while the database is locked.
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const db = require('./db');
const trybitService = require('./trybit');
const { OFFICIAL_SASPAY_COUNTRIES, normalizePhoneNumber } = require('./saspay-countries');

const SASPAY_BASE_URL = process.env.SASPAY_BASE_URL || 'https://api.saspay.me/api/v1';
const MAX_DEPOSIT_USD = 5000;
const { roundMoney, cleanText } = db.helpers;

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function publicTx(t) {
  if (!t) return null;
  const { proofImage, idempotencyKey, ...rest } = t;
  return { ...rest, hasProof: Boolean(proofImage) };
}

class PaymentService {
  getCountries() {
    return OFFICIAL_SASPAY_COUNTRIES;
  }

  get sasPayKey() { return process.env.SASPAY_API_KEY || ''; }

  requestSasPay(endpoint, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
      const base = SASPAY_BASE_URL.endsWith('/') ? SASPAY_BASE_URL : SASPAY_BASE_URL + '/';
      const url = new URL(cleanEndpoint, base);
      const postData = body ? JSON.stringify(body) : null;
      const reqHeaders = { Authorization: `Bearer ${this.sasPayKey}`, 'Content-Type': 'application/json', ...headers };
      if (postData) reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      const req = https.request(url, { method, headers: reqHeaders, timeout: 15000 }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw: data ? undefined : raw });
        });
      });
      req.on('error', (err) => reject(httpError(502, 'Erreur de communication avec SasPay: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(httpError(504, "Délai d'attente dépassé avec SasPay (Timeout).")); });
      if (postData) req.write(postData);
      req.end();
    });
  }

  _validateAmount(amount, min) {
    const v = roundMoney(parseFloat(amount));
    if (!isFinite(v) || v < min) throw httpError(400, `Le montant minimum est de $${min.toFixed(2)} USD.`);
    if (v > MAX_DEPOSIT_USD) throw httpError(400, `Le montant maximum par paiement est de $${MAX_DEPOSIT_USD} USD.`);
    return v;
  }

  _customerEmail(user, provided) {
    const ok = em => typeof em === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.trim()) && !em.trim().toLowerCase().startsWith('admin@');
    if (ok(provided)) return provided.trim();
    if (user.role !== 'admin' && ok(user.email)) return user.email.trim();
    return `client_${user.id}@getvirtu.shop`;
  }

  // ================================================================== SASPAY
  async createSasPayDeposit({ user, amountUsd, country, network, phone, otp, customerName, customerEmail, returnUrl, isPurchase, productId, preferredMode }) {
    if (!user) throw httpError(401, 'Veuillez vous connecter pour initier une recharge.');
    if (!this.sasPayKey) throw httpError(503, 'Clé API SasPay non configurée sur le serveur.');

    const isDirect = Boolean(isPurchase || productId);
    const settings = await db.read(() => db.getPublicSettings());
    const parsedUsd = this._validateAmount(amountUsd, isDirect ? 0.5 : settings.min_recharge);

    const countryCode = String(country || 'CI').toUpperCase();
    const cfg = OFFICIAL_SASPAY_COUNTRIES.find(c => c.code === countryCode) || OFFICIAL_SASPAY_COUNTRIES[0];
    const formattedAmount = Math.round(parsedUsd * cfg.rate).toFixed(2);
    const cleanPhone = normalizePhoneNumber(cleanText(phone, 30), cfg.code);
    const txId = 'TXN-SP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const idempotencyKey = crypto.randomUUID();
    const name = cleanText(customerName, 80) || user.name;
    const email = this._customerEmail(user, customerEmail);
    const safeReturn = this._safeReturnUrl(returnUrl, 'https://getvirtu.shop/#deposit_success');

    // Phase 1 — record the pending payment
    await db.tx(() => {
      const u = db.getUserById(user.id);
      if (!u) throw httpError(401, 'Session invalide.', 'SESSION_INVALID');
      db.createTransaction({
        id: txId, userId: u.id, userEmail: u.email, userName: u.name,
        amount: parsedUsd, currency: 'USD', paymentMethod: `Mobile Money (${cleanText(network, 40) || cfg.code})`,
        provider: 'saspay', status: 'pending', idempotencyKey,
        metadata: { localAmount: formattedAmount, localCurrency: cfg.currency, country: cfg.code, network: cleanText(network, 40) || 'direct', phone: cleanPhone, customerName: name, customerEmail: email }
      });
    });

    const fail = async (msg, status = 400) => {
      await db.tx(() => { db.updateTransaction(txId, { status: 'failed', failureReason: msg }); }).catch(() => {});
      throw httpError(status, msg);
    };

    // Phase 2 — provider call (no database lock held)
    const metadata = { internalTxId: txId, userId: user.id, amountUsd: parsedUsd.toFixed(2) };
    const checkoutPayload = {
      amount: formattedAmount,
      currency: cfg.currency,
      description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD`,
      country: cfg.code === 'ALL' ? undefined : cfg.code,
      customer_email: email,
      customer_name: name,
      customer_phone: cleanPhone || '',
      return_url: safeReturn,
      metadata
    };
    const finish = async (providerId, result) => {
      await db.tx(() => { db.updateTransaction(txId, { providerTxId: providerId || null }); });
      return result;
    };

    let res;
    const checkoutMode = (!network || network === 'checkout_hosted' || preferredMode === 'checkout');
    try {
      if (checkoutMode) {
        res = await this.requestSasPay('checkout-sessions/', 'POST', checkoutPayload);
        if (!res.ok || !res.data || !res.data.success) {
          return fail((res.data && (res.data.error && res.data.error.message || res.data.message)) || 'Échec de création de la session de paiement SasPay.');
        }
        const r = res.data.data;
        return finish(r.id, { success: true, transactionId: txId, providerTxId: r.id, status: 'pending', checkoutUrl: r.checkout_url, mode: 'checkout', amountUsd: parsedUsd, localAmount: formattedAmount, currency: cfg.currency, instructions: 'Paiement sécurisé via le guichet officiel SasPay.' });
      }

      let cleanNetwork = cleanText(network, 40).toLowerCase();
      if (cleanNetwork && !cleanNetwork.includes('_') && !['card', 'crypto', 'direct', 'togocel'].includes(cleanNetwork)) cleanNetwork = `${cleanNetwork}_${cfg.code.toLowerCase()}`;
      const parts = (name || 'Client GetVirtu').trim().split(/\s+/);
      const softpayPayload = {
        amount: formattedAmount,
        currency: cfg.currency,
        country: cfg.code,
        network: cleanNetwork,
        customer: { email, first_name: parts[0] || 'Client', last_name: parts.slice(1).join(' ') || 'GetVirtu', phone: cleanPhone || '' },
        description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD`,
        return_url: safeReturn,
        metadata
      };
      if (otp) softpayPayload.otp = cleanText(otp, 20);
      res = await this.requestSasPay('payments/softpay/', 'POST', softpayPayload, { 'Idempotency-Key': idempotencyKey });

      if (!res.ok || !res.data || !res.data.success) {
        const code = res.data && ((res.data.error && res.data.error.code) || res.data.code);
        const msg = (res.data && ((res.data.error && res.data.error.message) || res.data.message)) || '';
        const low = msg.toLowerCase();
        if (code === 'no_route_available' || low.includes('aucun fournisseur') || low.includes('no route') || low.includes('inactif')) {
          const op = cleanNetwork.includes('orange_cm') ? 'Orange Money Cameroun' : cleanNetwork.includes('mtn_cm') ? 'MTN MoMo Cameroun' : cleanNetwork.includes('orange') ? 'Orange Money' : cleanNetwork.includes('mtn') ? 'MTN MoMo' : cleanNetwork;
          return fail(`L'opérateur ${op} est temporairement indisponible auprès de la passerelle SasPay (${msg || 'maintenance technique'}). Veuillez sélectionner un autre opérateur ou le paiement Crypto.`);
        }
        // Fallback: hosted checkout session
        const fb = await this.requestSasPay('checkout-sessions/', 'POST', checkoutPayload);
        if (fb.ok && fb.data && fb.data.success) {
          const r = fb.data.data;
          return finish(r.id, { success: true, transactionId: txId, providerTxId: r.id, status: 'pending', checkoutUrl: r.checkout_url, mode: 'checkout', amountUsd: parsedUsd, localAmount: formattedAmount, currency: cfg.currency, instructions: 'Paiement sécurisé via le guichet officiel SasPay.' });
        }
        return fail(msg || "Erreur lors de l'initiation Mobile Money auprès de l'opérateur.");
      }

      const r = res.data.data || res.data || {};
      let instructions = Array.isArray(r.instructions) && r.instructions.length ? r.instructions : null;
      if (!instructions) {
        if (r.checkout_url) instructions = ['Cliquez sur "Ouvrir le paiement" ci-dessous pour finaliser la transaction.'];
        else if (cleanNetwork.startsWith('orange_cm')) instructions = ['Tapez #150*50#'];
        else if (cleanNetwork.startsWith('mtn_cm')) instructions = ["Validez l'invite USSD envoyée sur votre mobile ou composez le *126# pour approuver le prélèvement MTN MoMo."];
        else if (cleanNetwork.startsWith('orange_ci')) instructions = ["Transaction initiée avec votre code d'autorisation Orange Money. Validez si une invite s'affiche."];
        else if (cleanNetwork.startsWith('mtn_ci')) instructions = ['Validez la demande en composant le *133# sur votre mobile MTN MoMo.'];
        else if (cleanNetwork.startsWith('moov_')) instructions = ["Validez l'invite avec votre code PIN Moov Money sur votre mobile."];
        else if (cleanNetwork.startsWith('wave_')) instructions = ["Ouvrez l'application Wave pour confirmer le paiement."];
        else instructions = ['Validez la demande de débit avec votre code PIN secret sur votre téléphone portable.'];
      }
      return finish(r.id, { success: true, transactionId: txId, providerTxId: r.id, status: 'pending', checkoutUrl: r.checkout_url || null, instructions, mode: r.checkout_url ? 'redirect' : 'push', amountUsd: parsedUsd, localAmount: formattedAmount, currency: cfg.currency });
    } catch (err) {
      if (err.status && err.status < 500 && err.message) throw err; // already handled by fail()
      return fail(err.message || 'Erreur SasPay.', err.status || 502);
    }
  }

  /** Looks up a transaction for the caller (owner or administrator). */
  async _loadTxForCaller(transactionId, caller) {
    return db.read(() => {
      const t = db.getTransactionById(transactionId);
      if (!t) throw httpError(404, 'Transaction introuvable.');
      if (caller && caller.role !== 'admin' && String(t.userId) !== String(caller.id)) throw httpError(404, 'Transaction introuvable.');
      return JSON.parse(JSON.stringify(t));
    });
  }

  async _statusFor(txId) {
    return db.read(() => {
      const t = db.getTransactionById(txId);
      const u = t ? db.getUserById(t.userId) : null;
      return { transaction: publicTx(t), newBalance: u ? u.balance : null };
    });
  }

  /**
   * Server-to-server SasPay verification. `caller` is the authenticated user (null for webhook triggers).
   * Uses ONLY the provider id stored on the transaction (or ids returned by SasPay itself for that session).
   */
  async verifySasPayPayment({ transactionId, caller = null }) {
    const tx = await this._loadTxForCaller(transactionId, caller);
    if (tx.provider !== 'saspay') return { success: false, status: tx.status, message: 'Transaction non SasPay.' };
    if (tx.status === 'completed') { const s = await this._statusFor(tx.id); return { success: true, status: 'completed', alreadyCompleted: true, ...s }; }
    if (tx.status === 'failed' || tx.status === 'cancelled') return { success: true, status: tx.status, message: tx.failureReason || 'Cette transaction a été annulée ou a échoué.' };
    if (!tx.providerTxId) return { success: true, status: 'pending', message: 'Paiement en cours de création...' };
    if (!this.sasPayKey) return { success: true, status: 'pending', message: 'Vérification indisponible (SasPay non configuré).' };

    let paymentId = tx.providerTxId;
    let official = '';
    let pData = null;
    try {
      let vr = await this.requestSasPay(`payments/${encodeURIComponent(paymentId)}/verify/`, 'GET');
      if (!vr.ok) {
        // The stored id may be a checkout session: resolve the underlying payment through SasPay
        let sr = await this.requestSasPay(`checkout-sessions/${encodeURIComponent(paymentId)}/status/`, 'GET');
        if (!sr.ok || !sr.data) sr = await this.requestSasPay(`checkout-sessions/${encodeURIComponent(paymentId)}/`, 'GET');
        if (!(sr.ok && sr.data && sr.data.success)) return { success: true, status: 'pending', message: "Vérification en cours auprès de l'opérateur..." };
        const sData = sr.data.data || sr.data;
        const sStatus = String(sData.status || '').toUpperCase();
        const tStatus = String(sData.transaction_status || '').toUpperCase();
        if (sStatus === 'EXPIRED' || sStatus === 'FAILED' || sStatus === 'CANCELLED' || tStatus === 'FAILED') {
          await db.tx(() => { const t = db.getTransactionById(tx.id); if (t && t.status === 'pending') db.updateTransaction(tx.id, { status: 'failed', failureReason: `Session de paiement ${sStatus.toLowerCase() || 'échouée'}.` }); });
          return { success: false, status: 'failed', message: `Session de paiement ${sStatus.toLowerCase() || 'échouée'}.` };
        }
        if (!(sStatus === 'PAID' || sStatus === 'SUCCESS' || tStatus === 'SUCCESS')) return { success: true, status: 'pending', message: 'Session en attente de validation sur votre téléphone portable...' };
        paymentId = (sData.transaction && typeof sData.transaction === 'object' ? sData.transaction.id : sData.transaction) || sData.transaction_id;
        if (!paymentId) return { success: true, status: 'pending', message: 'Paiement en cours de confirmation...' };
        vr = await this.requestSasPay(`payments/${encodeURIComponent(paymentId)}/verify/`, 'GET');
        if (!vr.ok) return { success: true, status: 'pending', message: 'Paiement en cours de confirmation...' };
      }
      pData = (vr.data && (vr.data.data || vr.data)) || {};
      official = String(pData.status || '').toUpperCase();
    } catch (err) {
      return { success: true, status: 'pending', message: 'Vérification en cours...' };
    }

    if (official === 'SUCCESS') {
      // Defense in depth: the provider record must belong to this transaction when SasPay echoes our metadata
      const echoed = pData && pData.metadata && pData.metadata.internalTxId;
      if (echoed && echoed !== tx.id) {
        console.error('[SasPay] Provider payment metadata does not match transaction', tx.id);
        return { success: false, status: 'pending', message: 'Paiement non concordant : contactez le support.' };
      }
      const res = await db.tx(() => db.creditDeposit(tx.id, { providerTxId: paymentId }));
      const s = await this._statusFor(tx.id);
      return { success: true, status: 'completed', newBalance: s.newBalance, creditedAmount: res.creditedAmount, transaction: s.transaction, message: 'Paiement confirmé avec succès ! Votre solde a été crédité.' };
    }
    if (official === 'FAILED' || official === 'CANCELLED' || official === 'EXPIRED') {
      let reason = `Paiement ${official === 'EXPIRED' ? 'expiré' : 'rejeté'} par l'opérateur.`;
      try {
        const d = await this.requestSasPay(`transactions/${encodeURIComponent(paymentId)}/`, 'GET');
        const logs = (d.ok && d.data && d.data.data && d.data.data.status_logs) || [];
        const raw = String((logs.slice(-1)[0] || {}).reason || '').trim();
        if (raw.includes('INSUFFICIENT_BALANCE')) {
          const txData = d.data.data;
          const amt = txData.debited_amount ? `${Math.round(parseFloat(txData.debited_amount))} ${txData.currency || 'XAF'}` : 'le montant avec frais';
          reason = `Solde insuffisant sur votre compte Mobile Money. Prévoyez au moins ${amt} (frais réseau inclus) sur votre SIM pour valider ce paiement.`;
        } else if (raw.includes('TIMED_OUT') || raw.includes('EXPIRED')) reason = "Délai de validation dépassé. Vous n'avez pas validé la transaction à temps sur votre téléphone portable.";
        else if (raw.includes('USER_REJECTED') || raw.includes('CANCELLED')) reason = 'La transaction a été annulée ou refusée depuis votre téléphone portable.';
        else if (raw.includes('INVALID_PIN')) reason = 'Code secret PIN erroné lors de la validation sur votre téléphone.';
        else if (raw) reason = cleanText(raw, 300);
      } catch (e) {}
      await db.tx(() => { const t = db.getTransactionById(tx.id); if (t && t.status === 'pending') db.updateTransaction(tx.id, { status: 'failed', failureReason: reason }); });
      return { success: true, status: 'failed', message: reason };
    }
    return { success: true, status: 'pending', message: 'En attente de validation sur votre téléphone portable.' };
  }

  /** SasPay webhook: optional signature check, then server-to-server verification. Payload is never trusted. */
  async handleWebhook({ headers = {}, rawBody, payload }) {
    const secret = process.env.SASPAY_WEBHOOK_SECRET || '';
    if (secret) {
      const signature = String(headers['x-webhook-signature'] || '');
      const timestamp = String(headers['x-webhook-timestamp'] || '');
      if (!signature || !timestamp) throw httpError(401, 'Headers de signature webhook manquants.');
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) throw httpError(401, 'Horodatage du webhook hors tolérance.');
      const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${typeof rawBody === 'string' ? rawBody : JSON.stringify(payload)}`).digest('hex');
      const a = Buffer.from(signature), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, 'Signature du webhook SasPay invalide.');
    }
    const ev = (payload && payload.data) || {};
    const internalTxId = ev.metadata && ev.metadata.internalTxId;
    const txId = await db.read(() => {
      let t = internalTxId ? db.getTransactionById(internalTxId) : null;
      if (!t && ev.id) t = db.getTransactionByProviderTxId(ev.id);
      if (!t && ev.reference) t = db.getTransactionById(ev.reference) || db.getTransactionByProviderTxId(ev.reference);
      return t && t.provider === 'saspay' ? t.id : null;
    });
    if (!txId) return { success: true, message: 'Notification reçue.' };
    const r = await this.verifySasPayPayment({ transactionId: txId });
    return { success: true, message: 'Statut vérifié auprès de SasPay.', status: r.status };
  }

  // ================================================================== MANUAL DEPOSITS (proof of payment)
  async createDepositRequest({ user, amount, currency = 'USD', paymentMethodId, proofImage }) {
    if (!user) throw httpError(401, 'Veuillez vous connecter pour initier une recharge.');
    const settings = await db.read(() => db.getPublicSettings());
    const parsed = this._validateAmount(amount, settings.min_recharge);
    if (!proofImage) throw httpError(400, 'Veuillez joindre la preuve de paiement (capture d\'écran).');
    const proofId = await db.saveImageDataUrl(proofImage, { isPrivate: true, maxBytes: 2 * 1024 * 1024 });
    return db.tx(() => {
      const u = db.getUserById(user.id);
      if (!u) throw httpError(401, 'Session invalide.', 'SESSION_INVALID');
      const method = db.getPaymentMethods().find(m => m.id === parseInt(paymentMethodId, 10) && m.enabled !== false);
      if (!method) throw httpError(400, 'Moyen de paiement inconnu ou désactivé.');
      const t = db.createTransaction({
        userId: u.id, userEmail: u.email, userName: u.name,
        amount: parsed, currency: String(currency || 'USD').toUpperCase().slice(0, 5),
        paymentMethod: method.name, provider: method.type || 'manual', status: 'pending',
        idempotencyKey: crypto.randomBytes(16).toString('hex'), proofImage: proofId
      });
      return {
        success: true,
        transaction: publicTx(t),
        paymentInstructions: { methodName: method.name, address: method.address, network: method.network || '', instructions: method.instructions }
      };
    });
  }

  /** Administrator approval/rejection of a pending deposit (manual or stuck automatic one). */
  async verifyAndCompleteTransaction({ transactionId, failureReason = null, isApproval = true, adminName }) {
    return db.tx(() => {
      const t = db.getTransactionById(transactionId);
      if (!t) throw httpError(404, 'Transaction introuvable.');
      if (t.status === 'completed') return { success: true, alreadyProcessed: true, transaction: publicTx(t) };
      if (!['deposit'].includes(t.type)) throw httpError(400, 'Seules les recharges en attente peuvent être validées.');
      if (!isApproval) {
        const updated = db.updateTransaction(t.id, { status: 'failed', failureReason: cleanText(failureReason, 300) || 'Paiement rejeté lors de la vérification.', completedAt: new Date().toISOString(), adminResponsible: adminName });
        return { success: true, transaction: publicTx(updated) };
      }
      const r = db.creditDeposit(t.id, {});
      db.updateTransaction(t.id, { adminResponsible: adminName, notes: t.notes || `Validée manuellement par ${adminName}` });
      return { success: true, transaction: publicTx(r.transaction), newBalance: r.newBalance };
    });
  }

  async getUserTransactions(userId) {
    return db.read(() => db.getTransactions({ userId }).map(publicTx));
  }

  // ================================================================== TRYBIT
  async createTrybitDeposit({ user, amountUsd, customerEmail, cryptocurrency, returnUrl, productId, quantity, contactInfo }) {
    if (!user) throw httpError(401, 'Veuillez vous connecter pour initier une recharge.');
    const txId = 'TXN-TB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const crypt = cleanText(cryptocurrency, 20) || null;

    // Phase 1 — compute the amount on the server and record the pending payment
    const prepared = await db.tx(() => {
      const u = db.getUserById(user.id);
      if (!u) throw httpError(401, 'Session invalide.', 'SESSION_INVALID');
      let amount;
      let meta = { customerEmail: this._customerEmail(u, customerEmail), customerName: u.name, cryptocurrency: crypt, returnUrl: this._safeReturnUrl(returnUrl, 'https://getvirtu.shop/?payment_status=success') };
      if (productId) {
        if (u.role === 'admin') throw httpError(403, 'Un compte administrateur ne peut pas passer de commande.');
        const p = db.getProductById(productId);
        if (!p || p.published !== true) throw httpError(404, "Ce produit n'est plus disponible dans la boutique.", 'PRODUCT_UNAVAILABLE');
        const qty = parseInt(quantity, 10) || 1;
        if (qty < 1 || qty > 100) throw httpError(400, 'Quantité invalide (1 à 100).');
        if ((parseInt(p.stock, 10) || 0) < qty) throw httpError(409, `Stock insuffisant : ${p.stock} disponible(s).`, 'INSUFFICIENT_STOCK');
        amount = roundMoney(p.price * qty); // never the amount sent by the browser
        if (amount < 0.5) throw httpError(400, 'Montant trop faible pour un paiement crypto (minimum $0.50).');
        meta = { ...meta, productId: p.id, productName: p.name, quantity: qty, unitPrice: p.price, contactInfo: cleanText(contactInfo, 120) || null };
      } else {
        amount = this._validateAmount(amountUsd, db.getPublicSettings().min_recharge);
      }
      db.createTransaction({
        id: txId, userId: u.id, userEmail: u.email, userName: u.name,
        amount, currency: 'USD', paymentMethod: 'Crypto Instantané (Trybit)', provider: 'trybit', status: 'pending',
        idempotencyKey: crypto.randomBytes(16).toString('hex'), metadata: meta
      });
      return { amount, email: meta.customerEmail };
    });

    // Phase 2 — create the invoice (no lock held)
    let invoice;
    try {
      invoice = await trybitService.createInvoice({ amount: prepared.amount, currency: 'USD', orderId: txId, email: prepared.email, cryptocurrency: crypt });
    } catch (err) {
      await db.tx(() => { db.updateTransaction(txId, { status: 'failed', failureReason: cleanText(err.message, 300) }); }).catch(() => {});
      throw httpError(502, err.message || 'Échec de création de la facture Trybit.');
    }
    // Phase 3 — store the provider invoice id
    await db.tx(() => {
      const t = db.getTransactionById(txId);
      db.updateTransaction(txId, {
        providerTxId: invoice.uuid,
        metadata: { ...(t.metadata || {}), invoiceUuid: invoice.uuid, paymentUrl: invoice.link, amountCrypto: invoice.amountCrypto, cryptoCurrency: invoice.currency, address: invoice.address, expiryDate: invoice.expiryDate }
      });
    });
    return {
      success: true, transactionId: txId, invoiceUuid: invoice.uuid, paymentUrl: invoice.link, amountUsd: prepared.amount,
      amountCrypto: invoice.amountCrypto, currency: invoice.currency, address: invoice.address, status: 'pending',
      instructions: 'Redirection vers la page de paiement sécurisée Trybit...'
    };
  }

  async verifyTrybitPayment({ transactionId, caller = null }) {
    const tx = await this._loadTxForCaller(transactionId, caller);
    if (tx.provider !== 'trybit') return { success: false, status: tx.status, message: 'Transaction non Trybit.' };
    if (tx.status === 'completed') { const s = await this._statusFor(tx.id); return { success: true, status: 'completed', ...s }; }
    if (tx.status === 'failed') return { success: false, status: 'failed', message: tx.failureReason || 'Paiement annulé ou expiré.' };
    const uuid = tx.providerTxId || (tx.metadata && tx.metadata.invoiceUuid);
    if (!uuid) return { success: true, status: 'pending', message: 'En attente de paiement sur Trybit...' };

    let info;
    try {
      const infos = await trybitService.getInvoiceInfo(uuid);
      info = Array.isArray(infos) ? infos.find(i => i && (i.uuid === uuid || !i.uuid)) || infos[0] : null;
    } catch (e) {
      return { success: true, status: 'pending', message: 'Vérification Trybit en cours...' };
    }
    if (!info) return { success: true, status: 'pending', message: 'Vérification Trybit en cours...' };
    const st = String(info.status || '').toLowerCase();
    const ist = String(info.invoice_status || '').toLowerCase();
    if (info.order_id && info.order_id !== tx.id) {
      console.error('[Trybit] Invoice order_id does not match transaction', tx.id);
      return { success: false, status: 'pending', message: 'Paiement non concordant : contactez le support.' };
    }
    if (st === 'paid' || st === 'overpaid' || st === 'success' || ist === 'success') {
      const result = await db.tx(() => this._settleTrybit(tx.id, uuid, { status: st, invoice_status: ist, amount_usd: info.amount_usd }));
      const s = await this._statusFor(tx.id);
      return { success: true, status: 'completed', newBalance: s.newBalance, creditedAmount: tx.amount, transaction: s.transaction, order: result.order || null, message: 'Paiement Trybit confirmé avec succès !' };
    }
    if (st === 'canceled' || st === 'cancelled' || st === 'expired') {
      await db.tx(() => { const t = db.getTransactionById(tx.id); if (t && t.status === 'pending') db.updateTransaction(tx.id, { status: 'failed', failureReason: 'Paiement annulé ou expiré sur Trybit.' }); });
      return { success: false, status: 'failed', message: 'Paiement annulé ou expiré sur Trybit.' };
    }
    return { success: true, status: 'pending', message: 'Facture en attente de paiement ou de confirmation blockchain...' };
  }

  /** Inside db.tx: credits the balance or delivers the directly purchased product — exactly once. */
  _settleTrybit(txId, providerTxId, extra) {
    const t = db.getTransactionById(txId);
    if (!t) throw httpError(404, 'Transaction introuvable.');
    if (t.status === 'completed') return { alreadyCompleted: true };
    const user = db.getUserById(t.userId);
    if (!user) throw httpError(404, 'Client de la transaction introuvable.');
    const meta = t.metadata || {};
    if (meta.productId) {
      const p = db.getProductById(meta.productId);
      if (!p) {
        // Product deleted meanwhile: the payment is kept as balance
        const r = db.creditDeposit(t.id, { providerTxId, extra });
        db.updateTransaction(t.id, { notes: `Produit ${meta.productName || meta.productId} supprimé : montant crédité sur le solde.` });
        return { credited: r.creditedAmount };
      }
      const qty = parseInt(meta.quantity, 10) || 1;
      const orderId = 'ORD-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      let status = db.ORDER_STATUS.DONE;
      let deliveryMode = p.deliveryMode === 'manual' ? 'manual' : 'auto';
      let vaultContent = null;
      let note;
      try {
        const alloc = db.allocateKeysForProduct(p.id, qty, { orderId, userId: user.id, userEmail: user.email });
        if (alloc.manualDelivery) status = db.ORDER_STATUS.PENDING;
        else if (alloc.fileDelivery) vaultContent = alloc.fileDelivery;
        else {
          const keys = alloc.allocatedKeys.map(k => ({ id: k.id, content: k.content }));
          vaultContent = { type: alloc.vaultType === 'link' ? 'link' : 'text', content: keys.map(k => k.content).join('\n'), keys, fileName: 'licences.txt' };
        }
      } catch (e) {
        status = db.ORDER_STATUS.PENDING;
        deliveryMode = 'manual';
        note = 'Paiement reçu, stock épuisé au moment de la livraison automatique : livraison manuelle requise.';
      }
      const order = db.createOrder({
        id: orderId, userId: user.id, userEmail: user.email, userName: user.name,
        productId: p.id, productName: p.name, unitPrice: meta.unitPrice || p.price, quantity: qty, amount: t.amount,
        remainingBalance: user.balance, userBalanceAfter: user.balance, contactInfo: meta.contactInfo || '',
        method: 'Crypto Instantané (Trybit)', transactionId: t.id, deliveryMode, deliveryNote: note, status, vaultContent, refunded: false
      });
      db.updateTransaction(t.id, {
        status: 'completed', type: 'purchase_crypto', providerTxId: providerTxId || t.providerTxId,
        completedAt: new Date().toISOString(), metadata: { ...meta, orderId, completedDetails: extra }
      });
      return { order };
    }
    const r = db.creditDeposit(t.id, { providerTxId, extra });
    return { credited: r.creditedAmount };
  }

  /** Trybit postback: only a trigger, the invoice status is re-checked with the Trybit API. */
  async handleTrybitWebhook(payload = {}, headers = {}) {
    if (!payload || typeof payload !== 'object') throw httpError(400, 'Payload webhook Trybit invalide.');
    let token = payload.token || payload.jwt || String(headers['authorization'] || '').replace(/^(Bearer|Token)\s+/i, '').trim() || headers['x-token'] || '';
    let tokenPayload = null;
    if (token) {
      const v = trybitService.verifyWebhookToken(token);
      if (v.valid) tokenPayload = v.payload;
    }
    const orderId = payload.order_id || (tokenPayload && tokenPayload.order_id) || payload.orderId;
    const invoiceId = payload.invoice_id || (tokenPayload && tokenPayload.invoice_id);
    const info = payload.invoice_info || (tokenPayload && tokenPayload.invoice_info) || {};
    const uuid = info.uuid || (invoiceId ? (String(invoiceId).startsWith('INV-') ? invoiceId : `INV-${invoiceId}`) : null);
    const txId = await db.read(() => {
      let t = orderId ? db.getTransactionById(orderId) : null;
      if (!t && uuid) t = db.getTransactionByProviderTxId(uuid);
      if (!t && invoiceId) t = db.getTransactionByProviderTxId(invoiceId);
      return t && t.provider === 'trybit' ? t.id : null;
    });
    if (!txId) return { success: true, message: 'Notification reçue.' };
    const r = await this.verifyTrybitPayment({ transactionId: txId });
    return { success: true, message: 'Statut vérifié auprès de Trybit.', status: r.status };
  }

  _safeReturnUrl(url, fallback) {
    try {
      const u = new URL(String(url || ''));
      const allowed = ['getvirtu.shop', 'www.getvirtu.shop', 'localhost', '127.0.0.1'];
      if ((u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) &&
          (allowed.includes(u.hostname) || /\.vercel\.app$/.test(u.hostname))) return u.toString();
    } catch (e) {}
    return fallback;
  }
}

module.exports = new PaymentService();
module.exports.publicTx = publicTx;
