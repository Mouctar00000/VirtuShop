/**
 * Minimal in-memory mock of the Vercel Edge Config REST API (items endpoints) used by the tests,
 * so that the EdgeConfigStore code path can be exercised without touching any real store.
 */
'use strict';

const http = require('http');

function createEdgeConfigMock(initialItems = {}) {
  const items = new Map(Object.entries(JSON.parse(JSON.stringify(initialItems))));
  let writes = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer test-token') return send(403, { error: { code: 'forbidden' } });
    const mItem = /^\/v1\/edge-config\/([^/]+)\/item\/([^/]+)$/.exec(url.pathname);
    const mItems = /^\/v1\/edge-config\/([^/]+)\/items$/.exec(url.pathname);
    if (req.method === 'GET' && mItem) {
      const key = decodeURIComponent(mItem[2]);
      if (!items.has(key)) { res.writeHead(204); return res.end(); } // same as the real Vercel API
      return send(200, { key, value: items.get(key) });
    }
    if (req.method === 'GET' && mItems) {
      return send(200, Array.from(items.entries()).map(([key, value]) => ({ key, value })));
    }
    if (req.method === 'PATCH' && mItems) {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        for (const op of body.items || []) {
          if (op.operation === 'upsert' || op.operation === 'create' || op.operation === 'update') items.set(op.key, JSON.parse(JSON.stringify(op.value)));
          else if (op.operation === 'delete') items.delete(op.key);
        }
        writes++;
        send(200, { status: 'ok' });
      });
      return;
    }
    send(404, { error: { code: 'not_found' } });
  });
  return {
    server,
    items,
    get writes() { return writes; },
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => server.close(r))
  };
}

module.exports = { createEdgeConfigMock };
