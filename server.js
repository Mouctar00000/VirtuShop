/**
 * GetVirtu — local development server (production runs on Vercel, see vercel.json).
 * Serves ONLY the public front-end files and routes /api/* to the same handlers as the serverless functions.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

// Public files only (everything else — backend/, data/, .env, tests/, scripts — is never served)
const PUBLIC_FILES = new Set([
  '/index.html', '/admin.html', '/app.js', '/security.js', '/style.css',
  '/favicon.ico', '/favicon.svg', '/robots.txt', '/sitemap.xml'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8'
};

// Kept identical to the "headers" section of vercel.json
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com",
    "frame-src https://accounts.google.com",
    "form-action 'self' https://accounts.google.com",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'"
  ].join('; ')
};

// Simple per-IP limiter for the API
const ipCounts = new Map();
setInterval(() => ipCounts.clear(), 60 * 1000).unref();

function routeApi(urlPath) {
  if (urlPath.startsWith('/api/auth')) return require('./api/auth');
  if (urlPath.startsWith('/api/payments')) return require('./api/payments');
  if (urlPath === '/api/version' || urlPath.startsWith('/api/data')) return require('./api/data');
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = '/';
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { urlPath = (req.url || '/').split('?')[0]; }

  // /media/<id>  ->  /api/data?resource=media&id=<id>   (same rewrite as vercel.json)
  const mediaMatch = /^\/media\/((?:pub|prv)_[a-f0-9]{24})$/.exec(urlPath);
  if (mediaMatch) {
    req.url = '/api/data?resource=media&id=' + mediaMatch[1];
    urlPath = '/api/data';
  }

  if (urlPath.startsWith('/api/')) {
    const ip = req.socket.remoteAddress || 'local';
    const n = (ipCounts.get(ip) || 0) + 1;
    ipCounts.set(ip, n);
    if (n > 600) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=UTF-8', 'Retry-After': '60', ...SECURITY_HEADERS });
      return res.end(JSON.stringify({ error: 'Trop de requêtes. Veuillez patienter quelques secondes.' }));
    }
    const handler = routeApi(urlPath);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8', ...SECURITY_HEADERS });
      return res.end(JSON.stringify({ error: 'Endpoint API non trouvé.' }));
    }
    req.query = {};
    try { for (const [k, v] of new URL(req.url || '/', 'http://localhost').searchParams) req.query[k] = v; } catch (e) {}

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; } // drain without buffering
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=UTF-8', Connection: 'close', ...SECURITY_HEADERS });
        return res.end(JSON.stringify({ error: 'Requête trop volumineuse.' }));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      req.rawBody = raw;
      req.body = raw; // parsed (with validation) by backend/http.js
      res.status = function (code) { res.statusCode = code; return res; };
      res.json = function (data) {
        if (!res.headersSent) {
          for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.getHeader(k)) res.setHeader(k, v);
          res.setHeader('Content-Type', 'application/json; charset=UTF-8');
        }
        res.end(JSON.stringify(data));
        return res;
      };
      try {
        await handler(req, res);
      } catch (err) {
        console.error('[Server API Error]', err);
        if (!res.headersSent) res.status(500).json({ error: 'Erreur interne du serveur.' });
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=UTF-8', Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end('405 Méthode non autorisée');
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  else if (urlPath === '/admin') urlPath = '/admin.html';

  if (!PUBLIC_FILES.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8', ...SECURITY_HEADERS });
    return res.end('<h2>404 - Page non trouvée</h2><p><a href="/">Retour à l\'accueil</a></p>');
  }

  const filePath = path.join(ROOT_DIR, urlPath);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8', ...SECURITY_HEADERS });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
      ...SECURITY_HEADERS
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    const db = require('./backend/db');
    console.log('\n========================================');
    console.log('⚡ GetVirtu — serveur local');
    console.log(`➡️  Boutique : http://localhost:${PORT}`);
    console.log(`➡️  Admin    : http://localhost:${PORT}/admin`);
    console.log(`➡️  Stockage : ${db.storageInfo().kind} (${db.storageInfo().location})`);
    console.log('========================================\n');
  });
}

module.exports = server;
module.exports.SECURITY_HEADERS = SECURITY_HEADERS;
