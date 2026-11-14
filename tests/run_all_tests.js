#!/usr/bin/env node
/**
 * GetVirtu — runs every automated test suite in an isolated environment.
 *   npm test                                  -> file store + mocked Edge Config + static checks
 *   TEST_DATABASE_URL=postgres://... npm test -> also runs the Postgres suites (use a DISPOSABLE database)
 * Never touches data/ (local database) nor any production store: each run uses a temporary directory,
 * ignores .env and clears every provider credential.
 */
'use strict';

const { spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cleanEnv = { ...process.env };
for (const k of ['VERCEL', 'DATABASE_URL', 'POSTGRES_URL', 'EDGE_CONFIG_ID', 'VERCEL_TOKEN', 'SASPAY_API_KEY', 'TRYBIT_API_KEY', 'TRYBIT_SHOP_ID', 'TRYBIT_SECRET_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET']) delete cleanEnv[k];
cleanEnv.GV_SKIP_DOTENV = '1';

const suites = [
  { name: 'Static front-end & configuration checks', file: 'tests/frontend.static.test.js' },
  { name: 'API end-to-end (file store)', file: 'tests/api.e2e.test.js', env: { TEST_STORE: 'file' } },
  { name: 'API end-to-end (Edge Config store, mocked API)', file: 'tests/api.e2e.test.js', env: { TEST_STORE: 'edge-config' } },
  { name: 'Legacy Edge Config migration', file: 'tests/edge-config.migration.test.js' },
  { name: 'Postgres store guarantees', file: 'tests/postgres.store.test.js', pg: true },
  { name: 'API end-to-end (Postgres)', file: 'tests/api.e2e.test.js', pg: true, requirePg: true },
  { name: 'Deposit modal layout (legacy check)', file: 'tests/test_deposit_methods_layout.js', plain: true },
  { name: 'Version & cache headers (legacy check)', file: 'tests/test_version_cache.js', plain: true }
];

let failed = 0;
for (const s of suites) {
  if (s.requirePg && !process.env.TEST_DATABASE_URL) { console.log(`- SKIP ${s.name} (TEST_DATABASE_URL not set)`); continue; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-run-'));
  const env = { ...cleanEnv, GV_DATA_DIR: tmp, GV_STORE: 'file', ...(s.env || {}) };
  if (s.pg && process.env.TEST_DATABASE_URL) env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL; else delete env.TEST_DATABASE_URL;
  const argv = s.plain ? [s.file] : ['--test', '--test-reporter=spec', s.file];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✔ PASS' : '✖ FAIL'} ${s.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!ok) console.log((r.stdout || '') + (r.stderr || ''));
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
