#!/usr/bin/env node
/**
 * GetVirtu — local demonstration shop (never touches production).
 *
 *   npm run demo            -> http://localhost:3000  (admin: http://localhost:3000/admin)
 *
 * - Data in a temporary folder (GV_STORE=file), .env ignored, no database URL, no payment key:
 *   no real customer, no real money, nothing sent to SasPay / Vercel / Supabase.
 * - Demo content: products (one sold out, one with a 15-minute delayed delivery, instant keys, WhatsApp delivery),
 *   two customers with a balance, a few orders and visits, so every admin screen has something to show.
 * - The administrator password is generated at start and printed below (valid for this demo only).
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getvirtu-demo-'));
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'SASPAY_API_KEY',
  'SASPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'MAIL_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CRON_SECRET']) delete process.env[k];
process.env.GV_SKIP_DOTENV = '1';
process.env.GV_STORE = 'file';
process.env.GV_DATA_DIR = dataDir;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = 'Demo-' + crypto.randomBytes(4).toString('hex') + '-7';
{
  const salt = crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;
}
const PORT = Number(process.env.PORT) || 3000;
const CUSTOMER_PASSWORD = 'Client-Demo-12';

const server = require('../server');

function call(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seed() {
  const admin = (await call('POST', '/api/auth/login', { identifier: 'admin@getvirtu.shop', password: ADMIN_PASSWORD })).body.session.token;
  const product = async (p) => {
    const r = await call('POST', '/api/data/products', p, admin);
    if (r.status !== 200) throw new Error('demo product: ' + JSON.stringify(r.body));
    return r.body.product.id;
  };
  await product({ name: 'Gmail USA 2005 - 2009', category: 'E-mail', price: 6.3, costPrice: 3, deliveryMode: 'manual', deliveryTiming: 'delayed', deliveryDelayMinutes: 15, stock: 0, description: 'Exemple de produit en rupture : il passe automatiquement en bas du catalogue.' });
  const delayed = await product({ name: 'Gmail USA 2010 - 2015', category: 'E-mail', price: 5.4, costPrice: 2.5, deliveryMode: 'manual', deliveryTiming: 'delayed', deliveryDelayMinutes: 15, stock: 10, description: 'Livraison au plus tard 15 minutes après le paiement : l\'administrateur peut livrer avant.' });
  const instant = await product({ name: 'VPN Premium – Connexion sécurisée', category: 'Abonnements', price: 10, costPrice: 4, newKeys: ['VPN-DEMO-0001', 'VPN-DEMO-0002', 'VPN-DEMO-0003', 'VPN-DEMO-0004', 'VPN-DEMO-0005'], description: 'Clé livrée automatiquement et immédiatement.' });
  const whatsapp = await product({ name: 'Création de votre chaîne YouTube', category: 'Services & formations', price: 35, deliveryMode: 'manual', stock: 10, description: 'Service personnalisé livré à la main (WhatsApp).' });
  const customer = async (email, name) => {
    const r = await call('POST', '/api/auth/register', { email, password: CUSTOMER_PASSWORD, confirmPassword: CUSTOMER_PASSWORD, name });
    await call('POST', '/api/data/users', { userId: r.body.user.id, amount: 100, action: 'gift', reason: 'Solde de démonstration' }, admin);
    return r.body.session.token;
  };
  const ana = await customer('ana.demo@example.com', 'Ana Démo');
  const bob = await customer('bob.demo@example.com', 'Bob Démo');
  await call('POST', '/api/data/orders', { productId: instant, quantity: 2 }, bob);
  await call('POST', '/api/data/orders', { productId: whatsapp, quantity: 1 }, bob);
  await call('POST', '/api/data/orders', { productId: delayed, quantity: 1 }, ana);
  for (const v of ['demo-visitor-1', 'demo-visitor-2', 'demo-visitor-3']) await call('POST', '/api/data/visitors', { vid: v, isNew: true });
}

server.listen(PORT, '127.0.0.1', async () => {
  try {
    await seed();
  } catch (e) {
    console.error('Démo : préparation des données impossible —', e.message);
  }
  console.log('\n================ BOUTIQUE DE DÉMONSTRATION (locale, données fictives) ================');
  console.log(`  Boutique        : http://localhost:${PORT}`);
  console.log(`  Administration  : http://localhost:${PORT}/admin`);
  console.log(`  Admin           : admin@getvirtu.shop  /  ${ADMIN_PASSWORD}`);
  console.log(`  Clients         : ana.demo@example.com  et  bob.demo@example.com  /  ${CUSTOMER_PASSWORD}`);
  console.log(`  Données         : ${dataDir} (supprimables, aucune donnée réelle)`);
  console.log('  Paiement Mobile Money : désactivé dans la démo (aucune clé SasPay, aucun argent réel).');
  console.log('  Arrêt          : Ctrl + C');
  console.log('======================================================================================\n');
});
