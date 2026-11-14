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

module.exports = { OFFICIAL_SASPAY_COUNTRIES, normalizePhoneNumber };
