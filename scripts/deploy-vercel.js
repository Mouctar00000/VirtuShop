#!/usr/bin/env node
/**
 * Deploys GetVirtu to Vercel (project "virtushop") through the Vercel API.
 * Only an explicit whitelist of files is uploaded (never .env, data/, tests/, backups or local tools).
 *
 *   node scripts/deploy-vercel.js            -> production (getvirtu.shop)
 *   node scripts/deploy-vercel.js --preview  -> preview deployment only
 *   options: --no-stamp (keep the current version.json)
 *
 * Requires VERCEL_TOKEN (and VERCEL_TEAM_ID) in the environment or in the local .env file.
 * Tip: connecting the Vercel project to the GitHub repository (Vercel > Settings > Git) makes every push deploy
 * automatically; this script remains useful for manual deployments.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const isPreview = args.includes('--preview');

// Local .env (never uploaded)
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (e) {}

const token = process.env.VERCEL_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID || '';
const project = process.env.VERCEL_PROJECT || 'virtushop';
if (!token) { console.error('VERCEL_TOKEN missing (environment or .env).'); process.exit(1); }

const PUBLIC_FILES = ['index.html', 'admin.html', 'app.js', 'security.js', 'style.css', 'favicon.ico', 'favicon.svg', 'robots.txt', 'sitemap.xml'];
const SERVER_FILES = ['vercel.json', 'package.json', 'package-lock.json', 'version.json'];
const SERVER_DIRS = ['api', 'backend'];

function listFiles() {
  const files = [...PUBLIC_FILES, ...SERVER_FILES].filter(f => fs.existsSync(path.join(root, f)));
  for (const d of SERVER_DIRS) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (f.endsWith('.js')) files.push(d + '/' + f);
    }
  }
  return files;
}

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const q = (p.includes('?') ? '&' : '?') + (teamId ? 'teamId=' + teamId : '');
    const req = https.request({ host: 'api.vercel.com', method, path: p + q, headers: Object.assign({ Authorization: 'Bearer ' + token }, headers) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        try { data = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  if (!args.includes('--no-stamp')) {
    const v = execFileSync(process.execPath, [path.join(__dirname, 'stamp-version.js')], { encoding: 'utf8' }).trim();
    console.log('Version:', v);
  }
  const files = listFiles();
  console.log(`Uploading ${files.length} files to project "${project}" (${isPreview ? 'preview' : 'production'})...`);
  const uploaded = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(root, f));
    const sha = crypto.createHash('sha1').update(content).digest('hex');
    const r = await request('POST', '/v2/files', content, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, 'x-vercel-digest': sha });
    if (r.status !== 200 && r.status !== 201) { console.error('Upload failed:', f, r.status, r.raw.slice(0, 200)); process.exit(1); }
    uploaded.push({ file: f, sha, size: content.length });
  }
  const payload = { name: project, project, files: uploaded, projectSettings: { framework: null } };
  if (!isPreview) payload.target = 'production';
  const dep = await request('POST', '/v13/deployments', JSON.stringify(payload), { 'Content-Type': 'application/json' });
  if (dep.status !== 200 && dep.status !== 201) { console.error('Deployment failed:', dep.status, dep.raw.slice(0, 500)); process.exit(1); }
  console.log('Deployment', dep.data.id, '-> https://' + dep.data.url);
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const c = await request('GET', '/v13/deployments/' + dep.data.id);
    const state = c.data && (c.data.readyState || c.data.status);
    if (state === 'READY') {
      console.log('READY:', 'https://' + c.data.url, '| aliases:', (c.data.alias || []).join(', ') || '-');
      console.log('DEPLOYMENT_ID=' + dep.data.id);
      return;
    }
    if (state === 'ERROR' || state === 'CANCELED') { console.error('Deployment', state, JSON.stringify(c.data.errorMessage || c.data.errorCode || '').slice(0, 300)); process.exit(1); }
  }
  console.error('Timed out waiting for the deployment.');
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
