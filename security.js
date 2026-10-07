/**
 * GetVirtu Security Engine (security.js)
 * Module de durcissement cryptographique, protection anti-brute-force,
 * validation des fichiers binaires et gestion sécurisée des sessions.
 */

(function(window) {
  'use strict';

  var Security = {};

  // 1. HACHAGE CRYPTOGRAPHIQUE SÉCURISÉ (SHA-256 via Web Crypto API)
  Security.hashPassword = async function(password, salt) {
    if (!salt) salt = 'getvirtu_sec_salt_2026';
    var text = salt + ':' + password;
    var encoder = new TextEncoder();
    var data = encoder.encode(text);
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  };

  Security.verifyPassword = async function(password, storedHash, salt) {
    var computed = await Security.hashPassword(password, salt);
    return computed === storedHash;
  };

  // 2. GESTION SÉCURISÉE DES JETONS ET SESSIONS
  Security.generateSecureToken = function(length) {
    var len = length || 32;
    var array = new Uint8Array(len);
    crypto.getRandomValues(array);
    return Array.from(array).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  };

  Security.SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 heures de validité max

  Security.createSession = function(user, role) {
    var token = Security.generateSecureToken(32);
    var now = Date.now();
    return {
      userId: user.id || user.userId,
      role: role || user.role || 'client',
      name: user.name || 'Utilisateur',
      email: user.email || '',
      token: token,
      createdAt: now,
      expiresAt: now + Security.SESSION_DURATION_MS,
      avatarColor: user.avatarColor || '#2563eb'
    };
  };

  Security.isSessionValid = function(session) {
    if (!session || typeof session !== 'object') return false;
    if (!session.userId) return false;
    if (session.expiresAt && typeof session.expiresAt === 'number') {
      if (Date.now() > session.expiresAt) return false;
    }
    return true;
  };

  // 3. LIMITATION DE DÉBIT (RATE LIMITING ANTI BRUTE-FORCE)
  var RATE_LIMIT_PREFIX = 'gv_rl_';

  Security.checkRateLimit = function(actionKey, maxAttempts, windowMs) {
    var max = maxAttempts || 5;
    var windowTime = windowMs || (5 * 60 * 1000); // 5 minutes
    var key = RATE_LIMIT_PREFIX + actionKey;

    try {
      var raw = localStorage.getItem(key);
      var record = raw ? JSON.parse(raw) : null;
      var now = Date.now();

      if (!record || (now - record.firstAttempt) > windowTime) {
        return { allowed: true, remaining: max, waitSeconds: 0 };
      }

      if (record.count >= max) {
        var waitSec = Math.ceil((record.firstAttempt + windowTime - now) / 1000);
        return { allowed: false, remaining: 0, waitSeconds: waitSec > 0 ? waitSec : 0 };
      }

      return { allowed: true, remaining: max - record.count, waitSeconds: 0 };
    } catch (e) {
      return { allowed: true, remaining: max, waitSeconds: 0 };
    }
  };

  Security.recordFailedAttempt = function(actionKey, windowMs) {
    var windowTime = windowMs || (5 * 60 * 1000);
    var key = RATE_LIMIT_PREFIX + actionKey;
    var now = Date.now();

    try {
      var raw = localStorage.getItem(key);
      var record = raw ? JSON.parse(raw) : null;

      if (!record || (now - record.firstAttempt) > windowTime) {
        record = { count: 1, firstAttempt: now };
      } else {
        record.count++;
      }
      localStorage.setItem(key, JSON.stringify(record));
    } catch (e) {}
  };

  Security.resetRateLimit = function(actionKey) {
    try {
      localStorage.removeItem(RATE_LIMIT_PREFIX + actionKey);
    } catch (e) {}
  };

  // 4. VALIDATION BINAIRE STRICTE DES FICHIERS (SIGNATURES / MAGIC NUMBERS)
  Security.validateImageFile = function(file, maxSizeMB) {
    var maxMB = maxSizeMB || 2;
    var maxBytes = maxMB * 1024 * 1024;

    return new Promise(function(resolve) {
      if (!file) {
        return resolve({ valid: false, error: 'Aucun fichier sélectionné.' });
      }

      if (file.size > maxBytes) {
        return resolve({
          valid: false,
          error: 'Le fichier dépasse la taille maximale autorisée (' + maxMB + ' Mo).'
        });
      }

      var reader = new FileReader();
      reader.onloadend = function(e) {
        if (!e.target.result) {
          return resolve({ valid: false, error: 'Impossible de lire le fichier.' });
        }
        var arr = new Uint8Array(e.target.result).subarray(0, 8);
        var header = '';
        for (var i = 0; i < arr.length; i++) {
          header += arr[i].toString(16).padStart(2, '0');
        }

        // Vérification des Magic Numbers
        // PNG: 89504e470d0a1a0a
        var isPng = header.startsWith('89504e47');
        // JPEG / JPG: ffd8ff
        var isJpg = header.startsWith('ffd8ff');
        // WebP: 52494646 (RIFF) + WEBP
        var isWebp = header.startsWith('52494646');

        if (!isPng && !isJpg && !isWebp) {
          return resolve({
            valid: false,
            error: 'Format non autorisé. Seules les images authentiques (PNG, JPEG, WebP) sont acceptées.'
          });
        }

        return resolve({ valid: true });
      };

      reader.onerror = function() {
        resolve({ valid: false, error: 'Erreur lors de la lecture du fichier.' });
      };

      // Lecture des 16 premiers octets seulement
      reader.readAsArrayBuffer(file.slice(0, 16));
    });
  };

  // 5. PROTECTION XSS RENFORCÉE
  Security.escapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Exposer dans le namespace global
  window.Security = Security;

})(typeof window !== 'undefined' ? window : this);
