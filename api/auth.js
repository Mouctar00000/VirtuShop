/**
 * Vercel Serverless Function: /api/auth
 */

const authService = require('../backend/auth');

module.exports = async function handler(req, res) {
  // CORS & Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Déterminer l'action demandée de manière robuste (support Vercel rewrites, query, et URL path)
  let action = '';
  if (req.query && req.query.action) {
    action = req.query.action;
  } else if (req.query && req.query.path) {
    action = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
  }

  if (!action) {
    const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    action = urlParts[urlParts.length - 1]; // ex: 'register', 'login', 'google', 'me', 'logout', 'config'
    if (action === 'auth') {
      action = '';
    }
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    if (req.method === 'GET' && action === 'config') {
      return res.status(200).json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || ''
      });
    }

    // Callback OAuth 2.0 officiel (en cas de flux par redirection complète)
    if (req.method === 'GET' && (action === 'callback' || (req.url && (req.url.includes('/callback') || req.url.includes('code=') || req.url.includes('error='))))) {
      const urlObj = new URL(req.url, 'http://localhost');
      const errorParam = req.query?.error || urlObj.searchParams.get('error');
      if (errorParam) {
        console.warn('[Google Auth Callback] Annulé ou refusé:', errorParam);
        res.writeHead(302, { Location: '/#catalog?auth_error=' + encodeURIComponent(errorParam) });
        return res.end();
      }

      const code = req.query?.code || urlObj.searchParams.get('code');
      if (code) {
        const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
        const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'getvirtu.shop';
        const redirectUri = `${proto}://${host}/api/auth/google/callback`;

        try {
          const result = await authService.continueWithGoogle({ code, redirect_uri: redirectUri });
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connexion GetVirtu...</title></head><body>
            <script>
              try {
                localStorage.setItem('vs_session', JSON.stringify(${JSON.stringify(result.session)}));
                var users = JSON.parse(localStorage.getItem('vs_users') || '[]');
                var user = ${JSON.stringify(result.user)};
                var idx = users.findIndex(function(u){ return u.id === user.id || (u.email && user.email && u.email.toLowerCase() === user.email.toLowerCase()); });
                if (idx !== -1) { users[idx] = Object.assign({}, users[idx], user); } else { users.push(user); }
                localStorage.setItem('vs_users', JSON.stringify(users));
              } catch(e){}
              window.location.href = '/#catalog';
            </script>
          </body></html>`;
          res.setHeader('Content-Type', 'text/html; charset=UTF-8');
          return res.end(html);
        } catch (authErr) {
          console.error('[Google Auth Callback Error]', authErr.message);
          const errHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Erreur de connexion</title></head><body>
            <script>
              alert("Erreur de connexion Google: " + ${JSON.stringify(authErr.message)});
              window.location.href = '/#catalog';
            </script>
          </body></html>`;
          res.setHeader('Content-Type', 'text/html; charset=UTF-8');
          return res.end(errHtml);
        }
      }
    }

    if (req.method === 'GET' && (action === 'me' || action === 'auth' || !action)) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || req.cookies?.gv_session;
      const verified = authService.verifySession(token);
      if (!verified) {
        return res.status(401).json({ error: 'Session non authentifiée ou expirée.' });
      }
      return res.status(200).json({ success: true, user: authService.sanitizeUser(verified.user), session: verified.session });
    }

    if (req.method === 'POST') {
      if (action === 'register') {
        const result = await authService.register(body);
        return res.status(201).json({ success: true, ...result });
      }

      if (action === 'login') {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
        const result = await authService.login({ ...body, ip });
        return res.status(200).json({ success: true, ...result });
      }

      if (action === 'google') {
        const result = await authService.continueWithGoogle(body);
        return res.status(200).json({ success: true, ...result });
      }

      if (action === 'logout') {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        authService.destroySession(token);
        return res.status(200).json({ success: true, message: 'Déconnexion effectuée.' });
      }
    }

    return res.status(404).json({ error: `Action '${action || 'inconnue'}' non reconnue.` });
  } catch (error) {
    console.error('[API Auth Error]', error.message);
    return res.status(400).json({ error: error.message });
  }
};
