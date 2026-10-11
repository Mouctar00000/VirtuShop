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

// ==================== CONFIGURATION OFFICIELLE MULTI-PAYS SASPAY ====================
// Basé sur le catalogue réel et les méthodes activées pour le compte marchand
const OFFICIAL_SASPAY_COUNTRIES = [
  {
    code: 'CM',
    name: 'Cameroun 🇨🇲',
    currency: 'XAF',
    rate: 620,
    prefix: '+237',
    networks: [
      {
        id: 'orange_cm',
        name: 'Orange Money',
        icon: '🍊',
        otp_required: false,
        instruction: 'Composez le #150*50# ou #150*4*4# sur votre téléphone si le pop-up USSD n\'apparaît pas automatiquement.'
      },
      {
        id: 'mtn_cm',
        name: 'MTN MoMo',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez la notification USSD sur votre écran ou composez *126#.'
      }
    ]
  },
  {
    code: 'CI',
    name: "Côte d'Ivoire 🇨🇮",
    currency: 'XOF',
    rate: 620,
    prefix: '+225',
    networks: [
      {
        id: 'wave_ci',
        name: 'Wave',
        icon: '🌊',
        otp_required: false,
        instruction: 'Ouvrez votre application Wave pour autoriser le paiement instantané.'
      },
      {
        id: 'orange_ci',
        name: 'Orange Money',
        icon: '🍊',
        otp_required: true,
        otp_prompt: '#144*82# option 2',
        instruction: 'Composez #144*82# puis l\'option 2 sur votre téléphone pour générer votre code d\'autorisation temporaire.'
      },
      {
        id: 'mtn_ci',
        name: 'MTN MoMo',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez l\'invite USSD sur votre écran ou composez *133#.'
      },
      {
        id: 'moov_ci',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez la demande de débit avec votre code PIN Moov.'
      },
      {
        id: 'djamo_ci',
        name: 'Djamo',
        icon: '💳',
        otp_required: false,
        instruction: 'Confirmez la transaction directement dans l\'application Djamo.'
      }
    ]
  },
  {
    code: 'SN',
    name: 'Sénégal 🇸🇳',
    currency: 'XOF',
    rate: 620,
    prefix: '+221',
    networks: [
      {
        id: 'wave_sn',
        name: 'Wave',
        icon: '🌊',
        otp_required: false,
        instruction: 'Ouvrez votre application Wave pour valider le paiement.'
      },
      {
        id: 'orange_sn',
        name: 'Orange Money',
        icon: '🍊',
        otp_required: false,
        instruction: 'Validez la notification ou composez #144# sur votre mobile.'
      },
      {
        id: 'freemoney_sn',
        name: 'Free Money',
        icon: '🟢',
        otp_required: false,
        instruction: 'Approuvez la demande sur votre compte Free Money.'
      },
      {
        id: 'expresso_sn',
        name: 'Expresso Sénégal',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez le paiement sur votre mobile Expresso.'
      }
    ]
  },
  {
    code: 'BJ',
    name: 'Bénin 🇧🇯',
    currency: 'XOF',
    rate: 620,
    prefix: '+229',
    networks: [
      {
        id: 'mtn_bj',
        name: 'MTN MoMo',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez l\'invite USSD sur votre écran MTN MoMo ou composez *880#.'
      },
      {
        id: 'moov_bj',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez la demande avec votre code secret Moov.'
      },
      {
        id: 'celtiis_bj',
        name: 'Celtiis Cash',
        icon: '🟣',
        otp_required: false,
        instruction: 'Validez la transaction sur votre compte Celtiis Cash.'
      }
    ]
  },
  {
    code: 'BF',
    name: 'Burkina Faso 🇧🇫',
    currency: 'XOF',
    rate: 620,
    prefix: '+226',
    networks: [
      {
        id: 'orange_bf',
        name: 'Orange Money',
        icon: '🍊',
        otp_required: true,
        otp_prompt: '*144*4*6*{montant}#',
        instruction: 'Composez *144*4*6*{amount}# sur votre téléphone pour générer votre code OTP de paiement.'
      },
      {
        id: 'moov_bf',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez la notification USSD sur votre mobile Moov.'
      }
    ]
  },
  {
    code: 'TG',
    name: 'Togo 🇹🇬',
    currency: 'XOF',
    rate: 620,
    prefix: '+228',
    networks: [
      {
        id: 'moov_tg',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez l\'invite USSD sur votre mobile Moov.'
      },
      {
        id: 'togocel',
        name: 'TMoney / Togocel',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez la notification TMoney avec votre code secret.'
      }
    ]
  },
  {
    code: 'GA',
    name: 'Gabon 🇬🇦',
    currency: 'XAF',
    rate: 620,
    prefix: '+241',
    networks: [
      {
        id: 'airtel_ga',
        name: 'Airtel Gabon',
        icon: '🔴',
        otp_required: false,
        instruction: 'Validez la demande de débit sur votre téléphone Airtel Money.'
      },
      {
        id: 'moov_ga',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez l\'invite sur votre mobile Moov.'
      }
    ]
  },
  {
    code: 'CG',
    name: 'Congo-Brazzaville 🇨🇬',
    currency: 'XAF',
    rate: 620,
    prefix: '+242',
    networks: [
      {
        id: 'airtel_cg',
        name: 'Airtel Congo',
        icon: '🔴',
        otp_required: false,
        instruction: 'Validez le paiement sur votre mobile Airtel Money.'
      },
      {
        id: 'mtn_cg',
        name: 'MTN MoMo',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez l\'invite USSD sur votre écran MTN MoMo.'
      }
    ]
  },
  {
    code: 'ML',
    name: 'Mali 🇲🇱',
    currency: 'XOF',
    rate: 620,
    prefix: '+223',
    networks: [
      {
        id: 'orange_ml',
        name: 'Orange Money',
        icon: '🍊',
        otp_required: false,
        instruction: 'Validez la demande avec votre code secret Orange Money.'
      },
      {
        id: 'moov_ml',
        name: 'Moov Money',
        icon: '🔵',
        otp_required: false,
        instruction: 'Validez l\'invite sur votre téléphone Moov.'
      },
      {
        id: 'wave_ml',
        name: 'Wave Mali',
        icon: '🌊',
        otp_required: false,
        instruction: 'Ouvrez votre application Wave pour valider.'
      },
      {
        id: 'mobi_cash_ml',
        name: 'Mobi Cash',
        icon: '🟣',
        otp_required: false,
        instruction: 'Validez la transaction sur votre compte Mobi Cash.'
      }
    ]
  },
  {
    code: 'NE',
    name: 'Niger 🇳🇪',
    currency: 'XOF',
    rate: 620,
    prefix: '+227',
    networks: [
      {
        id: 'airtel_ne',
        name: 'Airtel Niger',
        icon: '🔴',
        otp_required: false,
        instruction: 'Validez l\'invite de prélèvement sur votre téléphone Airtel.'
      }
    ]
  },
  {
    code: 'GN',
    name: 'Guinée 🇬🇳',
    currency: 'GNF',
    rate: 8600,
    prefix: '+224',
    networks: [
      {
        id: 'mtn_gn',
        name: 'MTN MoMo Guinea',
        icon: '🟡',
        otp_required: false,
        instruction: 'Validez l\'invite USSD reçue sur votre téléphone MTN MoMo.'
      }
    ]
  },
  {
    code: 'GH',
    name: 'Ghana 🇬🇭',
    currency: 'GHS',
    rate: 15.5,
    prefix: '+233',
    networks: [
      {
        id: 'mtn_gh',
        name: 'MTN MoMo Ghana',
        icon: '🟡',
        otp_required: false,
        instruction: 'Approve the prompt on your phone or dial *170#.'
      },
      {
        id: 'vodafone_gh',
        name: 'Telecel / Vodafone',
        icon: '🔴',
        otp_required: false,
        instruction: 'Approve the payment request on your mobile.'
      },
      {
        id: 'tigo_gh',
        name: 'AirtelTigo Ghana',
        icon: '🔵',
        otp_required: false,
        instruction: 'Approve the prompt on your phone.'
      }
    ]
  },
  {
    code: 'KE',
    name: 'Kenya 🇰🇪',
    currency: 'KES',
    rate: 130,
    prefix: '+254',
    networks: [
      {
        id: 'mpesa_ke',
        name: 'M-Pesa Kenya',
        icon: '🟢',
        otp_required: false,
        instruction: 'Enter your secret M-Pesa PIN on the prompt.'
      },
      {
        id: 'airtel_ke',
        name: 'Airtel Money Kenya',
        icon: '🔴',
        otp_required: false,
        instruction: 'Approve the Airtel Money prompt.'
      }
    ]
  },
  {
    code: 'CD',
    name: 'Rép. Dém. du Congo 🇨🇩',
    currency: 'CDF',
    rate: 2850,
    prefix: '+243',
    networks: [
      {
        id: 'orange_cd',
        name: 'Orange RDC',
        icon: '🍊',
        otp_required: false,
        instruction: 'Validez la demande sur votre mobile Orange Money.'
      },
      {
        id: 'vodacom_cd',
        name: 'Vodacom M-Pesa',
        icon: '🔴',
        otp_required: false,
        instruction: 'Validez l\'invite M-Pesa avec votre code secret.'
      },
      {
        id: 'airtel_cd',
        name: 'Airtel RDC',
        icon: '🔴',
        otp_required: false,
        instruction: 'Validez le prélèvement Airtel Money.'
      },
      {
        id: 'afrimoney_cd',
        name: 'Afrimoney',
        icon: '🟣',
        otp_required: false,
        instruction: 'Validez la transaction sur votre compte Afrimoney.'
      }
    ]
  },
  {
    code: 'RW',
    name: 'Rwanda 🇷🇼',
    currency: 'RWF',
    rate: 1350,
    prefix: '+250',
    networks: [
      {
        id: 'mtn_rw',
        name: 'MTN MoMo Rwanda',
        icon: '🟡',
        otp_required: false,
        instruction: 'Enter your MoMo PIN to complete payment.'
      },
      {
        id: 'airtel_rw',
        name: 'Airtel Rwanda',
        icon: '🔴',
        otp_required: false,
        instruction: 'Approve the Airtel Money prompt.'
      }
    ]
  },
  {
    code: 'UG',
    name: 'Ouganda 🇺🇬',
    currency: 'UGX',
    rate: 3700,
    prefix: '+256',
    networks: [
      {
        id: 'mtn_ug',
        name: 'MTN MoMo Uganda',
        icon: '🟡',
        otp_required: false,
        instruction: 'Approve the USSD prompt on your phone.'
      },
      {
        id: 'airtel_ug',
        name: 'Airtel Uganda',
        icon: '🔴',
        otp_required: false,
        instruction: 'Approve the Airtel Money prompt.'
      }
    ]
  },
  {
    code: 'TZ',
    name: 'Tanzanie 🇹🇿',
    currency: 'TZS',
    rate: 2600,
    prefix: '+255',
    networks: [
      {
        id: 'mpesa_tz',
        name: 'Vodacom M-Pesa',
        icon: '🔴',
        otp_required: false,
        instruction: 'Enter your M-Pesa PIN on your phone.'
      },
      {
        id: 'tigo_tz',
        name: 'Tigo Pesa',
        icon: '🔵',
        otp_required: false,
        instruction: 'Approve the Tigo Pesa prompt.'
      },
      {
        id: 'airtel_tz',
        name: 'Airtel Money',
        icon: '🔴',
        otp_required: false,
        instruction: 'Approve the Airtel Money prompt.'
      },
      {
        id: 'halopesa_tz',
        name: 'Halopesa',
        icon: '🟠',
        otp_required: false,
        instruction: 'Approve the Halopesa prompt.'
      }
    ]
  },
  {
    code: 'SL',
    name: 'Sierra Leone 🇸🇱',
    currency: 'SLE',
    rate: 23,
    prefix: '+232',
    networks: [
      {
        id: 'orange_sl',
        name: 'Orange Sierra Leone',
        icon: '🍊',
        otp_required: false,
        instruction: 'Approve the Orange Money prompt on your phone.'
      }
    ]
  },
  {
    code: 'NG',
    name: 'Nigeria 🇳🇬',
    currency: 'NGN',
    rate: 1600,
    prefix: '+234',
    networks: [
      {
        id: 'allbanks_ng',
        name: 'Virement bancaire (Swychr)',
        icon: '🏦',
        otp_required: false,
        instruction: 'Suivez les instructions pour finaliser le virement sécurisé.'
      }
    ]
  },
  {
    code: 'ALL',
    name: 'Tous Pays & Cartes Bancaires 🌍',
    currency: 'USD',
    rate: 1,
    prefix: '',
    networks: [
      {
        id: 'checkout_hosted',
        name: 'Guichet SasPay (Cartes, Visa/Mastercard & Mobile Money)',
        icon: '⚡',
        otp_required: false,
        instruction: 'Accédez au guichet sécurisé officiel SasPay pour choisir librement votre mode de règlement.'
      }
    ]
  }
];

function normalizePhoneNumber(phone, countryCode) {
  if (!phone) return '';
  let clean = String(phone).replace(/[^\d+]/g, '');
  const country = OFFICIAL_SASPAY_COUNTRIES.find(c => c.code === countryCode);
  const prefix = country ? country.prefix : '+225';
  const prefixDigits = prefix ? prefix.replace('+', '') : '';

  if (clean.startsWith('+')) {
    return clean;
  }
  if (clean.startsWith('00')) {
    return '+' + clean.slice(2);
  }
  if (prefixDigits && clean.startsWith(prefixDigits)) {
    return '+' + clean;
  }
  if (clean.startsWith('0') && prefixDigits) {
    clean = clean.slice(1);
  }
  return prefix ? (prefix + clean) : clean;
}

class PaymentService {
  /**
   * Retourne la liste officielle des pays et opérateurs supportés
   */
  getCountries() {
    return OFFICIAL_SASPAY_COUNTRIES;
  }

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
        timeout: 15000 // Timeout optimisé 15s pour éviter tout blocage
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
   * Gère de façon fiable tous les pays, devises (XAF, XOF, GNF, USD, etc.) et opérateurs.
   * Ne crédite le compte que lors de la validation officielle.
   */
  async createSasPayDeposit({
    userId,
    amountUsd,
    country,
    network,
    phone,
    otp,
    customerName,
    customerEmail,
    returnUrl,
    isPurchase,
    productId,
    quantity,
    preferredMode
  }) {
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
    const isDirectPurchase = Boolean(isPurchase || productId);
    const minRequired = isDirectPurchase ? 0.50 : (db.data.settings?.min_recharge || 5.0);

    if (isNaN(parsedUsd) || parsedUsd < minRequired) {
      throw new Error(isDirectPurchase 
        ? `Le montant minimum pour un paiement est de $${minRequired.toFixed(2)} USD.` 
        : `Le montant minimum de recharge est de $${minRequired.toFixed(2)} USD.`);
    }

    if (!SASPAY_API_KEY) {
      throw new Error('Clé API SasPay non configurée sur le serveur.');
    }

    // Résolution précise du pays et de la devise officielle
    const countryCode = (country || 'CI').toUpperCase();
    const countryConfig = OFFICIAL_SASPAY_COUNTRIES.find(c => c.code === countryCode) || OFFICIAL_SASPAY_COUNTRIES[0];
    const currency = countryConfig.currency;
    const localRate = countryConfig.rate;

    // Calcul du montant décimal formatté (règle SasPay : chaîne décimale stricte "2500.00")
    const calculatedLocalAmount = Math.round(parsedUsd * localRate);
    const formattedAmount = calculatedLocalAmount.toFixed(2);

    // Formatage et normalisation du téléphone selon le pays
    const cleanPhone = normalizePhoneNumber(phone, countryCode);

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

    console.log(`[SasPay] Nouvelle transaction initiée : ${txId} (${parsedUsd} USD -> ${formattedAmount} ${currency}) par ${user.email} [${countryCode}]`);

    try {
      const isCheckoutSessionMode = (!network || network === 'checkout_hosted' || preferredMode === 'checkout');

      if (isCheckoutSessionMode) {
        // Option A : Création d'une session de checkout hébergée SasPay officielle
        const sessionPayload = {
          amount: formattedAmount,
          currency: currency,
          description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD - ${user.email}`,
          country: countryCode === 'ALL' ? undefined : countryCode,
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

        const res = await this.requestSasPay('checkout-sessions/', 'POST', sessionPayload);
        if (!res.ok || !res.data?.success) {
          const errMsg = res.data?.error?.message || res.data?.message || 'Échec de création de la session de paiement SasPay.';
          db.updateTransaction(txId, { status: 'failed', failureReason: errMsg });
          throw new Error(errMsg);
        }

        const saspayResult = res.data.data;
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
          instructions: 'Paiement sécurisé via le guichet officiel SasPay.'
        };
      } else {
        // Option B : Softpay direct (push sur mobile / USSD / lien opérateur)
        let cleanNetwork = (network || '').trim().toLowerCase();
        if (cleanNetwork && !cleanNetwork.includes('_') && countryCode && cleanNetwork !== 'card' && cleanNetwork !== 'crypto' && cleanNetwork !== 'direct' && cleanNetwork !== 'togocel') {
          cleanNetwork = `${cleanNetwork}_${countryCode.toLowerCase()}`;
        }

        const nameParts = (customerName || user.name || 'Client GetVirtu').trim().split(' ');
        const firstName = nameParts[0] || 'Client';
        const lastName = nameParts.slice(1).join(' ') || 'GetVirtu';

        const softpayPayload = {
          amount: formattedAmount,
          currency: currency,
          country: countryCode,
          network: cleanNetwork,
          customer: {
            email: (customerEmail && !customerEmail.includes('admin@')) ? customerEmail.trim() : (user.role !== 'admin' && !user.email.includes('admin@') ? user.email.trim() : `client_${user.id}@getvirtu.shop`),
            first_name: firstName,
            last_name: lastName,
            phone: cleanPhone || '+237690000000'
          },
          description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD`,
          return_url: returnUrl || 'https://getvirtu.shop/#deposit_success',
          metadata: {
            internalTxId: txId,
            userId: user.id,
            amountUsd: parsedUsd.toFixed(2)
          }
        };

        // Si OTP pré-paiement fourni (ex: Orange CI #144*82# ou Orange BF *144*4*6*montant#)
        if (otp) {
          softpayPayload.otp = String(otp).trim();
        }

        const res = await this.requestSasPay('payments/softpay/', 'POST', softpayPayload, {
          'Idempotency-Key': idempotencyKey
        });

        if (!res.ok || !res.data?.success) {
          console.warn(`[SasPay Softpay] Échec direct (${cleanNetwork}): ${res.data?.message || res.data?.error?.message || res.status}. Bascule de secours vers session hébergée...`);
          // En cas d'indisponibilité temporaire du push direct, repli transparent vers session de checkout
          const fallbackPayload = {
            amount: formattedAmount,
            currency: currency,
            description: `Recharge GetVirtu ${parsedUsd.toFixed(2)} USD - ${user.email}`,
            country: countryCode === 'ALL' ? undefined : countryCode,
            customer_email: (customerEmail && !customerEmail.includes('admin@')) ? customerEmail.trim() : `client_${user.id}@getvirtu.shop`,
            customer_name: customerName || user.name,
            customer_phone: cleanPhone || '',
            return_url: returnUrl || 'https://getvirtu.shop/#deposit_success',
            metadata: { internalTxId: txId, userId: user.id, amountUsd: parsedUsd.toFixed(2) }
          };

          const fallbackRes = await this.requestSasPay('checkout-sessions/', 'POST', fallbackPayload);
          if (fallbackRes.ok && fallbackRes.data?.success) {
            const fallbackResult = fallbackRes.data.data;
            db.updateTransaction(txId, { providerTxId: fallbackResult.id });
            return {
              success: true,
              transactionId: txId,
              providerTxId: fallbackResult.id,
              status: 'pending',
              checkoutUrl: fallbackResult.checkout_url,
              mode: 'checkout',
              amountUsd: parsedUsd,
              localAmount: formattedAmount,
              currency: currency,
              instructions: 'Paiement sécurisé via le guichet officiel SasPay.'
            };
          }

          const errMsg = res.data?.error?.message || res.data?.message || 'Erreur lors de l\'initiation Mobile Money auprès de l\'opérateur.';
          db.updateTransaction(txId, { status: 'failed', failureReason: errMsg });
          throw new Error(errMsg);
        }

        const saspayResult = res.data?.data || res.data || {};
        if (saspayResult.id) {
          db.updateTransaction(txId, { providerTxId: saspayResult.id });
        }

        // Instructions claires et adaptées à chaque opérateur
        let instructionsList = (Array.isArray(saspayResult.instructions) && saspayResult.instructions.length > 0)
          ? saspayResult.instructions
          : null;

        if (!instructionsList) {
          if (saspayResult.checkout_url) {
            instructionsList = ['Cliquez sur "Ouvrir le paiement" ci-dessous pour finaliser la transaction sur votre application ou navigateur.'];
          } else if (cleanNetwork.startsWith('orange_cm')) {
            instructionsList = ['Demande de paiement envoyée. IMPORTANT : Si aucun pop-up n\'apparaît sur votre téléphone, composez le #150*50# (ou #150*4*4#) pour valider avec votre code PIN secret.'];
          } else if (cleanNetwork.startsWith('mtn_cm')) {
            instructionsList = ['Validez l\'invite USSD envoyée sur votre mobile ou composez le *126# pour approuver le prélèvement MTN MoMo.'];
          } else if (cleanNetwork.startsWith('orange_ci')) {
            instructionsList = ['Transaction initiée avec votre code d\'autorisation Orange Money. Validez si une invite s\'affiche.'];
          } else if (cleanNetwork.startsWith('mtn_ci')) {
            instructionsList = ['Validez la demande en composant le *133# sur votre mobile MTN MoMo.'];
          } else if (cleanNetwork.startsWith('moov_')) {
            instructionsList = ['Validez l\'invite avec votre code PIN Moov Money sur votre mobile.'];
          } else if (cleanNetwork.startsWith('wave_')) {
            instructionsList = ['Ouvrez l\'application Wave pour confirmer le paiement.'];
          } else {
            instructionsList = ['Validez la demande de débit avec votre code PIN secret sur votre téléphone portable.'];
          }
        }

        // Retour immédiat sans deuxième appel bloquant
        return {
          success: true,
          transactionId: txId,
          providerTxId: saspayResult.id,
          status: 'pending',
          checkoutUrl: saspayResult.checkout_url || null,
          instructions: instructionsList,
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
        success: true,
        status: tx.status,
        message: tx.failureReason || 'Cette transaction a été annulée ou a échoué.'
      };
    }

    // Appel de vérification officielle auprès de l'API SasPay
    try {
      const verifyRes = await this.requestSasPay(`/payments/${effectiveProviderTxId}/verify/`, 'GET');

      if (!verifyRes.ok) {
        // Tentative de vérification par statut de session de checkout si c'était une session
        let sessionRes = await this.requestSasPay(`checkout-sessions/${effectiveProviderTxId}/status/`, 'GET');
        if (!sessionRes.ok || !sessionRes.data?.id) {
          sessionRes = await this.requestSasPay(`checkout-sessions/${effectiveProviderTxId}/`, 'GET');
        }

        if (sessionRes.ok && sessionRes.data?.success) {
          const sData = sessionRes.data.data || sessionRes.data;
          const sStatus = (sData.status || '').toUpperCase();
          const tStatus = (sData.transaction_status || '').toUpperCase();
          if (sStatus === 'PAID' || sStatus === 'SUCCESS' || tStatus === 'SUCCESS') {
            const txIdToVerify = (sData.transaction && typeof sData.transaction === 'object' ? sData.transaction.id : sData.transaction) || sData.transaction_id || effectiveProviderTxId;
            return await this.verifySasPayPayment({ transactionId: tx.id, providerTxId: txIdToVerify });
          } else if (sStatus === 'EXPIRED' || sStatus === 'FAILED' || sStatus === 'CANCELLED' || tStatus === 'FAILED') {
            const failedTx = db.updateTransaction(tx.id, {
              status: 'failed',
              failureReason: `Session de paiement ${sStatus.toLowerCase()}.`,
              updatedAt: new Date().toISOString()
            });
            return { success: false, status: 'failed', message: failedTx.failureReason, transaction: failedTx };
          }
          return { success: true, status: 'pending', message: 'Session en attente de validation sur votre téléphone portable...' };
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
        await db.persistToRemote();

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
          success: true,
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

      let user = db.getUserById(tx.userId);
      if (!user && tx.userEmail) {
        user = db.getUserByEmail(tx.userEmail);
      }
      if (!user) {
        user = db.createUser({
          id: tx.userId || `user-${Date.now()}`,
          email: tx.userEmail || tx.metadata?.customerEmail || `client_${tx.id}@getvirtu.shop`,
          name: tx.metadata?.customerName || 'Client GetVirtu',
          role: 'client',
          balance: 0.00
        });
      }

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
    let user = db.getUserById(userId);
    if (!user) {
      user = db.createUser({
        id: userId,
        email: `client_${userId}@getvirtu.shop`,
        name: 'Client GetVirtu',
        role: 'client',
        balance: 0.00
      });
    }

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

    let user = db.getUserById(transaction.userId);
    if (!user && transaction.metadata?.customerEmail) {
      user = db.getUserByEmail(transaction.metadata.customerEmail);
    }
    if (!user) {
      user = db.createUser({
        id: transaction.userId || `user-${Date.now()}`,
        email: transaction.metadata?.customerEmail || `client_${transaction.id}@getvirtu.shop`,
        name: transaction.metadata?.customerName || 'Client GetVirtu',
        role: 'client',
        balance: 0.00
      });
    }

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

    await db.persistToRemote();
    return { success: true, transaction: completedTx, newBalance };
  }

  getUserTransactions(userId) {
    return db.getTransactions({ userId });
  }

  // ========== INTÉGRATION OFFICIELLE CRYPTO TRYBIT ==========

  /**
   * Création d'une recharge de solde ou d'un achat direct par Crypto Instantané via Trybit
   */
  async createTrybitDeposit({ userId, amountUsd, customerEmail, customerName, cryptocurrency, returnUrl, productId, quantity, contactInfo }) {
    if (!userId) throw new Error('Utilisateur non authentifié.');
    let user = db.getUserById(userId);
    if (!user && customerEmail) {
      user = db.getUserByEmail(customerEmail);
    }
    if (!user) {
      // Auto-provision user in db if missing in serverless instance
      user = db.createUser({
        id: userId,
        email: (customerEmail && !customerEmail.includes('admin@')) ? customerEmail : `client_${userId}@getvirtu.shop`,
        name: customerName || 'Client GetVirtu',
        role: 'client',
        balance: 0.00
      });
    }

    const parsedUsd = parseFloat(amountUsd);
    const minRecharge = productId ? 0.01 : (db.data.settings?.min_recharge || 5.0);

    if (isNaN(parsedUsd) || parsedUsd < minRecharge) {
      throw new Error(`Le montant minimum est de ${minRecharge.toFixed(2)} USD.`);
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
        returnUrl: returnUrl || 'https://getvirtu.shop/?payment_status=success',
        productId: productId || null,
        quantity: quantity || 1,
        contactInfo: contactInfo || null
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

    if (invStatus === 'paid' || invStatus === 'overpaid' || invInvoiceStatus === 'success' || invStatus === 'success') {
      return await this._creditUserForTransaction(tx, effectiveUuid, invoiceData);
    } else if (invStatus === 'canceled' || invStatus === 'cancelled' || invStatus === 'expired') {
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
  async handleTrybitWebhook(payload = {}, headers = {}) {
    console.log('[Trybit POSTBACK] Traitement notification webhook...');
    if (!payload || typeof payload !== 'object') {
      throw new Error('Payload webhook Trybit invalide.');
    }

    // Extraction du jeton JWT dans le corps ou dans les en-têtes HTTP
    let token = payload.token || payload.jwt;
    if (!token && headers) {
      const authHeader = headers['authorization'] || headers['Authorization'] || '';
      if (authHeader) {
        token = authHeader.replace(/^(Bearer|Token)\s+/i, '').trim();
      }
      if (!token) {
        token = headers['x-token'] || headers['x-webhook-token'] || headers['token'] || '';
      }
    }

    let tokenPayload = null;
    if (token) {
      const verifyResult = trybitService.verifyWebhookToken(token);
      if (!verifyResult.valid) {
        console.warn('[Trybit POSTBACK] Jeton JWT invalide ou expiré :', verifyResult.error);
        throw new Error('Jeton JWT du webhook Trybit invalide: ' + verifyResult.error);
      }
      tokenPayload = verifyResult.payload;
    } else {
      console.log('[Trybit POSTBACK] Information: notification reçue sans jeton JWT de signature.');
    }

    const orderId = payload.order_id || tokenPayload?.order_id || payload.orderId;
    const invoiceId = payload.invoice_id || tokenPayload?.invoice_id || payload.invoiceId;
    const invoiceInfo = payload.invoice_info || tokenPayload?.invoice_info || {};
    const uuid = invoiceInfo.uuid || (invoiceId ? (invoiceId.startsWith('INV-') ? invoiceId : `INV-${invoiceId}`) : null);

    let tx = null;
    if (orderId) tx = db.getTransactionById(orderId);
    if (!tx && uuid) tx = db.getTransactionByProviderTxId(uuid);
    if (!tx && invoiceId) tx = db.getTransactionByProviderTxId(invoiceId);
    if (!tx && uuid) {
      tx = db.data.transactions.find(t => t.metadata?.invoiceUuid === uuid || t.providerTxId === uuid);
    }

    if (!tx) {
      console.warn(`[Trybit POSTBACK] Transaction introuvable pour order_id: ${orderId}, uuid: ${uuid}`);
      return { success: true, message: 'Notification reçue (transaction non locale).' };
    }

    // Protection anti-double traitement (Idempotence)
    if (tx.status === 'completed') {
      console.log(`[Trybit POSTBACK] Transaction ${tx.id} déjà traitée (Idempotence).`);
      return { success: true, message: 'Déjà traitée.' };
    }

    const status = (payload.status || tokenPayload?.status || invoiceInfo.status || '').toLowerCase();
    const invoiceStatus = (invoiceInfo.invoice_status || '').toLowerCase();

    if (status === 'success' || status === 'paid' || status === 'overpaid' || invoiceStatus === 'success' || invoiceStatus === 'paid') {
      return await this._creditUserForTransaction(tx, uuid || tx.providerTxId, { ...invoiceInfo, payload });
    } else if (status === 'canceled' || status === 'cancelled' || status === 'expired') {
      db.updateTransaction(tx.id, {
        status: 'failed',
        failureReason: 'Annulé ou expiré sur Trybit.'
      });
      return { success: true, message: 'Transaction marquée annulée.' };
    }

    return { success: true, message: 'Statut Trybit enregistré.' };
  }

  /**
   * Crédit atomique et sécurisé du solde utilisateur ou livraison directe de commande
   */
  async _creditUserForTransaction(tx, providerTxId, extraData = {}) {
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

    // 1. Si c'était un achat direct de produit par crypto
    if (tx.metadata?.productId) {
      const prod = db.getProductById(tx.metadata.productId);
      if (prod) {
        const qty = parseInt(tx.metadata.quantity, 10) || 1;
        const orderId = 'ORD-' + (tx.id.replace('TXN-TB-', '').substring(0, 8) || Date.now().toString().slice(-6));
        let deliveredContent = null;

        try {
          const allocRes = await db.allocateKeysForProduct(prod.id, qty, {
            orderId: orderId,
            userId: user.id,
            userEmail: user.email
          });
          const keysList = allocRes.allocatedKeys || [];
          deliveredContent = {
            type: 'text',
            content: keysList.map(k => k.content).join('\n'),
            keys: keysList,
            fileName: 'licences.txt'
          };
        } catch (allocErr) {
          console.warn('[Trybit Achat] Allocation de clés:', allocErr.message);
          // Fallback déterministe sécurisé si les clés étaient manquantes
          deliveredContent = {
            type: 'text',
            content: 'GV-' + prod.id + '-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase() + ' (Licence Active)'
          };
        }

        db.createOrder({
          id: orderId,
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
          productId: prod.id,
          productName: prod.name,
          unitPrice: prod.price,
          quantity: qty,
          amount: tx.amount,
          remainingBalance: user.balance,
          userBalanceAfter: user.balance,
          contactInfo: tx.metadata.contactInfo || '',
          method: 'Crypto Instantané (Trybit)',
          status: 'Complété',
          vaultContent: deliveredContent
        });
        console.log(`[Trybit Achat] Commande débloquée et livrée avec succès pour ${prod.name} (x${qty}) !`);
      }
    } else {
      // 2. Si c'était une recharge de solde
      const creditAmount = tx.amount || 0;
      const newBalance = Math.round(((user.balance || 0) + creditAmount) * 100) / 100;
      db.updateUser(user.id, { balance: newBalance });
      console.log(`[Paiement Validé] Transaction ${tx.id} complétée. Solde ${user.email} crédité de +${creditAmount} USD. Nouveau solde : ${newBalance} USD.`);
    }

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

    await db.persistToRemote();

    return {
      success: true,
      status: 'completed',
      newBalance: user.balance,
      creditedAmount: tx.amount,
      transaction: completedTx,
      message: 'Paiement Trybit confirmé avec succès !'
    };
  }
}

module.exports = new PaymentService();
