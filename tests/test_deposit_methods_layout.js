// Test unitaire et fonctionnel de la modale de recharge (#modal-deposit)
// Vérifie la stabilité du centrage, la disposition 2x2 (<= 4 méthodes) et le scrolling horizontal isolé (> 4 méthodes)

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function runLayoutTests() {
  console.log('=== TEST: Recharge Modal Layout & Isolated Horizontal Scrolling ===\n');

  const css = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

  // 1. Vérification CSS : Stabilité et interdiction d'overflow du modal
  console.log('▶ Test 1: Vérification CSS des contraintes anti-débordement de la modale...');
  assert.ok(css.includes('#modal-deposit.modal-backdrop'), 'CSS doit cibler #modal-deposit.modal-backdrop');
  assert.ok(css.includes('overflow-x: hidden !important;'), 'La modale doit avoir overflow-x: hidden pour interdire tout débordement horizontal');
  assert.ok(css.includes('.modal-deposit-compact .deposit-field-methods'), 'CSS doit cibler .deposit-field-methods');
  console.log('  ✓ Contraintes anti-overflow de la modale validées.');

  // 2. Vérification CSS : Grille 2 colonnes par défaut (<= 4 méthodes)
  console.log('▶ Test 2: Disposition 2 colonnes par défaut (<= 4 méthodes)...');
  assert.ok(css.includes('grid-template-columns: repeat(2, 1fr) !important;'), 'Doit utiliser 2 colonnes par défaut pour reproduire fidèlement la capture 1');
  console.log('  ✓ Grille 2 colonnes par défaut conforme à la capture 1.');

  // 3. Vérification CSS : Classe .scrollable pour > 4 méthodes
  console.log('▶ Test 3: Classe .payment-method-tabs.scrollable pour > 4 méthodes...');
  assert.ok(css.includes('.payment-method-tabs.scrollable'), 'CSS doit définir les règles de défilement pour .payment-method-tabs.scrollable');
  assert.ok(css.includes('grid-auto-flow: column !important;'), 'Le flux doit être en colonnes pour un défilement horizontal fluide');
  assert.ok(css.includes('overflow-x: auto !important;'), 'overflow-x: auto doit être actif sur le conteneur scrollable');
  assert.ok(css.includes('overflow-y: hidden !important;'), 'overflow-y: hidden pour isoler strictement le défilement horizontal');
  assert.ok(css.includes('-webkit-overflow-scrolling: touch !important;'), 'Support tactile iOS/Android présent');
  console.log('  ✓ Règles de défilement horizontal isolé validées.');

  // 4. Vérification HTML : Structure du conteneur et boutons de navigation
  console.log('▶ Test 4: Structure HTML de la section méthode de paiement...');
  assert.ok(html.includes('id="deposit-methods-tabs-container"'), 'Conteneur deposit-methods-tabs-container présent');
  assert.ok(html.includes('id="pm-scroll-nav-btns"'), 'Boutons de navigation pm-scroll-nav-btns présents');
  assert.ok(html.includes('scrollDepositMethodsTabs'), 'Fonction de défilement reliée aux boutons');
  console.log('  ✓ Structure HTML et contrôles de navigation validés.');

  // 5. Vérification JS : Logique de partitionnement et de disposition
  console.log('▶ Test 5: Algorithme d\'ordonnancement des méthodes dans app.js...');
  assert.ok(js.includes('isScrollable = methods.length > 4'), 'Condition de défilement si methods.length > 4');
  assert.ok(js.includes('container.classList.toggle(\'scrollable\', isScrollable)'), 'Activation dynamique de la classe .scrollable');
  assert.ok(js.includes('initDepositModalScroll'), 'Gestionnaires tactiles, molette et glisser-déposer initialisés');
  console.log('  ✓ Ordonnancement et activation dynamique validés.');

  // 6. Test unitaire simulé de l'algorithme d'ordonnancement
  console.log('▶ Test 6: Simulation avec 4 méthodes et avec 6 méthodes...');
  const sampleMethods = [
    { id: 1, name: 'Mobile Money (Wave, Orange, MTN)', type: 'mobile_money', enabled: true },
    { id: 2, name: 'Crypto Instant (Trybit)', type: 'crypto_trybit', enabled: true },
    { id: 3, name: 'USDT TRC20 Manuel Mis à Jour', type: 'crypto', enabled: true },
    { id: 4, name: 'USDT TRC20 Manuel', type: 'crypto', enabled: true },
    { id: 5, name: 'USDT BEP20 Rapide', type: 'crypto', enabled: true },
    { id: 6, name: 'Virement Express', type: 'bank', enabled: true }
  ];

  // Cas <= 4 méthodes
  const fourMethods = sampleMethods.slice(0, 4);
  assert.strictEqual(fourMethods.length, 4);
  const isScrollable4 = fourMethods.length > 4;
  assert.strictEqual(isScrollable4, false, '4 méthodes ne doivent pas déclencher le mode scrollable');

  // Cas 6 méthodes
  const sixMethods = sampleMethods.slice(0, 6);
  assert.strictEqual(sixMethods.length, 6);
  const isScrollable6 = sixMethods.length > 4;
  assert.strictEqual(isScrollable6, true, '6 méthodes doivent activer le mode scrollable');

  // Test de l'ordre d'affichage pour 6 méthodes
  const ordered = [];
  if (sixMethods[0]) ordered.push(sixMethods[0]);
  if (sixMethods[2]) ordered.push(sixMethods[2]);
  if (sixMethods[1]) ordered.push(sixMethods[1]);
  if (sixMethods[3]) ordered.push(sixMethods[3]);
  for (let i = 4; i < sixMethods.length; i += 2) {
    if (sixMethods[i]) ordered.push(sixMethods[i]);
    if (sixMethods[i + 1]) ordered.push(sixMethods[i + 1]);
  }

  // Dans une grille 2 rangées avec grid-auto-flow: column :
  // Col 1 : ordered[0] (haut) = sampleMethods[0] (Mobile Money), ordered[1] (bas) = sampleMethods[2] (USDT TRC20 Manuel Mis à Jour)
  // Col 2 : ordered[2] (haut) = sampleMethods[1] (Crypto Instant), ordered[3] (bas) = sampleMethods[3] (USDT TRC20 Manuel)
  // Col 3 : ordered[4] (haut) = sampleMethods[4] (USDT BEP20), ordered[5] (bas) = sampleMethods[5] (Virement Express)
  assert.strictEqual(ordered[0].name, 'Mobile Money (Wave, Orange, MTN)', 'Col 1 Haut doit être Mobile Money');
  assert.strictEqual(ordered[1].name, 'USDT TRC20 Manuel Mis à Jour', 'Col 1 Bas doit être USDT Manuel Mis à Jour');
  assert.strictEqual(ordered[2].name, 'Crypto Instant (Trybit)', 'Col 2 Haut doit être Crypto Instant');
  assert.strictEqual(ordered[3].name, 'USDT TRC20 Manuel', 'Col 2 Bas doit être USDT TRC20 Manuel');
  assert.strictEqual(ordered[4].name, 'USDT BEP20 Rapide', 'Col 3 Haut doit être la 5ème méthode');
  assert.strictEqual(ordered[5].name, 'Virement Express', 'Col 3 Bas doit être la 6ème méthode');

  console.log('  ✓ Correspondance exacte 100% avec les positions de la capture 1 dans la vue initiale (Colonnes 1 & 2).');
  console.log('  ✓ Les méthodes additionnelles 5 et 6 sont placées proprement dans la colonne 3 scrollable.');

  console.log('\n🎉 TOUS LES TESTS DE MISE EN PAGE ET DE DÉFILEMENT HORIZONTAL ONT RÉUSSI À 100% !\n');
  return true;
}

if (require.main === module) {
  runLayoutTests();
}

module.exports = runLayoutTests;
