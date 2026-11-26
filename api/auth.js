/**
 * Vercel Serverless Function: /api/auth
 * Actions: config, me, register, login, google, callback, logout, change-password, profile,
 *          forgot-password, reset-password
 */

'use strict';

const authService = require('../backend/auth');
const db = require('../backend/db');
const { httpError, apiHeaders, parseBody, getToken, clientIp, queryParam, pathParts, requireUser, sendError } = require('../backend/http');

function resolveAction(req) {
  const a = queryParam(req, 'action');
  if (a) return String(a);
  // Vercel rewrites /api/auth/:path* -> /api/auth?path=...; the local server keeps the full URL
  const p = queryParam(req, 'path');
  const parts = p ? String(p).split('/').filter(Boolean) : pathParts(req).filter(x => x !== 'api' && x !== 'auth');
  if (parts.includes('callback')) return 'callback';
  return parts[parts.length - 1] || '';
}

// JSON safely embedded in an inline <script> (no </script> breakout, no U+2028 issues)
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function publicOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'getvirtu.shop').split(',')[0].trim();
  const allowed = /^(getvirtu\.shop|www\.getvirtu\.shop|[a-z0-9-]+\.vercel\.app|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/i.test(host);
  const safeHost = allowed ? host : 'getvirtu.shop';
  const proto = /^(localhost|127\.0\.0\.1)/.test(safeHost) ? 'http' : 'https';
  return `${proto}://${safeHost}`;
}

module.exports = async function handler(req, res) {
  apiHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = resolveAction(req);

  try {
    const body = req.method === 'GET' ? {} : parseBody(req);

    if (req.method === 'GET' && action === 'config') {
      return res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
    }

    // Google OAuth redirect flow (fallback when the popup is blocked)
    if (req.method === 'GET' && action === 'callback') {
      const sendPage = (script) => {
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'");
        return res.status(200).end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GetVirtu</title></head><body><script>${script}</script></body></html>`);
      };
      const errorParam = queryParam(req, 'error');
      const code = queryParam(req, 'code');
      if (errorParam || !code) {
        return sendPage(`window.location.replace('/#catalog?auth_error=' + encodeURIComponent(${jsonForScript(String(errorParam || 'missing_code').slice(0, 60))}));`);
      }
      try {
        const profile = await authService.verifyGoogleIdentity({ code, redirect_uri: `${publicOrigin(req)}/api/auth/google/callback` });
        const result = await db.tx(() => authService.signInWithGoogleProfile(profile));
        return sendPage(`try{localStorage.setItem('vs_session', JSON.stringify(${jsonForScript(result.session)}));}catch(e){}window.location.replace('/?auth_success=google#catalog');`);
      } catch (e) {
        return sendPage(`alert(${jsonForScript('Connexion Google impossible : ' + (e.status && e.status < 500 ? e.message : 'erreur temporaire'))});window.location.replace('/#catalog');`);
      }
    }

    if (req.method === 'GET' && (action === 'me' || action === '')) {
      const out = await db.read(() => {
        const auth = requireUser(req);
        return { success: true, user: authService.sanitizeUser(auth.user), session: auth.session };
      });
      return res.status(200).json(out);
    }

    if (req.method !== 'POST' && req.method !== 'PUT') {
      throw httpError(404, `Action '${action || 'inconnue'}' non reconnue.`);
    }

    if (action === 'register') {
      if (!authService.hit('register:' + clientIp(req), 10, 60 * 60 * 1000)) throw httpError(429, 'Trop de créations de compte depuis cette connexion. Réessayez plus tard.');
      const result = await db.tx(() => authService.register(body));
      return res.status(201).json({ success: true, ...result });
    }

    if (action === 'login') {
      const ip = clientIp(req);
      let user;
      try {
        user = await db.read(() => {
          const u = authService.checkCredentials({ identifier: body.identifier, email: body.email, password: body.password, ip });
          return JSON.parse(JSON.stringify(u));
        });
      } catch (err) {
        // Failed attempts on an administrator identifier are kept in the activity log (security trail)
        if (err && err.status === 401) {
          const adminId = await db.read(() => {
            const target = db.getUserByIdentifier(String(body.identifier || body.email || ''));
            return target && target.role === 'admin' ? target.id : null;
          }).catch(() => null);
          if (adminId) {
            await db.tx(() => db.audit(null, 'admin.login_failed', { targetType: 'admin', targetId: adminId, ip, summary: 'Tentative de connexion administrateur refusée (mot de passe incorrect)' })).catch(() => {});
          }
        }
        throw err;
      }
      let fresh = user;
      if (authService.needsRehash(user)) {
        fresh = await db.tx(() => db.updateUser(user.id, { password_hash: authService.hashPassword(body.password) })) || user;
      }
      if (fresh.role === 'admin') {
        await db.tx(() => db.audit(fresh, 'admin.login', { targetType: 'admin', targetId: fresh.id, ip, summary: 'Connexion administrateur réussie' })).catch(() => {});
      }
      return res.status(200).json({ success: true, user: authService.sanitizeUser(fresh), session: authService.createSession(fresh) });
    }

    if (action === 'google') {
      const profile = await authService.verifyGoogleIdentity(body);
      const result = await db.tx(() => authService.signInWithGoogleProfile(profile));
      return res.status(200).json({ success: true, ...result });
    }

    if (action === 'logout') {
      const token = getToken(req);
      if (token) await db.tx(() => authService.destroySession(token));
      return res.status(200).json({ success: true, message: 'Déconnexion effectuée.' });
    }

    if (action === 'change-password') {
      const session = await db.tx(() => {
        const auth = requireUser(req);
        const s = authService.changePassword(auth.user, body);
        if (auth.user.role === 'admin') db.audit(auth.user, 'admin.password_changed', { targetType: 'admin', targetId: auth.user.id, ip: clientIp(req), summary: 'Mot de passe administrateur modifié (les autres sessions sont déconnectées)' });
        return s;
      });
      return res.status(200).json({ success: true, message: 'Mot de passe modifié avec succès.', session });
    }

    if (action === 'profile') {
      const user = await db.tx(() => {
        const auth = requireUser(req);
        const name = db.helpers.cleanText(body.name, 80);
        if (!name || name.length < 2) throw httpError(400, 'Le nom doit contenir au moins 2 caractères.');
        return authService.sanitizeUser(db.updateUser(auth.user.id, { name }));
      });
      return res.status(200).json({ success: true, user });
    }

    if (action === 'forgot-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const ip = clientIp(req);
      if (!authService.hit('forgot-ip:' + ip, 5, 60 * 60 * 1000) || !authService.hit('forgot-mail:' + email, 3, 60 * 60 * 1000)) {
        throw httpError(429, 'Trop de demandes. Réessayez dans une heure.');
      }
      const emailConfigured = Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
      let token = null;
      if (emailConfigured && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        token = await db.tx(() => {
          const u = db.getUserByEmail(email);
          if (!u || u.role === 'admin') return null; // admins recover through the server (ADMIN_PASSWORD_HASH)
          return db.createPasswordResetToken(u.id);
        });
        if (token) await authService.sendPasswordResetEmail(email, `${publicOrigin(req)}/#reset-password=${encodeURIComponent(token)}`);
      }
      // Same answer whether the account exists or not (no account enumeration)
      return res.status(200).json({
        success: true,
        emailDelivery: emailConfigured,
        message: emailConfigured
          ? "Si un compte correspond à cette adresse, un e-mail contenant un lien de réinitialisation (valable 30 minutes) vient d'être envoyé."
          : "La réinitialisation par e-mail n'est pas activée : contactez le support (WhatsApp ou formulaire) pour recevoir un mot de passe temporaire."
      });
    }

    if (action === 'reset-password') {
      if (!authService.hit('reset-ip:' + clientIp(req), 10, 60 * 60 * 1000)) throw httpError(429, 'Trop de tentatives. Réessayez plus tard.');
      await db.tx(() => authService.resetPasswordWithToken(body.token, body.newPassword, body.confirmPassword));
      return res.status(200).json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez maintenant vous connecter.' });
    }

    throw httpError(404, `Action '${action || 'inconnue'}' non reconnue.`);
  } catch (err) {
    return sendError(res, err, 'API Auth');
  }
};
