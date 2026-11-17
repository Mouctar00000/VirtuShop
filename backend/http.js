/**
 * GetVirtu — shared HTTP helpers for the API handlers (backend/http.js)
 */

'use strict';

const authService = require('./auth');
const db = require('./db');

const MAX_JSON_BYTES = 4 * 1024 * 1024; // Vercel functions accept ~4.5 MB request bodies

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function apiHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function parseBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw httpError(413, 'Requête trop volumineuse.');
    if (!body.trim()) return {};
    try { body = JSON.parse(body); } catch (e) { throw httpError(400, 'Corps de requête JSON invalide.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

function getToken(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return String(h).replace(/^Bearer\s+/i, '').trim();
}

function clientIp(req) {
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'local';
}

function queryParam(req, key) {
  if (req.query && req.query[key] !== undefined) {
    const v = req.query[key];
    return Array.isArray(v) ? v[0] : v;
  }
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.get(key);
  } catch (e) { return null; }
}

function pathParts(req) {
  return String(req.url || '').split('?')[0].split('/').filter(Boolean);
}

// ---- auth guards (must run inside db.read / db.tx)
function currentAuth(req) {
  return authService.verifySession(getToken(req));
}
function requireUser(req) {
  const auth = currentAuth(req);
  if (!auth) throw httpError(401, 'Session non authentifiée ou expirée. Veuillez vous reconnecter.', 'SESSION_INVALID');
  return auth;
}
function requireAdmin(req) {
  const auth = currentAuth(req);
  if (!auth) throw httpError(403, "Votre session administrateur a expiré ou n'est plus valide. Veuillez vous reconnecter.", 'SESSION_INVALID');
  if (auth.user.role !== 'admin') throw httpError(403, "Action réservée à l'administrateur.");
  return auth;
}
function requireOwnerAdmin(req) {
  const auth = requireAdmin(req);
  if (!db.isOwnerAdmin(auth.user)) throw httpError(403, "Action réservée à l'administrateur principal.");
  return auth;
}

function sendError(res, err, tag) {
  const status = Number(err && err.status) || 0;
  if (status >= 400 && status < 500) {
    const payload = { error: err.message || 'Requête invalide.' };
    if (err.code) payload.code = err.code;
    if (err.extra) Object.assign(payload, err.extra);
    if (err.availableStock !== undefined) payload.availableStock = err.availableStock;
    return res.status(status).json(payload);
  }
  if (status === 502 || status === 503 || status === 504) {
    const payload = { error: err.message || 'Service externe indisponible.' };
    if (err.code) payload.code = err.code;
    if (err.extra) Object.assign(payload, err.extra);
    return res.status(status).json(payload);
  }
  console.error(`[${tag || 'API'} Error]`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Erreur interne du serveur. Veuillez réessayer.' });
}

module.exports = { httpError, apiHeaders, parseBody, getToken, clientIp, queryParam, pathParts, currentAuth, requireUser, requireAdmin, requireOwnerAdmin, sendError };
