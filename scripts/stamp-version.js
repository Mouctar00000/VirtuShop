#!/usr/bin/env node
/**
 * Stamps a new build version everywhere it is used for cache busting:
 * version.json, the ?v= query strings of index.html / admin.html, and VersionManager.currentVersion.
 * Usage: node scripts/stamp-version.js   (prints the new version)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const now = new Date();
const version = 'v' + now.toISOString().replace(/[-:T]/g, '').slice(0, 12) + '_' + crypto.randomBytes(3).toString('hex');

function edit(file, fn) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after !== before) fs.writeFileSync(p, after, 'utf8');
}

fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version, buildTime: now.toISOString(), timestamp: now.getTime(), env: 'production' }, null, 2) + '\n', 'utf8');
for (const f of ['index.html', 'admin.html']) {
  edit(f, s => s
    .replace(/(href="style\.css)(\?v=[^"]*)?"/g, `$1?v=${version}"`)
    .replace(/(src="security\.js)(\?v=[^"]*)?"/g, `$1?v=${version}"`)
    .replace(/(src="app\.js)(\?v=[^"]*)?"/g, `$1?v=${version}"`)
    .replace(/currentVersion:\s*'[^']*'/g, `currentVersion: '${version}'`));
}
edit('app.js', s => s.replace(/currentVersion:\s*'[^']*'/g, `currentVersion: '${version}'`));
console.log(version);
