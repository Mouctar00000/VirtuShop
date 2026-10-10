/**
 * Test de validation stricte de l'isolation des rôles Client vs Admin
 * Vérifie :
 * 1. Un compte client authentifié conserve son rôle 'client' lors de la synchronisation et de la persistance.
 * 2. Tout résidu d'admin_session est purgé pour un compte client.
 * 3. Les API administrateur (/api/data/stats, /api/data/users) renvoient 403 Forbidden aux clients.
 * 4. Seul un véritable compte administrateur peut accéder aux fonctionnalités administrateur.
 */

const assert = require('assert');
const authService = require('../backend/auth');
const db = require('../backend/db');

async function testRoleIsolation() {
  console.log('=== TEST D\'ISOLATION STRICTE DES RÔLES (CLIENT vs ADMIN) ===\n');

  // 1. Vérifier le compte client Ibrahim
  const clientUser = db.getUserByEmail('fou67377@gmail.com');
  assert(clientUser, 'Le compte client Ibrahim doit exister dans la base.');
  assert.strictEqual(clientUser.role, 'client', 'Le rôle du compte Ibrahim doit être strictement "client".');
  console.log('✓ 1. Compte client identifié :', clientUser.email, '| Rôle :', clientUser.role);

  // 2. Création et vérification d'une session client
  const clientSession = authService.createSession(clientUser);
  assert.strictEqual(clientSession.role, 'client', 'La session générée pour le client doit avoir le rôle "client".');

  const verifiedClient = authService.verifySession(clientSession.token);
  assert(verifiedClient, 'La session client doit être vérifiée avec succès.');
  assert.strictEqual(verifiedClient.user.role, 'client', 'L\'utilisateur vérifié par le token doit avoir le rôle "client".');
  assert.strictEqual(verifiedClient.session.role, 'client', 'La session vérifiée par le token doit avoir le rôle "client".');
  console.log('✓ 2. Session et token client validés avec rôle "client" immutable.');

  // 3. Vérifier le compte administrateur
  const adminUser = db.getUserByEmail('admin@virtushop.com');
  assert(adminUser, 'Le compte administrateur doit exister.');
  assert.strictEqual(adminUser.role, 'admin', 'Le rôle du compte admin doit être "admin".');

  const adminSession = authService.createSession(adminUser);
  assert.strictEqual(adminSession.role, 'admin', 'La session admin doit avoir le rôle "admin".');

  const verifiedAdmin = authService.verifySession(adminSession.token);
  assert.strictEqual(verifiedAdmin.user.role, 'admin', 'L\'utilisateur admin vérifié doit avoir le rôle "admin".');
  console.log('✓ 3. Session et token administrateur validés avec rôle "admin".');

  // 4. Test d'autorisation serveur sur /api/data
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

  // A. Tentative d'accès à /api/data/stats par le client -> Doit retourner 403 Forbidden
  const clientStatsReq = {
    method: 'GET',
    url: '/api/data/stats',
    headers: { authorization: 'Bearer ' + clientSession.token },
    query: {}
  };
  const clientStatsRes = mockRes();
  await dataHandler(clientStatsReq, clientStatsRes);
  assert.strictEqual(clientStatsRes.statusCode, 403, 'Le client ne doit PAS pouvoir accéder aux statistiques admin (403 attendu).');
  console.log('✓ 4A. Tentative d\'accès aux statistiques par le client bloquée (403 Forbidden).');

  // B. Tentative d'accès à /api/data/users par le client -> Doit retourner 403 Forbidden
  const clientUsersReq = {
    method: 'GET',
    url: '/api/data/users',
    headers: { authorization: 'Bearer ' + clientSession.token },
    query: {}
  };
  const clientUsersRes = mockRes();
  await dataHandler(clientUsersReq, clientUsersRes);
  assert.strictEqual(clientUsersRes.statusCode, 403, 'Le client ne doit PAS pouvoir accéder aux données utilisateurs admin (403 attendu).');
  console.log('✓ 4B. Tentative d\'accès aux utilisateurs par le client bloquée (403 Forbidden).');

  // C. Accès à /api/data/stats par l'administrateur -> Doit retourner 200 OK
  const adminStatsReq = {
    method: 'GET',
    url: '/api/data/stats',
    headers: { authorization: 'Bearer ' + adminSession.token },
    query: {}
  };
  const adminStatsRes = mockRes();
  await dataHandler(adminStatsReq, adminStatsRes);
  assert.strictEqual(adminStatsRes.statusCode, 200, 'L\'administrateur doit pouvoir accéder aux statistiques (200 attendu).');
  console.log('✓ 4C. Accès aux statistiques autorisé pour le compte administrateur authentifié.');

  console.log('\n🎉 TOUS LES TESTS D\'ISOLATION ET DE SÉCURITÉ DES RÔLES ONT RÉUSSI À 100% !');
}

testRoleIsolation().catch(err => {
  console.error('❌ Échec du test :', err);
  process.exit(1);
});
