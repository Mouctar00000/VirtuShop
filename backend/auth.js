/**
 * GetVirtu — Authentication service (backend/auth.js)
 *
 * - Passwords: scrypt (per-user salt). Legacy SHA-256 hashes are upgraded on the next successful login.
 * - Sessions: HMAC-signed tokens { sid, uid, ver, iat, exp }. A token is only valid if the account still exists,
 *   its `session_version` matches (bumped on password change / reset / logout-all) and its `sid` is not revoked.
 *   The role always comes from the database, never from the token or the browser.
 * - Administrator sessions expire after 12 hours, customer sessions after 30 days.
 * All functions that read/write the database must be called inside db.read() / db.tx().
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const db = require('./db');

const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const IS_SERVERLESS_RUNTIME = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Session signing key: mandatory in production. Without it, a random per-instance key is used (sessions then do
// not survive restarts, but can never be forged with a key published in the source code).
if (!process.env.SESSION_SECRET && IS_SERVERLESS_RUNTIME) {
  console.error('[Auth] SESSION_SECRET is missing in production: using a temporary random key.');
}
const AUTH_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const LEGACY_SHA_SALT = 'getvirtu_sec_salt_2026';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

// In-memory throttling (per serverless instance). Combined with scrypt cost and strong password rules.
const attempts = new Map();
const RL_MAX = 5;
const RL_WINDOW = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of attempts) if (now - r.first > RL_WINDOW) attempts.delete(k);
}, 60 * 1000).unref();

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

class AuthService {
  // ------------------------------------------------------------------ passwords
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  verifyPassword(password, storedHash) {
    if (!storedHash || typeof storedHash !== 'string' || typeof password !== 'string' || !password || password.length > 256) return false;
    if (db.helpers.KNOWN_PUBLIC_HASHES.has(storedHash)) return false; // published defaults are never valid
    if (storedHash.startsWith('scrypt:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 3) return false;
      try {
        const computed = crypto.scryptSync(password, parts[1], 64);
        const expected = Buffer.from(parts[2], 'hex');
        return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
      } catch (e) { return false; }
    }
    if (/^[0-9a-f]{64}$/i.test(storedHash)) {
      // Legacy formats (upgraded to scrypt after a successful login)
      const salted = crypto.createHash('sha256').update(LEGACY_SHA_SALT + ':' + password).digest('hex');
      const raw = crypto.createHash('sha256').update(password).digest('hex');
      return timingSafeEqualStr(salted, storedHash.toLowerCase()) || timingSafeEqualStr(raw, storedHash.toLowerCase());
    }
    return false;
  }

  validateNewPassword(password, confirm) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw httpError(400, `Le mot de passe doit contenir entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères.`);
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw httpError(400, 'Le mot de passe doit contenir au moins une lettre et un chiffre.');
    }
    if (confirm !== undefined && password !== confirm) {
      throw httpError(400, 'Les deux mots de passe ne correspondent pas.');
    }
  }

  generateTemporaryPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    while (s.length < 12) {
      const b = crypto.randomBytes(1)[0];
      if (b < alphabet.length * 4) s += alphabet[b % alphabet.length];
    }
    return 'Tmp-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '7';
  }

  // ------------------------------------------------------------------ sessions
  createSession(user) {
    const now = Date.now();
    const isAdmin = user.role === 'admin';
    const exp = now + (isAdmin ? ADMIN_SESSION_MS : CUSTOMER_SESSION_MS);
    const sid = crypto.randomBytes(12).toString('hex');
    const payload = b64url(JSON.stringify({ sid, uid: user.id, ver: user.session_version || 0, iat: now, exp }));
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
    const token = payload + '.' + sig;
    return {
      token,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'client',
      createdAt: now,
      expiresAt: exp,
      mustChangePassword: Boolean(user.must_change_password)
    };
  }

  _decode(token) {
    if (!token || typeof token !== 'string' || token.length > 1000) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0]).digest('base64url');
    if (!timingSafeEqualStr(parts[1], expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (!data || !data.sid || !data.uid || !(data.exp > Date.now())) return null;
      return data;
    } catch (e) { return null; }
  }

  /** Returns { session, user } for a valid token, null otherwise. Must run inside db.read()/db.tx(). */
  verifySession(token) {
    const data = this._decode(token);
    if (!data) return null;
    const user = db.getUserById(data.uid);
    if (!user) return null;
    if ((user.session_version || 0) !== (data.ver || 0)) return null;
    if (db.isSessionRevoked(data.sid)) return null;
    if (db.isAccountSuspended(user)) return null; // suspended by an administrator: no access at all
    return {
      user,
      session: { token, sid: data.sid, userId: user.id, email: user.email, name: user.name, role: user.role, createdAt: data.iat, expiresAt: data.exp, mustChangePassword: Boolean(user.must_change_password) }
    };
  }

  /** Revokes one session (logout). Must run inside db.tx(). */
  destroySession(token) {
    const data = this._decode(token);
    if (data) db.revokeSession(data.sid, data.exp);
  }

  // ------------------------------------------------------------------ throttling
  checkRateLimit(key, max = RL_MAX) {
    const r = attempts.get(key);
    const now = Date.now();
    if (!r || now - r.first > RL_WINDOW) return { allowed: true, remaining: max };
    if (r.count >= max) return { allowed: false, remaining: 0, waitSeconds: Math.max(1, Math.ceil((r.first + RL_WINDOW - now) / 1000)) };
    return { allowed: true, remaining: max - r.count };
  }
  recordFailedLogin(key) {
    const now = Date.now();
    const r = attempts.get(key);
    if (!r || now - r.first > RL_WINDOW) attempts.set(key, { count: 1, first: now });
    else r.count++;
  }
  resetRateLimit(key) { attempts.delete(key); }
  hit(key, max, windowMs) {
    // generic limiter (registration, tickets, password reset requests)
    const now = Date.now();
    const r = attempts.get(key);
    if (!r || now - r.first > (windowMs || RL_WINDOW)) { attempts.set(key, { count: 1, first: now }); return true; }
    r.count++;
    return r.count <= max;
  }

  // ------------------------------------------------------------------ account flows (inside db.tx)
  register({ email, password, confirmPassword, name, username }) {
    if (!email || typeof email !== 'string') throw httpError(400, 'Adresse e-mail requise.');
    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(cleanEmail)) throw httpError(400, "Format d'adresse e-mail invalide.");
    let cleanUsername = null;
    if (username && typeof username === 'string' && username.trim()) {
      cleanUsername = username.trim().toLowerCase();
      if (cleanUsername.length < 3 || cleanUsername.length > 30) throw httpError(400, "Le nom d'utilisateur doit comporter entre 3 et 30 caractères.");
      if (!/^[a-z0-9_]+$/.test(cleanUsername)) throw httpError(400, "Le nom d'utilisateur ne peut contenir que des lettres, chiffres et tirets bas (_).");
      if (['admin', 'administrator', 'administrateur', 'root', 'support', 'getvirtu'].includes(cleanUsername)) throw httpError(400, "Ce nom d'utilisateur est réservé.");
    }
    this.validateNewPassword(password, confirmPassword);
    const user = db.createUser({
      email: cleanEmail,
      username: cleanUsername,
      password_hash: this.hashPassword(password),
      name: name || cleanUsername || cleanEmail.split('@')[0],
      auth_provider: 'email',
      email_verified: false
    });
    return { user: this.sanitizeUser(user), session: this.createSession(user) };
  }

  /** Step 1 of login (read-only): returns the user when the password is valid, with throttling. */
  checkCredentials({ identifier, email, password, ip }) {
    const target = String(identifier || email || '').trim().toLowerCase();
    if (!target || !password || typeof password !== 'string') throw httpError(400, "Identifiant (e-mail ou nom d'utilisateur) et mot de passe requis.");
    const key = `login:${target}:${ip || 'local'}`;
    const ipKey = `login-ip:${ip || 'local'}`;
    const rl = this.checkRateLimit(key);
    const rlIp = this.checkRateLimit(ipKey, 30);
    if (!rl.allowed || !rlIp.allowed) {
      throw httpError(429, `Trop de tentatives infructueuses. Veuillez patienter ${Math.max(rl.waitSeconds || 0, rlIp.waitSeconds || 0)} secondes.`);
    }
    const user = db.getUserByIdentifier(target);
    const ok = Boolean(user && user.password_hash && this.verifyPassword(password, user.password_hash));
    if (!ok) {
      if (!user) this.verifyPassword(password, 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128)); // constant-ish timing
      this.recordFailedLogin(key);
      this.recordFailedLogin(ipKey);
      throw httpError(401, 'Identifiant ou mot de passe incorrect.');
    }
    this.resetRateLimit(key);
    // Checked only after a correct password: the suspension is never revealed to someone guessing passwords
    if (db.isAccountSuspended(user)) throw httpError(403, 'Ce compte est suspendu. Contactez le support (WhatsApp ou formulaire de contact) pour en savoir plus.', 'ACCOUNT_SUSPENDED');
    return user;
  }

  needsRehash(user) {
    return Boolean(user && typeof user.password_hash === 'string' && !user.password_hash.startsWith('scrypt:'));
  }

  changePassword(user, { currentPassword, newPassword, confirmPassword }) {
    const rlKey = 'change_pwd:' + user.id;
    const rl = this.checkRateLimit(rlKey);
    if (!rl.allowed) throw httpError(429, `Trop de tentatives. Réessayez dans ${rl.waitSeconds} secondes.`);
    if (!user.must_change_password || currentPassword) {
      if (typeof currentPassword !== 'string' || !this.verifyPassword(currentPassword, user.password_hash)) {
        this.recordFailedLogin(rlKey);
        throw httpError(401, 'Mot de passe actuel incorrect.');
      }
    }
    this.validateNewPassword(newPassword, confirmPassword === undefined ? newPassword : confirmPassword);
    if (currentPassword && newPassword === currentPassword) throw httpError(400, "Le nouveau mot de passe doit être différent de l'actuel.");
    this.resetRateLimit(rlKey);
    db.updateUser(user.id, { password_hash: this.hashPassword(newPassword), must_change_password: false });
    db.bumpSessionVersion(user.id); // every other session is logged out
    return this.createSession(db.getUserById(user.id));
  }

  resetPasswordWithToken(token, newPassword, confirmPassword) {
    this.validateNewPassword(newPassword, confirmPassword === undefined ? newPassword : confirmPassword);
    const userId = db.consumePasswordResetToken(token);
    const user = userId ? db.getUserById(userId) : null;
    if (!user) throw httpError(400, 'Lien de réinitialisation invalide ou expiré. Faites une nouvelle demande.');
    db.updateUser(user.id, { password_hash: this.hashPassword(newPassword), must_change_password: false });
    db.bumpSessionVersion(user.id);
    return user;
  }

  /** Admin-assisted recovery: sets a one-time temporary password that must be changed at next login. */
  adminResetCustomerPassword(userId) {
    const user = db.getUserById(userId);
    if (!user) throw httpError(404, 'Utilisateur introuvable.');
    if (user.role === 'admin') throw httpError(403, "Le mot de passe d'un administrateur ne peut pas être réinitialisé ici.");
    const temp = this.generateTemporaryPassword();
    db.updateUser(user.id, { password_hash: this.hashPassword(temp), must_change_password: true });
    db.bumpSessionVersion(user.id);
    return temp;
  }

  // ------------------------------------------------------------------ Google
  /** Network part (outside any transaction): returns a verified Google profile. */
  async verifyGoogleIdentity({ credential, code, redirect_uri }) {
    let profile = null;
    if (credential) profile = await this.verifyGoogleIdToken(credential);
    else if (code) profile = await this.exchangeGoogleAuthCode(code, redirect_uri);
    else throw httpError(400, "Jeton ou code d'authentification Google manquant.");
    if (!profile || !profile.email) throw httpError(401, "Impossible de récupérer l'identité Google vérifiée.");
    return profile;
  }

  /** Database part (inside db.tx). */
  signInWithGoogleProfile(googleUser) {
    const googleEmail = String(googleUser.email).toLowerCase();
    const googleId = String(googleUser.sub || googleUser.id || '');
    if (!googleId) throw httpError(401, 'Identifiant Google manquant.');
    const name = googleUser.name || googleEmail.split('@')[0];
    const picture = typeof googleUser.picture === 'string' && googleUser.picture.startsWith('https://') ? googleUser.picture : null;

    const candidate = db.getUserByGoogleId(googleId) || db.getUserByEmail(googleEmail);
    if (candidate && candidate.role === 'admin') {
      throw httpError(403, "La connexion Google n'est pas disponible pour ce compte.");
    }
    if (candidate && db.isAccountSuspended(candidate)) {
      throw httpError(403, 'Ce compte est suspendu. Contactez le support (WhatsApp ou formulaire de contact) pour en savoir plus.', 'ACCOUNT_SUSPENDED');
    }
    let user = db.getUserByGoogleId(googleId);
    if (user) return { user: this.sanitizeUser(user), session: this.createSession(user), isNew: false, linked: false };

    const existing = db.getUserByEmail(googleEmail);
    if (existing) {
      user = db.linkGoogleAccount(existing.id, { google_id: googleId, profile_picture: picture, name });
      return { user: this.sanitizeUser(user), session: this.createSession(user), isNew: false, linked: true };
    }
    user = db.createUser({ email: googleEmail, password_hash: null, name, profile_picture: picture, google_id: googleId, auth_provider: 'google', email_verified: true });
    return { user: this.sanitizeUser(user), session: this.createSession(user), isNew: true, linked: false };
  }

  _getJson(url, headers) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: headers || {}, timeout: 8000 }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(httpError(502, 'Réponse Google illisible.')); } });
      }).on('error', () => reject(httpError(502, 'Erreur de communication avec Google.'))).on('timeout', function () { this.destroy(httpError(504, 'Google ne répond pas.')); });
    });
  }

  async verifyGoogleIdToken(idToken) {
    const data = await this._getJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (data.error || data.error_description) throw httpError(401, 'Jeton Google invalide.');
    const expected = process.env.GOOGLE_CLIENT_ID;
    if (!expected) throw httpError(503, 'Connexion Google non configurée sur le serveur.');
    if (data.aud !== expected) throw httpError(401, 'Audience du jeton Google non reconnue.');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(data.iss)) throw httpError(401, 'Émetteur du jeton Google non reconnu.');
    if (Number(data.exp) * 1000 < Date.now()) throw httpError(401, 'Jeton Google expiré.');
    if (data.email_verified !== 'true' && data.email_verified !== true) throw httpError(401, "L'adresse e-mail de ce compte Google n'est pas vérifiée.");
    return data;
  }

  exchangeGoogleAuthCode(code, customRedirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return Promise.reject(httpError(503, 'Connexion Google non configurée sur le serveur.'));
    const redirectUri = customRedirectUri || process.env.GOOGLE_REDIRECT_URI || 'postmessage';
    const postData = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString();
    return new Promise((resolve, reject) => {
      const req = https.request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 8000
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', async () => {
          try {
            const t = JSON.parse(raw);
            if (t.id_token) return resolve(await this.verifyGoogleIdToken(t.id_token));
            reject(httpError(401, "Impossible d'échanger le code Google."));
          } catch (e) { reject(e.status ? e : httpError(502, 'Réponse Google illisible.')); }
        });
      });
      req.on('error', () => reject(httpError(502, 'Erreur de communication avec Google.')));
      req.on('timeout', () => req.destroy(httpError(504, 'Google ne répond pas.')));
      req.write(postData);
      req.end();
    });
  }

  // ------------------------------------------------------------------ email (optional provider)
  async sendPasswordResetEmail(to, link) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.MAIL_FROM;
    if (!key || !from) return false;
    const body = JSON.stringify({
      from,
      to: [to],
      subject: 'GetVirtu — Réinitialisation de votre mot de passe',
      html: `<p>Bonjour,</p><p>Pour choisir un nouveau mot de passe, ouvrez ce lien (valable 30 minutes) :</p><p><a href="${link}">${link}</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`
    });
    return new Promise(resolve => {
      const req = https.request('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  sanitizeUser(user) {
    if (!user) return null;
    // Purchase-suspension fields are administrator-only information: never sent to the customer
    const { password_hash, session_version, google_id, purchasesSuspended, purchasesSuspendedAt, purchasesSuspensionUpdatedAt, purchasesSuspensionUpdatedBy,
      accountSuspended, accountSuspendedAt, accountSuspensionReason, accountSuspensionUpdatedAt, accountSuspensionUpdatedBy, ...safe } = user;
    safe.mustChangePassword = Boolean(user.must_change_password);
    safe.hasPassword = Boolean(password_hash);
    return safe;
  }
}

module.exports = new AuthService();
