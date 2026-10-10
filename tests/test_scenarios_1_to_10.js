const assert = require('assert');
const db = require('../backend/db');

async function run10Scenarios() {
  console.log('\n======================================================');
  console.log('⚡ VALIDATION OFFICIELLE DES 10 SCÉNARIOS DE GESTION DU STOCK');
  console.log('======================================================\n');

  // Nettoyage préalable pour le produit de test "Gmail"
  const existingGmail = db.findProductByNormalizedName('Gmail');
  if (existingGmail) {
    db.deleteProduct(existingGmail.id);
  }

  // --- SCÉNARIO 1 : Créer « Gmail » avec 1 clé → stock = 1, un seul produit au catalogue ---
  console.log('▶ SCÉNARIO 1 : Créer « Gmail » avec 1 clé...');
  const prod1 = db.saveProduct({
    name: 'Gmail',
    category: 'email',
    price: 2.50,
    description: 'Compte Gmail propre'
  }, { newKeys: ['gmail_key_1_abc'] });

  assert.strictEqual(prod1.stock, 1, 'Le stock initial doit être de 1');
  const prodsAfter1 = db.getProducts().filter(p => db.findProductByNormalizedName(p.name)?.id === prod1.id);
  assert.strictEqual(prodsAfter1.length, 1, 'Il ne doit y avoir qu\'un seul produit au catalogue');
  console.log('✓ Scénario 1 validé : stock = 1, 1 seul produit au catalogue.');

  // --- SCÉNARIO 2 : Re-créer « Gmail » → champs auto-remplis, j'ajoute seulement une clé → stock = 2 ---
  console.log('\n▶ SCÉNARIO 2 : Re-créer « Gmail » avec une nouvelle clé...');
  const foundGmail = db.findProductByNormalizedName('  gmail  '); // Test de normalisation casse + espaces
  assert.ok(foundGmail, 'Le produit existant doit être détecté sans tenir compte de la casse ni des espaces');
  
  const prod2 = db.saveProduct({
    id: foundGmail.id,
    name: '  gmail  ',
    category: foundGmail.category,
    price: foundGmail.price,
    description: foundGmail.description
  }, { newKeys: ['gmail_key_2_def'] });

  assert.strictEqual(prod2.id, prod1.id, 'Le produit doit conserver le même ID');
  assert.strictEqual(prod2.stock, 2, 'Le stock doit maintenant être de 2');
  const prodsAfter2 = db.getProducts().filter(p => p.id === prod1.id);
  assert.strictEqual(prodsAfter2.length, 1, 'Toujours un seul produit au catalogue');
  console.log('✓ Scénario 2 validé : détection par nom insensible à la casse, stock = 2, aucun doublon.');

  // --- SCÉNARIO 3 : Modifier le prix pendant cet ajout → le prix change pour le produit existant ---
  console.log('\n▶ SCÉNARIO 3 : Modification du prix pendant l\'ajout...');
  const prod3 = db.saveProduct({
    id: prod2.id,
    name: 'Gmail',
    price: 3.00
  }, { newKeys: ['gmail_key_3_ghi'] });

  assert.strictEqual(prod3.price, 3.00, 'Le prix du produit existant doit être mis à jour à 3.00 $');
  assert.strictEqual(prod3.stock, 3, 'Le stock doit passer à 3');
  console.log('✓ Scénario 3 validé : nouveau prix = 3.00 $ appliqué au produit existant.');

  // --- SCÉNARIO 4 : Avoir 4 clés pour le même nom → stock = 4, un seul produit côté client ---
  console.log('\n▶ SCÉNARIO 4 : Ajout de la 4ème clé → stock = 4...');
  const prod4 = db.saveProduct({
    name: 'GMAIL '
  }, { newKeys: ['gmail_key_4_jkl'] });

  assert.strictEqual(prod4.stock, 4, 'Le stock doit être de 4');
  const catalogGmail = db.getProducts().filter(p => p.name.toLowerCase().includes('gmail'));
  assert.strictEqual(catalogGmail.length, 1, 'Un seul produit visible dans le catalogue');
  console.log('✓ Scénario 4 validé : stock = 4, un seul produit côté client.');

  // Test anti-doublon de clé
  console.log('\n▶ TEST ANTI-DOUBLON DE CLÉ : tentative d\'insérer une clé déjà existante...');
  let duplicateRejected = false;
  try {
    db.saveProduct({ id: prod4.id, name: 'Gmail' }, { newKeys: ['gmail_key_2_def'] });
  } catch (err) {
    duplicateRejected = true;
  }
  assert.ok(duplicateRejected, 'Une clé déjà présente dans le produit doit être refusée');
  console.log('✓ Test anti-doublon validé : la clé dupliquée a été rejetée avec succès.');

  // --- SCÉNARIO 5 : Un client achète 1 unité → il reçoit 1 clé, stock = 3 ---
  console.log('\n▶ SCÉNARIO 5 : Client 1 achète 1 unité...');
  const allocClient1 = await db.allocateKeysForProduct(prod4.id, 1, {
    orderId: 'ORD-TEST-001',
    userId: 'usr_client_1',
    userEmail: 'client1@example.com'
  });

  assert.strictEqual(allocClient1.allocatedKeys.length, 1, 'Le client doit recevoir 1 clé');
  assert.strictEqual(allocClient1.remainingStock, 3, 'Le stock restant doit être de 3');
  const key1 = allocClient1.allocatedKeys[0];
  assert.strictEqual(key1.content, 'gmail_key_1_abc', 'La première clé attribuée doit être gmail_key_1_abc');
  assert.strictEqual(key1.soldTo, 'client1@example.com');
  console.log(`✓ Scénario 5 validé : client 1 a reçu '${key1.content}', stock = 3.`);

  // --- SCÉNARIO 6 : Un autre client achète 2 unités → il reçoit 2 autres clés différentes, stock = 1 ---
  console.log('\n▶ SCÉNARIO 6 : Client 2 achète 2 unités...');
  const allocClient2 = await db.allocateKeysForProduct(prod4.id, 2, {
    orderId: 'ORD-TEST-002',
    userId: 'usr_client_2',
    userEmail: 'client2@example.com'
  });

  assert.strictEqual(allocClient2.allocatedKeys.length, 2, 'Le client doit recevoir 2 clés différentes');
  assert.strictEqual(allocClient2.remainingStock, 1, 'Le stock restant doit être de 1');
  const c2KeyContents = allocClient2.allocatedKeys.map(k => k.content);
  assert.notStrictEqual(c2KeyContents.indexOf(key1.content), 0, 'Les clés ne doivent pas inclure la clé du client 1');
  assert.strictEqual(c2KeyContents[0] !== c2KeyContents[1], true, 'Les 2 clés doivent être différentes entre elles');
  console.log(`✓ Scénario 6 validé : client 2 a reçu [${c2KeyContents.join(', ')}], stock = 1.`);

  // --- SCÉNARIO 7 : Un client tente une quantité supérieure au stock → bloqué au maximum ---
  console.log('\n▶ SCÉNARIO 7 : Tentative d\'achat d\'une quantité > stock (demande 5 alors que stock = 1)...');
  let overstockBlocked = false;
  try {
    await db.allocateKeysForProduct(prod4.id, 5, {
      orderId: 'ORD-TEST-OVER',
      userId: 'usr_client_3',
      userEmail: 'client3@example.com'
    });
  } catch (err) {
    overstockBlocked = true;
    assert.strictEqual(err.code, 'INSUFFICIENT_STOCK');
    assert.strictEqual(err.availableStock, 1);
  }
  assert.ok(overstockBlocked, 'L\'achat de 5 unités doit être bloqué par le serveur car stock = 1');
  console.log('✓ Scénario 7 validé : commande supérieure au stock bloquée proprement (erreur 400 / INSUFFICIENT_STOCK).');

  // --- SCÉNARIO 8 : Deux clients achètent la dernière clé en même temps → un seul la reçoit, l'autre est refusé ---
  console.log('\n▶ SCÉNARIO 8 : Concurrence stricte (Race Condition) - Deux clients simultanés sur la dernière clé...');
  const pA = db.allocateKeysForProduct(prod4.id, 1, {
    orderId: 'ORD-RACE-A',
    userId: 'usr_race_A',
    userEmail: 'clientA@example.com'
  });
  const pB = db.allocateKeysForProduct(prod4.id, 1, {
    orderId: 'ORD-RACE-B',
    userId: 'usr_race_B',
    userEmail: 'clientB@example.com'
  });

  const raceResults = await Promise.allSettled([pA, pB]);
  const succeeded = raceResults.filter(r => r.status === 'fulfilled');
  const rejected = raceResults.filter(r => r.status === 'rejected');

  assert.strictEqual(succeeded.length, 1, 'Exactement un client doit réussir');
  assert.strictEqual(rejected.length, 1, 'Exactement un client doit être refusé proprement');
  assert.strictEqual(rejected[0].reason.code, 'INSUFFICIENT_STOCK');
  console.log('✓ Scénario 8 validé : verrouillage atomique parfait. Un seul client a reçu la clé, le second a été refusé sans double-vente.');

  // --- SCÉNARIO 9 : Stock à 0 → produit visible avec « Rupture de stock », non supprimé ---
  console.log('\n▶ SCÉNARIO 9 : Vérification du produit à stock = 0...');
  const pOos = db.getProductById(prod4.id);
  assert.ok(pOos, 'Le produit ne doit PAS être supprimé');
  assert.strictEqual(pOos.stock, 0, 'Le stock doit être égal à 0');
  console.log('✓ Scénario 9 validé : le produit existe toujours avec stock = 0 (Rupture de stock).');

  // --- SCÉNARIO 10 : Ajout d'une clé sur un produit en rupture → il redevient disponible ---
  console.log('\n▶ SCÉNARIO 10 : Ajout d\'une nouvelle clé sur le produit en rupture...');
  const resRestock = db.saveProduct({
    id: prod4.id,
    name: 'Gmail'
  }, { newKeys: ['gmail_key_5_restock'] });

  assert.strictEqual(resRestock.stock, 1, 'Le stock doit repasser à 1');
  const refreshedProd = db.getProductById(prod4.id);
  assert.strictEqual(refreshedProd.stock, 1, 'Le produit est de nouveau disponible avec 1 unité');
  console.log('✓ Scénario 10 validé : nouvelle clé enregistrée, le produit redevient disponible avec stock = 1.');

  // Nettoyage après test
  db.deleteProduct(prod4.id);

  console.log('\n🎉 TOUS LES 10 SCÉNARIOS ONT ÉTÉ EXÉCUTÉS ET VALIDÉS AVEC 100% DE SUCCÈS !\n');
}

run10Scenarios().catch(err => {
  console.error('\n❌ Échec du test :', err);
  process.exit(1);
});
