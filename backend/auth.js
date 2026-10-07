/**
 * GetVirtu Production Authentication Service (backend/auth.js)
 * Implémentation complète de l'authentification Email/Mot de passe et Google OAuth 2.0.
 */

const crypto = require('crypto');
const https = require('https');
const db = require('./db');

// Variables d'environnement pour Google OAuth (aucune clé en dur dans le code)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://getvirtu.shop/api/auth/google/callback';

// Sessions actives en mémoire (avec expiration à 24h)
const activeSessions = new Map();
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

// Anti brute-force en mémoire
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes

class AuthService {
  // 1. HACHAGE DE MOT DE PASSE SÉCURISÉ (Scrypt avec sel cryptographique)
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  verifyPassword(password, storedHash) {
    if (!storedHash) return false;

    // Format Scrypt : scrypt:salt:hash
    if (storedHash.startsWith('scrypt:')) {
      const parts = storedHash.split(':');
      if (parts.length !== 3) return false;
      const salt = parts[1];
      const originalHash = parts[2];
      const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(originalHash, 'hex'));
    }

    // Compatibilité SHA-256 salé (pour l'administrateur initial et transition transparente)
    const ADMIN_SALT = 'getvirtu_sec_salt_2026';
    const computedSha = crypto.createHash('sha256').update(ADMIN_SALT + ':' + password).digest('hex');
    return computedSha === storedHash;
  }

  // 2. GESTION DES JETONS ET SESSIONS
  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
      token,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'client',
      createdAt: now,
      expiresAt: now + SESSION_DURATION_MS
    };
    activeSessions.set(token, session);
    return session;
  }

  verifySession(token) {
    if (!token) return null;
    const session = activeSessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      activeSessions.delete(token);
      return null;
    }
    const user = db.getUserById(session.userId);
    if (!user) {
      activeSessions.delete(token);
      return null;
    }
    return { session, user };
  }

  destroySession(token) {
    if (token) activeSessions.delete(token);
  }

  // 3. CONTRÔLE DU DÉBIT (ANTI BRUTE-FORCE)
  checkRateLimit(key) {
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (!record || (now - record.firstAttempt) > RATE_LIMIT_WINDOW) {
      return { allowed: true, remaining: RATE_LIMIT_MAX };
    }
    if (record.count >= RATE_LIMIT_MAX) {
      const waitSeconds = Math.ceil((record.firstAttempt + RATE_LIMIT_WINDOW - now) / 1000);
      return { allowed: false, remaining: 0, waitSeconds: Math.max(0, waitSeconds) };
    }
    return { allowed: true, remaining: RATE_LIMIT_MAX - record.count };
  }

  recordFailedLogin(key) {
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (!record || (now - record.firstAttempt) > RATE_LIMIT_WINDOW) {
      loginAttempts.set(key, { count: 1, firstAttempt: now });
    } else {
      record.count++;
    }
  }

  resetRateLimit(key) {
    loginAttempts.delete(key);
  }

  // 4. INSCRIPTION EMAIL + MOT DE PASSE
  async register({ email, password, confirmPassword, name, username }) {
    if (!email || typeof email !== 'string') {
      throw new Error('Adresse e-mail requise.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new Error('Format d\'adresse e-mail invalide.');
    }

    // Validation du nom d'utilisateur (si fourni)
    let cleanUsername = null;
    if (username && typeof username === 'string' && username.trim().length > 0) {
      cleanUsername = username.trim().toLowerCase();
      if (cleanUsername.length < 3) {
        throw new Error('Le nom d\'utilisateur doit comporter au moins 3 caractères.');
      }
      if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
        throw new Error('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres et tirets bas (_).');
      }
      const existingUserByUsername = db.getUserByUsername(cleanUsername);
      if (existingUserByUsername) {
        throw new Error('Ce nom d\'utilisateur est déjà utilisé par un autre compte.');
      }
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      throw new Error('Le mot de passe doit comporter au moins 8 caractères.');
    }

    // Exigence de production : lettres et chiffres
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new Error('Le mot de passe doit contenir au moins une lettre et un chiffre.');
    }

    if (password !== confirmPassword) {
      throw new Error('Les deux mots de passe ne correspondent pas.');
    }

    // Vérification de compte existant (Prévention des doublons)
    const existing = db.getUserByEmail(cleanEmail);
    if (existing) {
      throw new Error('Un compte est déjà associé à cette adresse e-mail. Veuillez vous connecter.');
    }

    const password_hash = this.hashPassword(password);
    const user = db.createUser({
      email: cleanEmail,
      username: cleanUsername,
      password_hash,
      name: name || cleanUsername || cleanEmail.split('@')[0],
      auth_provider: 'email',
      email_verified: false,
      role: 'client'
    });

    const session = this.createSession(user);
    return { user: this.sanitizeUser(user), session };
  }

  // 5. CONNEXION EMAIL + MOT DE PASSE (ou NOM D'UTILISATEUR)
  async login({ email, identifier, password, ip }) {
    const loginTarget = (identifier || email || '').trim().toLowerCase();
    if (!loginTarget || !password) {
      throw new Error('Identifiant (e-mail ou nom d\'utilisateur) et mot de passe requis.');
    }
    const rateLimitKey = `${loginTarget}_${ip || 'local'}`;

    const rl = this.checkRateLimit(rateLimitKey);
    if (!rl.allowed) {
      throw new Error(`Trop de tentatives infructueuses. Veuillez patienter ${rl.waitSeconds} secondes.`);
    }

    const user = db.getUserByIdentifier(loginTarget);
    if (!user || !user.password_hash) {
      this.recordFailedLogin(rateLimitKey);
      throw new Error('Identifiant ou mot de passe incorrect.');
    }

    const isValid = this.verifyPassword(password, user.password_hash);
    if (!isValid) {
      this.recordFailedLogin(rateLimitKey);
      throw new Error('Identifiant ou mot de passe incorrect.');
    }

    this.resetRateLimit(rateLimitKey);
    const session = this.createSession(user);
    return { user: this.sanitizeUser(user), session };
  }

  // 6. CONTINUER AVEC GOOGLE (GOOGLE OAUTH 2.0 / IDENTITY SERVICES)
  async continueWithGoogle({ credential, code, redirect_uri }) {
    let googleUser = null;

    if (credential) {
      // Vérification du jeton ID Google (Google Identity Services) côté serveur
      googleUser = await this.verifyGoogleIdToken(credential);
    } else if (code) {
      // Échange du code d'autorisation OAuth 2.0
      googleUser = await this.exchangeGoogleAuthCode(code, redirect_uri);
    } else {
      throw new Error('Jeton ou code d\'authentification Google manquant.');
    }

    if (!googleUser || !googleUser.email) {
      throw new Error('Impossible de récupérer l\'identité Google vérifiée.');
    }

    const googleEmail = googleUser.email.toLowerCase();
    const googleId = googleUser.sub || googleUser.id;
    const name = googleUser.name || googleEmail.split('@')[0];
    const picture = googleUser.picture || null;

    // GESTION DU LIAGE DE COMPTE (ACCOUNT LINKING)
    // 1. L'utilisateur existe-t-il déjà avec cet identifiant Google ?
    let user = db.getUserByGoogleId(googleId);

    if (user) {
      // Déjà lié -> Connexion directe
      const session = this.createSession(user);
      return { user: this.sanitizeUser(user), session, isNew: false, linked: false };
    }

    // 2. L'utilisateur a-t-il déjà créé un compte par email/mot de passe ?
    const existingByEmail = db.getUserByEmail(googleEmail);
    if (existingByEmail) {
      // LIAGE SÉCURISÉ : On associe le compte Google à l'utilisateur existant SANS créer de doublon
      user = db.linkGoogleAccount(existingByEmail.id, {
        google_id: googleId,
        profile_picture: picture,
        name: existingByEmail.name || name
      });
      const session = this.createSession(user);
      return { user: this.sanitizeUser(user), session, isNew: false, linked: true };
    }

    // 3. Nouvel utilisateur Google
    user = db.createUser({
      email: googleEmail,
      password_hash: null, // Pas de mot de passe requis pour les comptes 100% Google
      name: name,
      profile_picture: picture,
      google_id: googleId,
      auth_provider: 'google',
      email_verified: true,
      role: 'client'
    });

    const session = this.createSession(user);
    return { user: this.sanitizeUser(user), session, isNew: true, linked: false };
  }

  // Vérification de l'ID Token auprès des serveurs officiels de Google
  verifyGoogleIdToken(idToken) {
    return new Promise((resolve, reject) => {
      const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
      https.get(url, res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.error || data.error_description) {
              return reject(new Error(data.error_description || data.error || 'Jeton Google invalide.'));
            }
            const expectedClientId = process.env.GOOGLE_CLIENT_ID;
            // Vérification de l'audience si GOOGLE_CLIENT_ID est configuré
            if (expectedClientId && data.aud && data.aud !== expectedClientId) {
              return reject(new Error('Audience du jeton Google non reconnue.'));
            }
            // Vérification de l'e-mail vérifié par Google
            if (data.email_verified !== 'true' && data.email_verified !== true) {
              return reject(new Error("L'adresse e-mail associée à ce compte Google n'a pas été vérifiée par Google."));
            }
            resolve(data);
          } catch (e) {
            reject(new Error('Erreur de décodage du jeton Google: ' + e.message));
          }
        });
      }).on('error', err => {
        reject(new Error('Erreur de communication avec Google: ' + err.message));
      });
    });
  }

  // Échange du code OAuth 2.0 (flux code d'autorisation officiel)
  exchangeGoogleAuthCode(code, customRedirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    // En mode popup Google Identity Services, le redirect_uri attendu par Google est 'postmessage'
    const redirectUri = customRedirectUri || process.env.GOOGLE_REDIRECT_URI || 'postmessage';

    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET doivent être configurés sur le serveur.');
    }

    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString();

      const req = https.request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', async () => {
          try {
            const tokenRes = JSON.parse(raw);
            if (tokenRes.id_token) {
              const profile = await this.verifyGoogleIdToken(tokenRes.id_token);
              resolve(profile);
            } else if (tokenRes.access_token) {
              const profile = await this.fetchGoogleUserInfo(tokenRes.access_token);
              resolve(profile);
            } else {
              reject(new Error(tokenRes.error_description || tokenRes.error || 'Impossible d\'échanger le code Google.'));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  fetchGoogleUserInfo(accessToken) {
    return new Promise((resolve, reject) => {
      https.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.error) return reject(new Error(data.error_description || data.error));
            resolve(data);
          } catch (e) {
            reject(new Error('Erreur de décodage des données utilisateur Google.'));
          }
        });
      }).on('error', reject);
    });
  }

  sanitizeUser(user) {
    if (!user) return null;
    const { password_hash, ...safe } = user;
    return safe;
  }
}

module.exports = new AuthService();
