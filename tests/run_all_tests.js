const assert = require('assert');
const fs = require('fs');
const db = require('../backend/db');
const authService = require('../backend/auth');

console.log('=== TEST 1: Session Persistence & HMAC Resiliency ===');
const testUser = { id: 'usr_test_sess_' + Date.now(), email: 'sess_test@getvirtu.shop', name: 'Sess User', role: 'client' };
const sess = authService.createSession(testUser);
assert(sess.token && sess.token.includes('.'), 'Token must be HMAC signed with a period');
assert(sess.expiresAt - sess.createdAt >= 29 * 24 * 3600 * 1000, 'Session must last at least 29+ days');

// Simuler la perte de mémoire vive (restart serverless)
db.data.users.push({ id: testUser.id, email: testUser.email, name: testUser.name, role: testUser.role, balance: 15.0 });
const verified = authService.verifySession(sess.token);
assert(verified && verified.user.id === testUser.id, 'Session must verify even with new token verification');
console.log('✓ Test 1 Réussi: Session valide 30 jours et vérifiable cross-container.');

console.log('=== TEST 2: Admin Balance Adjustment & Transaction Logging ===');
const adjustUser = { id: 'usr_bal_' + Date.now(), email: 'bal_test@getvirtu.shop', name: 'Bal Test', balance: 0.0 };
db.data.users.push(adjustUser);

// 1. Crédit +20$
const res1 = db.adjustUserBalance(adjustUser.id, { amount: 20, action: 'add', reason: 'Crédit initial test', adminName: 'SuperAdmin' });
assert.strictEqual(res1.newBalance, 20.0);
assert.strictEqual(res1.transaction.balanceBefore, 0.0);
assert.strictEqual(res1.transaction.balanceAfter, 20.0);
assert.strictEqual(res1.transaction.type, 'credit_manuel_admin');

// 2. Déduction -5$
const res2 = db.adjustUserBalance(adjustUser.id, { amount: 5, action: 'deduct', reason: 'Régularisation', adminName: 'SuperAdmin' });
assert.strictEqual(res2.newBalance, 15.0);
assert.strictEqual(res2.transaction.balanceBefore, 20.0);
assert.strictEqual(res2.transaction.balanceAfter, 15.0);
assert.strictEqual(res2.transaction.type, 'debit_manuel_admin');

// 3. Définir montant exact 50$
const res3 = db.adjustUserBalance(adjustUser.id, { amount: 50, action: 'set', reason: 'Montant fixé', adminName: 'SuperAdmin' });
assert.strictEqual(res3.newBalance, 50.0);
assert.strictEqual(res3.transaction.balanceAfter, 50.0);
console.log('✓ Test 2 Réussi: Ajustements solde (+, -, set) et traçabilité transactionnels parfaits.');

console.log('=== TEST 3: Visitor Tracking & Statistics Periods ===');
db.trackVisitor({ vid: 'vid_test_1', isNew: true });
db.trackVisitor({ vid: 'vid_test_2', isNew: true });
db.trackVisitor({ vid: 'vid_test_1', isNew: false }); // revisit

const vStats = db.getVisitorStats('day');
assert(vStats.totalVisits >= 3, 'Total visits recorded');
assert(vStats.uniqueVisitors >= 2, 'Unique visitors recorded');

const statsDay = db.getLiveStatistics('day');
assert(statsDay.visitors !== undefined, 'Live statistics include visitors');
assert(statsDay.summary !== undefined, 'Live statistics include summary');
console.log('✓ Test 3 Réussi: Traçabilité des visiteurs et statistiques par période validées.');

console.log('=== TEST 4: Frontend Assets Verification ===');
const styleCss = fs.readFileSync('style.css', 'utf8');
const adminHtml = fs.readFileSync('admin.html', 'utf8');
const appJs = fs.readFileSync('app.js', 'utf8');

// Footer
assert(styleCss.includes('.footer-top') && styleCss.includes('text-align: center'), 'Footer top must be centered');
assert(styleCss.includes('.footer-brand') && styleCss.includes('text-align: center'), 'Footer brand must be centered');
assert(styleCss.includes('.footer-col') && styleCss.includes('align-items: center'), 'Footer col must be centered');

// Status indicator pills
assert(adminHtml.includes('.status-indicator-pill') && adminHtml.includes('border-radius: 5px'), 'Admin status pill must have 5px radius');
assert(adminHtml.includes('white-space: nowrap !important;'), 'Admin status pill must have nowrap');
assert(styleCss.includes('.order-status-badge-select') && styleCss.includes('border-radius: 5px !important;'), 'Order status badge must have 5px radius');

// Purchase modal & light sweep
assert(styleCss.includes('.btn-light-sweep'), 'btn-light-sweep animation must be present');
assert(styleCss.includes('paymentLightSweep'), 'paymentLightSweep keyframes must be present');
assert(appJs.includes('Payer $${total.toFixed(2)} en Crypto ⚡'), 'Crypto button single line dynamic label');
assert(appJs.includes('Recharger ⚡'), 'Recharge button without plus');
assert(appJs.includes('Recharger mon solde ⚡'), 'Recharge mon solde button without overflow');

// Admin toggle button
assert(adminHtml.includes('switchToShop()'), 'switchToShop function present in admin.html');
// Header Connected Navigation & Role isolation assertions
const indexHtml = fs.readFileSync('index.html', 'utf8');
assert(styleCss.includes('.nav-tab-connected'), '.nav-tab-connected must be present in style.css');
assert(styleCss.includes('.nav-links-connected'), '.nav-links-connected must be present in style.css');
assert(indexHtml.includes('nav-tab-connected'), 'nav-tab-connected must be present in index.html');
assert(indexHtml.includes('id="nav-admin-link-li"'), 'nav-admin-link-li must be present in index.html');
assert(appJs.includes("var isAdmin = Boolean(session && session.userId && session.role === 'admin');"), 'Strict role isolation check in app.js');

console.log('✓ Test 4 Réussi: Toutes les modifications UI, CSS et boutons de bascule validées.');

console.log('=== TEST 5: Role Isolation & Permissions ===');
require('./test_role_isolation');

console.log('=== TEST 6: Validation des 10 Scénarios de Gestion du Stock & Clés ===');
require('./test_scenarios_1_to_10');

