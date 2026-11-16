/**
 * GetVirtu — one-time Edge Config -> Postgres migration.
 * The export part runs everywhere (mocked Edge Config API); the Postgres part needs a DISPOSABLE database:
 *   TEST_DATABASE_URL=postgres://user:pass@host:port/db node --test tests/postgres.migration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEdgeConfigMock } = require('./helpers/edge-config-mock');
const { EdgeConfigStore, PostgresStore } = require('../backend/store');

test('Edge Config export carries the state and every binary file, and fails loudly when unreadable', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const mock = createEdgeConfigMock({
    gv_state: { users: [{ id: 'u1' }], products: [{ id: 'p1' }] },
    gv_blob_pub_abc: { mime: 'image/png', b64: png.toString('base64') }
  });
  process.env.GV_EDGE_API_BASE = await mock.listen();
  try {
    const out = await new EdgeConfigStore({ edgeConfigId: 'ecfg_test', token: 'test-token' }).exportForMigration();
    assert.deepEqual(out.state.products, [{ id: 'p1' }]);
    assert.equal(out.blobs.length, 1);
    assert.equal(out.blobs[0].id, 'pub_abc');
    assert.equal(out.blobs[0].mime, 'image/png');
    assert.ok(Buffer.from(out.blobs[0].data).equals(png));
    // An unreadable Edge Config must be an error, never an empty export
    await assert.rejects(new EdgeConfigStore({ edgeConfigId: 'ecfg_test', token: 'wrong-token' }).exportForMigration(), /export failed/);
  } finally {
    delete process.env.GV_EDGE_API_BASE;
    await mock.close();
  }
});

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test('Postgres migration tests (skipped: set TEST_DATABASE_URL to a disposable database)', { skip: true }, () => {});
} else {
  const { Client } = require('pg');
  const resetSchema = async () => {
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS getvirtu CASCADE');
    await c.end();
  };
  const seed = () => ({ users: [], products: [], fresh: true });

  test('a failing import never creates an empty shop and is retried on the next request', async () => {
    await resetSchema();
    let calls = 0;
    const legacy = { state: { users: [{ id: 'admin-001' }], products: [{ id: 'p1' }] }, blobs: [{ id: 'pub_x', mime: 'image/webp', data: Buffer.from('img') }] };
    const s = new PostgresStore(URL_, {
      legacyImporter: async () => {
        calls++;
        if (calls === 1) throw new Error('Edge Config export failed (HTTP 503)');
        return legacy;
      }
    });
    try {
      await assert.rejects(s.init(seed), /HTTP 503/);
      const n = await s.pool.query('SELECT count(*)::int AS n FROM getvirtu.state');
      assert.equal(n.rows[0].n, 0, 'no state row after a failed import');
      await s.init(seed); // next request retries
      assert.equal(calls, 2);
      const st = await s.load();
      assert.deepEqual(st.products, [{ id: 'p1' }]);
      assert.equal(st.fresh, undefined, 'imported data, not the empty seed');
      const blob = await s.getBlob('pub_x');
      assert.equal(blob.mime, 'image/webp');
      assert.equal(Buffer.from(blob.data).toString(), 'img');
    } finally {
      await s.pool.end();
    }
  });

  test('the import runs once: an existing database is never overwritten', async () => {
    let calls = 0; // database left by the previous test
    const s = new PostgresStore(URL_, { legacyImporter: async () => { calls++; return { state: { products: [{ id: 'OTHER' }] }, blobs: [] }; } });
    try {
      await s.init(seed);
      assert.equal(calls, 0);
      assert.deepEqual((await s.load()).products, [{ id: 'p1' }]);
    } finally {
      await s.pool.end();
    }
  });

  test('nothing to import starts from the clean seed', async () => {
    await resetSchema();
    const s = new PostgresStore(URL_, { legacyImporter: async () => ({ state: null, blobs: [] }) });
    try {
      await s.init(seed);
      assert.equal((await s.load()).fresh, true);
    } finally {
      await s.pool.end();
    }
  });

  test('concurrent cold starts import exactly once', async () => {
    await resetSchema();
    const legacy = { state: { products: [{ id: 'p1' }] }, blobs: [{ id: 'pub_y', mime: 'image/png', data: Buffer.from('y') }] };
    const stores = [1, 2, 3].map(() => new PostgresStore(URL_, { legacyImporter: async () => legacy }));
    try {
      await Promise.all(stores.map(s => s.init(seed)));
      const r = await stores[0].pool.query('SELECT version::int AS v FROM getvirtu.state WHERE id = 1');
      assert.equal(r.rows[0].v, 1);
      const b = await stores[0].pool.query('SELECT count(*)::int AS n FROM getvirtu.blobs');
      assert.equal(b.rows[0].n, 1);
    } finally {
      await Promise.all(stores.map(s => s.pool.end()));
    }
  });
}
