const assert = require('assert');
const crypto = require('crypto');
const db = require('../backend/db');
const trybitService = require('../backend/trybit');
const paymentService = require('../backend/payments');

console.log('=== TEST SUITE: TRYBIT CRYPTO PAYMENT INTEGRATION ===\n');

(async () => {
  try {
    // 1. VÉRIFICATION DES CREDENTIALS ET CONFIGURATION
    console.log('[TEST 1] Vérification des identifiants Trybit...');
    assert(trybitService.apiKey && trybitService.apiKey.startsWith('eyJ'), 'API Key Trybit valide et chargée');
    assert.strictEqual(trybitService.shopId, '8V5AHIqEHMUSnGHq', 'Shop ID Trybit conforme');
    assert.strictEqual(trybitService.secretKey, 'fW3XEH7PJE55hlf27TBUhIOssjObBTXuRLBE', 'Secret Key Trybit conforme');
    console.log('✓ Test 1 Réussi : Identifiants Trybit chargés avec succès.\n');

    // 2. CRÉATION RÉELLE D'UNE FACTURE SUR L'API TRYBIT (V2)
    console.log('[TEST 2] Appel réel à l\'API Trybit (POST /invoice/create)...');
    const testOrderId = 'TEST-ORD-' + Date.now();
    const invoice = await trybitService.createInvoice({
      amount: 10.0,
      currency: 'USD',
      orderId: testOrderId,
      email: 'client.test@getvirtu.shop'
    });

    assert(invoice.success === true, 'Facture créée avec succès');
    assert(invoice.uuid && invoice.uuid.startsWith('INV-'), 'UUID de facture Trybit au format INV-XXXX');
    assert(invoice.link && invoice.link.includes('pay.trybit.com'), 'Lien de paiement Trybit valide');
    assert.strictEqual(invoice.orderId, testOrderId, 'Order ID transmis et restitué');
    console.log(`✓ Test 2 Réussi : Facture créée sur Trybit (${invoice.uuid}) - Lien : ${invoice.link}\n`);

    // 3. CONSULTATION DU STATUT SUR L'API TRYBIT (POST /invoice/merchant/info)
    console.log('[TEST 3] Consultation du statut de la facture (POST /invoice/merchant/info)...');
    const infoList = await trybitService.getInvoiceInfo(invoice.uuid);
    assert(Array.isArray(infoList) && infoList.length > 0, 'Statut de facture retourné par Trybit');
    const invoiceInfo = infoList[0];
    assert.strictEqual(invoiceInfo.uuid, invoice.uuid, 'UUID correspond');
    assert.strictEqual(invoiceInfo.order_id, testOrderId, 'Order ID correspond');
    console.log(`✓ Test 3 Réussi : Facture consultée avec succès (Statut : ${invoiceInfo.status})\n`);

    // 4. VÉRIFICATION SÉCURISÉE DU JETON JWT DE POSTBACK (HS256)
    console.log('[TEST 4] Test de la signature cryptographique JWT (HS256) avec la Secret Key...');
    const secretKey = trybitService.secretKey;

    function generateValidJwt(payloadData) {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
      const signature = crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url');
      return `${header}.${payload}.${signature}`;
    }

    // A. Jeton valide
    const validJwt = generateValidJwt({
      invoice_id: invoice.uuid,
      order_id: testOrderId,
      status: 'success',
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const resValid = trybitService.verifyWebhookToken(validJwt);
    assert(resValid.valid === true, 'Jeton JWT officiel validé');
    assert.strictEqual(resValid.payload.invoice_id, invoice.uuid, 'Payload décodé');

    // B. Jeton falsifié / altéré
    const tamperedJwt = validJwt.slice(0, -5) + 'XXXXX';
    const resTampered = trybitService.verifyWebhookToken(tamperedJwt);
    assert(resTampered.valid === false, 'Jeton altéré immédiatement rejeté');

    // C. Jeton expiré
    const expiredJwt = generateValidJwt({
      invoice_id: invoice.uuid,
      status: 'success',
      exp: Math.floor(Date.now() / 1000) - 400 // Expiré depuis > 5 min
    });
    const resExpired = trybitService.verifyWebhookToken(expiredJwt);
    assert(resExpired.valid === false, 'Jeton expiré immédiatement rejeté');
    console.log('✓ Test 4 Réussi : Validation cryptographique JWT HS256 rigoureuse (valide, falsifié, expiré).\n');

    // 5. TEST DU FLUX RECHARGE DE SOLDE PAR CRYPTO & TRAITEMENT DU POSTBACK
    console.log('[TEST 5] Test du flux de recharge de solde par Trybit & exécution du POSTBACK...');
    const testUser = {
      id: 'usr_crypto_' + Date.now(),
      email: 'crypto.buyer@getvirtu.shop',
      name: 'Crypto Buyer',
      balance: 10.0
    };
    db.data.users.push(testUser);

    const depositResult = await paymentService.createTrybitDeposit({
      userId: testUser.id,
      amountUsd: 25.0,
      customerEmail: testUser.email,
      customerName: testUser.name
    });
    assert(depositResult.success === true, 'Dépôt initié avec succès');
    assert(depositResult.transactionId, 'Transaction ID généré');

    // Simuler l'arrivée du webhook Trybit avec signature JWT officielle
    const postbackJwt = generateValidJwt({
      invoice_id: depositResult.invoiceUuid,
      order_id: depositResult.transactionId,
      status: 'success',
      amount_crypto: 25.0,
      currency: 'USDT',
      exp: Math.floor(Date.now() / 1000) + 300
    });

    const webhookResult = await paymentService.handleTrybitWebhook({
      order_id: depositResult.transactionId,
      invoice_id: depositResult.invoiceUuid,
      status: 'success',
      token: postbackJwt
    });

    assert(webhookResult.success === true, 'Webhook traité avec succès');
    const updatedUser = db.getUserById(testUser.id);
    assert.strictEqual(updatedUser.balance, 35.0, 'Solde crédité de +25 USD (10 + 25 = 35)');
    console.log(`✓ Test 5 Réussi : Recharge confirmée par webhook et solde crédité (Nouveau solde : $${updatedUser.balance}).\n`);

    // 6. TEST DE L'IDEMPOTENCE (PROTECTION CONTRE LE DOUBLE CRÉDIT)
    console.log('[TEST 6] Test de la protection contre les notifications répétées (Idempotence)...');
    const duplicateWebhook = await paymentService.handleTrybitWebhook({
      order_id: depositResult.transactionId,
      invoice_id: depositResult.invoiceUuid,
      status: 'success',
      token: postbackJwt
    });
    assert(duplicateWebhook.success === true, 'Réponse HTTP 200 confirmée pour webhook dupliqué');
    const userAfterDuplicate = db.getUserById(testUser.id);
    assert.strictEqual(userAfterDuplicate.balance, 35.0, 'Le solde ne doit PAS être re-crédité une seconde fois');
    console.log('✓ Test 6 Réussi : Idempotence stricte vérifiée, aucun double crédit.\n');

    // 7. TEST DU FLUX D'ACHAT DIRECT DE PRODUIT PAR CRYPTO
    console.log('[TEST 7] Test d\'un achat direct de produit via Trybit Crypto...');
    const testProduct = {
      id: 9991,
      name: 'Compte Test Crypto Delivery',
      price: 15.0,
      stock: 5,
      category: 'Test'
    };
    db.data.products.push(testProduct);

    const purchaseDeposit = await paymentService.createTrybitDeposit({
      userId: testUser.id,
      amountUsd: 15.0,
      customerEmail: testUser.email,
      customerName: testUser.name,
      productId: testProduct.id,
      quantity: 1,
      contactInfo: 'whatsapp:+33600000000'
    });

    const purchaseJwt = generateValidJwt({
      invoice_id: purchaseDeposit.invoiceUuid,
      order_id: purchaseDeposit.transactionId,
      status: 'success',
      exp: Math.floor(Date.now() / 1000) + 300
    });

    await paymentService.handleTrybitWebhook({
      order_id: purchaseDeposit.transactionId,
      invoice_id: purchaseDeposit.invoiceUuid,
      status: 'success',
      token: purchaseJwt
    });

    const orders = db.getOrders({ userId: testUser.id });
    const productOrder = orders.find(o => o.productId === testProduct.id);
    assert(productOrder, 'Commande de produit créée et débloquée');
    assert.strictEqual(productOrder.status, 'Complété', 'Statut de commande Complété');
    console.log(`✓ Test 7 Réussi : Achat direct par Crypto validé et livré (Commande ${productOrder.id}).\n`);

    console.log('======================================================');
    console.log('🎉 TOUS LES TESTS D\'INTÉGRATION TRYBIT ONT RÉUSSI À 100% !');
    console.log('======================================================');
  } catch (err) {
    console.error('\n❌ Échec du test :', err);
    process.exit(1);
  }
})();
