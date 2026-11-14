/**
 * GetVirtu — PostgresStore guarantees (requires a disposable database).
 * Run: TEST_DATABASE_URL=postgres://user:pass@host:port/db node --test tests/postgres.store.test.js
 * Simulates several serverless instances (independent connection pools) working on the same database.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test('PostgresStore tests (skipped: set TEST_DATABASE_URL to a disposable database)', { skip: true }, () => {});
} else {
  const { PostgresStore } = require('../backend/store');
  const { Client } = require('pg');

  const seed = () => ({ counter: 0, keys: Array.from({ length: 5 }, (_, i) => ({ id: 'K' + i, used: false, by: null })) });
  let a, b;

  test.before(async () => {
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS getvirtu CASCADE');
    await c.end();
    a = new PostgresStore(URL_);
    b = new PostgresStore(URL_);
    await Promise.all([a.init(seed), b.init(seed)]); // concurrent first init must not fail nor double-seed
  });
  test.after(async () => { await a.pool.end(); await b.pool.end(); });

  test('schema is private and protected by row level security', async () => {
    const r = await a.pool.query(`SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'getvirtu' AND relkind = 'r' ORDER BY relname`);
    assert.deepEqual(r.rows.map(x => x.relname), ['backups', 'blobs', 'state', 'visits']);
    assert.ok(r.rows.every(x => x.relrowsecurity === true), 'RLS enabled on every table');
  });

  test('no lost update: 2 instances x 25 concurrent read-modify-write transactions', async () => {
    const inc = (s) => s.transaction(async (state) => {
      const v = state.counter;
      await new Promise(r => setTimeout(r, Math.random() * 5)); // widen the race window
      state.counter = v + 1;
      return { changed: true };
    });
    await Promise.all([...Array(25)].map(() => inc(a)).concat([...Array(25)].map(() => inc(b))));
    assert.equal((await a.load()).counter, 50);
    assert.equal((await b.load()).counter, 50);
  });

  test('rollback: an error inside a transaction writes nothing (state and side effects)', async () => {
    await a.putBlob('pub_' + 'a'.repeat(24), 'image/png', Buffer.from([1, 2, 3]));
    await assert.rejects(a.transaction(async (state, ctx) => {
      state.counter = -999;
      ctx.deleteAllBlobs();
      ctx.clearVisits();
      throw new Error('boom');
    }), /boom/);
    assert.equal((await b.load()).counter, 50);
    assert.ok(await b.getBlob('pub_' + 'a'.repeat(24)), 'blob still present after rollback');
  });

  test('no oversell: 2 instances x 6 concurrent buyers for 5 keys', async () => {
    const buy = (s, who) => s.transaction(async (state) => {
      const k = state.keys.find(x => !x.used);
      if (!k) { const e = new Error('SOLD_OUT'); e.code = 'SOLD_OUT'; throw e; }
      await new Promise(r => setTimeout(r, Math.random() * 5));
      k.used = true;
      k.by = who;
      return { changed: true, result: k.id };
    }).then(id => ({ ok: true, id }), e => ({ ok: false, code: e.code }));
    const results = await Promise.all([...Array(6)].map((_, i) => buy(a, 'a' + i)).concat([...Array(6)].map((_, i) => buy(b, 'b' + i))));
    const ok = results.filter(r => r.ok);
    assert.equal(ok.length, 5);
    assert.equal(new Set(ok.map(r => r.id)).size, 5, 'each key sold once');
    assert.equal(results.filter(r => r.code === 'SOLD_OUT').length, 7);
    const st = await a.load();
    assert.ok(st.keys.every(k => k.used));
  });

  test('blobs, visits and backups', async () => {
    await a.putBlob('pub_' + 'b'.repeat(24), 'image/webp', Buffer.from('hello'));
    const blob = await b.getBlob('pub_' + 'b'.repeat(24));
    assert.equal(blob.mime, 'image/webp');
    assert.equal(Buffer.from(blob.data).toString(), 'hello');
    await a.recordVisit({ vid: 'v1', isNew: true });
    await b.recordVisit({ vid: 'v1', isNew: false });
    await b.recordVisit({ vid: 'v2', isNew: true });
    const vs = await a.visitStats(0);
    assert.equal(vs.totalVisits, 3);
    assert.equal(vs.uniqueVisitors, 2);
    await a.transaction(async (state, ctx) => { ctx.backup('test', { x: 1 }); ctx.deleteAllBlobsExcept(['pub_' + 'b'.repeat(24)]); return { changed: false }; });
    assert.equal(await b.getBlob('pub_' + 'a'.repeat(24)), null);
    assert.ok(await b.getBlob('pub_' + 'b'.repeat(24)));
    const n = await a.pool.query('SELECT count(*)::int AS n FROM getvirtu.backups');
    assert.equal(n.rows[0].n, 1);
  });
}
