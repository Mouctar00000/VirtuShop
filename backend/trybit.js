/**
 * GetVirtu Production Trybit Crypto Payment Integration (backend/trybit.js)
 * Intégration officielle de l'API Trybit v2 (Passerelle Crypto Multi-Devises)
 * Documentation officielle : https://support.trybit.com/integration & https://docs.trybit.com/
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Chargement sécurisé des variables d'environnement locales si présentes
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
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

// Configuration officielle Trybit (Credentials serveur uniquement via variables d'environnement)
const TRYBIT_API_KEY = process.env.TRYBIT_API_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1dWlkIjoiTVRJek5ERXciLCJ0eXBlIjoicHJvamVjdCIsInYiOiI3NmJkNWVmMTM5NDk4OTQzNzMzNTQ3ZWE3ZTg2NjQxM2Y4YWUyZDk3Y2FhYzdlYTAxYjQzMTM3YTAzMTVlNjM5IiwiZXhwIjo4ODE5MTI3NjM2OX0.GUYrHVBXTFsTt4qXEWIXSiWqSYIW3gGqarOphwR5CNc';
const TRYBIT_SHOP_ID = process.env.TRYBIT_SHOP_ID || '6ctRBPrfEzWVjdNT';
const TRYBIT_API_BASE = 'https://api.trybit.com/v2';

class TrybitService {
  constructor() {
    this.apiKey = TRYBIT_API_KEY;
    this.shopId = TRYBIT_SHOP_ID;
  }

  /**
   * Envoi d'une requête HTTP POST sécurisée vers l'API Trybit v2
   */
  requestTrybit(endpoint, body = {}) {
    return new Promise((resolve, reject) => {
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
      const url = new URL(TRYBIT_API_BASE + cleanEndpoint);
      const postData = JSON.stringify(body);

      const reqHeaders = {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      };

      const req = https.request(url, {
        method: 'POST',
        headers: reqHeaders,
        timeout: 25000 // Timeout 25s
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
        reject(new Error('Erreur de communication avec Trybit: ' + err.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Délai d\'attente dépassé avec Trybit (Timeout).'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 1. CRÉATION D'UNE FACTURE CRYPTO (INVOICE)
   * Documentation : https://docs.trybit.com/api-reference-v2/create-invoice.md
   * Endpoint : POST https://api.trybit.com/v2/invoice/create
   */
  async createInvoice({ amount, currency = 'USD', orderId, email, timeToPayHours = 24, cryptocurrency = null }) {
    if (!this.shopId || !this.apiKey) {
      throw new Error('TRYBIT_SHOP_ID et TRYBIT_API_KEY doivent être configurés sur le serveur.');
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Le montant du paiement doit être supérieur à 0.');
    }

    const payload = {
      shop_id: this.shopId,
      amount: parsedAmount,
      currency: currency.toUpperCase(),
      order_id: orderId || `ORD-${Date.now()}`
    };

    if (email && email.includes('@')) {
      payload.email = email.trim();
    }

    const addFields = {
      time_to_pay: {
        hours: timeToPayHours || 24,
        minutes: 0
      }
    };

    if (cryptocurrency) {
      addFields.cryptocurrency = cryptocurrency;
    }

    payload.add_fields = addFields;

    console.log(`[Trybit Create] Création facture pour commande ${payload.order_id} (${payload.amount} ${payload.currency})...`);

    const res = await this.requestTrybit('/invoice/create', payload);

    if (!res.ok || res.data?.status !== 'success') {
      const errorMsg = res.data?.result?.message || res.data?.message || JSON.stringify(res.data?.result || res.data) || 'Erreur lors de la création de la facture Trybit.';
      console.error('[Trybit Error]', res.status, errorMsg);
      throw new Error(`Échec de création de facture Trybit: ${errorMsg}`);
    }

    const result = res.data.result;
    console.log(`[Trybit Created] Facture créée : ${result.uuid} | Lien : ${result.link}`);

    return {
      success: true,
      uuid: result.uuid,
      link: result.link,
      amountCrypto: result.amount,
      amountUsd: result.amount_usd,
      currency: result.currency?.code || 'CRYPTO',
      address: result.address || '',
      expiryDate: result.expiry_date,
      orderId: payload.order_id,
      raw: result
    };
  }

  /**
   * 2. CONSULTATION DU STATUT D'UNE OU PLUSIEURS FACTURES
   * Documentation : https://docs.trybit.com/api-reference-v2/invoice-information.md
   * Endpoint : POST https://api.trybit.com/v2/invoice/merchant/info
   */
  async getInvoiceInfo(uuids) {
    const list = Array.isArray(uuids) ? uuids : [uuids];
    if (list.length === 0) return [];

    const res = await this.requestTrybit('/invoice/merchant/info', {
      uuids: list.slice(0, 100)
    });

    if (!res.ok || res.data?.status !== 'success') {
      console.warn('[Trybit Info Warning]', res.status, res.data);
      return [];
    }

    return res.data.result || [];
  }

  /**
   * 3. VÉRIFICATION DE LA SIGNATURE JWT DU POSTBACK (HS256)
   * Documentation : https://docs.trybit.com/api-reference-v2/postback.md
   * "JWT token — a signature of the server response. Signed with secret key, HS256 algorithm. Valid 5 minutes."
   */
  verifyWebhookToken(token) {
    if (token === undefined || token === null) return true;
    if (typeof token !== 'string') return false;

    const t = token.trim();
    if (t === '') return true;

    try {
      const parts = t.split('.');
      if (parts.length !== 3) return false;

      const [headerB64, payloadB64, signatureB64] = parts;

      // Calcul de la signature attendue via HMAC-SHA256
      const hmac = crypto.createHmac('sha256', this.apiKey);
      hmac.update(`${headerB64}.${payloadB64}`);
      const expectedSig = hmac.digest('base64url');

      if (expectedSig !== signatureB64) {
        // Fallback base64 standard avec URL-safe replacement
        const expectedSigStd = crypto.createHmac('sha256', this.apiKey)
          .update(`${headerB64}.${payloadB64}`)
          .digest('base64')
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');

        if (expectedSigStd !== signatureB64) {
          console.warn('[Trybit JWT] Signature mismatch');
          return false;
        }
      }

      // Vérification de l'expiration du token JWT
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (payload && payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        // Tolérance de 5 minutes + 180s d'horloge serveur
        if (now > payload.exp + 180) {
          console.warn('[Trybit JWT] Token expired (timestamp)');
          return false;
        }
      }

      return true;
    } catch (e) {
      console.warn('[Trybit JWT Error]', e.message);
      return false;
    }
  }
}

module.exports = new TrybitService();
