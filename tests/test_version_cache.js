const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../backend/db');
const dataHandler = require('../api/data');

async function testVersionAndCache() {
  console.log('=== TEST 10: Versioning, Cache-Control & Auto-Update System ===\n');

  // 1. Tester la méthode getDeploymentVersion de la DB
  const vInfo = db.getDeploymentVersion();
  assert(vInfo && vInfo.version, 'La version doit être présente');
  assert(vInfo.buildTime, 'Le timestamp buildTime doit être présent');
  console.log('✓ 1. getDeploymentVersion renvoie :', vInfo.version, '| Date :', vInfo.buildTime);

  // 2. Tester l'endpoint /api/version
  const req = {
    method: 'GET',
    url: '/api/data?resource=version',
    query: { resource: 'version' },
    headers: {}
  };
  const headers = {};
  let statusCode = 200;
  let resData = null;
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(c) { statusCode = c; return res; },
    json(d) { resData = d; return res; },
    end() { return res; }
  };

  await dataHandler(req, res);
  assert.strictEqual(statusCode, 200, 'HTTP 200 attendu sur /api/version');
  assert(resData && resData.version, 'Données de version attendues');
  assert(headers['cache-control'] && headers['cache-control'].includes('no-store'), 'Cache-Control no-store requis sur /api/version');
  console.log('✓ 2. Endpoint /api/version répond 200 OK avec Cache-Control anti-cache :', headers['cache-control']);

  // 3. Vérifier les balises méta et versions dans index.html
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(indexHtml.includes('http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"'), 'Balise meta Cache-Control manquante dans index.html');
  assert(indexHtml.includes('style.css?v='), 'Tag versionné style.css manquant dans index.html');
  assert(indexHtml.includes('app.js?v='), 'Tag versionné app.js manquant dans index.html');
  console.log('✓ 3. index.html validé : Balises meta anti-cache et tags versionnés présents.');

  // 4. Vérifier les balises méta et versions dans admin.html
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert(adminHtml.includes('http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"'), 'Balise meta Cache-Control manquante dans admin.html');
  assert(adminHtml.includes('VersionManager'), 'VersionManager manquant dans admin.html');
  assert(adminHtml.includes('syncAdminDataFromServer'), 'syncAdminDataFromServer manquant dans admin.html');
  console.log('✓ 4. admin.html validé : Balises meta anti-cache, VersionManager et synchronisation automatique présents.');

  // 5. Vérifier la configuration vercel.json
  const vercelJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const hasVersionRewrite = vercelJson.rewrites.some(r => r.source === '/api/version');
  assert(hasVersionRewrite, 'Rewrite /api/version manquant dans vercel.json');
  const hasHtmlNoCache = vercelJson.headers.some(h => h.source.includes('html') && h.headers.some(k => k.key === 'Cache-Control' && k.value.includes('must-revalidate')));
  assert(hasHtmlNoCache, 'En-têtes Cache-Control pour HTML manquants dans vercel.json');
  console.log('✓ 5. vercel.json validé : Rewrites et en-têtes Cache-Control conformes aux exigences.');

  console.log('\n🎉 TOUS LES TESTS DU SYSTÈME DE VERSIONING ET DE GESTION DU CACHE ONT RÉUSSI À 100% !');
}

if (require.main === module) {
  testVersionAndCache().catch(e => {
    console.error('Erreur:', e);
    process.exit(1);
  });
}

module.exports = testVersionAndCache;
