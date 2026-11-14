#!/usr/bin/env node
/**
 * GetVirtu — browser end-to-end tests (real Chromium through Playwright, isolated temporary store).
 *   npm i -D playwright && npx playwright install chromium
 *   node tests/browser.e2e.js            (screenshots in $BROWSER_SHOTS_DIR or a temp folder)
 * Covers the administrator and customer journeys on desktop, tablet and mobile viewports.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('Playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-browser-'));
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'SASPAY_API_KEY', 'TRYBIT_API_KEY', 'GOOGLE_CLIENT_ID', 'RESEND_API_KEY']) delete process.env[k];
Object.assign(process.env, { GV_SKIP_DOTENV: '1', GV_STORE: 'file', GV_DATA_DIR: TMP, SESSION_SECRET: crypto.randomBytes(32).toString('hex') });
const ADMIN_PASSWORD = 'Browser-Admin-' + crypto.randomBytes(4).toString('hex');
const salt = crypto.randomBytes(16).toString('hex');
process.env.ADMIN_PASSWORD_HASH = `scrypt:${salt}:${crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const SHOTS = process.env.BROWSER_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'gv-shots-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR42mNkYPhfz0AEYBxVSFUAANfKAf2l5fGMAAAAAElFTkSuQmCC', 'base64');

const server = require('../server');
const results = [];
let base;
const step = (ok, name, detail) => { results.push({ ok, name, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };

function api(method, url, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url, base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    if (data) req.write(data);
    req.end();
  });
}

function watch(page, label) {
  const problems = [];
  page.on('pageerror', e => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location && m.location();
    const t = m.text() + (loc && loc.url ? ` (${loc.url.replace(base, '')})` : '');
    if (/accounts\.google\.com|gsi\/client|Failed to load resource: net::ERR_|status of 40[13]/i.test(t)) return; // offline Google / expected auth checks
    problems.push(`[${label}] console: ${t}`);
  });
  page.on('dialog', async d => {
    if (d.type() === 'alert') problems.push(`[${label}] unexpected alert(): ${d.message()}`);
    await d.accept();
  });
  return problems;
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const allProblems = [];
  try {
    // ================================================================= DESKTOP: full journey
    const adminCtx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
    const admin = await adminCtx.newPage();
    allProblems.push(watch(admin, 'admin'));

    await admin.goto(base + '/admin');
    await admin.fill('#admin-direct-email', 'admin');
    await admin.fill('#admin-direct-pass', ADMIN_PASSWORD);
    await admin.click('#btn-admin-direct-login');
    await admin.waitForSelector('#admin-dashboard-container:not(.hidden)', { timeout: 10000 });
    step(true, 'Admin logs in through the dashboard form');

    // create a product with image + keys through the UI
    await admin.evaluate(() => openNewProductModal());
    await admin.fill('#admin-prod-name', 'Compte Netflix Premium');
    await admin.fill('#admin-prod-cat', 'streaming');
    await admin.fill('#admin-prod-price', '7.5');
    await admin.fill('#admin-prod-desc', 'Profil privé 30 jours');
    await admin.setInputFiles('#admin-prod-img-file', { name: 'p.png', mimeType: 'image/png', buffer: PNG });
    await admin.waitForTimeout(400);
    await admin.fill('#admin-vault-content', 'netflix1@x.com|pass1\nnetflix2@x.com|pass2\nnetflix3@x.com|pass3');
    await admin.click('#admin-prod-form button[type="submit"]');
    await admin.waitForFunction(() => document.querySelector('#admin-products-tbody') && document.querySelector('#admin-products-tbody').textContent.includes('Compte Netflix Premium'), null, { timeout: 10000 });
    const rowText = await admin.textContent('#admin-products-tbody');
    step(/3 dispo/.test(rowText), 'Admin creates a product with image and 3 keys', rowText.replace(/\s+/g, ' ').slice(0, 80));
    await admin.screenshot({ path: path.join(SHOTS, 'desktop-admin-products.png'), fullPage: false });

    const adminToken = await admin.evaluate(() => JSON.parse(localStorage.getItem('vs_admin_session')).token);

    // stored XSS attempt through the public support form
    const xss = '<img src=x onerror="alert(\'XSS\')">';
    await api('POST', '/api/data/tickets', { userName: xss, userContact: xss, subject: xss, message: xss });

    // customer journey
    const custCtx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
    const cust = await custCtx.newPage();
    allProblems.push(watch(cust, 'customer'));
    await cust.goto(base + '/');
    await cust.waitForFunction(() => document.querySelector('#landing-products-grid') && document.querySelector('#landing-products-grid').textContent.includes('Compte Netflix Premium'), null, { timeout: 10000 });
    step(true, 'Product created by the admin appears on the storefront');
    const imgOk = await cust.evaluate(() => { const i = document.querySelector('#landing-products-grid img.product-img'); return i && i.complete && i.naturalWidth > 0 && /\/media\/pub_/.test(i.getAttribute('src')); });
    step(imgOk, 'Uploaded product image is served from media storage');
    await cust.screenshot({ path: path.join(SHOTS, 'desktop-storefront.png') });

    await cust.click('#landing-products-grid .btn-buy-product');
    await cust.waitForSelector('#auth-modal.active', { timeout: 5000 });
    await cust.evaluate(() => switchAuthTab('register'));
    await cust.fill('#reg-name', 'Client Demo');
    await cust.fill('#reg-username', 'clientdemo');
    await cust.fill('#reg-email', 'client.demo@example.com');
    await cust.fill('#reg-password', 'Client-Demo-1');
    await cust.fill('#reg-password-confirm', 'Client-Demo-1');
    await cust.click('#btn-register-submit');
    await cust.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('vs_session') || 'null'); return s && s.token; }, null, { timeout: 8000 });
    step(true, 'Customer registers from the storefront');

    const custId = await cust.evaluate(() => JSON.parse(localStorage.getItem('vs_session')).userId);
    const gift = await api('POST', '/api/data/users', { userId: custId, amount: 20, action: 'gift' }, adminToken);
    step(gift.status === 200, 'Admin credits the customer balance (+20 $)');

    await cust.reload(); // the balance also refreshes every 15 s and when the tab regains focus
    await cust.waitForFunction(() => /\$20\.00/.test((document.querySelector('.balance-amount') || {}).textContent || ''), null, { timeout: 8000 });
    step(true, 'Customer sees the synchronized balance ($20.00)');

    await cust.evaluate(() => { var p = (JSON.parse(localStorage.getItem('vs_products')) || [])[0]; startProductPurchase(p.id); });
    await cust.waitForSelector('#btn-submit-purchase', { timeout: 5000 });
    await cust.click('#btn-submit-purchase');
    await cust.waitForSelector('.purchase-success-box', { timeout: 8000 });
    step(true, 'Customer buys with the balance');
    await cust.screenshot({ path: path.join(SHOTS, 'desktop-purchase-success.png') });
    const revealed = await cust.evaluate(() => {
      var btn = document.querySelector('.purchase-success-box [id^="btn-reveal-"]');
      if (btn) btn.click();
      return (document.querySelector('.purchase-success-box .vault-content-field') || {}).textContent || '';
    });
    step(/netflix\d@x\.com/.test(revealed), 'Delivered key is revealed in the vault', revealed.trim().slice(0, 40));
    const navBal = await cust.textContent('.balance-amount');
    step(/12\.50/.test(navBal), 'Balance debited server-side ($12.50 left)', navBal);

    // admin: XSS payload rendered as text, order visible, cancel with refund
    await admin.evaluate(() => { switchAdminTab('tickets'); return syncAdminDataFromServer(); });
    await admin.waitForTimeout(600);
    const ticketHtml = await admin.innerHTML('#admin-tickets-tbody');
    step(!/<img src="?x/i.test(ticketHtml) && ticketHtml.includes('&lt;img'), 'Support ticket XSS payload is rendered as inert text');
    await admin.evaluate(() => { switchAdminTab('orders'); return syncAdminDataFromServer(); });
    await admin.waitForFunction(() => document.querySelector('#admin-orders-tbody').textContent.includes('Compte Netflix Premium'), null, { timeout: 8000 });
    step(true, 'Order appears in the admin dashboard');
    const orderId = await admin.evaluate(() => (JSON.parse(localStorage.getItem('vs_orders')) || [])[0].id);
    await admin.evaluate((id) => cancelOrder(id), orderId); // confirm() dialogs are accepted, keys NOT restocked (2nd confirm accepted => restock) — accept both
    await admin.waitForFunction(() => document.querySelector('#admin-orders-tbody').textContent.includes('Remboursée'), null, { timeout: 8000 });
    step(true, 'Admin cancels the order (refund once)');
    await admin.screenshot({ path: path.join(SHOTS, 'desktop-admin-orders.png') });

    await cust.reload();
    await cust.waitForFunction(() => /\$20\.00/.test((document.querySelector('.balance-amount') || {}).textContent || ''), null, { timeout: 8000 });
    step(true, 'Customer balance refunded and synchronized ($20.00)');

    // System tab + demo reset through the UI
    await admin.evaluate(() => switchAdminTab('system'));
    await admin.waitForFunction(() => /produit/.test((document.getElementById('reset-counts-demo') || {}).textContent || ''), null, { timeout: 8000 });
    await admin.screenshot({ path: path.join(SHOTS, 'desktop-admin-system.png'), fullPage: true });
    await admin.click('button.btn-reset-option:not(.full)');
    await admin.waitForSelector('#admin-store-reset-modal.active');
    const disabledBefore = await admin.isDisabled('#btn-store-reset-submit');
    await admin.fill('#store-reset-phrase', 'reset website');
    await admin.fill('#store-reset-password', ADMIN_PASSWORD);
    await admin.check('#store-reset-ack');
    const disabledWrongPhrase = await admin.isDisabled('#btn-store-reset-submit');
    await admin.fill('#store-reset-phrase', 'RESET WEBSITE');
    const enabled = !(await admin.isDisabled('#btn-store-reset-submit'));
    step(disabledBefore && disabledWrongPhrase && enabled, 'Reset button stays locked until exact phrase + password + acknowledgement');
    const dl = admin.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await admin.click('#btn-store-reset-submit');
    await admin.waitForSelector('#store-reset-result:not(.hidden)', { timeout: 15000 });
    const download = await dl;
    const resultText = await admin.textContent('#store-reset-result');
    step(!resultText.includes('⚠️') && /Boutique publique vide/.test(resultText), 'Demo reset succeeds with all post-reset checks green', resultText.replace(/\s+/g, ' ').slice(0, 120));
    step(Boolean(download), 'Pre-reset backup file downloaded automatically', download ? download.suggestedFilename() : 'none');
    await admin.screenshot({ path: path.join(SHOTS, 'desktop-admin-reset-done.png') });

    await cust.reload();
    await cust.waitForTimeout(800);
    const loggedOut = await cust.evaluate(() => !localStorage.getItem('vs_session'));
    const empty = await cust.evaluate(() => /Aucun produit/.test(document.querySelector('#landing-products-grid').textContent));
    step(loggedOut && empty, 'After reset: demo customer logged out and storefront empty');

    // ================================================================= TABLET & MOBILE: layout and key screens
    for (const vp of [{ name: 'tablet', width: 820, height: 1180 }, { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: Boolean(vp.isMobile), hasTouch: Boolean(vp.hasTouch) });
      const p = await ctx.newPage();
      allProblems.push(watch(p, vp.name));
      await api('POST', '/api/data/products', { name: 'Produit ' + vp.name, price: 3, category: 'demo', newKeys: ['K-' + vp.name] }, adminToken);
      await p.goto(base + '/');
      await p.waitForFunction(() => document.querySelector('#landing-products-grid .product-card'), null, { timeout: 8000 });
      step(await noHorizontalOverflow(p), `${vp.name}: storefront has no horizontal overflow`);
      await p.screenshot({ path: path.join(SHOTS, `${vp.name}-storefront.png`), fullPage: false });
      await p.evaluate(() => openAuthModal('register'));
      await p.waitForSelector('#auth-modal.active');
      const modalFits = await p.evaluate(() => { const r = document.querySelector('#auth-modal .auth-card').getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; });
      step(modalFits, `${vp.name}: auth modal fits the screen`);
      await p.screenshot({ path: path.join(SHOTS, `${vp.name}-auth-modal.png`) });
      await p.evaluate(() => closeAuthModal());

      await p.goto(base + '/admin');
      await p.fill('#admin-direct-email', 'admin');
      await p.fill('#admin-direct-pass', ADMIN_PASSWORD);
      await p.click('#btn-admin-direct-login');
      await p.waitForSelector('#admin-dashboard-container:not(.hidden)', { timeout: 10000 });
      for (const tab of ['products', 'orders', 'users', 'system']) {
        await p.evaluate((t) => switchAdminTab(t), tab);
        await p.waitForTimeout(300);
        step(await noHorizontalOverflow(p), `${vp.name}: admin "${tab}" tab has no page-level horizontal overflow`);
      }
      await p.screenshot({ path: path.join(SHOTS, `${vp.name}-admin-system.png`), fullPage: false });
      await ctx.close();
    }
  } catch (err) {
    step(false, 'Unexpected error', err.stack || err.message);
  } finally {
    await browser.close();
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }
  const problems = allProblems.flat();
  problems.forEach(pb => step(false, 'Browser error', pb));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed — screenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
