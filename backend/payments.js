/**
 * GetVirtu — Payments (backend/payments.js)
 * SasPay (Mobile Money) deposits with optional automatic order, manual deposits with proof.
 *
 * Security rules applied everywhere:
 *  - A deposit always belongs to the authenticated user (never to a userId sent by the browser).
 *  - A balance is credited ONLY after a server-to-server check with SasPay, using the provider id stored when the
 *    payment was created (webhooks are just triggers; client-supplied provider ids are ignored).
 *  - Crediting happens inside a database transaction and exactly once (idempotent).
 *  - The price of a product bought after a Mobile Money payment is computed by the server from the catalogue.
 *  - Network calls to providers are never made while the database is locked.
 *
 * SasPay reference: https://docs.saspay.me (responses wrapped in { success, data | error, code }).
 *  - POST /payments/softpay/          push on the customer's phone, or `checkout_url` to open (Wave, Orange CI...)
 *  - GET  /payments/{id}/verify/      real status re-checked with the operator (PENDING | SUCCESS | FAILED)
 *  - POST /checkout-sessions/         hosted payment page; GET /checkout-sessions/{id}/status/
 *  - GET  /transactions/{id}/         status_logs[].reason = reason given by the operator
 *  - Webhooks (configured in the SasPay dashboard only): { event, data:{ id, status, ... } },
 *    X-Webhook-Signature = hex HMAC-SHA256(secret, `${X-Webhook-Timestamp}.${raw body}`).
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('./db');
const { OFFICIAL_SASPAY_COUNTRIES, normalizeMobileNumber } = require('./saspay-countries');

const SASPAY_BASE_URL = process.env.SASPAY_BASE_URL || 'https://api.saspay.me/api/v1';
const SASPAY_TIMEOUT_MS = Math.max(1000, Number(process.env.SASPAY_TIMEOUT_MS) || 12000);
const MAX_DEPOSIT_USD = 5000;
const PUSH_VALIDATION_WINDOW_SEC = 180;     // operators cancel a push that is not validated within ~3 minutes
const CHECKOUT_TTL_MIN = 30;                // hosted payment pages expire (they would otherwise stay PENDING forever)
const PENDING_GIVE_UP_HOURS = 72;           // after that, a payment still PENDING at SasPay is closed as not completed
const RECONCILE_MIN_INTERVAL_MS = 20000;    // the same pending payment is not re-checked more often by reconciliation
const PUBLIC_SITE_URL = 'https://getvirtu.shop';
const { roundMoney, cleanText } = db.helpers;

// Texts returned by SasPay that carry no information for the customer
const GENERIC_PROVIDER_TEXT = /^(payment pushed successfully|payment initiated|paiement (initi|pouss)[ée]+.*|success|ok)\.?$/i;

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function publicTx(t) {
  if (!t) return null;
  const { proofImage, idempotencyKey, ...rest } = t;
  if (rest.metadata && rest.metadata.softpayRequest) {
    const { softpayRequest, ...meta } = rest.metadata;
    rest.metadata = meta;
  }
  return { ...rest, hasProof: Boolean(proofImage) };
}

function ageSeconds(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : 0;
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length <= 6) return s;
  return s.slice(0, Math.min(6, s.length - 4)) + '•'.repeat(Math.max(2, s.length - Math.min(6, s.length - 4) - 2)) + s.slice(-2);
}

function formatLocal(amount, currency) {
  const n = Math.round(parseFloat(amount));
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('fr-FR').replace(/ | /g, ' ') + ' ' + (currency || '');
}

function findNetwork(networkId) {
  for (const c of OFFICIAL_SASPAY_COUNTRIES) {
    const n = (c.networks || []).find(x => x.id === networkId);
    if (n) return { ...n, country: c };
  }
  return null;
}

function countryLabel(c) {
  return String((c && c.name) || '').replace(/\s*\S*$/u, '').trim() || (c && c.code) || '';
}

/** Python json.dumps() serialisation (SasPay is a Django service): used only as a signature fallback. */
function pyDumps(v, ascii) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') {
    const s = JSON.stringify(v);
    return ascii ? s.replace(/[\u0080-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) : s;
  }
  if (Array.isArray(v)) return '[' + v.map(x => pyDumps(x, ascii)).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).map(k => pyDumps(k, ascii) + ': ' + pyDumps(v[k], ascii)).join(', ') + '}';
  return 'null';
}

/** Customer instructions shown while waiting for the operator (specific per network). */
function pushInstructions(networkId, chargeLabel) {
  const amount = chargeLabel ? ` de ${chargeLabel}` : '';
  const net = findNetwork(networkId);
  const name = net ? net.name : 'Mobile Money';
  const deadline = 'Vous disposez d’environ 3 minutes : passé ce délai, l’opérateur annule la demande et vous devrez relancer le paiement.';
  switch (networkId) {
    case 'orange_cm':
      return [
        `Une demande de paiement Orange Money${amount} vient d’être envoyée à votre numéro.`,
        'Si aucune fenêtre ne s’affiche sur votre téléphone, composez #150*50# puis validez le paiement avec votre code secret Orange Money.',
        deadline
      ];
    case 'mtn_cm':
      return [
        `Une demande de paiement MTN MoMo${amount} vient d’être envoyée à votre numéro.`,
        'Validez la fenêtre qui s’affiche avec votre code PIN MoMo. Si rien ne s’affiche, composez *126# et validez le paiement en attente.',
        deadline
      ];
    case 'mtn_ci':
      return [`Une demande de paiement MTN MoMo${amount} vient d’être envoyée à votre numéro.`, 'Validez-la avec votre code PIN, ou composez *133# pour la retrouver.', deadline];
    default:
      return [
        `Une demande de paiement ${name}${amount} vient d’être envoyée à votre numéro.`,
        (net && net.instruction && !net.otp_required) ? net.instruction : 'Validez-la sur votre téléphone avec votre code secret Mobile Money si elle s’affiche.',
        deadline
      ];
  }
}

function otpHelp(net) {
  if (!net) return '';
  if (net.id === 'orange_ci') return 'composez #144*82# puis choisissez l’option 2 pour obtenir votre code de paiement';
  if (net.id === 'orange_bf') return 'composez *144*4*6*MONTANT# (montant en FCFA) pour obtenir votre code de paiement';
  return net.otp_prompt ? `composez ${net.otp_prompt} pour obtenir votre code de paiement` : 'générez votre code de paiement depuis votre téléphone';
}

/** Extracts { code, message } from a SasPay error envelope (business error or field validation errors). */
function providerError(res) {
  const body = res && res.data;
  const err = body && body.error;
  let code = '';
  let message = '';
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    if (typeof err.code === 'string') code = err.code;
    if (typeof err.message === 'string') message = err.message;
    if (!message) {
      const parts = [];
      for (const [k, v] of Object.entries(err)) {
        if (k === 'code') continue;
        const txt = Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') : (typeof v === 'string' ? v : (v && typeof v === 'object' ? Object.values(v).flat().join(' ') : ''));
        const label = { amount: 'montant', customer: 'client', phone: 'téléphone', network: 'opérateur', currency: 'devise', country: 'pays', otp: 'code OTP', email: 'e-mail', return_url: 'adresse de retour', non_field_errors: '' }[k];
        if (txt) parts.push(label === '' ? txt : `${label || k} : ${txt}`);
      }
      message = parts.join(' ; ');
    }
  } else if (typeof err === 'string') message = err;
  if (!code && body && typeof body.code === 'string') code = body.code;
  if (!message && body && typeof body.message === 'string') message = body.message;
  if (!message && body && typeof body.detail === 'string') message = body.detail;
  if (!message && res && res.raw) message = String(res.raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { code, message: cleanText(message, 400) };
}

function unwrap(res) {
  const d = res && res.data;
  if (!d || typeof d !== 'object') return {};
  return (d.data && typeof d.data === 'object') ? d.data : d;
}

/** Turns the operator's raw reason into a clear explanation for the customer. */
function explainFailure(raw, { networkId, charged, mode } = {}) {
  const text = cleanText(raw, 300).replace(/[\s.]+$/, '');
  const low = text.toLowerCase();
  const chargeTxt = charged ? ` (${charged}, frais opérateur inclus)` : '';
  let hint;
  if (/insufficient|solde insuffisant|not enough|balance/.test(low)) {
    hint = `Le solde de votre compte Mobile Money ne couvre pas le montant demandé${chargeTxt}. Rechargez votre compte puis relancez le paiement.`;
  } else if (/time ?out|timed_out|expir|délai|non confirm|not confirmed/.test(low)) {
    hint = 'La demande n’a pas été validée à temps sur votre téléphone (environ 3 minutes). Relancez le paiement et validez-la dès réception.';
  } else if (/pin|code secret|wrong code|invalid code/.test(low)) {
    hint = 'Le code secret saisi sur le téléphone est incorrect. Relancez le paiement et saisissez votre code Mobile Money.';
  } else if (/user_rejected|rejected by user|annulé par|cancel/.test(low) && !/opérateur/.test(low)) {
    hint = 'La demande a été refusée ou annulée depuis votre téléphone.';
  } else if (/invalid.*(msisdn|phone|number)|numéro invalide|unknown subscriber|abonné/.test(low)) {
    hint = 'Le numéro indiqué n’est pas un compte Mobile Money valide pour cet opérateur. Vérifiez le numéro et l’opérateur choisis.';
  } else if (mode === 'checkout') {
    hint = 'Le paiement n’a pas été finalisé sur la page sécurisée SasPay. Vous pouvez relancer un paiement.';
  } else {
    hint = 'L’opérateur a annulé la demande : elle n’a pas été validée sur le téléphone dans le délai (environ 3 minutes), le code secret était incorrect ou le solde était insuffisant' +
      (charged ? ` (il faut ${charged}, frais opérateur inclus)` : '') + '.';
    if (networkId === 'orange_cm') hint += ' Pour Orange Money Cameroun, si aucune fenêtre ne s’affiche après avoir cliqué sur « Payer », composez #150*50# et validez avec votre code secret.';
    else if (networkId === 'mtn_cm') hint += ' Pour MTN MoMo Cameroun, si aucune fenêtre ne s’affiche, composez *126# et validez le paiement en attente.';
  }
  const source = mode === 'checkout' ? 'SasPay' : 'l’opérateur';
  const reason = text ? `Motif communiqué par ${source} : « ${text} »` : `Paiement refusé par ${source} (aucun motif détaillé transmis).`;
  return { reason, hint, message: `${reason}. ${hint}`.replace(/\.\s*\./g, '.') };
}

class PaymentService {
  constructor() {
    this._lastCheck = new Map(); // transaction id -> last reconciliation timestamp (per function instance)
  }

  getCountries() {
    return OFFICIAL_SASPAY_COUNTRIES;
  }

  get sasPayKey() { return process.env.SASPAY_API_KEY || ''; }

  requestSasPay(endpoint, method = 'GET', body = null, headers = {}, timeoutMs = SASPAY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
      const baseUrl = process.env.SASPAY_BASE_URL || SASPAY_BASE_URL;
      const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      const url = new URL(cleanEndpoint, base);
      const postData = body ? JSON.stringify(body) : null;
      const reqHeaders = { Authorization: `Bearer ${this.sasPayKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...headers };
      if (postData) reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      const lib = url.protocol === 'http:' ? http : https; // http only for local test doubles
      const req = lib.request(url, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (raw.length < 2e6) raw += c; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw: data ? undefined : raw });
        });
      });
      req.on('error', (err) => { const e = httpError(502, 'Erreur de communication avec SasPay : ' + err.message); e.network = true; reject(e); });
      req.on('timeout', () => { req.destroy(); const e = httpError(504, "SasPay n'a pas répondu à temps."); e.timeout = true; reject(e); });
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

  async _markFailed(txId, message, details = {}) {
    return db.tx(() => {
      const t = db.getTransactionById(txId);
      if (!t || t.status === 'completed') return t;
      if (t.status !== 'pending' && !(t.metadata && t.metadata.localFailure)) return t;
      const metadata = { ...(t.metadata || {}), failure: { ...details, at: new Date().toISOString() } };
      if (details.local) metadata.localFailure = true; else delete metadata.localFailure;
      return db.updateTransaction(txId, { status: 'failed', failureReason: cleanText(message, 600), completedAt: new Date().toISOString(), metadata });
    }).catch((e) => { console.error('[SasPay] could not record failure', txId, e && e.message); });
  }

  // ================================================================== SASPAY — creation
  /**
   * Starts a Mobile Money payment.
   *  - push: SasPay pushes a request to the customer's phone (or returns a page to open: `checkoutUrl`).
   *  - checkout: hosted SasPay page where the customer picks the operator.
   * `purchase` = { productId, quantity, contactInfo }: the order is placed automatically as soon as the payment
   * is confirmed (no action needed from the browser). Direct purchases (isPurchase) charge exactly the catalogue price.
   */
  async createSasPayDeposit({ user, amountUsd, country, network, phone, otp, customerName, customerEmail, returnUrl, isPurchase, productId, quantity, contactInfo, purchase, preferredMode }) {
    if (!user) throw httpError(401, 'Veuillez vous connecter pour initier une recharge.');

    const intentIn = purchase && typeof purchase === 'object' ? purchase : (isPurchase && productId ? { productId, quantity, contactInfo } : null);
    const { settings, externalProduct, intent } = await db.read(() => {
      const pid = intentIn ? intentIn.productId : productId;
      const p = pid !== undefined && pid !== null && pid !== '' ? db.getProductById(pid) : null;
      let it = null;
      if (intentIn && p && !(p && db.purchaseModeOf(p) === 'redirect')) {
        if (p.published !== true) throw httpError(404, "Ce produit n'est plus disponible dans la boutique.", 'PRODUCT_UNAVAILABLE');
        const qty = intentIn.quantity === undefined || intentIn.quantity === null || intentIn.quantity === '' ? 1 : Number(intentIn.quantity);
        if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw httpError(400, 'La quantité doit être un nombre entier compris entre 1 et 100.');
        if (!db.isProductAvailable(p)) throw httpError(409, 'Ce produit est en rupture de stock : le paiement n’a pas été lancé.', 'INSUFFICIENT_STOCK');
        it = { productId: p.id, productName: p.name, quantity: qty, total: roundMoney(p.price * qty), contactInfo: cleanText(intentIn.contactInfo, 120) };
      } else if (intentIn && !p) {
        throw httpError(404, "Ce produit n'est plus disponible dans la boutique.", 'PRODUCT_UNAVAILABLE');
      }
      return { settings: db.getPublicSettings(), externalProduct: Boolean(p && db.purchaseModeOf(p) === 'redirect'), intent: it };
    });
    // A product sold through an external link (WhatsApp...) is never paid on the site
    if (externalProduct) throw httpError(409, "Ce produit s'achète directement auprès du vendeur via le bouton « Acheter » : aucun paiement n'est demandé sur le site.", 'EXTERNAL_PURCHASE');
    if (!this.sasPayKey) throw httpError(503, 'Le paiement Mobile Money n’est pas configuré sur le serveur (clé SasPay absente). Prévenez le support.');

    const isDirect = Boolean(isPurchase && intent);
    const parsedUsd = isDirect ? this._validateAmount(intent.total, 0.5) : this._validateAmount(amountUsd, settings.min_recharge);

    const countryCode = String(country || 'CM').toUpperCase();
    const cfg = OFFICIAL_SASPAY_COUNTRIES.find(c => c.code === countryCode);
    if (!cfg) throw httpError(400, 'Pays non pris en charge pour le paiement Mobile Money.');
    const checkoutMode = (!network || network === 'checkout_hosted' || preferredMode === 'checkout' || cfg.code === 'ALL');
    const formattedAmount = Math.round(parsedUsd * cfg.rate).toFixed(2);

    let net = null;
    let cleanPhone = '';
    let cleanOtp = '';
    if (!checkoutMode) {
      net = (cfg.networks || []).find(n => n.id === String(network).toLowerCase());
      if (!net) throw httpError(400, `Opérateur inconnu pour ${countryLabel(cfg)} : choisissez un opérateur dans la liste.`);
      const ph = normalizeMobileNumber(cleanText(phone, 30), cfg.code);
      if (ph.error) throw httpError(400, ph.error, 'INVALID_PHONE');
      cleanPhone = ph.phone;
      cleanOtp = cleanText(otp, 20).replace(/\s+/g, '');
      if (net.otp_required && !cleanOtp) {
        throw httpError(400, `${net.name} (${countryLabel(cfg)}) exige un code de paiement : ${otpHelp(net)}, puis saisissez-le dans le champ « Code d'autorisation ».`, 'OTP_REQUIRED');
      }
    }

    const txId = 'TXN-SP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const idempotencyKey = crypto.randomUUID();
    const name = cleanText(customerName, 80) || user.name || 'Client GetVirtu';
    const email = this._customerEmail(user, customerEmail);
    const safeReturn = this._safeReturnUrl(returnUrl, `${PUBLIC_SITE_URL}/?momo_return=${txId}`, txId);
    const description = intent ? `GetVirtu ${intent.productName}`.slice(0, 120) : `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD`;
    const providerMetadata = { internalTxId: txId, userId: user.id, amountUsd: parsedUsd.toFixed(2) };

    const parts = name.trim().split(/\s+/);
    const softpayBody = checkoutMode ? null : {
      amount: formattedAmount,
      currency: cfg.currency,
      country: cfg.code,
      network: net.id,
      customer: { email, first_name: parts[0] || 'Client', last_name: parts.slice(1).join(' ') || 'GetVirtu', phone: cleanPhone },
      description,
      return_url: safeReturn,
      metadata: providerMetadata
    };
    if (softpayBody && cleanOtp) softpayBody.otp = cleanOtp;

    // Phase 1 — record the pending payment
    await db.tx(() => {
      const u = db.getUserById(user.id);
      if (!u) throw httpError(401, 'Session invalide.', 'SESSION_INVALID');
      db.createTransaction({
        id: txId, userId: u.id, userEmail: u.email, userName: u.name,
        amount: parsedUsd, currency: 'USD', paymentMethod: checkoutMode ? 'Mobile Money (page SasPay)' : `Mobile Money (${net.name} ${cfg.code})`,
        provider: 'saspay', status: 'pending', idempotencyKey,
        notes: intent ? `Paiement de la commande ${intent.productName} (x${intent.quantity})` : null,
        metadata: {
          localAmount: formattedAmount, localCurrency: cfg.currency, country: cfg.code, network: net ? net.id : 'checkout_hosted',
          networkName: net ? net.name : 'Page de paiement SasPay', phone: cleanPhone, customerName: name, customerEmail: email,
          providerKind: checkoutMode ? 'checkout' : 'softpay',
          purchase: intent ? { productId: intent.productId, productName: intent.productName, quantity: intent.quantity, contactInfo: intent.contactInfo, total: intent.total } : undefined
        }
      });
    });

    const fail = async (status, message, code, details = {}) => {
      await this._markFailed(txId, message, { stage: 'creation', ...details });
      const e = httpError(status, message, code);
      e.extra = { transactionId: txId };
      throw e;
    };

    // Phase 2 — provider call (no database lock held)
    let res;
    if (checkoutMode) {
      const checkoutPayload = {
        amount: formattedAmount,
        currency: cfg.currency,
        description,
        country: cfg.code === 'ALL' ? undefined : cfg.code,
        customer_email: email,
        customer_name: name,
        customer_phone: '',
        return_url: safeReturn,
        metadata: providerMetadata,
        expires_at: new Date(Date.now() + CHECKOUT_TTL_MIN * 60000).toISOString()
      };
      try {
        res = await this.requestSasPay('checkout-sessions/', 'POST', checkoutPayload);
      } catch (err) {
        return fail(err.status || 502, `${err.message} La page de paiement n'a pas pu être créée : aucun débit n'a été effectué. Réessayez dans un instant.`, 'PROVIDER_UNREACHABLE', { network: err.message });
      }
      if (!res.ok || !res.data || res.data.success === false) return this._creationFailure(res, { fail, net, cfg });
      const r = unwrap(res);
      if (!r.id || !r.checkout_url) return fail(502, 'Réponse inattendue de SasPay (page de paiement sans adresse). Aucun débit n’a été effectué.', 'PROVIDER_ERROR');
      await db.tx(() => { db.updateTransaction(txId, { providerTxId: r.id }); });
      return {
        success: true, transactionId: txId, providerTxId: r.id, status: 'pending', mode: 'checkout', checkoutUrl: r.checkout_url,
        amountUsd: parsedUsd, localAmount: formattedAmount, currency: cfg.currency, network: 'checkout_hosted', networkName: 'Page de paiement SasPay',
        validationWindowSec: CHECKOUT_TTL_MIN * 60, autoPurchase: Boolean(intent),
        instructions: ['Ouvrez la page de paiement sécurisée SasPay, choisissez votre opérateur et confirmez le paiement.', `La page reste valable ${CHECKOUT_TTL_MIN} minutes.`]
      };
    }

    // Softpay: one automatic retry with the SAME Idempotency-Key (documented by SasPay: never creates a 2nd payment)
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await this.requestSasPay('payments/softpay/', 'POST', softpayBody, { 'Idempotency-Key': idempotencyKey });
        lastErr = null;
        if (res.status >= 500 || (res.status === 409 && attempt === 0 && /idempot|cours|progress/i.test(providerError(res).message))) {
          lastErr = res;
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise(r => setTimeout(r, 800));
      }
    }
    if (lastErr && !(res && res.status < 500 && res.status !== 409)) {
      const why = lastErr instanceof Error ? lastErr.message : `erreur ${lastErr.status} de SasPay`;
      // local: SasPay may still have registered it — a later webhook can re-check and credit it
      return fail(502, `SasPay ne répond pas pour le moment (${why}). Si vous recevez malgré tout une demande de paiement sur votre téléphone, ne la validez pas et relancez le paiement dans quelques minutes.`, 'PROVIDER_UNREACHABLE', { network: why, local: true });
    }
    if (!res.ok || !res.data || res.data.success === false) return this._creationFailure(res, { fail, net, cfg });

    const r = unwrap(res);
    if (!r.id) return fail(502, 'Réponse inattendue de SasPay (paiement sans identifiant). Aucun débit n’a été confirmé : relancez le paiement.', 'PROVIDER_ERROR');
    const checkoutUrl = typeof r.checkout_url === 'string' && /^https:\/\//i.test(r.checkout_url) ? r.checkout_url : null;
    const providerTexts = (Array.isArray(r.instructions) ? r.instructions : (typeof r.instructions === 'string' && r.instructions ? [r.instructions] : []))
      .map(x => cleanText(x, 300)).filter(x => x && !GENERIC_PROVIDER_TEXT.test(x));
    const status = String(r.status || 'PENDING').toUpperCase();
    await db.tx(() => {
      const t = db.getTransactionById(txId);
      db.updateTransaction(txId, { providerTxId: r.id, metadata: { ...(t.metadata || {}), checkoutUrl: checkoutUrl || undefined } });
    });

    const localLabel = formatLocal(formattedAmount, cfg.currency);
    let instructions;
    let mode;
    if (r.bank_transfer && r.bank_transfer.account_number) {
      const b = r.bank_transfer;
      mode = 'bank_transfer';
      instructions = [`Effectuez un virement de ${formatLocal(b.amount_expected || formattedAmount, b.currency || cfg.currency)} vers ${cleanText(b.bank_name, 80)} — compte ${cleanText(b.account_number, 40)} (${cleanText(b.account_name, 80)}).`, `Ce compte est valable jusqu'au ${cleanText(b.expires_at, 40)}.`];
    } else if (checkoutUrl) {
      mode = 'redirect';
      instructions = [...providerTexts, `${net.name} se règle sur une page sécurisée : ouvrez-la avec le bouton ci-dessous et confirmez le paiement de ${localLabel}.`, 'Aucune demande n’arrivera sur votre téléphone tant que cette page n’est pas ouverte.'];
    } else {
      mode = 'push';
      instructions = [...providerTexts, ...pushInstructions(net.id, localLabel)];
    }

    const out = {
      success: true, transactionId: txId, providerTxId: r.id, status: 'pending', mode, checkoutUrl,
      instructions, amountUsd: parsedUsd, localAmount: formattedAmount, currency: cfg.currency,
      network: net.id, networkName: net.name, phone: maskPhone(cleanPhone),
      validationWindowSec: mode === 'push' ? PUSH_VALIDATION_WINDOW_SEC : CHECKOUT_TTL_MIN * 60,
      autoPurchase: Boolean(intent)
    };
    // SasPay may already know the final state (e.g. sandbox, or a refusal returned immediately)
    if (status === 'SUCCESS' || status === 'FAILED') {
      const v = await this.verifySasPayPayment({ transactionId: txId }).catch(() => null);
      if (v && v.status !== 'pending') return { ...out, ...v, success: v.status === 'completed', transactionId: txId, mode };
    }
    return out;
  }

  /** Clear message for a SasPay refusal at creation time (never a silent fallback to another payment mode). */
  _creationFailure(res, { fail, net, cfg }) {
    const info = providerError(res);
    const status = res ? res.status : 0;
    const op = net ? `${net.name} (${countryLabel(cfg)})` : 'Le paiement Mobile Money';
    const detail = info.message ? ` — ${info.message.replace(/[s.]+$/, '')}` : '';
    const details = { httpStatus: status, providerCode: info.code || null, providerMessage: info.message || null };
    switch (info.code) {
      case 'prepayment_otp_missing':
        return fail(400, `${op} exige un code de paiement : ${otpHelp(net)}, puis saisissez-le dans le champ « Code d'autorisation ».`, 'OTP_REQUIRED', details);
      case 'no_route_available':
        return fail(503, `${op} est momentanément indisponible chez notre prestataire de paiement SasPay${detail}. Aucun débit n’a été effectué : choisissez un autre opérateur ou réessayez plus tard.`, 'OPERATOR_UNAVAILABLE', details);
      case 'invalid_method':
        return fail(400, `${op} n’est pas disponible actuellement${detail}. Choisissez un autre opérateur.`, 'OPERATOR_UNAVAILABLE', details);
      case 'invalid_customer':
        return fail(400, `Coordonnées refusées par SasPay${detail}. Vérifiez votre numéro de téléphone.`, 'INVALID_PHONE', details);
      case 'invalid_country':
      case 'missing_method':
        return fail(400, `Pays ou opérateur refusé par SasPay${detail}.`, 'OPERATOR_UNAVAILABLE', details);
      case 'no_exchange_rate':
        return fail(503, `Conversion vers ${cfg.currency} momentanément indisponible chez SasPay${detail}. Réessayez plus tard.`, 'PROVIDER_ERROR', details);
      case 'api_key_scope_forbidden':
      case 'merchant_suspended':
        console.error('[SasPay] merchant account refused:', status, info.code, info.message);
        return fail(503, 'Le paiement Mobile Money est momentanément indisponible (compte marchand SasPay refusé). Aucun débit n’a été effectué. Prévenez le support.', 'PROVIDER_CONFIG', details);
      default:
        break;
    }
    if (status === 401 || status === 403) {
      console.error('[SasPay] API key refused:', status, info.code, info.message);
      return fail(503, 'Le paiement Mobile Money est momentanément indisponible (clé SasPay refusée par le prestataire). Aucun débit n’a été effectué. Prévenez le support.', 'PROVIDER_CONFIG', details);
    }
    if (status === 429) return fail(503, 'Trop de paiements simultanés chez SasPay : réessayez dans une minute. Aucun débit n’a été effectué.', 'PROVIDER_BUSY', details);
    if (status === 409) return fail(502, 'SasPay traite encore cette demande. Si vous recevez une demande de paiement sur votre téléphone, ne la validez pas : relancez le paiement dans quelques minutes.', 'PROVIDER_BUSY', { ...details, local: true });
    if (status >= 500 || !status) return fail(502, `SasPay rencontre une erreur technique (code ${status || 'inconnu'})${detail}. Aucun débit n’a été effectué : réessayez dans quelques minutes.`, 'PROVIDER_ERROR', details);
    return fail(400, `Paiement refusé par SasPay${detail || ` (code ${status})`}.`, info.code ? String(info.code).toUpperCase() : 'PROVIDER_REFUSED', details);
  }

  // ================================================================== SASPAY — verification
  /** Looks up a transaction for the caller (owner or administrator). */
  async _loadTxForCaller(transactionId, caller) {
    return db.read(() => {
      const t = db.getTransactionById(transactionId);
      if (!t) throw httpError(404, 'Transaction introuvable.');
      if (caller && caller.role !== 'admin' && String(t.userId) !== String(caller.id)) throw httpError(404, 'Transaction introuvable.');
      return JSON.parse(JSON.stringify(t));
    });
  }

  /** Final state of a completed payment, with the order placed automatically (if any). */
  async _completedResult(txId, extra = {}, attempt = 0) {
    const snap = await db.read(() => {
      const t = db.getTransactionById(txId);
      const u = t ? db.getUserById(t.userId) : null;
      const intent = t && t.metadata && t.metadata.purchase;
      const order = intent && intent.orderId ? db.getOrderById(intent.orderId) : null;
      return { t: publicTx(t), balance: u ? u.balance : null, intent: intent ? { ...intent } : null, order: order ? JSON.parse(JSON.stringify(order)) : null };
    });
    if (snap.intent && !snap.intent.orderId && !snap.intent.error && attempt === 0) {
      await this._completePurchaseIntent(txId);
      return this._completedResult(txId, extra, 1);
    }
    const credited = snap.t ? snap.t.amount : null;
    let message = `Paiement confirmé par l’opérateur : votre solde a été crédité de $${Number(credited || 0).toFixed(2)}.`;
    if (snap.order) message = `Paiement confirmé : votre commande ${snap.order.id} (${snap.order.productName}) est validée.`;
    else if (snap.intent && snap.intent.error) message = `Paiement confirmé et crédité sur votre solde, mais la commande n’a pas pu être validée automatiquement : ${snap.intent.error}`;
    return {
      success: true, status: 'completed', newBalance: snap.balance, creditedAmount: credited, transaction: snap.t,
      order: snap.order, orderError: snap.intent && snap.intent.error ? snap.intent.error : null, message, ...extra
    };
  }

  /** Places the order attached to a confirmed Mobile Money payment (exactly once). */
  async _completePurchaseIntent(txId) {
    try {
      return await db.tx(() => {
        const t = db.getTransactionById(txId);
        const intent = t && t.metadata && t.metadata.purchase;
        if (!t || t.status !== 'completed' || !intent || intent.orderId || intent.error) return null;
        const user = db.getUserById(t.userId);
        if (!user) throw httpError(404, 'Compte client introuvable.');
        const r = db.purchaseWithBalance(user, {
          productId: intent.productId, quantity: intent.quantity, contactInfo: intent.contactInfo,
          idempotencyKey: 'momo-' + t.id, paymentLabel: 'Mobile Money'
        });
        db.updateTransaction(t.id, { metadata: { ...t.metadata, purchase: { ...intent, orderId: r.order.id, completedAt: new Date().toISOString() } } });
        return r.order.id;
      });
    } catch (err) {
      const msg = err && err.status && err.status < 500 ? err.message : 'erreur interne lors de la création de la commande.';
      if (!(err && err.status && err.status < 500)) console.error('[SasPay] automatic order failed', txId, err && err.stack ? err.stack : err);
      await db.tx(() => {
        const t = db.getTransactionById(txId);
        const intent = t && t.metadata && t.metadata.purchase;
        if (!t || !intent || intent.orderId) return;
        db.updateTransaction(t.id, { metadata: { ...t.metadata, purchase: { ...intent, error: cleanText(msg, 300), failedAt: new Date().toISOString() } } });
      }).catch(() => {});
      return null;
    }
  }

  async _failureRaw(paymentId) {
    try {
      const d = await this.requestSasPay(`transactions/${encodeURIComponent(paymentId)}/`, 'GET');
      if (!d.ok) return '';
      const tx = unwrap(d);
      const logs = Array.isArray(tx.status_logs) ? tx.status_logs : [];
      const last = logs.filter(l => l && /FAILED|CANCELLED|EXPIRED/i.test(String(l.to_status || ''))).pop();
      if (last && last.reason) return String(last.reason);
      const attempts = Array.isArray(tx.attempts) ? tx.attempts : [];
      const failedAttempt = attempts.filter(a => a && a.error_message).pop();
      return failedAttempt ? String(failedAttempt.error_message) : '';
    } catch (e) {
      return '';
    }
  }

  async _checkPayment(paymentId) {
    const vr = await this.requestSasPay(`payments/${encodeURIComponent(paymentId)}/verify/`, 'GET');
    if (vr.status === 404) return { state: 'notfound' };
    if (vr.status === 401 || vr.status === 403) return { state: 'unknown', configError: true };
    if (!vr.ok) return { state: 'unknown', transient: true, httpStatus: vr.status };
    const p = unwrap(vr);
    const st = String(p.status || '').toUpperCase();
    const charged = p.debited_amount ? formatLocal(p.debited_amount, p.currency) : null;
    if (st === 'SUCCESS') return { state: 'success', paymentId: p.id || paymentId, payment: p, charged };
    if (st === 'FAILED' || st === 'CANCELLED' || st === 'EXPIRED') return { state: 'failed', raw: await this._failureRaw(p.id || paymentId), charged, paymentId: p.id || paymentId };
    return { state: 'pending', charged, paymentId: p.id || paymentId };
  }

  async _checkCheckoutSession(sessionId) {
    const sr = await this.requestSasPay(`checkout-sessions/${encodeURIComponent(sessionId)}/status/`, 'GET');
    if (sr.status === 404) return { state: 'notfound' };
    if (sr.status === 401 || sr.status === 403) return { state: 'unknown', configError: true };
    if (!sr.ok) return { state: 'unknown', transient: true, httpStatus: sr.status };
    const s = unwrap(sr);
    const sStatus = String(s.status || '').toUpperCase();
    const tStatus = String(s.transaction_status || '').toUpperCase();
    const payId = s.transaction_id || (s.transaction && typeof s.transaction === 'object' ? s.transaction.id : s.transaction) || null;
    if (sStatus === 'PAID' || tStatus === 'SUCCESS') {
      if (!payId) return { state: 'pending' };
      const r = await this._checkPayment(payId);
      return r.state === 'success' ? r : { ...r, state: r.state === 'failed' ? 'pending' : r.state };
    }
    if (sStatus === 'EXPIRED') return { state: 'failed', raw: 'Page de paiement expirée sans paiement', mode: 'checkout' };
    if (sStatus === 'CANCELLED') return { state: 'failed', raw: 'Page de paiement annulée', mode: 'checkout' };
    // On the hosted page the customer can retry after a refused attempt: the session stays open
    if (tStatus === 'FAILED' && payId) return { state: 'pending', lastAttemptFailed: await this._failureRaw(payId) || 'tentative refusée' };
    return { state: 'pending' };
  }

  /**
   * Server-to-server SasPay verification. `caller` is the authenticated user (null for webhooks / reconciliation).
   * Uses ONLY the provider id stored on the transaction. `force` re-checks a payment closed locally (timeouts).
   */
  async verifySasPayPayment({ transactionId, caller = null, force = false }) {
    const tx = await this._loadTxForCaller(transactionId, caller);
    if (tx.provider !== 'saspay') return { success: false, status: tx.status, message: 'Transaction non SasPay.' };
    const meta = tx.metadata || {};
    if (tx.status === 'completed') return this._completedResult(tx.id, { alreadyCompleted: true });
    if ((tx.status === 'failed' || tx.status === 'cancelled') && !(force && meta.localFailure)) {
      return { success: true, status: 'failed', message: tx.failureReason || 'Ce paiement n’a pas abouti.', transaction: publicTx(tx) };
    }
    const age = ageSeconds(tx.createdAt);
    const kind = meta.providerKind || null;
    const base = { success: true, transactionId: tx.id, mode: kind === 'checkout' ? 'checkout' : (meta.checkoutUrl ? 'redirect' : 'push'), elapsedSec: Math.round(age) };

    if (!tx.providerTxId) {
      if (age > 120) {
        const msg = 'L’initialisation du paiement auprès de SasPay n’a pas abouti : aucune demande de paiement n’a été confirmée par l’opérateur. Vous pouvez relancer le paiement.';
        await this._markFailed(tx.id, msg, { stage: 'creation', local: true });
        return { ...base, status: 'failed', message: msg };
      }
      return { ...base, status: 'pending', message: 'Initialisation du paiement en cours…' };
    }
    if (!this.sasPayKey) return { ...base, status: 'pending', configError: true, message: 'Vérification impossible : la clé SasPay n’est pas configurée sur le serveur. Prévenez le support.' };

    let o;
    try {
      if (kind === 'checkout') o = await this._checkCheckoutSession(tx.providerTxId);
      else if (kind === 'softpay') o = await this._checkPayment(tx.providerTxId);
      else {
        o = await this._checkPayment(tx.providerTxId); // older payments: id may be a payment or a checkout session
        if (o.state === 'notfound') o = { ...(await this._checkCheckoutSession(tx.providerTxId)), mode: 'checkout' };
      }
    } catch (err) {
      o = { state: 'unknown', transient: true, error: err.message };
    }

    if (o.state === 'success') {
      const p = o.payment || {};
      const echoed = p.metadata && p.metadata.internalTxId;
      if (echoed && echoed !== tx.id) {
        console.error('[SasPay] provider payment metadata does not match transaction', tx.id);
        return { ...base, status: 'pending', message: 'Paiement non concordant : contactez le support avec la référence ' + tx.id + '.' };
      }
      const expected = parseFloat(meta.localAmount);
      const paid = parseFloat(p.requested_amount || p.net_amount);
      const sameCurrency = !p.currency || !meta.localCurrency || String(p.currency).toUpperCase() === String(meta.localCurrency).toUpperCase();
      if (Number.isFinite(expected) && Number.isFinite(paid) && (Math.abs(paid - expected) > 1 || !sameCurrency)) {
        console.error('[SasPay] amount mismatch', tx.id, expected, meta.localCurrency, paid, p.currency);
        await db.tx(() => { const t = db.getTransactionById(tx.id); if (t) db.updateTransaction(tx.id, { metadata: { ...(t.metadata || {}), amountMismatch: { expected, paid, currency: p.currency || null } } }); }).catch(() => {});
        return { ...base, status: 'pending', message: 'Montant payé différent du montant attendu : vérification manuelle par le support (référence ' + tx.id + ').' };
      }
      await db.tx(() => db.creditDeposit(tx.id, { extra: { providerPaymentId: o.paymentId || null, charged: o.charged || null, confirmedAt: new Date().toISOString() } }));
      return this._completedResult(tx.id, { justCompleted: true });
    }

    if (o.state === 'failed') {
      const ex = explainFailure(o.raw, { networkId: meta.network, charged: o.charged, mode: o.mode || kind });
      await this._markFailed(tx.id, ex.message, { raw: o.raw || null, charged: o.charged || null, by: 'saspay' });
      return { ...base, status: 'failed', message: ex.message, reason: ex.reason, hint: ex.hint, charged: o.charged || null };
    }

    if (o.state === 'notfound') {
      if (age > 900) {
        const msg = 'Ce paiement est introuvable chez SasPay : aucune demande n’a été enregistrée par l’opérateur et aucun débit n’a eu lieu. Vous pouvez relancer le paiement.';
        await this._markFailed(tx.id, msg, { by: 'saspay', notFound: true, local: true });
        return { ...base, status: 'failed', message: msg };
      }
      return { ...base, status: 'pending', message: 'Paiement en cours d’enregistrement chez SasPay…' };
    }

    if (o.state === 'unknown') {
      if (o.configError) console.error('[SasPay] verification refused (API key)', tx.id);
      return {
        ...base, status: 'pending', providerReachable: false, configError: Boolean(o.configError),
        message: o.configError ? 'Vérification impossible : la clé SasPay du site est refusée par le prestataire. Prévenez le support.' : 'Connexion à SasPay momentanément impossible : nouvelle vérification automatique dans quelques secondes…'
      };
    }

    // Still pending at SasPay
    if (age > PENDING_GIVE_UP_HOURS * 3600) {
      const msg = `Aucune confirmation de l’opérateur après ${PENDING_GIVE_UP_HOURS} heures : ce paiement est considéré comme non abouti. Si votre compte Mobile Money a été débité, contactez le support avec la référence ${tx.id}.`;
      await this._markFailed(tx.id, msg, { by: 'timeout', local: true });
      return { ...base, status: 'failed', message: msg };
    }
    if (o.charged && meta.charged !== o.charged) {
      await db.tx(() => { const t = db.getTransactionById(tx.id); if (t && t.status === 'pending') db.updateTransaction(tx.id, { metadata: { ...(t.metadata || {}), charged: o.charged } }); }).catch(() => {});
    }
    let message;
    if (kind === 'checkout' || meta.checkoutUrl) {
      message = o.lastAttemptFailed
        ? `Dernière tentative refusée par l’opérateur (« ${cleanText(o.lastAttemptFailed, 200)} »). Vous pouvez réessayer sur la page de paiement.`
        : 'En attente de votre paiement sur la page sécurisée SasPay…';
    } else if (age < PUSH_VALIDATION_WINDOW_SEC) {
      message = 'Demande envoyée : validez le paiement sur votre téléphone' + (o.charged ? ` (${o.charged}, frais inclus)` : '') + '.';
    } else {
      message = 'Le délai de validation est dépassé : l’opérateur n’a pas encore transmis sa réponse finale. Vérification automatique en cours…';
    }
    return { ...base, status: 'pending', message, charged: o.charged || meta.charged || null, validationWindowSec: kind === 'checkout' ? CHECKOUT_TTL_MIN * 60 : PUSH_VALIDATION_WINDOW_SEC };
  }

  /**
   * Re-checks pending SasPay payments (customer history, admin dashboard, daily cron) so that no transaction stays
   * blocked when the browser was closed or a webhook was lost. Bounded in number and time.
   */
  async reconcilePending({ userId = null, limit = 6, budgetMs = 18000 } = {}) {
    if (!this.sasPayKey) return { checked: 0, results: [], configured: false };
    const started = Date.now();
    const candidates = await db.read(() => db.getTransactions(userId ? { userId } : {})
      .filter(t => t && t.provider === 'saspay' && (t.status === 'pending' ||
        (t.status === 'completed' && t.metadata && t.metadata.purchase && !t.metadata.purchase.orderId && !t.metadata.purchase.error)))
      .map(t => ({ id: t.id, createdAt: t.createdAt })));
    candidates.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    const results = [];
    for (const c of candidates) {
      if (results.length >= limit || Date.now() - started > budgetMs) break;
      const last = this._lastCheck.get(c.id) || 0;
      if (Date.now() - last < RECONCILE_MIN_INTERVAL_MS) continue;
      this._lastCheck.set(c.id, Date.now());
      try {
        const r = await this.verifySasPayPayment({ transactionId: c.id });
        results.push({ id: c.id, status: r.status });
      } catch (e) {
        results.push({ id: c.id, status: 'error' });
      }
    }
    if (this._lastCheck.size > 500) this._lastCheck.clear();
    return { checked: results.length, results, configured: true };
  }

  // ================================================================== SASPAY — webhooks
  _verifySignature(secret, headers, rawBody, payload) {
    const signature = String(headers['x-webhook-signature'] || '').trim().toLowerCase();
    const timestamp = String(headers['x-webhook-timestamp'] || '').trim();
    if (!signature || !timestamp) throw httpError(401, 'Headers de signature webhook manquants.');
    if (!/^\d+$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) throw httpError(401, 'Horodatage du webhook hors tolérance.');
    const candidates = [];
    if (typeof rawBody === 'string' && rawBody) candidates.push(rawBody);
    else if (payload && typeof payload === 'object') candidates.push(JSON.stringify(payload), pyDumps(payload, true), pyDumps(payload, false));
    const a = Buffer.from(signature);
    for (const body of candidates) {
      const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    throw httpError(401, 'Signature du webhook SasPay invalide.');
  }

  async _recordWebhook(info) {
    await db.tx(() => {
      const meta = db.data.meta || (db.data.meta = {});
      const prev = meta.saspay || {};
      meta.saspay = { ...prev, lastWebhookAt: new Date().toISOString(), lastWebhookEvent: cleanText(info.event, 60) || null, lastWebhookSignature: info.signature, lastWebhookTransaction: info.transactionId || null, webhookCount: (prev.webhookCount || 0) + 1 };
      db.persist();
    }).catch((e) => console.error('[SasPay] could not record webhook', e && e.message));
  }

  /** SasPay webhook: signature check on the raw body, then server-to-server verification. Payload is never trusted. */
  async handleWebhook({ headers = {}, rawBody, payload }) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const secret = process.env.SASPAY_WEBHOOK_SECRET || '';
    let signature = 'non configurée';
    if (secret) {
      this._verifySignature(secret, h, rawBody, payload);
      signature = 'valide';
    }
    const body = payload && typeof payload === 'object' ? payload : {};
    const event = String(body.event || h['x-webhook-event'] || '').trim();
    const data = body.data && typeof body.data === 'object' ? body.data : {};

    if (event === 'webhook.test') {
      await this._recordWebhook({ event, signature });
      return { success: true, message: 'Webhook GetVirtu opérationnel.' };
    }
    if (event && !/^transaction\./.test(event)) return { success: true, message: 'Événement ignoré.' };

    const providerId = typeof data.id === 'string' ? data.id.slice(0, 80) : '';
    const legacyInternal = data.metadata && typeof data.metadata.internalTxId === 'string' ? data.metadata.internalTxId : null;
    let txId = await db.read(() => {
      let t = providerId ? db.getTransactionByProviderTxId(providerId) : null;
      if (!t && providerId) t = db.getTransactions({}).find(x => x && x.provider === 'saspay' && x.metadata && x.metadata.completedDetails && x.metadata.completedDetails.providerPaymentId === providerId) || null;
      if (!t && legacyInternal) t = db.getTransactionById(legacyInternal);
      return t && t.provider === 'saspay' ? t.id : null;
    });
    // Payment made on a hosted page (id unknown locally): ask SasPay which shop transaction it belongs to
    if (!txId && providerId && this.sasPayKey && /^[0-9a-f-]{16,64}$/i.test(providerId)) {
      try {
        const d = await this.requestSasPay(`transactions/${encodeURIComponent(providerId)}/`, 'GET');
        if (d.ok) {
          const p = unwrap(d);
          const internal = p.metadata && typeof p.metadata.internalTxId === 'string' ? p.metadata.internalTxId : null;
          const session = p.checkout_session && typeof p.checkout_session === 'object' ? p.checkout_session.id : p.checkout_session;
          txId = await db.read(() => {
            let t = internal ? db.getTransactionById(internal) : null;
            if (!t && session) t = db.getTransactionByProviderTxId(session);
            return t && t.provider === 'saspay' ? t.id : null;
          });
          // Creation answer lost (timeout): the id comes from SasPay's own API, so it can be attached safely
          if (txId && internal === txId) {
            await db.tx(() => {
              const t = db.getTransactionById(txId);
              if (t && !t.providerTxId) db.updateTransaction(txId, { providerTxId: providerId, metadata: { ...(t.metadata || {}), providerKind: 'softpay' } });
            });
          }
        }
      } catch (e) { /* SasPay unreachable: the delivery will be retried by SasPay */ }
    }
    await this._recordWebhook({ event, signature, transactionId: txId });
    if (!txId) return { success: true, message: 'Notification reçue (transaction inconnue de la boutique).' };
    const r = await this.verifySasPayPayment({ transactionId: txId, force: true });
    return { success: true, message: 'Statut vérifié auprès de SasPay.', status: r.status };
  }

  /** Administrator diagnostic: API key, active operators, webhook configuration and last deliveries. */
  async sasPayHealth() {
    const meta = await db.read(() => ({ ...((db.data.meta && db.data.meta.saspay) || {}) }));
    const baseUrl = process.env.SASPAY_BASE_URL || SASPAY_BASE_URL;
    const expectedWebhookUrl = `${PUBLIC_SITE_URL}/api/payments/webhook`;
    const out = {
      configured: Boolean(this.sasPayKey), environment: /sandbox/i.test(baseUrl) ? 'sandbox' : 'live',
      signatureSecretConfigured: Boolean(process.env.SASPAY_WEBHOOK_SECRET), expectedWebhookUrl, lastWebhook: meta.lastWebhookAt ? meta : null
    };
    if (!this.sasPayKey) return out;
    const safe = p => this.requestSasPay(p, 'GET', null, {}, 15000).catch(e => ({ ok: false, status: 0, error: e.message }));
    const [rates, hooks, subs, logs] = await Promise.all([safe('pricing/my-rates/'), safe('merchant-webhooks/'), safe('merchant-webhook-subscriptions/'), safe('webhook-logs/?page_size=10')]);
    const list = r => { const d = unwrap(r); return Array.isArray(d) ? d : (Array.isArray(d.results) ? d.results : []); };
    out.keyValid = Boolean(rates.ok);
    out.keyHttpStatus = rates.status || 0;
    if (!rates.ok) out.keyError = providerError(rates).message || rates.error || null;
    const ratesList = rates.ok ? (Array.isArray(rates.data && rates.data.data) ? rates.data.data : list(rates)) : [];
    out.activeNetworks = ratesList.filter(x => x && x.payin && x.payin.available).length;
    out.otpNetworks = ratesList.filter(x => x && x.payin && x.payin.otp_required).map(x => x.network_code);
    const subsList = list(subs);
    out.webhooks = list(hooks).map(w => ({
      url: w.url, environment: w.environment, active: w.is_active !== false,
      events: subsList.filter(s => s.webhook === w.id).map(s => s.event_type)
    }));
    out.webhookPointsHere = out.webhooks.some(w => w.active && /^https:\/\/(www\.)?getvirtu\.shop\/api\/payments(\/saspay)?\/webhook\/?$/i.test(String(w.url || '')));
    out.webhookHasSuccessEvent = out.webhooks.some(w => w.events.includes('transaction.success'));
    out.recentDeliveries = list(logs).slice(0, 10).map(l => ({ event: l.event_type, status: l.status, httpStatus: l.http_status, at: l.sent_at || l.created_at, url: l.url }));
    return out;
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
    const r = await db.tx(() => {
      const t = db.getTransactionById(transactionId);
      if (!t) throw httpError(404, 'Transaction introuvable.');
      if (t.status === 'completed') return { success: true, alreadyProcessed: true, transaction: publicTx(t) };
      if (!['deposit'].includes(t.type)) throw httpError(400, 'Seules les recharges en attente peuvent être validées.');
      if (!isApproval) {
        const updated = db.updateTransaction(t.id, { status: 'failed', failureReason: cleanText(failureReason, 300) || 'Paiement rejeté lors de la vérification.', completedAt: new Date().toISOString(), adminResponsible: adminName });
        return { success: true, transaction: publicTx(updated) };
      }
      const c = db.creditDeposit(t.id, {});
      db.updateTransaction(t.id, { adminResponsible: adminName, notes: t.notes || `Validée manuellement par ${adminName}` });
      return { success: true, transaction: publicTx(c.transaction), newBalance: c.newBalance, _hasIntent: Boolean(t.metadata && t.metadata.purchase) };
    });
    // A Mobile Money payment approved by hand still places the order it was made for
    if (r && r._hasIntent) {
      await this._completePurchaseIntent(transactionId);
      const done = await this._completedResult(transactionId);
      return { success: true, transaction: done.transaction, newBalance: done.newBalance, order: done.order, orderError: done.orderError };
    }
    if (r) delete r._hasIntent;
    return r;
  }

  async getUserTransactions(userId) {
    return db.read(() => db.getTransactions({ userId }).map(publicTx));
  }

  _safeReturnUrl(url, fallback, txId) {
    try {
      const u = new URL(String(url || ''));
      const allowed = ['getvirtu.shop', 'www.getvirtu.shop', 'localhost', '127.0.0.1'];
      if ((u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) &&
          (allowed.includes(u.hostname) || /\.vercel\.app$/.test(u.hostname))) {
        if (txId) { u.searchParams.set('momo_return', txId); u.hash = ''; }
        return u.toString();
      }
    } catch (e) {}
    return fallback;
  }
}

module.exports = new PaymentService();
module.exports.publicTx = publicTx;
module.exports._internals = { explainFailure, providerError, pyDumps, pushInstructions, maskPhone };
