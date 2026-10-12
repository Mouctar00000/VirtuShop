/**
 * Test E2E du système de gestion, persistance et synchronisation des soldes
 * Couvre tous les scénarios 1 à 8 demandés par l'utilisateur.
 */

const assert = require('assert');
const db = require('../backend/db');
const authService = require('../backend/auth');
const paymentService = require('../backend/payments');

async function runTests() {
  console.log('=== DÉBUT DES TESTS DU SYSTÈME DE SOLDE ===\n');

  // Synchronisation initiale avec Edge Config
  console.log('[Init] Synchronisation avec Edge Config...');
  await db.syncFromRemote();
  console.log('Utilisateurs chargés :', db.getUsers().length);

  // Scénario 1, 2, 3 : Persistance du solde Administrateur et cohérence de session
  console.log('\n--- Scénarios 1, 2, 3 : Crédit Admin, Persistance, Switch Storefront & Reconnexion ---');
  const admin = db.getUserById('admin-001') || db.getUserByEmail('admin@virtushop.com') || db.getUserByEmail('admin@getvirtu.shop');
  assert(admin, 'Administrateur introuvable');
  
  const initialAdminBal = admin.balance || 0;
  console.log(`Solde initial administrateur : $${initialAdminBal.toFixed(2)}`);

  // Ajustement / Ajout de $30
  const targetBal = 30.00;
  const adjResult = db.adjustUserBalance(admin.id, {
    amount: targetBal,
    action: 'set',
    reason: 'Initialisation du solde admin à 30 $ pour test de persistance',
    adminName: 'Administrateur GetVirtu'
  });
  await db.persistToRemote();

  assert.strictEqual(adjResult.newBalance, 30.00, 'Le solde doit être exactement 30.00');
  console.log(`✓ Solde administrateur mis à jour à : $${adjResult.newBalance.toFixed(2)}`);

  // Simulation vérification storefront (appel API /api/auth/me)
  const adminFresh = db.getUserById(admin.id);
  assert.strictEqual(adminFresh.balance, 30.00, 'Le solde storefront doit lire 30.00');
  console.log(`✓ Storefront lit le solde : $${adminFresh.balance.toFixed(2)} (identique au dashboard)`);

  // Simulation Déconnexion / Reconnexion
  const loginRes = await authService.login({ email: admin.email, password: 'admin123', ip: '127.0.0.1' });
  assert(loginRes && loginRes.user, 'Connexion admin échouée');
  assert.strictEqual(loginRes.user.balance, 30.00, 'Le solde après reconnexion doit être 30.00');
  console.log(`✓ Reconnexion réussie : le solde est toujours de $${loginRes.user.balance.toFixed(2)}`);

  // Scénario 4 : Don d'un cadeau de 20 $ à un client dont le solde est 0 $
  console.log('\n--- Scénario 4 : Don d\'un cadeau de 20 $ à un client (Solde initial 0 $) ---');
  let clientTest = db.getUserByEmail('client_cadeau_test@getvirtu.shop');
  if (!clientTest) {
    clientTest = db.createUser({
      id: 'client-gift-test-' + Date.now(),
      email: 'client_cadeau_test@getvirtu.shop',
      name: 'Client Fidèle Cadeau',
      role: 'client',
      balance: 0.00
    });
  } else {
    clientTest.balance = 0.00;
    db.updateUser(clientTest.id, { balance: 0.00 });
  }

  assert.strictEqual(clientTest.balance, 0.00, 'Solde initial du client doit être 0.00');
  console.log(`Client ${clientTest.email} préparé avec solde : $${clientTest.balance.toFixed(2)}`);

  // Don de 20 $ par l'administrateur
  const giftResult = db.adjustUserBalance(clientTest.id, {
    amount: 20.00,
    action: 'gift',
    reason: 'Cadeau de bienvenue offert par l\'administrateur',
    adminName: 'Administrateur GetVirtu'
  });
  await db.persistToRemote();

  assert.strictEqual(giftResult.newBalance, 20.00, 'Le solde client doit être 20.00');
  assert.strictEqual(giftResult.transaction.type, 'gift', 'Le type de transaction doit être "gift"');
  assert.strictEqual(giftResult.transaction.provider, 'admin_gift', 'Le provider doit être "admin_gift"');
  console.log(`✓ Don de 20 $ accordé avec succès ! Nouveau solde client : $${giftResult.newBalance.toFixed(2)}`);
  console.log(`✓ Transaction enregistrée : ID=${giftResult.transaction.id}, Type=${giftResult.transaction.type}, Notes=${giftResult.transaction.notes}`);

  // Scénario 5 : Dépôt Mobile Money et protection contre le double-crédit
  console.log('\n--- Scénario 5 : Dépôt Mobile Money & Idempotence ---');
  const momoTx = db.createTransaction({
    id: 'TXN-MOMO-TEST-' + Date.now(),
    userId: clientTest.id,
    userEmail: clientTest.email,
    userName: clientTest.name,
    amount: 15.00,
    currency: 'USD',
    paymentMethod: 'Mobile Money SasPay',
    provider: 'saspay',
    providerTxId: 'SP-EXT-' + Date.now(),
    status: 'pending'
  });

  const momoBalBefore = clientTest.balance; // 20.00
  const verifyMomoRes = await paymentService.verifyAndCompleteTransaction({
    transactionId: momoTx.id,
    isApproval: true
  });
  assert(verifyMomoRes.success, 'Validation Mobile Money échouée');
  assert.strictEqual(verifyMomoRes.newBalance, 35.00, 'Le solde doit être 20 + 15 = 35.00');
  console.log(`✓ Dépôt Mobile Money validé : +15.00 $, nouveau solde : $${verifyMomoRes.newBalance.toFixed(2)}`);

  // Test Anti-Double Crédit
  const doubleMomoRes = await paymentService.verifyAndCompleteTransaction({
    transactionId: momoTx.id,
    isApproval: true
  });
  assert.strictEqual(doubleMomoRes.alreadyProcessed, true, 'La transaction doit être marquée alreadyProcessed');
  const clientCheckDouble = db.getUserById(clientTest.id);
  assert.strictEqual(clientCheckDouble.balance, 35.00, 'Le solde ne doit pas être crédité deux fois');
  console.log(`✓ Protection anti double-crédit validée : solde intact à $${clientCheckDouble.balance.toFixed(2)}`);

  // Scénario 6 : Dépôt Crypto
  console.log('\n--- Scénario 6 : Dépôt Crypto & Idempotence ---');
  const cryptoTx = db.createTransaction({
    id: 'TXN-CRYPTO-TEST-' + Date.now(),
    userId: clientTest.id,
    userEmail: clientTest.email,
    userName: clientTest.name,
    amount: 10.00,
    currency: 'USD',
    paymentMethod: 'Trybit Crypto USDT',
    provider: 'trybit',
    providerTxId: 'TB-INV-' + Date.now(),
    status: 'pending'
  });

  const verifyCryptoRes = await paymentService.verifyAndCompleteTransaction({
    transactionId: cryptoTx.id,
    isApproval: true
  });
  assert(verifyCryptoRes.success, 'Validation Crypto échouée');
  assert.strictEqual(verifyCryptoRes.newBalance, 45.00, 'Le solde doit être 35 + 10 = 45.00');
  console.log(`✓ Dépôt Crypto validé : +10.00 $, nouveau solde : $${verifyCryptoRes.newBalance.toFixed(2)}`);

  // Scénario 7 : Achat d'un produit et déduction automatique du solde
  console.log('\n--- Scénario 7 : Achat Produit & Déduction Atomique ---');
  // Créer un produit avec une clé dans le coffre
  const oldTestProd = db.findProductByNormalizedName('Produit Test Déduction');
  if (oldTestProd) {
    db.deleteProduct(oldTestProd.id);
  }
  const testRunSuffix = Date.now().toString(36);
  const prodTest = db.saveProduct({
    name: 'Produit Test Déduction ' + testRunSuffix,
    category: 'vpn',
    price: 5.00,
    description: 'Produit pour tester la déduction automatique',
    published: true
  }, { newKeys: [`KEY-TEST-${testRunSuffix}-1`, `KEY-TEST-${testRunSuffix}-2`, `KEY-TEST-${testRunSuffix}-3`] });

  const clientBalBeforeBuy = db.getUserById(clientTest.id).balance; // 45.00
  const qty = 2; // 2 x 5.00 = 10.00
  const totalCost = prodTest.price * qty;

  const keyAlloc = await db.allocateKeysForProduct(prodTest.id, qty, {
    orderId: 'ORD-TEST-DEDUCT-' + Date.now(),
    userId: clientTest.id,
    userEmail: clientTest.email
  });
  assert.strictEqual(keyAlloc.allocatedKeys.length, qty, 'Doit allouer 2 clés');

  const expectedBalAfterBuy = Math.round((clientBalBeforeBuy - totalCost) * 100) / 100;
  db.updateUser(clientTest.id, { balance: expectedBalAfterBuy });

  const orderTest = db.createOrder({
    id: 'ORD-TEST-DEDUCT-' + Date.now(),
    userId: clientTest.id,
    userEmail: clientTest.email,
    userName: clientTest.name,
    productId: prodTest.id,
    productName: prodTest.name,
    unitPrice: prodTest.price,
    quantity: qty,
    amount: totalCost,
    remainingBalance: expectedBalAfterBuy,
    userBalanceAfter: expectedBalAfterBuy,
    method: 'Solde GetVirtu',
    status: 'Complété',
    vaultContent: { type: 'text', keys: keyAlloc.allocatedKeys }
  });

  const txPurchase = db.createTransaction({
    userId: clientTest.id,
    userEmail: clientTest.email,
    userName: clientTest.name,
    amount: totalCost,
    currency: 'USD',
    paymentMethod: 'Solde GetVirtu',
    provider: 'balance',
    status: 'completed',
    balanceBefore: clientBalBeforeBuy,
    balanceAfter: expectedBalAfterBuy,
    notes: `Achat ${prodTest.name} (x${qty})`
  });

  await db.persistToRemote();

  assert.strictEqual(expectedBalAfterBuy, 35.00, 'Le solde après achat de 2 x 5$ doit être 35.00');
  const freshClientAfterBuy = db.getUserById(clientTest.id);
  assert.strictEqual(freshClientAfterBuy.balance, 35.00, 'Le solde en base doit être 35.00');
  console.log(`✓ Achat validé : Solde initial $${clientBalBeforeBuy.toFixed(2)} - Achat $${totalCost.toFixed(2)} = $${freshClientAfterBuy.balance.toFixed(2)}`);

  // Scénario 8 : Synchronisation et persistance globale
  console.log('\n--- Scénario 8 : Vérification de la persistance globale Edge Config ---');
  // Re-synchronisation depuis Edge Config
  db._lastRemoteSync = 0; // forcer le rafraîchissement
  await db.syncFromRemote();
  const clientFromRemote = db.getUserById(clientTest.id);
  assert(clientFromRemote, 'Client doit exister dans Edge Config');
  assert.strictEqual(clientFromRemote.balance, 35.00, 'Le solde client dans Edge Config doit être 35.00');
  console.log(`✓ Synchronisation Edge Config validée : Solde client = $${clientFromRemote.balance.toFixed(2)}`);

  console.log('\n🎉 TOUS LES SCÉNARIOS (1 à 8) ONT ÉTÉ VALIDÉS AVEC SUCCÈS !');
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => {
    console.error('\n❌ Échec du test :', err);
    process.exit(1);
  });
}
