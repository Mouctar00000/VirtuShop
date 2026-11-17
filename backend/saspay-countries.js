/**
 * GetVirtu — SasPay countries, operators and phone number normalization (backend/saspay-countries.js)
 */

'use strict';

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
        instruction: 'Tapez #150*50#'
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

// Mobile numbering plans (national significant number, i.e. what follows the country code).
// len: accepted lengths. keep0: the leading 0 is PART of the number (Côte d'Ivoire since 2021, Bénin since 2024,
// Congo) — it must never be removed, otherwise the operator push goes to a non-existent number.
// legacy8Prefix: official migration of the old 8-digit numbers (Bénin: "01" + old number).
// Countries without a rule are sent as typed: SasPay adds the country code itself and never reformats a local number.
const PHONE_RULES = {
  CM: { len: [9], example: '6XX XX XX XX' },
  CI: { len: [10], keep0: true, example: '07 XX XX XX XX', hint: "Depuis 2021, les numéros ivoiriens comportent 10 chiffres (07… Orange, 05… MTN, 01… Moov)." },
  SN: { len: [9], example: '7X XXX XX XX' },
  BJ: { len: [10], keep0: true, legacy8Prefix: '01', example: '01 XX XX XX XX' },
  BF: { len: [8], example: 'XX XX XX XX' },
  TG: { len: [8], example: '9X XX XX XX' },
  ML: { len: [8], example: 'XX XX XX XX' },
  NE: { len: [8], example: '9X XX XX XX' },
  GN: { len: [9], example: '6XX XX XX XX' },
  CG: { len: [9], keep0: true, example: '06 XXX XX XX' },
  GH: { len: [9], example: '24X XXX XXX' },
  KE: { len: [9], example: '7XX XXX XXX' },
  CD: { len: [9], example: '8X XXX XXXX' },
  RW: { len: [9], example: '78X XXX XXX' },
  UG: { len: [9], example: '7XX XXX XXX' },
  TZ: { len: [9], example: '7XX XXX XXX' },
  NG: { len: [10], example: '80X XXX XXXX' },
  SL: { len: [8], example: '7X XXX XXX' }
};

/**
 * Validates and normalizes a Mobile Money number for the chosen country.
 * Returns { phone, error }: phone in international format (+CC…) when the numbering plan is known,
 * error = clear French message when the number cannot be valid (wrong length, other country...).
 */
function normalizeMobileNumber(phone, countryCode) {
  const raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return { phone: '', error: 'Veuillez indiquer votre numéro Mobile Money.' };
  const country = OFFICIAL_SASPAY_COUNTRIES.find(c => c.code === countryCode);
  const prefix = country && country.prefix ? country.prefix : '';
  const cc = prefix.replace('+', '');
  const rule = PHONE_RULES[countryCode];
  const international = /^(\+|00)/.test(raw);
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!cc) return { phone: (international ? '+' : '') + digits, error: digits.length < 6 ? 'Numéro de téléphone invalide.' : null };

  let national;
  if (international) {
    if (!digits.startsWith(cc)) {
      return { phone: '', error: `Ce numéro n'appartient pas au pays choisi (${country.name.replace(/\s*\S*$/u, '')}, indicatif ${prefix}). Choisissez le bon pays ou saisissez le numéro local.` };
    }
    national = digits.slice(cc.length);
  } else if (digits.startsWith(cc) && rule) {
    const rest = digits.slice(cc.length);
    const plausible = rule.len.includes(rest.length) || (rule.legacy8Prefix && rest.length === 8) || (rule.keep0 && rest.length === rule.len[0] - 1 && !rest.startsWith('0'));
    national = plausible ? rest : digits;
  } else if (digits.startsWith(cc) && !rule && digits.length > cc.length + 6) {
    national = digits.slice(cc.length);
  } else {
    national = digits;
  }

  if (!rule) {
    // Numbering plan not verified: send exactly what the customer typed (SasPay adds the country code itself)
    if (national.length < 6 || national.length > 12) return { phone: '', error: 'Numéro de téléphone invalide.' };
    return { phone: international ? '+' + cc + national : national, error: null };
  }
  if (!rule.keep0) {
    while (national.startsWith('0') && !rule.len.includes(national.length)) national = national.slice(1);
  } else if (national.length === rule.len[0] - 1 && !national.startsWith('0')) {
    national = '0' + national; // leading 0 forgotten by the customer (e.g. 7 07 07 07 07 in Côte d'Ivoire)
  }
  if (rule.legacy8Prefix && national.length === 8) national = rule.legacy8Prefix + national;
  if (!rule.len.includes(national.length)) {
    const label = country.name.replace(/\s*\S*$/u, '').trim();
    return {
      phone: '',
      error: `Numéro invalide pour ${label} : ${rule.len.join(' ou ')} chiffres attendus après l'indicatif ${prefix} (exemple : ${prefix} ${rule.example}).` + (rule.hint ? ' ' + rule.hint : '')
    };
  }
  return { phone: '+' + cc + national, error: null };
}

/** Backward-compatible helper: normalized number (or the cleaned input when it cannot be validated). */
function normalizePhoneNumber(phone, countryCode) {
  const r = normalizeMobileNumber(phone, countryCode);
  return r.phone || String(phone || '').replace(/[^\d+]/g, '');
}

module.exports = { OFFICIAL_SASPAY_COUNTRIES, PHONE_RULES, normalizeMobileNumber, normalizePhoneNumber };
