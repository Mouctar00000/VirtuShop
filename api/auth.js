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

  // Déterminer l'action demandée
  const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const action = urlParts[urlParts.length - 1]; // ex: 'register', 'login', 'google', 'me', 'logout', 'config'

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

    if (req.method === 'GET' && (action === 'me' || action === 'auth')) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || req.cookies?.gv_session;
      const verified = authService.verifySession(token);
      if (!verified) {
        return res.status(401).json({ error: 'Session non authentifiée ou expirée.' });
      }
      return res.status(200).json({ user: authService.sanitizeUser(verified.user), session: verified.session });
    }

    if (req.method === 'POST') {
      if (action === 'register') {
        const result = await authService.register(body);
        return res.status(201).json(result);
      }

      if (action === 'login') {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
        const result = await authService.login({ ...body, ip });
        return res.status(200).json(result);
      }

      if (action === 'google') {
        const result = await authService.continueWithGoogle(body);
        return res.status(200).json(result);
      }

      if (action === 'logout') {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        authService.destroySession(token);
        return res.status(200).json({ success: true, message: 'Déconnexion effectuée.' });
      }
    }

    return res.status(404).json({ error: 'Action non reconnue.' });
  } catch (error) {
    console.error('[API Auth Error]', error.message);
    return res.status(400).json({ error: error.message });
  }
};
