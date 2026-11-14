/**
 * GetVirtu — static checks of the front-end and deployment configuration (no server needed).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const FRONT = ['index.html', 'admin.html', 'app.js', 'security.js', 'style.css'];

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

test('all front-end JavaScript compiles', () => {
  for (const f of ['app.js', 'security.js']) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
  for (const f of ['index.html', 'admin.html']) {
    inlineScripts(read(f)).forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `${f}#${i}` }), `${f} inline script ${i}`));
  }
  for (const f of fs.readdirSync(path.join(root, 'backend')).filter(x => x.endsWith('.js'))) assert.doesNotThrow(() => new vm.Script(read('backend/' + f).replace(/^#!.*\n/, '')), f);
});

test('no secret, default password or password hash shipped to the browser', () => {
  const patterns = [
    [/admin123/i, 'default admin password'],
    [/scrypt:[0-9a-f]{16,}:[0-9a-f]{64,}/i, 'scrypt hash'],
    [/\b[0-9a-f]{64}\b/i, '64-hex hash'],
    [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT / API token'],
    [/(ghp_|github_pat_|sk_live_|sk_test_|GOCSPX-)[A-Za-z0-9_-]{10,}/, 'provider secret'],
    [/(VERCEL_TOKEN|TRYBIT_SECRET_KEY|SASPAY_API_KEY|SESSION_SECRET)\s*[:=]\s*['"][^'"]+['"]/, 'secret assignment']
  ];
  for (const f of FRONT) {
    const src = read(f);
    for (const [re, label] of patterns) assert.ok(!re.test(src), `${label} found in ${f}`);
  }
});

test('no published default password or legacy master password in server code', () => {
  for (const f of ['backend/auth.js', 'backend/db.js', 'api/auth.js', 'api/data.js']) {
    const src = read(f);
    assert.ok(!/['"]admin123['"]/.test(src), `${f} must not contain the admin123 literal`);
    assert.ok(!/password\s*===\s*['"]admin/.test(src), `${f} must not compare with a literal admin password`);
  }
  assert.ok(!/getvirtu_auth_sec_hmac_2026_super_key/.test(read('backend/auth.js')), 'no hard-coded session signing key');
});

test('admin templates escape customer-controlled fields', () => {
  const admin = read('admin.html');
  // showToast() renders with textContent (safe); every other raw interpolation would reach innerHTML
  const htmlLines = admin.split('\n').filter(l => !l.includes('showToast(') && !/\.textContent\s*=/.test(l));
  const text = htmlLines.join('\n');
  assert.ok(/t\.textContent = msg;/.test(admin), 'admin toasts are rendered as text');
  assert.ok(!/<strong>\$\{o\.id\}<\/strong>/.test(text), 'order id escaped');
  assert.ok(!/<strong>\$\{r\.id\}<\/strong>/.test(text), 'transaction id escaped');
  for (const field of ['t.userName', 't.subject', 't.message', 'o.userName', 'o.userEmail', 'o.productName', 'u.name', 'u.email', 'r.userName', 'r.userEmail']) {
    const raw = new RegExp('\\$\\{' + field.replace('.', '\\.') + '\\}');
    assert.ok(!raw.test(text), `${field} must be escaped`);
  }
});

test('System Management / Reset Website UI is present and safe', () => {
  const admin = read('admin.html');
  assert.ok(admin.includes('id="tab-content-system"'), 'System tab');
  assert.ok(admin.includes("openStoreResetModal('demo')") && admin.includes("openStoreResetModal('full')"), 'two reset options');
  assert.ok(admin.includes('id="store-reset-phrase"') && admin.includes('id="store-reset-password"') && admin.includes('id="store-reset-ack"'), 'phrase + password + acknowledgement');
  assert.ok(admin.includes("STORE_RESET_PHRASE = 'RESET WEBSITE'"), 'exact confirmation phrase');
  assert.ok(!admin.includes('/api/data/reset-password') && !admin.includes('openResetAllDataModal'), 'legacy reset mechanisms removed');
});

test('storefront: no fake key generation, safe link rendering, account & password recovery', () => {
  const app = read('app.js');
  assert.ok(!/'-ACTIF'/.test(app), 'no fabricated keys for empty deliveries');
  assert.ok(app.includes('function isHttpUrl'), 'links validated before rendering');
  assert.ok(app.includes('function openForgotPasswordModal') && app.includes('function openAccountModal'), 'account features');
  const index = read('index.html');
  assert.ok(index.includes('openForgotPasswordModal()'), 'forgot password link');
});

test('cache-busting versions are consistent', () => {
  const v = JSON.parse(read('version.json')).version;
  for (const f of ['index.html', 'admin.html']) {
    const refs = [...read(f).matchAll(/\?v=([^"]+)"/g)].map(m => m[1]);
    assert.ok(refs.length > 0 && refs.every(x => x === v), `${f} references version ${v}`);
  }
  assert.ok(read('app.js').includes(`currentVersion: '${v}'`), 'app.js VersionManager');
  assert.ok(read('admin.html').includes(`currentVersion: '${v}'`), 'admin.html VersionManager');
});

test('deployment configuration protects private paths and sets security headers', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const redirects = cfg.redirects.map(r => r.source).join(' ');
  for (const p of ['/backend/', '/data/', '/tests/', '/scripts/', '/package.json', '/server.js', '.env']) assert.ok(redirects.includes(p), `blocks ${p}`);
  const headers = cfg.headers.find(h => h.source === '/(.*)').headers.map(h => h.key);
  for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) assert.ok(headers.includes(h), h);
  const csp = cfg.headers.find(h => h.source === '/(.*)').headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.ok(!csp.includes('unsafe-eval'), 'no unsafe-eval');
  assert.ok(cfg.rewrites.some(r => r.source === '/media/:id'), 'media rewrite');
  const gi = read('.gitignore');
  for (const p of ['.env', 'data/', 'node_modules/']) assert.ok(gi.includes(p), `.gitignore covers ${p}`);
});
