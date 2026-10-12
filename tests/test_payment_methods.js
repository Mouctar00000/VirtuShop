const assert = require('assert');
const authService = require('../backend/auth');
const db = require('../backend/db');
const dataHandler = require('../api/data');

async function runPaymentMethodTests() {
  console.log('=== TEST: Payment Methods API & CRUD ===\n');

  // 1. Get an admin user
  const adminUser = db.getUserByEmail('admin@getvirtu.shop') || db.getUserByEmail('admin@virtushop.com');
  assert(adminUser && adminUser.role === 'admin', 'Admin user must exist');
  const adminSession = authService.createSession(adminUser);
  const adminToken = adminSession.token;

  // 2. Client user
  const clientUser = db.getUserByEmail('fou67377@gmail.com') || db.createUser({ email: 'test_client@gmail.com', name: 'Client Test', passwordHash: 'abc', role: 'client' });
  const clientSession = authService.createSession(clientUser);
  const clientToken = clientSession.token;

  // Helper mock request
  function mockReqRes(method, path, body, token) {
    return new Promise((resolve) => {
      const [pathname, queryString] = path.split('?');
      const query = {};
      if (queryString) {
        queryString.split('&').forEach(pair => {
          const [k, v] = pair.split('=');
          query[k] = decodeURIComponent(v);
        });
      }
      const req = {
        method,
        url: path,
        query,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'authorization': `Bearer ${token}` } : {})
        },
        body: body || {}
      };
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        getHeader(k) { return this.headers[k]; },
        status(code) { this.statusCode = code; return this; },
        json(data) { resolve({ statusCode: this.statusCode, data }); },
        end() { resolve({ statusCode: this.statusCode }); }
      };
      dataHandler(req, res);
    });
  }

  // TEST A: GET /api/data/methods (public read)
  const getRes = await mockReqRes('GET', '/api/data/methods');
  assert.strictEqual(getRes.statusCode, 200);
  assert(Array.isArray(getRes.data.methods), 'Methods should be an array');
  console.log('✓ 1. Lecture publique des moyens de paiement (/api/data/methods) validée (200 OK)');

  // TEST B: POST /api/data/methods as Client (should fail 403)
  const clientPostRes = await mockReqRes('POST', '/api/data/methods', { name: 'Hack Method', type: 'crypto' }, clientToken);
  assert.strictEqual(clientPostRes.statusCode, 403);
  console.log('✓ 2. Tentative d\'ajout par un client rejetée avec 403 Forbidden');

  // TEST C: POST /api/data/methods as Admin (add new method)
  const newMethodPayload = {
    name: 'USDT TRC20 Manuel',
    type: 'crypto',
    network: 'TRC20',
    isBinance: true,
    address: 'TXyz1234567890TestTRC20Address',
    instructions: 'Envoyez exactement le montant puis envoyez le hash de transaction',
    enabled: true
  };
  const adminPostRes = await mockReqRes('POST', '/api/data/methods', newMethodPayload, adminToken);
  assert.strictEqual(adminPostRes.statusCode, 200);
  assert(adminPostRes.data.success, 'Should be successful');
  assert(adminPostRes.data.method.id, 'Method should have an assigned ID');
  const createdId = adminPostRes.data.method.id;
  console.log(`✓ 3. Ajout d'un moyen par l'administrateur validé avec succès (ID: ${createdId})`);

  // TEST D: POST /api/data/methods as Admin (update existing method)
  const updatePayload = {
    id: createdId,
    name: 'USDT TRC20 Manuel Mis à Jour',
    instructions: 'Consigne modifiée'
  };
  const updateRes = await mockReqRes('POST', '/api/data/methods', updatePayload, adminToken);
  assert.strictEqual(updateRes.statusCode, 200);
  const updatedMethod = updateRes.data.methods.find(m => m.id === createdId);
  assert(updatedMethod, 'Updated method must exist in list');
  assert.strictEqual(updatedMethod.name, 'USDT TRC20 Manuel Mis à Jour');
  console.log('✓ 4. Modification du moyen par l\'administrateur validée avec succès');

  // TEST E: DELETE /api/data/methods as Admin
  const delRes = await mockReqRes('DELETE', `/api/data/methods?id=${createdId}`, {}, adminToken);
  assert.strictEqual(delRes.statusCode, 200);
  const stillExists = delRes.data.methods.some(m => m.id === createdId);
  assert.strictEqual(stillExists, false, 'Deleted method should not exist');
  console.log('✓ 5. Suppression du moyen par l\'administrateur validée avec succès');

  console.log('\n🎉 TOUS LES TESTS DE L\'API MOYENS DE PAIEMENT ONT RÉUSSI À 100% !');
}

module.exports = runPaymentMethodTests;

if (require.main === module) {
  runPaymentMethodTests().catch(err => {
    console.error('❌ Erreur de test:', err);
    process.exit(1);
  });
}
