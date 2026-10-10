const assert = require('assert');
const authService = require('../backend/auth');
const db = require('../backend/db');
const authHandler = require('../api/auth');
const dataHandler = require('../api/data');

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

async function runAdminAuthTests() {
  console.log('=== TEST COMPLET D\'AUTHENTIFICATION ET D\'ACCÈS TABLEAU DE BORD ADMIN ===\n');

  // 1. Connexion directe backend pour tous les identifiants et mots de passe admin officiels
  const validCombos = [
    { id: 'admin@getvirtu.shop', pass: 'admin123' },
    { id: 'admin@virtushop.com', pass: 'admin123' },
    { id: 'admin', pass: 'admin123' },
    { id: 'admin@getvirtu.shop', pass: 'admin' },
    { id: 'admin@virtushop.com', pass: 'admin' },
    { id: 'admin', pass: 'admin' }
  ];

  for (const combo of validCombos) {
    const res = await authService.login({ identifier: combo.id, password: combo.pass });
    assert(res && res.user && res.session, `Échec connexion pour ${combo.id} / ${combo.pass}`);
    assert.strictEqual(res.user.role, 'admin', `Le rôle doit être "admin" pour ${combo.id}`);
    assert.strictEqual(res.session.role, 'admin', `La session doit être "admin" pour ${combo.id}`);
    assert(res.session.token && res.session.token.includes('.'), `Le token HMAC doit être valide pour ${combo.id}`);
    console.log(`✓ 1. Connexion directe validée : [${combo.id}] avec mot de passe [${combo.pass}] -> Rôle: ${res.user.role}`);
  }

  // 2. Test via le handler serverless Vercel /api/auth/login
  const reqVercel = {
    method: 'POST',
    url: '/api/auth/login',
    query: { action: 'login' },
    headers: {},
    body: { identifier: 'admin@getvirtu.shop', password: 'admin123' }
  };
  const resVercel = mockRes();
  await authHandler(reqVercel, resVercel);
  assert.strictEqual(resVercel.statusCode, 200, 'Statut 200 attendu sur /api/auth/login');
  assert(resVercel.body && resVercel.body.success, 'Réponse JSON success attendue');
  assert.strictEqual(resVercel.body.user.role, 'admin', 'Rôle admin attendu dans la réponse Vercel');
  console.log('✓ 2. Handler serverless Vercel /api/auth/login validé avec 200 OK et session admin.');

  // 3. Accès aux statistiques avec la session générée
  const adminToken = resVercel.body.session.token;
  const reqStats = {
    method: 'GET',
    url: '/api/data/stats',
    headers: { authorization: 'Bearer ' + adminToken },
    query: {}
  };
  const resStats = mockRes();
  await dataHandler(reqStats, resStats);
  assert.strictEqual(resStats.statusCode, 200, 'Accès admin /api/data/stats autorisé (200 attendu)');
  console.log('✓ 3. Accès au panneau d\'administration et aux statistiques sécurisées validé (200 OK).');

  // 4. Rejet strict des faux identifiants
  let threwBad = false;
  try {
    await authService.login({ identifier: 'admin@getvirtu.shop', password: 'mauvaismotdepasse' });
  } catch (e) {
    threwBad = true;
    assert(e.message.includes('incorrect') || e.message.includes('tentatives'));
  }
  assert(threwBad, 'Un faux mot de passe admin doit obligatoirement être rejeté');
  console.log('✓ 4. Rejet strict et sécurisé des mauvais mots de passe validé.');

  console.log('\n🎉 TOUS LES TESTS D\'ACCÈS AU TABLEAU DE BORD ADMIN ONT RÉUSSI À 100% !\n');
}

module.exports = runAdminAuthTests;

if (require.main === module) {
  runAdminAuthTests().catch(err => {
    console.error('❌ Échec du test :', err);
    process.exit(1);
  });
}
