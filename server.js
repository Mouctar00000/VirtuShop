const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Protection anti-brute-force et limitation de débit en mémoire
const ipRequestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 150;

setInterval(() => {
  ipRequestCounts.clear();
}, RATE_LIMIT_WINDOW);

// En-têtes de sécurité HTTP stricts
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; base-uri 'self'; object-src 'none';"
};

const server = http.createServer((req, res) => {
  const clientIp = req.socket.remoteAddress || '127.0.0.1';
  const currentCount = (ipRequestCounts.get(clientIp) || 0) + 1;
  ipRequestCounts.set(clientIp, currentCount);

  if (currentCount > MAX_REQUESTS_PER_MINUTE) {
    res.writeHead(429, {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Retry-After': '60',
      ...SECURITY_HEADERS
    });
    res.end('429 Trop de requêtes. Veuillez patienter.');
    return;
  }

  let safePath = decodeURIComponent(req.url.split('?')[0]);
  if (safePath === '/' || safePath === '') {
    safePath = '/index.html';
  }

  // Protection contre l'accès aux fichiers sensibles (.git, .env, package.json, etc.)
  const blockedPatterns = ['/\\.env', '/\\.git', '/package\\.json', '/package-lock\\.json', '/node_modules'];
  if (blockedPatterns.some(p => new RegExp(p, 'i').test(safePath))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8', ...SECURITY_HEADERS });
    res.end('403 Accès interdit aux fichiers système.');
    return;
  }

  // Gestionnaire d'API REST unifié (compatible Node.js & Vercel Serverless)
  if (safePath.startsWith('/api/')) {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', async () => {
      try {
        req.body = bodyData ? JSON.parse(bodyData) : {};
      } catch (e) {
        req.body = bodyData;
      }

      res.status = function(code) {
        res.statusCode = code;
        return res;
      };
      res.json = function(data) {
        res.writeHead(res.statusCode || 200, {
          'Content-Type': 'application/json; charset=UTF-8',
          ...SECURITY_HEADERS
        });
        res.end(JSON.stringify(data));
      };

      try {
        if (safePath.startsWith('/api/auth')) {
          return await require('./api/auth')(req, res);
        }
        if (safePath.startsWith('/api/payments')) {
          return await require('./api/payments')(req, res);
        }
        if (safePath.startsWith('/api/data')) {
          return await require('./api/data')(req, res);
        }
        res.status(404).json({ error: 'Endpoint API non trouvé.' });
      } catch (err) {
        console.error('[Server API Error]', err);
        res.status(500).json({ error: 'Erreur interne du serveur.' });
      }
    });
    return;
  }

  // Normalize path and resolve
  const resolvedPath = path.normalize(path.join(ROOT_DIR, safePath));

  // Security check: ensure path stays within ROOT_DIR (Directory Traversal Protection)
  if (!resolvedPath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8', ...SECURITY_HEADERS });
    res.end('403 Interdit');
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8', ...SECURITY_HEADERS });
        res.end(`<h2>404 - Page non trouvée</h2><p><a href="/">Retour à l'accueil</a></p>`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8', ...SECURITY_HEADERS });
        res.end('500 Erreur Serveur');
      }
      return;
    }

    if (stats.isDirectory()) {
      const indexPath = path.join(resolvedPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=UTF-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          ...SECURITY_HEADERS
        });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8', ...SECURITY_HEADERS });
        res.end('403 Dossier protégé');
      }
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400',
      ...SECURITY_HEADERS
    });
    fs.createReadStream(resolvedPath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`⚡ GetVirtu (getvirtu.shop) est en ligne !`);
  console.log(`➡️  Boutique : http://localhost:${PORT}`);
  console.log(`➡️  Admin    : http://localhost:${PORT}/admin.html`);
  console.log(`========================================\n`);
});
