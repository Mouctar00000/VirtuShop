const assert = require('assert');
const db = require('../backend/db');
const authService = require('../backend/auth');
const dataHandler = require('../api/data');

// Mock request / response helper
function createMockReqRes(method, query = {}, body = {}, headers = {}) {
  const req = {
    method,
    url: '/api/data' + (Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''),
    query,
    body,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  };

  let statusCode = 200;
  let responseData = null;
  const resHeaders = {};

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(name, val) {
      resHeaders[name.toLowerCase()] = val;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    send(data) {
      responseData = data;
      return res;
    },
    end() {
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    }
  };

  return { req, res };
}

async function runTests() {
  console.log('=== DÉBUT DES TESTS : RESET ALL DATA & SUPPRESSIONS INDIVIDUELLES ===\n');

  // Obtenir un token admin valide via authService
  const adminUser = db.getUserById('admin-001') || db.getUsers().find(u => u.role === 'admin');
  assert(adminUser, 'L\'administrateur principal doit exister');
  const adminSession = authService.createSession(adminUser);
  const adminToken = adminSession.token;
  const adminHeaders = { 'authorization': 'Bearer ' + adminToken };

  // 1. TEST : Sécurité des endpoints
  console.log('Test 1 : Contrôle des accès et safeguards');
  {
    // Sans token
    const { req: req1, res: res1 } = createMockReqRes('POST', { resource: 'reset' }, { confirmation: 'CONFIRMER' });
    await dataHandler(req1, res1);
    assert.strictEqual(res1.statusCode, 403, 'Requête reset sans token doit renvoyer 403');

    // Token utilisateur non-admin
    const testUser = db.createUser({ name: 'Client Test Auth', email: 'test_client_auth@example.com', role: 'customer' });
    const clientSession = authService.createSession(testUser);
    const { req: req2, res: res2 } = createMockReqRes('POST', { resource: 'reset' }, { confirmation: 'CONFIRMER' }, { 'authorization': 'Bearer ' + clientSession.token });
    await dataHandler(req2, res2);
    assert.strictEqual(res2.statusCode, 403, 'Requête reset client non-admin doit renvoyer 403');

    // Token admin mais sans mot-clé 'CONFIRMER'
    const { req: req3, res: res3 } = createMockReqRes('POST', { resource: 'reset' }, { confirmation: 'MAUVAISE_CONFIRMATION' }, adminHeaders);
    await dataHandler(req3, res3);
    assert.strictEqual(res3.statusCode, 400, 'Requête reset sans CONFIRMER doit être rejetée avec 400');
    console.log('  ✓ Protection des accès et mot-clé de sécurité validés avec succès');
  }

  // 2. TEST : Suppression individuelle de client & Protection du SuperAdmin
  console.log('\nTest 2 : Suppression individuelle de client & Inviolabilité du SuperAdmin');
  {
    const customer = db.createUser({ name: 'Client A Supprimer', email: 'delete_me@example.com', balance: 15.00 });
    assert(db.getUserById(customer.id), 'Le client doit être créé');

    // Tentative de suppression du compte SuperAdmin
    const { req: reqAdminDel, res: resAdminDel } = createMockReqRes('DELETE', { resource: 'users' }, { id: adminUser.id }, adminHeaders);
    await dataHandler(reqAdminDel, resAdminDel);
    assert(resAdminDel.statusCode === 400 || (resAdminDel.data && resAdminDel.data.error), 'La suppression du SuperAdmin doit être strictement refusée');
    assert(db.getUserById(adminUser.id), 'Le compte SuperAdmin ne doit jamais être supprimé');

    // Suppression du client standard
    const { req: reqCustDel, res: resCustDel } = createMockReqRes('DELETE', { resource: 'users' }, { id: customer.id }, adminHeaders);
    await dataHandler(reqCustDel, resCustDel);
    assert.strictEqual(resCustDel.statusCode, 200, 'La suppression du client doit réussir');
    assert(!db.getUserById(customer.id), 'Le client doit avoir disparu de la base');
    console.log('  ✓ Suppression de client vérifiée et inviolabilité du compte SuperAdmin garantie');
  }

  // 3. TEST : Réinitialisation du solde d\'un client à 0.00 $ avec journalisation d\'audit
  console.log('\nTest 3 : Réinitialisation individuelle du solde à 0.00 $');
  {
    const customer = db.createUser({ name: 'Client Solde Reset', email: 'balance_reset@example.com' });
    db.updateUser(customer.id, { balance: 85.50 });
    customer.balance = 85.50;
    assert.strictEqual(customer.balance, 85.50);

    const { req, res } = createMockReqRes('POST', { resource: 'users' }, {
      userId: customer.id,
      amount: 0,
      action: 'reset',
      reason: 'Remise à zéro administrative de test'
    }, adminHeaders);

    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200, 'La réinitialisation de solde doit renvoyer 200');
    assert.strictEqual(res.data.newBalance, 0, 'Le nouveau solde doit être 0.00');

    const updatedCust = db.getUserById(customer.id);
    assert.strictEqual(updatedCust.balance, 0, 'Le solde en base doit être 0.00');

    // Vérifier la trace de transaction comptable
    const tx = db.getTransactions().find(t => t.userId === customer.id && t.paymentMethod === 'Réinitialisation de Solde');
    assert(tx, 'Une transaction de réinitialisation doit exister dans l\'audit financier');
    assert.strictEqual(tx.balanceBefore, 85.50);
    assert.strictEqual(tx.balanceAfter, 0);
    console.log('  ✓ Remise à zéro du solde à $0.00 et trace d\'audit financier vérifiées');
  }

  // 4. TEST : Suppression individuelle de commande
  console.log('\nTest 4 : Suppression individuelle d\'une commande');
  {
    const order = db.createOrder({
      id: 'ORD-TEST-DELETE-' + Date.now(),
      userName: 'Client Commande',
      userEmail: 'order_delete@example.com',
      productName: 'Produit Test',
      amount: 25.00,
      status: 'En attente'
    });
    assert(db.getOrderById(order.id), 'La commande doit exister');

    const { req, res } = createMockReqRes('DELETE', { resource: 'orders' }, { orderId: order.id }, adminHeaders);
    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200, 'Suppression commande doit renvoyer 200');
    assert(!db.getOrderById(order.id), 'La commande doit être supprimée de la base');
    console.log('  ✓ Suppression individuelle de commande validée');
  }

  // 5. TEST : Suppression individuelle de transaction
  console.log('\nTest 5 : Suppression individuelle d\'une transaction');
  {
    const tx = db.createTransaction({
      userName: 'Client Tx',
      userEmail: 'tx_delete@example.com',
      amount: 10.00,
      currency: 'USD',
      status: 'pending',
      paymentMethod: 'Test Method'
    });
    assert(db.getTransactionById(tx.id), 'La transaction doit exister');

    const { req, res } = createMockReqRes('DELETE', { resource: 'transactions' }, { transactionId: tx.id }, adminHeaders);
    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200, 'Suppression transaction doit renvoyer 200');
    assert(!db.getTransactionById(tx.id), 'La transaction doit être supprimée');
    console.log('  ✓ Suppression individuelle de transaction validée');
  }

  // 6. TEST : Réinitialisation des statistiques et visiteurs
  console.log('\nTest 6 : Réinitialisation des statistiques de visites');
  {
    db.trackVisitor({ vid: 'vid-test-reset-1', isNew: true });
    db.trackVisitor({ vid: 'vid-test-reset-2', isNew: true });

    const { req, res } = createMockReqRes('DELETE', { resource: 'visitors' }, {}, adminHeaders);
    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const stats = db.getVisitorStats('all');
    assert.strictEqual(stats.totalVisits, 0, 'Les compteurs visiteurs doivent être à 0');
    console.log('  ✓ Réinitialisation des statistiques de trafic validée');
  }

  // 7. TEST : Exportation de Sauvegarde (Backup JSON)
  console.log('\nTest 7 : Exportation de Sauvegarde (Backup JSON)');
  {
    const { req, res } = createMockReqRes('GET', { resource: 'backup' }, {}, adminHeaders);
    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.exportedAt, 'Le backup doit comporter un timestamp exportedAt');
    assert(res.data.data && Array.isArray(res.data.data.users), 'Le backup doit inclure les utilisateurs');
    assert(res.data.data && Array.isArray(res.data.data.orders), 'Le backup doit inclure les commandes');
    assert(res.data.data && Array.isArray(res.data.data.transactions), 'Le backup doit inclure les transactions');
    console.log('  ✓ Génération et intégrité de la sauvegarde JSON validées');
  }

  // 8. TEST : Réinitialisation Globale ("Reset All Data")
  console.log('\nTest 8 : Réinitialisation Globale des Données ("Reset All Data")');
  {
    const dummyClient = db.createUser({ name: 'Client Pour Reset Global', email: 'reset_all_user@example.com' });
    db.updateUser(dummyClient.id, { balance: 50.00 });
    db.createOrder({ id: 'ORD-GLOBAL-RESET-1', userName: 'Client Pour Reset Global', amount: 30.00 });
    db.createTransaction({ userName: 'Client Pour Reset Global', amount: 30.00 });
    const initialMethodsCount = (db.getPaymentMethods() || []).length;

    const { req, res } = createMockReqRes('POST', { resource: 'reset' }, {
      confirmation: 'CONFIRMER',
      options: {
        resetBalances: true,
        deleteOrders: true,
        deleteTransactions: true,
        deleteUsers: true,
        resetVisitors: true
      }
    }, adminHeaders);

    await dataHandler(req, res);
    assert.strictEqual(res.statusCode, 200, 'Reset All Data doit renvoyer 200');
    assert(res.data.success, 'La réponse doit indiquer success: true');

    // Vérifier les impacts
    assert.strictEqual(db.getOrders().length, 0, 'Toutes les commandes doivent être purgées');
    assert.strictEqual(db.getVisitorStats('all').totalVisits, 0, 'Les compteurs visiteurs doivent être à 0');
    assert(!db.getUserById(dummyClient.id), 'Le client dummy doit être supprimé');

    // Vérifier les protections
    assert(db.getUserById(adminUser.id), 'Le SuperAdmin DOIT ABSOLUMENT être préservé');
    assert.strictEqual(db.getUserById(adminUser.id).role, 'admin', 'Le rôle SuperAdmin doit être intact');
    assert.strictEqual((db.getPaymentMethods() || []).length, initialMethodsCount, 'Les moyens de paiement DOIVENT être préservés');
    assert(db.data.settings, 'Les paramètres du système DOIVENT être préservés');

    // Vérifier la consignation d'audit
    const auditTx = db.getTransactions().find(t => t.paymentMethod === 'Audit Système' || t.notes?.includes('Reset All Data'));
    assert(auditTx, 'L\'action Reset All Data doit être consignée dans l\'audit');
    console.log('  ✓ Réinitialisation globale exécutée avec succès en préservant le SuperAdmin, les réglages et les moyens de paiement');
  }

  console.log('\n======================================================');
  console.log('🎉 TOUS LES TESTS DE RÉINITIALISATION & SUPPRESSION ONT RÉUSSI !');
  console.log('======================================================\n');
  // Réinsérer le client Ibrahim Barry pour les autres tests du repository
  if (!db.getUserByEmail('fou67377@gmail.com')) {
    db.createUser({
      email: 'fou67377@gmail.com',
      name: 'Ibrahim Barry',
      role: 'client'
    });
  }
}

module.exports = runTests;

if (require.main === module) {
  runTests().catch(err => {
    console.error('\n❌ Échec du test :', err);
    process.exit(1);
  });
}
