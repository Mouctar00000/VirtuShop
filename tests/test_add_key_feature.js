const assert = require('assert');
const db = require('../backend/db');
const dataHandler = require('../api/data');

// Mock request / response helper for API tests
function createMockReqRes({ method, url, body, query, headers }) {
  const req = {
    method: method || 'GET',
    url: url || '/api/data/products',
    body: body || {},
    query: query || {},
    headers: headers || {}
  };

  let statusCode = 200;
  let headersSent = {};
  let responseData = null;

  const res = {
    statusCode: 200,
    setHeader: (k, v) => { headersSent[k] = v; },
    status: (code) => {
      statusCode = code;
      res.statusCode = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
    end: (data) => {
      if (data) responseData = data;
      return res;
    },
    _getData: () => responseData,
    _getStatus: () => statusCode
  };

  return { req, res };
}

async function runTest() {
  console.log('\n======================================================');
  console.log('🧪 TEST AUTOMATISÉ : FONCTIONNALITÉ « AJOUTER UNE CLÉ »');
  console.log('======================================================\n');

  // Authentification admin mock
  const adminUser = db.getUserByEmail('admin@getvirtu.shop');
  assert.ok(adminUser, 'Compte administrateur doit exister');
  const authService = require('../backend/auth');
  const adminSession = authService.createSession(adminUser);
  const adminToken = adminSession.token;

  // Nettoyage préalable si le produit de test existe déjà
  const existing = db.findProductByNormalizedName('VPN Ultra Secure Test');
  if (existing) {
    db.deleteProduct(existing.id);
  }

  // 1. Créer un produit existant initial avec 0 clé (stock = 0)
  console.log('▶ 1. Création d\'un produit test avec stock = 0...');
  const testProduct = db.saveProduct({
    name: 'VPN Ultra Secure Test',
    category: 'vpn',
    price: 4.99,
    description: 'Protection premium 1 mois'
  }, { newKeys: [] });

  assert.strictEqual(testProduct.stock, 0, 'Le stock initial doit être 0');
  console.log(`✓ Produit créé avec succès (ID: ${testProduct.id}, Stock: ${testProduct.stock})`);

  // 2. Tester l'ajout d'une clé via l'API (action: 'add_keys')
  console.log('\n▶ 2. Ajout de la première clé via l\'API (action: add_keys)...');
  const { req: req1, res: res1 } = createMockReqRes({
    method: 'POST',
    url: '/api/data/products',
    headers: { 'authorization': `Bearer ${adminToken}` },
    body: {
      action: 'add_keys',
      productId: testProduct.id,
      keys: ['VPN-KEY-001-ALPHA']
    }
  });

  await dataHandler(req1, res1);
  const data1 = res1._getData();
  assert.strictEqual(res1._getStatus(), 200, 'L\'API doit répondre 200 OK');
  assert.strictEqual(data1.success, true, 'La réponse doit indiquer success: true');
  assert.strictEqual(data1.stock, 1, 'Le stock doit passer à 1');
  assert.strictEqual(data1.addedCount, 1, 'Une clé doit avoir été ajoutée');
  console.log('✓ Clé ajoutée via API : Stock = 1');

  // 3. Tester l'ajout d'une seconde clé au même produit
  console.log('\n▶ 3. Ajout d\'une seconde clé au produit existant...');
  const { req: req2, res: res2 } = createMockReqRes({
    method: 'POST',
    url: '/api/data/products',
    headers: { 'authorization': `Bearer ${adminToken}` },
    body: {
      action: 'add_keys',
      productId: testProduct.id,
      keys: ['VPN-KEY-002-BETA']
    }
  });

  await dataHandler(req2, res2);
  const data2 = res2._getData();
  assert.strictEqual(data2.stock, 2, 'Le stock doit maintenant être de 2');
  console.log('✓ Seconde clé ajoutée : Stock = 2');

  // 4. Tester l'interdiction de créer un nouveau produit via "add_keys" (productId invalide)
  console.log('\n▶ 4. Vérification de sécurité : rejet des productId inexistants...');
  const { req: reqInvalid, res: resInvalid } = createMockReqRes({
    method: 'POST',
    url: '/api/data/products',
    headers: { 'authorization': `Bearer ${adminToken}` },
    body: {
      action: 'add_keys',
      productId: 99999999, // Inexistant
      keys: ['HACK-KEY']
    }
  });

  await dataHandler(reqInvalid, resInvalid);
  assert.strictEqual(resInvalid._getStatus(), 404, 'Doit refuser avec 404 si le produit n\'existe pas');
  console.log('✓ Rejet conforme (404) : impossible d\'utiliser add_keys pour créer un produit orphelin');

  // 5. Tester l'anti-doublon (tentative d'insérer une clé déjà existante)
  console.log('\n▶ 5. Vérification anti-doublon sur les clés...');
  const { req: reqDup, res: resDup } = createMockReqRes({
    method: 'POST',
    url: '/api/data/products',
    headers: { 'authorization': `Bearer ${adminToken}` },
    body: {
      action: 'add_keys',
      productId: testProduct.id,
      keys: ['vpn-key-001-alpha'] // Même clé en minuscules
    }
  });

  await dataHandler(reqDup, resDup);
  assert.strictEqual(resDup._getStatus(), 400, 'Doit rejeter avec statut 400');
  assert.ok(resDup._getData().error.includes('déjà présente') || resDup._getData().error.includes('doublon'), 'Doit indiquer une erreur de doublon');
  console.log('✓ Clé dupliquée rejetée avec succès');

  // 6. Attribution et vente de la première clé à un client
  console.log('\n▶ 6. Simulation d\'achat : Client A achète 1 unité...');
  const alloc1 = await db.allocateKeysForProduct(testProduct.id, 1, {
    orderId: 'ORD-TEST-VPN-01',
    userId: 'usr_client_a',
    userEmail: 'clientA@getvirtu.shop'
  });

  assert.strictEqual(alloc1.allocatedKeys.length, 1);
  assert.strictEqual(alloc1.allocatedKeys[0].content, 'VPN-KEY-001-ALPHA');
  assert.strictEqual(alloc1.remainingStock, 1, 'Stock restant doit être 1');
  console.log(`✓ Client A a reçu la clé : '${alloc1.allocatedKeys[0].content}' (Stock restant : 1)`);

  // 7. Achat de la seconde clé par Client B
  console.log('\n▶ 7. Simulation d\'achat : Client B achète 1 unité...');
  const alloc2 = await db.allocateKeysForProduct(testProduct.id, 1, {
    orderId: 'ORD-TEST-VPN-02',
    userId: 'usr_client_b',
    userEmail: 'clientB@getvirtu.shop'
  });

  assert.strictEqual(alloc2.allocatedKeys.length, 1);
  assert.strictEqual(alloc2.allocatedKeys[0].content, 'VPN-KEY-002-BETA');
  assert.strictEqual(alloc2.remainingStock, 0, 'Stock restant doit être 0');
  console.log(`✓ Client B a reçu la clé : '${alloc2.allocatedKeys[0].content}' (Stock restant : 0)`);

  // 8. Tentative d'achat quand le stock est à 0
  console.log('\n▶ 8. Client C tente d\'acheter alors que stock = 0...');
  let oosBlocked = false;
  try {
    await db.allocateKeysForProduct(testProduct.id, 1, {
      orderId: 'ORD-TEST-VPN-03',
      userId: 'usr_client_c',
      userEmail: 'clientC@getvirtu.shop'
    });
  } catch (err) {
    oosBlocked = true;
    assert.strictEqual(err.code, 'INSUFFICIENT_STOCK');
  }
  assert.ok(oosBlocked, 'La tentative d\'achat doit être bloquée avec INSUFFICIENT_STOCK');
  console.log('✓ Achat sur stock 0 bloqué sans double-vente');

  // 9. Réapprovisionnement d'une nouvelle clé par l'administrateur
  console.log('\n▶ 9. Réapprovisionnement par l\'admin avec 1 nouvelle clé...');
  const restockRes = await db.addKeysToProduct(testProduct.id, ['VPN-KEY-003-RESTOCKED']);
  assert.strictEqual(restockRes.stock, 1, 'Le stock doit redevenir 1');
  console.log('✓ Produit réapprovisionné : Stock = 1');

  // Nettoyage après test
  db.deleteProduct(testProduct.id);

  console.log('\n🎉 TOUS LES TESTS DE LA FONCTIONNALITÉ « AJOUTER UNE CLÉ » ONT RÉUSSI À 100% !\n');
}

module.exports = runTest;

if (require.main === module) {
  runTest().catch(err => {
    console.error('\n❌ Échec du test :', err);
    process.exit(1);
  });
}
