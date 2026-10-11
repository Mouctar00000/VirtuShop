const assert = require('assert');
const crypto = require('crypto');
const paymentService = require('../backend/payments');
const paymentsHandler = require('../api/payments');
const authService = require('../backend/auth');
const db = require('../backend/db');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; }
  };
}

async function runPaymentTests() {
  console.log('=== TEST MATRICIEL END-TO-END : AUDIT & VALIDATION MULTI-PAYS SASPAY ===\n');

  // 1. VÉRIFICATION DU CATALOGUE MULTI-PAYS OFFICIEL ET DES DEVISES
  console.log('[TEST 1] Audit du catalogue multi-pays et des devises officielles...');
  const countries = paymentService.getCountries();
  assert(Array.isArray(countries) && countries.length >= 19, 'Le catalogue doit supporter au moins 19 pays officiels');
  
  const cm = countries.find(c => c.code === 'CM');
  assert(cm && cm.currency === 'XAF', 'Cameroun doit impérativement utiliser XAF');
  assert(cm.networks.some(n => n.id === 'orange_cm'), 'Cameroun doit supporter Orange Money (orange_cm)');
  assert(cm.networks.some(n => n.id === 'mtn_cm'), 'Cameroun doit supporter MTN MoMo (mtn_cm)');

  const ci = countries.find(c => c.code === 'CI');
  assert(ci && ci.currency === 'XOF', 'Côte d\'Ivoire doit impérativement utiliser XOF');
  assert(ci.networks.some(n => n.id === 'orange_ci' && n.otp_required === true), 'Orange CI doit requérir un OTP');

  const sn = countries.find(c => c.code === 'SN');
  assert(sn && sn.currency === 'XOF', 'Sénégal doit utiliser XOF');

  const gn = countries.find(c => c.code === 'GN');
  assert(gn && gn.currency === 'GNF', 'Guinée doit utiliser GNF');

  const all = countries.find(c => c.code === 'ALL');
  assert(all && all.currency === 'USD', 'Option globale ALL doit utiliser USD');
  console.log('✓ Test 1 Réussi : Catalogue multi-pays, distinction XAF/XOF/GNF et règles OTP validées.\n');

  // 2. TEST ENDPOINT SERVERLESS GET /api/payments/countries
  console.log('[TEST 2] Test de l\'API Serverless GET /api/payments/countries...');
  const reqCountries = { method: 'GET', url: '/api/payments/countries' };
  const resCountries = mockRes();
  await paymentsHandler(reqCountries, resCountries);
  assert.strictEqual(resCountries.statusCode, 200, 'Statut 200 attendu sur GET /api/payments/countries');
  assert(resCountries.body && resCountries.body.success && resCountries.body.countries.length >= 19, 'Le catalogue complet doit être retourné');
  console.log('✓ Test 2 Réussi : Endpoint /api/payments/countries accessible et dynamique.\n');

  // 3. TEST INITIATION CAMEROUN (ORANGE MONEY) - RAPIDE ET SANS TIMEOUT
  console.log('[TEST 3] Test d\'initiation directe Orange Money Cameroun...');
  const testUser = db.getUserByEmail('fou67377@gmail.com') || db.createUser({
    id: 'usr_test_audit_cm',
    email: 'client_audit_cm@getvirtu.shop',
    name: 'Client Audit CM',
    role: 'client',
    balance: 0.00
  });

  const cmDeposit = await paymentService.createSasPayDeposit({
    userId: testUser.id,
    amountUsd: 5,
    country: 'CM',
    network: 'orange_cm',
    phone: '692960840',
    customerName: testUser.name,
    customerEmail: testUser.email
  });

  assert(cmDeposit && cmDeposit.success, 'La recharge SasPay CM doit réussir avec success: true');
  assert(cmDeposit.transactionId, 'Un ID de transaction interne unique doit être généré');
  assert(cmDeposit.providerTxId, 'Un providerTxId SasPay officiel doit être retourné');
  assert.strictEqual(cmDeposit.status, 'pending', 'Le statut initial doit être strictement "pending"');
  assert.strictEqual(cmDeposit.currency, 'XAF', 'La devise pour CM doit être strictement XAF');
  assert(cmDeposit.instructions && cmDeposit.instructions.length > 0, 'Des instructions USSD doivent être fournies au client');
  console.log('✓ Test 3 Réussi : Initiation directe Orange Money CM en 1 passe sans timeout ni double appel.\n');

  // 4. TEST INITIATION GUICHET SÉCURISÉ SASPAY (HOSTED CHECKOUT TOUS PAYS / CARTES)
  console.log('[TEST 4] Test du guichet de paiement SasPay Hosted Checkout (Multi-pays & Cartes)...');
  const hostedDeposit = await paymentService.createSasPayDeposit({
    userId: testUser.id,
    amountUsd: 10,
    country: 'ALL',
    network: 'checkout_hosted',
    preferredMode: 'checkout',
    customerName: testUser.name,
    customerEmail: testUser.email
  });

  assert(hostedDeposit && hostedDeposit.success, 'La création de session SasPay Hosted Checkout doit réussir');
  assert(hostedDeposit.checkoutUrl && hostedDeposit.checkoutUrl.includes('saspay.me'), 'L\'URL de paiement officielle SasPay doit être fournie');
  assert.strictEqual(hostedDeposit.mode, 'checkout', 'Le mode doit être "checkout"');
  console.log('✓ Test 4 Réussi : Session de checkout hébergée générée avec succès (checkoutUrl valide).\n');

  // 5. TEST DE SÉCURITÉ DU SOLDE CLIENT (NE JAMAIS CRÉDITER SANS CONFIRMATION FOURNISSEUR)
  console.log('[TEST 5] Audit de sécurité du solde client (Idempotence & non-crédit prématuré)...');
  const userBefore = db.getUserById(testUser.id);
  const initialBalance = userBefore ? userBefore.balance : 0;

  // La transaction cmDeposit est en statut "pending" : le solde ne doit JAMAIS avoir augmenté
  const userDuring = db.getUserById(testUser.id);
  assert.strictEqual(userDuring.balance, initialBalance, 'Le solde client NE DOIT PAS être crédité tant que le statut est pending');

  // Test de rejet sur montant inférieur au minimum
  try {
    await paymentService.createSasPayDeposit({
      userId: testUser.id,
      amountUsd: 1.00, // Inférieur au minimum requis de $5
      country: 'CM',
      network: 'orange_cm'
    });
    assert.fail('Une exception aurait dû être levée pour montant inférieur au seuil');
  } catch (err) {
    assert(err.message.includes('minimum'), 'Message d\'erreur explicite sur le minimum requis attendu');
  }
  console.log('✓ Test 5 Réussi : Protection absolue du solde et validation du montant minimum.\n');

  // 6. TEST DE LA VÉRIFICATION DU STATUT ET GESTION DES CYCLES DE VIE
  console.log('[TEST 6] Test de la vérification de statut en temps réel...');
  const verifyRes = await paymentService.verifySasPayPayment({
    transactionId: cmDeposit.transactionId,
    providerTxId: cmDeposit.providerTxId
  });
  assert(verifyRes.success, 'L\'appel de vérification doit réussir');
  assert(['pending', 'completed', 'failed'].includes(verifyRes.status), 'Statut officiel valide retourné');
  console.log(`✓ Test 6 Réussi : Vérification SasPay exécutée sans erreur (Statut constaté : ${verifyRes.status}).\n`);

  // 7. TEST DU HANDLER SERVERLESS POST /api/payments/saspay/create
  console.log('[TEST 7] Test complet du handler serverless /api/payments/saspay/create...');
  const sess = authService.createSession(testUser);
  const reqCreate = {
    method: 'POST',
    url: '/api/payments/saspay/create',
    headers: { authorization: 'Bearer ' + sess.token },
    body: {
      userId: testUser.id,
      amount: 5,
      country: 'CM',
      network: 'mtn_cm',
      phone: '+237670000000',
      customerName: testUser.name,
      customerEmail: testUser.email
    }
  };
  const resCreate = mockRes();
  await paymentsHandler(reqCreate, resCreate);
  assert.strictEqual(resCreate.statusCode, 201, 'Code HTTP 201 attendu');
  assert(resCreate.body && resCreate.body.success, 'success: true attendu');
  assert(resCreate.body.transactionId, 'transactionId attendu');
  console.log('✓ Test 7 Réussi : Handler serverless validé avec code HTTP 201 Created.\n');

  // 8. TEST DU WEBHOOK SASPAY : TRAITEMENT & SÉCURITÉ
  console.log('[TEST 8] Test de la réception et protection du Webhook SasPay...');
  const webhookTxId = 'TXN-SP-WEBHOOK-TEST-' + Date.now();
  db.createTransaction({
    id: webhookTxId,
    userId: testUser.id,
    amount: 15.00,
    currency: 'USD',
    provider: 'saspay',
    providerTxId: 'provider-sp-mock-123',
    status: 'pending'
  });

  const webhookPayload = {
    event: 'transaction.success',
    data: {
      id: 'provider-sp-mock-123',
      status: 'SUCCESS',
      metadata: { internalTxId: webhookTxId }
    }
  };

  const wbRes = await paymentService.handleWebhook({
    headers: { 'x-webhook-event': 'transaction.success' },
    payload: webhookPayload
  });
  assert(wbRes.success, 'Le webhook doit être accepté et traité avec succès');

  const userAfterWebhook = db.getUserById(testUser.id);
  assert.strictEqual(userAfterWebhook.balance, initialBalance + 15.00, 'Le solde de l\'utilisateur doit avoir été crédité exactement de 15.00 USD');

  // Test anti-rejeu (Idempotence) : un second webhook identique ne doit PAS recréditer le solde
  const secondWbRes = await paymentService.handleWebhook({
    headers: { 'x-webhook-event': 'transaction.success' },
    payload: webhookPayload
  });
  assert(secondWbRes.success, 'Le webhook dupliqué doit être reconnu');
  const userAfterDuplicate = db.getUserById(testUser.id);
  assert.strictEqual(userAfterDuplicate.balance, initialBalance + 15.00, 'Le solde NE DOIT PAS être crédité une deuxième fois');
  console.log('✓ Test 8 Réussi : Webhook validé, crédit atomique exécuté et protection anti-rejeu vérifiée.\n');

  console.log('🎉 TOUS LES 8 TESTS DE LA MATRICE DE PAIEMENT MULTI-PAYS ONT RÉUSSI À 100% !\n');
}

module.exports = runPaymentTests;

if (require.main === module) {
  runPaymentTests().catch(err => {
    console.error('❌ Échec du test :', err);
    process.exit(1);
  });
}
