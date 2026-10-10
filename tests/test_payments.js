const assert = require('assert');
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
  console.log('=== TEST OFFICIEL DU MODULE DE PAIEMENT SASPAY & TRYBIT ===\n');

  // 1. Test SasPay Mobile Money Cameroon (Orange Money)
  const cmDeposit = await paymentService.createSasPayDeposit({
    userId: 'usr_1791386539061_c9lu5',
    amountUsd: 5,
    country: 'CM',
    network: 'orange',
    phone: '692960840',
    customerName: 'IBRAHIM MOUCTAR ABOUBAKAR',
    customerEmail: 'fou67377@gmail.com'
  });

  assert(cmDeposit && cmDeposit.success, 'La recharge SasPay CM doit réussir avec success: true');
  assert(cmDeposit.transactionId, 'Un ID de transaction doit être généré');
  assert(cmDeposit.providerTxId, 'Un providerTxId SasPay officiel doit être retourné');
  assert.strictEqual(cmDeposit.status, 'pending', 'Le statut initial doit être strictement "pending"');
  assert.strictEqual(cmDeposit.currency, 'XAF', 'La devise pour CM doit être XAF');
  console.log('✓ 1. Initiation Mobile Money SasPay (Cameroun, Orange Money) validée avec succès 201.');

  // 2. Test SasPay via Handler API /api/payments/saspay/create
  const user = db.getUserByEmail('fou67377@gmail.com');
  const sess = authService.createSession(user);

  const req = {
    method: 'POST',
    url: '/api/payments/saspay/create',
    headers: { authorization: 'Bearer ' + sess.token },
    body: {
      userId: user.id,
      amount: 5,
      country: 'CM',
      network: 'orange',
      phone: '692960840',
      customerName: user.name,
      customerEmail: user.email
    }
  };
  const res = mockRes();
  await paymentsHandler(req, res);
  assert.strictEqual(res.statusCode, 201, 'Code HTTP 201 attendu sur /api/payments/saspay/create');
  assert(res.body && res.body.success, 'Réponse JSON avec success: true attendue');
  console.log('✓ 2. Handler serverless /api/payments/saspay/create validé avec statut 201 OK.');

  console.log('\n🎉 TOUS LES TESTS DU MODULE DE PAIEMENT ONT RÉUSSI À 100% !\n');
}

module.exports = runPaymentTests;

if (require.main === module) {
  runPaymentTests().catch(err => {
    console.error('❌ Échec du test :', err);
    process.exit(1);
  });
}
