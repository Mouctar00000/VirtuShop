/**
 * GetVirtu (getvirtu.shop) - Moteur Applicatif, Gestion du Solde & Expérience Client
 */

// ========== GESTION DES ERREURS ==========
window.onerror = function(m, u, l) {
  var b = document.getElementById('err');
  if (b) {
    b.style.display = 'block';
    b.textContent = '⚠ Erreur JS : ' + m + ' (ligne ' + l + ')';
  }
  console.error(m, u, l);
};

// ========== DB (STOCKAGE LOCAL) ==========
var DB = {
  get: function(k, d) {
    try {
      var v = localStorage.getItem('vs_' + k);
      return v ? JSON.parse(v) : (d === undefined ? null : d);
    } catch (e) { return d === undefined ? null : d; }
  },
  set: function(k, v) {
    try { localStorage.setItem('vs_' + k, JSON.stringify(v)); return true; }
    catch (e) { console.error('DB.set', e); return false; }
  },
  del: function(k) {
    try { localStorage.removeItem('vs_' + k); } catch (e) {}
  }
};

// ========== ÉTAT CENTRALISÉ ET RÉACTIF D'AUTHENTIFICATION (SINGLE SOURCE OF TRUTH) ==========
var AuthState = {
  _session: null,
  _user: null,
  _subscribers: [],

  subscribe: function(fn) {
    if (typeof fn === 'function') {
      this._subscribers.push(fn);
      try { fn(this.getSession(), this.getUser()); } catch (e) { console.error(e); }
    }
  },

  notify: function() {
    var s = this.getSession();
    var u = this.getUser();
    this._subscribers.forEach(function(fn) {
      try { fn(s, u); } catch (e) { console.error('[AuthState notify]', e); }
    });
  },

  getSession: function() {
    if (!this._session) {
      // Auto-restauration de la session depuis session ou admin_session
      this._session = DB.get('session') || DB.get('admin_session');
      if (this._session && typeof Security !== 'undefined') {
        if (!Security.isSessionValid(this._session)) {
          if (this._session.userId && (!this._session.expiresAt || Date.now() < this._session.expiresAt)) {
            this._session.expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
            DB.set('session', this._session);
          } else if (this._session.expiresAt && Date.now() > this._session.expiresAt) {
            DB.del('session');
            this._session = null;
          }
        } else {
          // Rafraîchir automatiquement la persistance (sliding window 30 jours)
          this._session.expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
          DB.set('session', this._session);
        }
      }
    }
    return this._session;
  },

  getUser: function() {
    var s = this.getSession();
    if (!s || !s.userId) return null;
    var users = DB.get('users', []);
    var u = users.find(function(x) {
      return x && (x.id === s.userId || (s.email && x.email && x.email.toLowerCase() === s.email.toLowerCase()));
    });
    if (!u) {
      u = { id: s.userId, name: s.name, email: s.email, role: s.role || 'client', balance: s.balance || 0 };
    }
    this._user = u;
    return u;
  },

  isAuthenticated: function() {
    var s = this.getSession();
    return !!(s && s.userId);
  },

  setAuthenticatedSession: function(session, user, source) {
    if (!session || !session.userId) return;

    if (!session.expiresAt) {
      session.expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 jours de persistance
    }
    if (!session.token) {
      session.token = (typeof Security !== 'undefined') ? Security.generateSecureToken(32) : ('tok_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10));
    }

    this._session = session;
    DB.set('session', session);
    if (session.role === 'admin') {
      DB.set('admin_session', session);
    }

    if (user) {
      this._user = user;
      var users = DB.get('users', []);
      var idx = users.findIndex(function(u) {
        return u && (u.id === user.id || (u.email && user.email && u.email.toLowerCase() === user.email.toLowerCase()));
      });
      if (idx !== -1) {
        users[idx] = Object.assign({}, users[idx], user);
      } else {
        users.push(user);
      }
      DB.set('users', users);
    }

    console.log('[AuthState] Session établie avec succès (' + (source || 'direct') + ') pour :', session.email);

    this.notify();
    routeUserExperience();
    updateNavbar();
  },

  clearSession: function() {
    this._session = null;
    this._user = null;
    DB.del('session');
    DB.del('admin_session');
    this.notify();
    routeUserExperience();
    updateNavbar();
  }
};

var ADMIN_SALT = 'getvirtu_sec_salt_2026';
var ADMIN_HASH = '7bdd3fd0f0123548f0c15f8ca94f91b90799cbe476669fbd544784d4c3a2f1dc'; // Salted SHA-256
var ADMIN_LEGACY_HASH = 'e1ef6864bfd0e96c37fa33f3de4ceff20f93b236fc292b9e6440310d88f27902'; // Salted SHA-256

var ADMIN = {
  id: 'admin-001',
  name: 'Administrateur VirtuShop',
  email: 'admin@virtushop.com',
  passwordHash: ADMIN_HASH,
  role: 'admin'
};

// Variables d'état
var currentLandingCat = 'all';
var currentConnectedCat = 'all';
var selectedPayProd = null;
var pendingPurchaseProductId = null;
var currentPayMethodId = 'balance'; // 'balance' ou id méthode
var currentDepositMethodId = null;
var currentProofBase64 = null;
var currentDepositProofBase64 = null;
var toastTimer = null;

// Taux de conversion indicatif 1 USD = 650 FCFA
var FCFA_RATE = 650;

// Générateur d'illustrations SVG intégrées fiables à 100% (aucune dépendance réseau externe, encodage Base64 propre)
function getReliableProductSvg(category, text, color) {
  var bg1 = color === 'red' ? '#ef4444' : (color === 'blue' ? '#3b82f6' : (color === 'purple' ? '#8b5cf6' : (color === 'amber' ? '#f59e0b' : '#10b981')));
  var bg2 = color === 'red' ? '#991b1b' : (color === 'blue' ? '#1d4ed8' : (color === 'purple' ? '#6d28d9' : (color === 'amber' ? '#b45309' : '#047857')));
  var symbol = category === 'youtube' ? '▶' : (category === 'discord' ? '🎮' : '✉️');
  var safeText = (text || 'PRODUIT').replace(/</g, '').replace(/>/g, '');
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220" width="400" height="220">' +
    '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
    '<stop offset="0%" stop-color="' + bg1 + '"/><stop offset="100%" stop-color="' + bg2 + '"/>' +
    '</linearGradient></defs>' +
    '<rect width="400" height="220" fill="url(#g)"/>' +
    '<circle cx="200" cy="85" r="42" fill="#ffffff" fill-opacity="0.18"/>' +
    '<text x="200" y="100" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#ffffff">' + symbol + '</text>' +
    '<text x="200" y="165" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="#ffffff">' + safeText + '</text>' +
    '<text x="200" y="192" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="middle" fill="#fef08a">⚡ GETVIRTU VÉRIFIÉ</text>' +
    '</svg>';
  try {
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  } catch (e) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
}

// Nettoyeur et extracteur d'URL d'image fiable (supprime les balises HTML accidentelles type <img class=...>)
function sanitizeProductImage(img, fallbackCategory, fallbackName) {
  if (!img || typeof img !== 'string') {
    return getReliableProductSvg(fallbackCategory, fallbackName, 'blue');
  }
  img = img.trim();
  if (img.includes('<img')) {
    var match = img.match(/src=["']([^"']+)["']/i);
    if (match && match[1]) {
      img = match[1].trim();
    } else {
      return getReliableProductSvg(fallbackCategory, fallbackName, 'blue');
    }
  }
  img = img.replace(/^["']+|["']+$/g, '').trim();
  if (!img || img.startsWith('<') || img.length < 5) {
    return getReliableProductSvg(fallbackCategory, fallbackName, 'blue');
  }
  return escapeHtml(img);
}

// QR Code SVG Helper
function generateQrSvg(label) {
  var encoded = encodeURIComponent(label);
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="160" height="160"><rect width="200" height="200" fill="%23ffffff"/><rect x="20" y="20" width="45" height="45" fill="%230f172a"/><rect x="28" y="28" width="29" height="29" fill="%23ffffff"/><rect x="34" y="34" width="17" height="17" fill="%230f172a"/><rect x="135" y="20" width="45" height="45" fill="%230f172a"/><rect x="143" y="28" width="29" height="29" fill="%23ffffff"/><rect x="149" y="34" width="17" height="17" fill="%230f172a"/><rect x="20" y="135" width="45" height="45" fill="%230f172a"/><rect x="28" y="143" width="29" height="29" fill="%23ffffff"/><rect x="34" y="149" width="17" height="17" fill="%230f172a"/><rect x="85" y="25" width="12" height="25" fill="%230f172a"/><rect x="105" y="45" width="15" height="15" fill="%230f172a"/><rect x="85" y="85" width="30" height="30" fill="%23f59e0b"/><rect x="135" y="90" width="15" height="25" fill="%230f172a"/><rect x="30" y="90" width="20" height="15" fill="%230f172a"/><rect x="80" y="135" width="25" height="15" fill="%230f172a"/><rect x="115" y="130" width="20" height="45" fill="%230f172a"/><rect x="145" y="145" width="30" height="30" fill="%230f172a"/><text x="100" y="192" font-family="sans-serif" font-size="8" font-weight="bold" text-anchor="middle" fill="%230f172a">${encoded}</text></svg>`;
}

// ========== INITIALISATION DE LA BASE (PRODUCTION CLEANED) ==========
function initDB() {
  console.log('[Init] Démarrage GetVirtu (getvirtu.shop) - Mode Production...');

  // Nettoyage impératif et définitif de toutes les données de test antérieures
  var isCleaned = DB.get('production_cleaned_2026');
  if (!isCleaned) {
    console.log('[Production] Purge de sécurité : suppression des données de démonstration...');
    // Réinitialisation des tables à zéro pour un départ de production propre
    DB.set('products', []);
    DB.set('orders', []);
    DB.set('recharges', []);
    DB.set('vault', {});

    // Suppression des faux comptes utilisateurs de test
    var currentUsers = DB.get('users', []);
    if (Array.isArray(currentUsers)) {
      var realUsers = currentUsers.filter(function(u) {
        if (!u || !u.email) return false;
        var em = u.email.toLowerCase();
        return em !== 'alexandre.dupont@gmail.com' &&
               em !== 'sarah.bennani@gmail.com' &&
               em !== 'client@test.com' &&
               em !== 'demo@virtushop.com';
      });
      DB.set('users', realUsers);
    }
    DB.set('production_cleaned_2026', true);
  }

  if (!DB.get('products')) DB.set('products', []);
  if (!DB.get('vault')) DB.set('vault', {});
  if (!DB.get('orders')) DB.set('orders', []);
  if (!DB.get('recharges')) DB.set('recharges', []);
  if (!DB.get('min_recharge')) DB.set('min_recharge', 5);

  // Nettoyage automatique des images corrompues dans les produits existants
  var currentProds = DB.get('products', []);
  if (Array.isArray(currentProds) && currentProds.length > 0) {
    var prodsModified = false;
    currentProds.forEach(function(p) {
      if (p && typeof p.image === 'string' && (p.image.includes('<img') || p.image.includes('class=') || p.image.includes('"') || p.image.includes("'"))) {
        p.image = sanitizeProductImage(p.image, p.category, p.name);
        prodsModified = true;
      }
    });
    if (prodsModified) {
      DB.set('products', currentProds);
      console.log('[Init] Images des produits nettoyées avec succès.');
    }
  }

  // Méthodes de paiement officielles de production (SasPay Mobile Money & Trybit Crypto Automatique)
  DB.set('payment_methods', [
    {
      id: 1,
      name: "Mobile Money (Wave, Orange, MTN, Moov)",
      type: "mobile_money",
      provider: "saspay",
      network: "all",
      isBinance: false,
      address: "Passerelle SasPay Officielle",
      instructions: "Paiement direct sécurisé : validation automatique par Wave, Orange Money ou notification USSD push instantanée sur votre smartphone.",
      enabled: true
    },
    {
      id: 2,
      name: "Crypto Instantané (Trybit - USDT, BTC, ETH, SOL...)",
      type: "crypto_trybit",
      provider: "trybit",
      network: "multi",
      isBinance: false,
      address: "Passerelle Trybit Officielle",
      instructions: "Paiement crypto automatisé instantané avec génération d'adresse et validation blockchain automatique en temps réel.",
      enabled: true
    }
  ]);

  // Admin par défaut VirtuShop
  var users = DB.get('users', []);
  if (!Array.isArray(users)) users = [];
  var existingAdmin = users.find(function(u) { return u && (u.role === 'admin' || (u.email && u.email.toLowerCase() === 'admin@virtushop.com')); });
  if (!existingAdmin) {
    users.push({
      id: ADMIN.id,
      name: ADMIN.name,
      email: ADMIN.email,
      passwordHash: ADMIN_HASH,
      role: 'admin',
      balance: 0.00,
      createdAt: new Date().toISOString()
    });
    DB.set('users', users);
  } else {
    existingAdmin.email = ADMIN.email;
    existingAdmin.name = ADMIN.name;
    existingAdmin.passwordHash = ADMIN_HASH;
    existingAdmin.role = 'admin';
    DB.set('users', users);
  }
}

function getMinRecharge() {
  var v = DB.get('min_recharge', 5);
  return typeof v === 'number' && v > 0 ? v : 5;
}

// ========== GESTION DU SOLDE CLIENT ==========
function getCurrentUser() {
  return AuthState.getUser();
}

function getUserBalance() {
  var u = AuthState.getUser();
  return u && typeof u.balance === 'number' ? u.balance : 0;
}

function updateUserBalance(newBalance) {
  var s = AuthState.getSession();
  if (!s || !s.userId) return false;
  var safeBalance = Math.max(0, Math.round(newBalance * 100) / 100);

  // 1. Mettre à jour dans la liste des utilisateurs du DB local
  var users = DB.get('users', []);
  var u = users.find(function(x) {
    return x && (String(x.id) === String(s.userId) || (s.email && x.email && x.email.toLowerCase() === s.email.toLowerCase()));
  });
  if (u) {
    u.balance = safeBalance;
  } else {
    // Si l'utilisateur n'existait pas encore dans vs_users, l'ajouter
    users.push({
      id: s.userId,
      name: s.name,
      email: s.email,
      role: s.role || 'client',
      balance: safeBalance
    });
  }
  DB.set('users', users);

  // 2. Mettre à jour l'objet session actif
  s.balance = safeBalance;
  DB.set('session', s);

  // 3. Mettre à jour AuthState._user
  if (AuthState._user) {
    AuthState._user.balance = safeBalance;
  }

  // 4. Mettre à jour l'affichage en direct sans rechargement
  try {
    AuthState.notify();
    updateNavbar();
    if (typeof renderLandingCatalog === 'function') renderLandingCatalog();
    if (typeof renderConnectedCatalog === 'function') renderConnectedCatalog();
  } catch (e) {}

  return true;
}

// Synchronisation du solde et de la session en direct avec le serveur
async function syncUserSessionAndBalance() {
  var s = AuthState.getSession();
  if (!s || !s.userId) return;
  try {
    var token = s.token || '';
    var res = await fetch('/api/auth/me', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (res.ok) {
      var data = await res.json();
      if (data && data.user) {
        AuthState.setAuthenticatedSession(data.session || s, data.user, 'server_sync');
      }
    } else if (res.status === 401) {
      console.warn('[Auth] Session révoquée côté serveur.');
      AuthState.clearSession();
    }
  } catch (e) {}
}

// Formatage FCFA
function formatFcfa(usdAmount) {
  return Math.round(usdAmount * FCFA_RATE).toLocaleString('fr-FR') + ' FCFA';
}

// ========== ROUTAGE & PARCOURS UTILISATEUR ==========
function routeUserExperience() {
  var session = AuthState.getSession();
  var isAuth = !!(session && session.userId);

  var landingView = document.getElementById('landing-view');
  var connectedView = document.getElementById('connected-view');
  var navPublic = document.getElementById('nav-public-links');
  var navConnected = document.getElementById('nav-connected-links');

  // Synchronisation immédiate des liens de navigation principale
  if (navPublic && navConnected) {
    if (isAuth) {
      navPublic.classList.add('hidden');
      navConnected.classList.remove('hidden');
    } else {
      navPublic.classList.remove('hidden');
      navConnected.classList.add('hidden');
    }
  }

  // Toujours rendre les composants du catalogue
  renderLandingShowcase();
  renderLandingCategories();
  renderLandingCatalog();

  if (isAuth) {
    var nameEl = document.getElementById('connected-user-name');
    if (nameEl) nameEl.textContent = session.name || 'Client';

    renderConnectedCatalog();
    renderConnectedCategories();

    // Expérience directe : après connexion, afficher directement le catalogue des produits
    if (landingView) landingView.classList.add('hidden');
    if (connectedView) connectedView.classList.remove('hidden');
  } else {
    // Mode visiteur
    if (landingView) landingView.classList.remove('hidden');
    if (connectedView) connectedView.classList.add('hidden');
  }

  updateNavbar();
  renderFooterBadges();
}

function showConnectedCatalog() {
  var s = AuthState.getSession();
  if (!s || !s.userId) { openAuthModal('login'); return; }
  routeUserExperience();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showPublicLanding() {
  document.getElementById('landing-view').classList.remove('hidden');
  document.getElementById('connected-view').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleLogoClick() {
  var s = AuthState.getSession();
  if (s && s.userId) showConnectedCatalog();
  else showPublicLanding();
}

// ========== BARRE DE NAVIGATION (SOLDE + PROFIL) ==========
function updateNavbar() {
  var session = AuthState.getSession();
  var isAuth = !!(session && session.userId);
  var container = document.getElementById('nav-user-actions');
  var navPublic = document.getElementById('nav-public-links');
  var navConnected = document.getElementById('nav-connected-links');
  if (!container) return;

  // Garantir la cohérence des liens de navigation
  if (navPublic && navConnected) {
    if (isAuth) {
      navPublic.classList.add('hidden');
      navConnected.classList.remove('hidden');
    } else {
      navPublic.classList.remove('hidden');
      navConnected.classList.add('hidden');
    }
  }

  if (isAuth) {
    var bal = getUserBalance();
    var isAdmin = session && (session.role === 'admin' || (DB.get('admin_session') && DB.get('admin_session').role === 'admin'));

    container.innerHTML = `
      <!-- Bouton Bascule Espace Admin (Prompt 9) -->
      ${isAdmin ? `
        <button type="button" class="btn-secondary btn-sm btn-admin-toggle-btn btn-light-sweep" onclick="switchToAdmin()" title="Basculer vers le tableau de bord administrateur" style="color: #1d4ed8; font-weight: 700; background: #eff6ff; border: 1px solid #bfdbfe; margin-right: 4px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 4px 10px; border-radius: 6px;">
          <span>⚡</span>
          <span>Espace Admin</span>
        </button>
      ` : ''}

      <!-- Capsule Solde avec bouton + -->
      <div class="balance-pill" title="Votre solde disponible">
        <span class="balance-label">Solde :</span>
        <strong class="balance-amount">$${bal.toFixed(2)}</strong>
        <button type="button" class="btn-add-balance" title="Recharger mon solde (+)" onclick="openDepositModal()">+</button>
      </div>

      <!-- Un seul bouton Mes commandes dans l'en-tête, positionné à côté du solde -->
      <button type="button" class="btn-secondary btn-sm nav-orders-btn" onclick="openOrdersModal()">
        <span>📦</span>
        <span>Mes commandes</span>
      </button>

      <!-- Profil Utilisateur & Menu Déroulant (Sans Scrollbar, Pleine Hauteur) -->
      <div class="user-profile-wrapper">
        <button type="button" class="btn-user-profile" onclick="toggleUserDropdown(event)" aria-label="Menu profil">
          <span class="user-avatar-circle">${escapeHtml(session.name.charAt(0).toUpperCase())}</span>
          <span>${escapeHtml(session.name)}</span>
          <span style="font-size: 10px; color: var(--text-muted);">▾</span>
        </button>

        <div class="user-dropdown-menu" id="user-dropdown">
          <div class="dropdown-user-header">
            <div style="font-weight: 700; font-size: 13px;">${escapeHtml(session.name)}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(session.email)}</div>
            <div style="font-size: 11px; color: var(--primary-600); margin-top: 4px; font-weight: 700;">Solde : $${bal.toFixed(2)}</div>
          </div>
          ${isAdmin ? `
            <a href="javascript:void(0)" class="dropdown-item" onclick="switchToAdmin(); toggleUserDropdown();" style="color: #1d4ed8; font-weight: 700;">
              <span>⚡</span> Tableau de bord Admin
            </a>
          ` : ''}
          <a href="javascript:void(0)" class="dropdown-item" onclick="openDepositModal(); toggleUserDropdown();">
            <span>💳</span> Recharger mon solde
          </a>
          <a href="javascript:void(0)" class="dropdown-item" onclick="openOrdersModal(); toggleUserDropdown();">
            <span>📦</span> Mes Commandes
          </a>
          <div style="border-top: 1px solid var(--border-subtle); margin: 4px 0;"></div>
          <a href="javascript:void(0)" class="dropdown-item danger" onclick="handleLogout(); toggleUserDropdown();">
            <span>🚪</span> Déconnexion
          </a>
        </div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <button type="button" class="btn-secondary btn-sm btn-nav-auth btn-nav-login" onclick="openAuthModal('login')">Connexion</button>
      <button type="button" class="btn-primary btn-sm btn-nav-auth btn-nav-register" onclick="openAuthModal('register')"><span>S'inscrire</span><span class="auth-bolt-icon"> ⚡</span></button>
    `;
  }
}

function toggleUserDropdown(event) {
  if (event) event.stopPropagation();
  var menu = document.getElementById('user-dropdown');
  if (menu) menu.classList.toggle('active');
}

// Fermer le dropdown si clic extérieur
document.addEventListener('click', function(e) {
  var wrapper = document.querySelector('.user-profile-wrapper');
  var menu = document.getElementById('user-dropdown');
  if (menu && menu.classList.contains('active')) {
    if (!wrapper || !wrapper.contains(e.target)) {
      menu.classList.remove('active');
    }
  }
});

// ========== CATALOGUE VISITEUR & ARTICLES EN VEDETTE ==========
function renderLandingShowcase() {
  var container = document.getElementById('hero-featured-items');
  if (!container) return;

  var prods = DB.get('products', []).filter(function(p) { return p.published; });
  var topProds = prods.slice(0, 3);

  if (topProds.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 28px 16px; color: var(--text-muted);">
        <div style="font-size: 26px; margin-bottom: 6px;">📦</div>
        <div style="font-size: 13.5px; font-weight: 700; color: var(--text-primary);">Catalogue en réapprovisionnement</div>
        <div style="font-size: 11.5px; margin-top: 4px; color: var(--text-secondary);">De nouveaux comptes et services vérifiés seront bientôt disponibles.</div>
      </div>
    `;
    return;
  }

  var html = '';
  topProds.forEach(function(p) {
    var oos = p.stock <= 0;
    var safeImg = sanitizeProductImage(p.image, p.category, p.name);
    html += `
      <div class="showcase-item">
        <div class="showcase-item-info">
          <img src="${safeImg}" class="showcase-thumb" alt="${escapeHtml(p.name)}">
          <div style="min-width: 0; flex: 1; overflow: hidden;">
            <h4 class="showcase-title">${escapeHtml(p.name)}</h4>
            <span class="showcase-stock-badge ${oos ? 'oos' : ''}">${oos ? '● Rupture' : '● ' + p.stock + ' en stock'}</span>
          </div>
        </div>
        <div class="showcase-pricing-action">
          <div class="showcase-price-box">
            <span class="showcase-price-val">$${p.price.toFixed(2)}</span>
          </div>
          <button type="button" class="btn-primary btn-sm showcase-buy-btn btn-light-sweep" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${p.id})">
            ${oos ? 'Rupture' : 'Acheter ⚡'}
          </button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

function renderLandingCategories() {
  var container = document.getElementById('landing-cats-filters');
  if (!container) return;
  var prods = DB.get('products', []).filter(function(p) { return p.published; });
  var cats = ['all'];
  prods.forEach(function(p) { if (p.category && cats.indexOf(p.category) === -1) cats.push(p.category); });

  var html = '';
  cats.forEach(function(cat) {
    var label = cat === 'all' ? 'Tous les produits' : cat.toUpperCase();
    var activeClass = cat === currentLandingCat ? ' active' : '';
    html += `<button type="button" class="cat-pill${activeClass}" onclick="setLandingCat('${cat}')">${label}</button>`;
  });
  container.innerHTML = html;
}

function setLandingCat(cat) {
  currentLandingCat = cat;
  renderLandingCategories();
  renderLandingCatalog();
}

function handleLandingSearch() { renderLandingCatalog(); }

function renderLandingCatalog() {
  var container = document.getElementById('landing-products-grid');
  if (!container) return;
  var q = (document.getElementById('landing-search')?.value || '').trim().toLowerCase();
  var prods = DB.get('products', []).filter(function(p) { return p.published; });

  if (currentLandingCat !== 'all') prods = prods.filter(function(p) { return p.category === currentLandingCat; });
  if (q) prods = prods.filter(function(p) { return p.name.toLowerCase().indexOf(q) !== -1 || (p.description && p.description.toLowerCase().indexOf(q) !== -1); });

  renderProductCardsInto(container, prods);
}

function renderConnectedCategories() {
  var container = document.getElementById('connected-cats-filters');
  if (!container) return;
  var prods = DB.get('products', []).filter(function(p) { return p.published; });
  var cats = ['all'];
  prods.forEach(function(p) { if (p.category && cats.indexOf(p.category) === -1) cats.push(p.category); });

  var html = '';
  cats.forEach(function(cat) {
    var label = cat === 'all' ? 'Tous les produits' : cat.toUpperCase();
    var activeClass = cat === currentConnectedCat ? ' active' : '';
    html += `<button type="button" class="cat-pill${activeClass}" onclick="setConnectedCat('${cat}')">${label}</button>`;
  });
  container.innerHTML = html;
}

function setConnectedCat(cat) {
  currentConnectedCat = cat;
  renderConnectedCategories();
  renderConnectedCatalog();
}

function handleConnectedSearch() { renderConnectedCatalog(); }

function renderConnectedCatalog() {
  var container = document.getElementById('connected-products-grid');
  if (!container) return;
  var q = (document.getElementById('connected-search')?.value || '').trim().toLowerCase();
  var prods = DB.get('products', []).filter(function(p) { return p.published; });

  if (currentConnectedCat !== 'all') prods = prods.filter(function(p) { return p.category === currentConnectedCat; });
  if (q) prods = prods.filter(function(p) { return p.name.toLowerCase().indexOf(q) !== -1 || (p.description && p.description.toLowerCase().indexOf(q) !== -1); });

  renderProductCardsInto(container, prods);
}

// Rendu des cartes produits (avec image propre par produit et fallback sécurisé)
function renderProductCardsInto(container, prods) {
  if (prods.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px 20px; color: var(--text-muted); background: #ffffff; border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle); box-shadow: var(--shadow-sm);">
        <div style="font-size: 38px; margin-bottom: 12px;">📦</div>
        <h3 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">Catalogue en cours de réapprovisionnement</h3>
        <p style="font-size: 13px; max-width: 480px; margin: 0 auto; line-height: 1.5; color: var(--text-secondary);">Nos équipes préparent et contrôlent les prochains stocks de comptes vérifiés et services digitaux. Revenez très prochainement !</p>
      </div>
    `;
    return;
  }

  var html = '';
  prods.forEach(function(prod) {
    var oos = prod.stock <= 0;
    var safeImg = sanitizeProductImage(prod.image, prod.category, prod.name);

    html += `
      <div class="product-card${oos ? ' oos' : ''}">
        <div class="product-image-box">
          <img src="${safeImg}" class="product-img" alt="${escapeHtml(prod.name)}">
          <div class="product-badge-overlay">⚡ Vérifié</div>
        </div>

        <div class="product-body">
          <span class="product-category-label">${escapeHtml(prod.category)}</span>
          <h3 class="product-name">${escapeHtml(prod.name)}</h3>
          <p class="product-desc">${escapeHtml(prod.description || 'Service numérique vérifié.')}</p>

          <div class="product-card-footer">
            <div class="product-meta">
              <span class="stock-tag${oos ? ' oos' : ''}">${oos ? '● Rupture' : '● ' + prod.stock + ' en stock'}</span>
              <span class="product-price">$${prod.price.toFixed(2)}</span>
            </div>
            <button type="button" class="btn-buy-product${oos ? ' btn-buy-disabled' : ''} btn-light-sweep" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${prod.id})">
              ${oos ? 'Rupture de Stock' : 'Acheter ⚡'}
            </button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ========== TUNNEL D'ACHAT (SOLDE, CRYPTO, MOBILE MONEY) ==========
function startProductPurchase(prodId) {
  var prods = DB.get('products', []);
  var prod = prods.find(function(p) { return p.id === prodId; });

  if (!prod || prod.stock <= 0) {
    showToast('Ce produit est actuellement en rupture de stock.', 'error');
    return;
  }

  var session = DB.get('session');
  if (!session || !session.userId) {
    pendingPurchaseProductId = prod.id;
    openAuthModal('login', 'Veuillez vous connecter pour acheter : ' + prod.name);
    return;
  }

  openPaymentModal(prod);
}

var currentPurchaseQty = 1;

function openPaymentModal(prod) {
  selectedPayProd = prod;
  currentPurchaseQty = 1;

  var session = DB.get('session');
  if (!session || !session.userId) {
    pendingPurchaseProductId = prod.id;
    openAuthModal('login', 'Veuillez vous connecter ou vous inscrire pour acheter : ' + prod.name);
    return;
  }

  renderPurchaseModal();
  document.getElementById('modal-pay').classList.add('active');
}

function closePayModal() {
  document.getElementById('modal-pay').classList.remove('active');
  selectedPayProd = null;
  currentPurchaseQty = 1;
}

function changePurchaseQty(delta) {
  if (!selectedPayProd) return;
  var stock = Math.max(1, selectedPayProd.stock || 1);
  currentPurchaseQty = Math.max(1, Math.min(stock, currentPurchaseQty + delta));
  renderPurchaseModal();
}

var currentPurchasePayMethod = 'balance'; // 'balance', 'mobile_money', 'crypto'
var orderTrybitPollingTimer = null;
var orderMomoPollingTimer = null;

function selectPurchasePayMethod(m) {
  currentPurchasePayMethod = m;
  renderPurchaseModal();
}

// ========== COMPOSANT FINTECH : SÉLECTEUR DE CRYPTO EN CARTES MODERNES ==========
var TRYBIT_SUPPORTED_CRYPTOS = [
  { id: '', name: 'Choix multi-crypto automatique', sub: 'USDT, BTC, ETH, SOL, LTC, TON...', icon: '🌐', badge: '' },
  { id: 'USDT_TRC20', name: 'USDT (Tron TRC20)', sub: 'Réseau TRON • Rapide & Frais minimes', icon: '🟢', badge: 'Recommandé' },
  { id: 'USDT_BSC', name: 'USDT (BNB Smart Chain)', sub: 'BEP20 Network', icon: '🟡', badge: '' },
  { id: 'USDT_SOL', name: 'USDT (Solana)', sub: 'Solana SPL Token', icon: '🟣', badge: '' },
  { id: 'BTC', name: 'Bitcoin (BTC)', sub: 'Blockchain Bitcoin', icon: '₿', badge: '' },
  { id: 'ETH', name: 'Ethereum (ETH)', sub: 'Réseau Ethereum ERC20', icon: '🔷', badge: '' },
  { id: 'SOL', name: 'Solana (SOL)', sub: 'Réseau Solana SPL', icon: '⚡', badge: '' },
  { id: 'LTC', name: 'Litecoin (LTC)', sub: 'Réseau Litecoin', icon: '🪙', badge: '' },
  { id: 'TON', name: 'The Open Network (TON)', sub: 'Réseau Telegram TON', icon: '💎', badge: '' }
];

function renderCryptoCardsHtml(containerId, inputId, selectedId, isCompact) {
  selectedId = selectedId || '';
  var compactClass = isCompact ? 'compact-crypto-list' : '';
  return `
    <div class="crypto-cards-container ${compactClass}" id="${containerId}">
      ${TRYBIT_SUPPORTED_CRYPTOS.map(function(c) {
        var isSel = (c.id === selectedId);
        return `
          <div class="crypto-card-item ${isSel ? 'active' : ''}" data-crypto-id="${c.id}" onclick="selectTrybitCrypto('${c.id}', '${containerId}', '${inputId}')">
            <div class="crypto-card-left">
              <div class="crypto-card-icon">${c.icon}</div>
              <div class="crypto-card-text">
                <div class="crypto-card-name-row">
                  <span class="crypto-card-name">${escapeHtml(c.name)}</span>
                  ${c.badge ? `<span class="crypto-card-badge">${escapeHtml(c.badge)}</span>` : ''}
                </div>
                <span class="crypto-card-sub">${escapeHtml(c.sub)}</span>
              </div>
            </div>
            <div class="crypto-card-indicator">
              <span class="crypto-card-radio-circle"></span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <input type="hidden" id="${inputId}" value="${selectedId}">
  `;
}

window.selectTrybitCrypto = function(cryptoId, containerId, inputId) {
  var input = document.getElementById(inputId);
  if (input) input.value = cryptoId;
  var container = document.getElementById(containerId);
  if (container) {
    var items = container.querySelectorAll('.crypto-card-item');
    items.forEach(function(item) {
      if (item.getAttribute('data-crypto-id') === cryptoId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }
};

// Récupération stricte de l'email client connecté (l'email admin ne doit JAMAIS être retourné)
function getActiveCustomerEmail() {
  var s = AuthState.getSession();
  var u = AuthState.getUser();
  if (!s || !u) return '';
  if (s.role === 'admin' || u.role === 'admin') return '';
  var em = (u.email || '').trim();
  var low = em.toLowerCase();
  if (!em.includes('@') || low.includes('admin@virtushop.com') || low.includes('admin@getvirtu.shop') || low.startsWith('admin@')) {
    return '';
  }
  return em;
}

function renderPurchaseModal() {
  var container = document.getElementById('pay-dynamic-content');
  if (!container || !selectedPayProd) return;

  var u = getCurrentUser();
  var defaultContact = getActiveCustomerEmail();
  var userBal = getUserBalance();
  var stock = selectedPayProd.stock || 0;
  var unitPrice = selectedPayProd.price;

  // Calcul automatique du total selon la quantité choisie (1, 2, 3, etc.)
  var total = unitPrice * currentPurchaseQty;
  var hasEnough = userBal >= total;
  var diff = (total - userBal).toFixed(2);

  var country = getSelectedMomoCountry();
  var momoAmountLocal = Math.round(total * country.rate);

  var countryOptionsHtml = MOMO_COUNTRIES.map(function(c) {
    return `<option value="${c.code}" ${c.code === selectedMomoCountry ? 'selected' : ''}>${c.name}</option>`;
  }).join('');

  var networksHtml = country.networks.map(function(net) {
    var isActive = net.id === selectedMomoNetwork ? 'active' : '';
    return `
      <div class="momo-network-btn ${isActive}" data-net="${net.id}" onclick="onSelectPurchaseMomoNetwork('${net.id}')">
        <span class="momo-network-icon">${net.icon}</span>
        <span class="momo-network-title">${escapeHtml(net.name)}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="purchase-modal-header-compact">
      <h2 class="modal-title purchase-modal-title-compact">Acheter le Produit</h2>
      <p class="purchase-delivery-notice-line">Livraison numérique immédiate après confirmation du paiement.</p>
    </div>

    <!-- 1. Grille compacte côte à côte : Produit (gauche) & Solde disponible (droite) -->
    <div class="purchase-top-grid">
      <div class="purchase-prod-box">
        <img src="${sanitizeProductImage(selectedPayProd.image, selectedPayProd.category, selectedPayProd.name)}" class="purchase-prod-thumb-compact" alt="${escapeHtml(selectedPayProd.name)}">
        <div class="purchase-prod-info-compact">
          <span class="purchase-prod-cat-compact">${escapeHtml(selectedPayProd.category)}</span>
          <h3 class="purchase-prod-title-compact" title="${escapeHtml(selectedPayProd.name)}">${escapeHtml(selectedPayProd.name)}</h3>
          <div class="purchase-unit-price-compact">
            Prix unitaire : <strong>$${unitPrice.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      <div class="purchase-balance-box">
        <span class="purchase-balance-label">Votre solde disponible</span>
        <strong class="purchase-balance-value">$${userBal.toFixed(2)}</strong>
      </div>
    </div>

    <!-- 2. Sélecteur de quantité compact -->
    <div class="purchase-qty-card-compact">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <label style="font-weight: 700; font-size: 12px; color: var(--text-primary); margin: 0;">Quantité à acheter</label>
          <span style="font-size: 11px; color: ${stock > 0 ? 'var(--emerald-600)' : 'var(--rose-600)'}; font-weight: 600; display: block;">
            ${stock > 0 ? '● ' + stock + ' unités disponibles' : '● Rupture'}
          </span>
        </div>
        <div class="qty-stepper">
          <button type="button" class="btn-qty-step" onclick="changePurchaseQty(-1)" ${currentPurchaseQty <= 1 ? 'disabled' : ''} title="Diminuer">&minus;</button>
          <span class="qty-display-value">${currentPurchaseQty}</span>
          <button type="button" class="btn-qty-step" onclick="changePurchaseQty(1)" ${currentPurchaseQty >= stock ? 'disabled' : ''} title="Augmenter">&plus;</button>
        </div>
      </div>
    </div>

    <!-- 3. Calcul automatique du montant total compact -->
    <div class="purchase-calc-box-compact">
      <div class="calc-row-compact">
        <span>Calcul du total :</span>
        <span>$${unitPrice.toFixed(2)} &times; ${currentPurchaseQty}</span>
      </div>
      <div class="calc-row-compact total-row">
        <span>Total à régler :</span>
        <span class="total-amount-compact">$${total.toFixed(2)}</span>
      </div>
    </div>

    <!-- 4. Choix du mode de paiement -->
    <div style="margin-bottom: 6px;">
      <label style="font-weight: 700; font-size: 11.5px; color: var(--text-primary); margin-bottom: 4px; display: block;">Moyen de règlement :</label>
      <div class="purchase-method-tabs-compact">
        <button type="button" class="btn-purchase-tab purchase-method-tab-compact ${currentPurchasePayMethod === 'balance' ? 'active' : ''}" onclick="selectPurchasePayMethod('balance')">
          💳 Solde ($${userBal.toFixed(2)})
        </button>
        <button type="button" class="btn-purchase-tab purchase-method-tab-compact ${currentPurchasePayMethod === 'mobile_money' ? 'active' : ''}" onclick="selectPurchasePayMethod('mobile_money')">
          📱 Mobile Money
        </button>
        <button type="button" class="btn-purchase-tab purchase-method-tab-compact ${currentPurchasePayMethod === 'crypto' ? 'active' : ''}" onclick="selectPurchasePayMethod('crypto')">
          ⚡ Crypto
        </button>
      </div>
    </div>

    <!-- 5. Panneau selon la méthode choisie -->
    ${currentPurchasePayMethod === 'balance' ? `
      <div style="margin-bottom: 6px;">
        ${hasEnough ? `
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 6px 10px; font-size: 11.5px; color: var(--emerald-600); display: flex; align-items: center; justify-content: space-between;">
            <span>✓ Solde suffisant ($${total.toFixed(2)})</span>
            <span>Reste après paiement : <strong>$${(userBal - total).toFixed(2)}</strong></span>
          </div>
        ` : `
          <div class="insufficient-balance-alert-centered">
            <span class="insufficient-balance-text">⚠️ Solde insuffisant (Il vous manque $${diff})</span>
            <button type="button" class="btn-quick-recharge-centered btn-light-sweep" onclick="promptDepositFromPurchase(${Math.max(5, Math.ceil(parseFloat(diff)))})">
              <span>Recharger ⚡</span>
            </button>
          </div>
        `}
      </div>

      <div class="optional-contact-box-compact">
        <label for="purchase-contact-input" class="optional-contact-label-oneline">
          <span>📱 Email ou WhatsApp de confirmation (Optionnel)</span>
        </label>
        <input type="text" id="purchase-contact-input" class="optional-contact-input-compact" value="${escapeHtml(defaultContact)}" placeholder="Ex: mon.email@domaine.com ou +33 6 12 34 56 78">
      </div>

      ${hasEnough ? `
        <button type="button" class="btn-recharge-bottom-compact btn-purchase-action-single-line btn-light-sweep" onclick="processProductPayment()">
          <span>Payer maintenant ($${total.toFixed(2)}) ⚡</span>
        </button>
      ` : `
        <button type="button" class="btn-recharge-bottom-compact btn-purchase-action-single-line btn-light-sweep" onclick="promptDepositFromPurchase(${Math.max(5, Math.ceil(parseFloat(diff)))})">
          <span>Recharger mon solde ⚡</span>
        </button>
      `}
    ` : ''}

    ${currentPurchasePayMethod === 'mobile_money' ? `
      <div class="purchase-method-panel-compact">
        <div style="margin-bottom: 5px;">
          <label style="font-size: 11px; font-weight: 700; margin-bottom: 2px; display: block;">Pays :</label>
          <select id="purchase-momo-country" onchange="onPurchaseMomoCountryChange(this.value)" style="width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border-subtle); font-size: 12px; height: 30px;">
            ${countryOptionsHtml}
          </select>
        </div>
        <div style="margin-bottom: 5px;">
          <label style="font-size: 11px; font-weight: 700; display: block; margin-bottom: 2px;">Réseau Mobile Money :</label>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 4px;">
            ${networksHtml}
          </div>
        </div>
        <div class="field" style="margin-bottom: 5px;">
          <label for="purchase-momo-phone" style="font-size: 11px; font-weight: 700;">Numéro de téléphone Mobile Money :</label>
          <input type="tel" id="purchase-momo-phone" placeholder="Ex: 0700000000" style="width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border-subtle); font-size: 12px; height: 30px;">
          <span style="font-size: 10px; color: var(--text-muted); display: block; margin-top: 1px;">Montant estimé : ~${momoAmountLocal.toLocaleString('fr-FR')} ${country.currency}</span>
        </div>
        <div class="optional-contact-box-compact" style="margin-bottom: 0;">
          <label for="purchase-contact-input" class="optional-contact-label-oneline">
            <span>📱 Email ou WhatsApp de confirmation (Optionnel)</span>
          </label>
          <input type="text" id="purchase-contact-input" class="optional-contact-input-compact" value="${escapeHtml(defaultContact)}" placeholder="Ex: mon.email@domaine.com ou +33 6 12 34 56 78">
        </div>
      </div>
      <button type="button" class="btn-pay-now btn-purchase-action-single-line btn-light-sweep" onclick="startPurchaseMomoPayment(${total}, ${currentPurchaseQty})">
        <span>Payer $${total.toFixed(2)} avec Mobile Money ⚡</span>
      </button>
    ` : ''}

    ${currentPurchasePayMethod === 'crypto' ? `
      <div class="purchase-method-panel-compact">
        <div style="margin-bottom: 5px;">
          <label style="font-size: 11px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; display: block;">Sélectionnez votre devise crypto :</label>
          ${renderCryptoCardsHtml('purchase-crypto-cards-grid', 'purchase-crypto-select', '', true)}
        </div>
        <div class="optional-contact-box-compact" style="margin-bottom: 0;">
          <label for="purchase-contact-input" class="optional-contact-label-oneline">
            <span>📱 Email ou WhatsApp de confirmation (Optionnel)</span>
          </label>
          <input type="text" id="purchase-contact-input" class="optional-contact-input-compact" value="${escapeHtml(defaultContact)}" placeholder="Ex: mon.email@domaine.com ou +33 6 12 34 56 78">
        </div>
      </div>
      <button type="button" class="btn-pay-now btn-purchase-action-single-line btn-light-sweep" onclick="startPurchaseTrybitPayment(${total}, ${currentPurchaseQty})">
        <span>Payer $${total.toFixed(2)} en Crypto ⚡</span>
      </button>
    ` : ''}
  `;
}

function onPurchaseMomoCountryChange(code) {
  selectedMomoCountry = code;
  var c = getSelectedMomoCountry();
  if (c && c.networks && c.networks.length > 0) {
    selectedMomoNetwork = c.networks[0].id;
  }
  renderPurchaseModal();
}

function onSelectPurchaseMomoNetwork(netId) {
  selectedMomoNetwork = netId;
  var btns = document.querySelectorAll('.momo-network-btn');
  btns.forEach(function(b) {
    if (b.getAttribute('data-net') === netId) b.classList.add('active');
    else b.classList.remove('active');
  });
}

function promptDepositFromPurchase(suggestedAmount) {
  closePayModal();
  openDepositModal(suggestedAmount);
}

// LIVRAISON IMMÉDIATE DU PRODUIT NUMÉRIQUE ACHETÉ AVEC CLÉ UNIQUE
function deliverCompletedOrder(prod, total, qty, contactVal, paymentMethodName, remainingBal) {
  var u = getCurrentUser();
  if (!u || !prod) return;

  // 1. Récupérer le coffre-fort associé au produit et délivrer une clé strictement unique
  var vaultMap = DB.get('vault', {});
  var prodVault = vaultMap[prod.id] || {};
  var deliveredContent = null;

  if (prodVault.keys && Array.isArray(prodVault.keys) && prodVault.keys.length > 0) {
    // Sélectionner la première clé strictement non vendue
    var unusedKey = prodVault.keys.find(function(k) { return !k.used; });
    if (unusedKey) {
      unusedKey.used = true;
      unusedKey.soldTo = u.email || u.name || 'Client #' + u.id;
      unusedKey.soldAt = new Date().toISOString();
      deliveredContent = {
        type: prodVault.type || 'text',
        content: unusedKey.content,
        fileName: prodVault.fileName || 'licence.txt'
      };
      DB.set('vault', vaultMap);
    }
  } else if (prodVault.content) {
    deliveredContent = {
      type: prodVault.type || 'text',
      content: prodVault.content,
      fileName: prodVault.fileName || 'licence.txt'
    };
  }

  if (!deliveredContent) {
    deliveredContent = {
      type: 'text',
      content: 'GV-' + prod.id + '-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase() + ' (Licence Active)'
    };
  }

  // 2. Décrémenter et recalculer automatiquement le stock selon les clés restantes
  var prods = DB.get('products', []);
  var pIndex = prods.findIndex(function(p) { return p.id === prod.id; });
  if (pIndex !== -1) {
    if (prodVault.keys && Array.isArray(prodVault.keys)) {
      prods[pIndex].stock = Math.max(0, prodVault.keys.filter(function(k) { return !k.used; }).length);
    } else {
      prods[pIndex].stock = Math.max(0, (prods[pIndex].stock || 1) - qty);
    }
    DB.set('products', prods);
  }

  // 3. Calcul du nouveau solde restant du client après transaction
  var userBalAfter = typeof remainingBal === 'number' ? remainingBal : getUserBalance();

  // 4. Création de la commande complétée avec accès immédiat et enregistrement du nouveau solde
  var orders = DB.get('orders', []);
  var newOrder = {
    id: 'ORD-' + Date.now().toString().slice(-6),
    userId: u.id,
    userEmail: u.email,
    userName: u.name,
    productId: prod.id,
    productName: prod.name,
    unitPrice: prod.price,
    quantity: qty,
    amount: total,
    remainingBalance: userBalAfter,
    userBalanceAfter: userBalAfter,
    contactInfo: contactVal,
    method: paymentMethodName || 'Solde Client',
    status: 'Complété', // 100% complété et livré immédiatement !
    proofImage: null,
    vaultContent: deliveredContent,
    date: new Date().toISOString()
  };
  orders.unshift(newOrder);
  DB.set('orders', orders);

  // Rendu de la boîte de livraison instantanée dans le modal
  var container = document.getElementById('pay-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="purchase-success-box">
        <div class="success-icon-badge" style="background: var(--emerald-500); color: white;">✓</div>
        <h3 style="font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Paiement Réussi & Produit Livré ! ⚡</h3>
        <p style="font-size: 13.5px; color: #475569; line-height: 1.5; margin-bottom: 16px;">
          Félicitations ! Votre commande est validée et votre clé/accès numérique unique est débloqué(e) :
        </p>

        <div class="vault-delivery-card" style="margin-bottom: 16px;">
          <div class="vault-header">
            <span>🔐 CONTENU DU PRODUIT DÉBLOQUÉ</span>
            <span style="font-size: 11px; color: var(--emerald-600); font-weight: 600;">● Accès Immédiat & Clé Unique</span>
          </div>
          ${renderVaultContentDisplay(newOrder)}
        </div>

        <div class="order-recap-mini">
          <div><span>N° Commande :</span> <strong>${newOrder.id}</strong></div>
          <div><span>Article :</span> <strong>${escapeHtml(prod.name)} (x${newOrder.quantity})</strong></div>
          <div><span>Montant débité :</span> <strong style="color: var(--primary-600);">$${total.toFixed(2)}</strong></div>
          <div><span>Nouveau solde :</span> <strong style="color: var(--emerald-600);">$${userBalAfter.toFixed(2)}</strong></div>
          <div><span>Règlement :</span> <strong>${escapeHtml(newOrder.method)}</strong></div>
          ${contactVal ? `<div><span>Contact :</span> <strong>${escapeHtml(contactVal)}</strong></div>` : ''}
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button type="button" class="btn-secondary" style="flex: 1;" onclick="closePayModal()">Continuer mes achats</button>
          <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal(); openOrdersModal();">📦 Mes commandes</button>
        </div>
      </div>
    `;
  }

  showToast('🎉 Félicitations ! Votre produit a été débloqué et livré.', 'success');
  updateNavbar();
  renderConnectedCatalog();
  renderLandingCatalog();
}

// 1. RÈGLEMENT PAR SOLDE GETVIRTU (LIVRAISON INSTANTANÉE & DÉBIT STRICT)
function processProductPayment() {
  var u = getCurrentUser();
  if (!u) {
    openAuthModal('login', 'Veuillez vous connecter pour acheter ce produit.');
    return;
  }
  if (!selectedPayProd) return;

  var qty = parseInt(currentPurchaseQty, 10);
  if (isNaN(qty) || qty < 1) {
    showToast('Quantité invalide.', 'error');
    return;
  }

  // Vérification de la disponibilité du stock
  if ((selectedPayProd.stock || 0) <= 0 || selectedPayProd.stock < qty) {
    showToast('Ce produit est actuellement en rupture de stock.', 'error');
    renderPurchaseModal();
    return;
  }

  var total = Math.round(selectedPayProd.price * qty * 100) / 100;
  var userBal = getUserBalance();

  // VÉRIFICATION EN AMONT DU SOLDE DU CLIENT (APPLICABLE SANS EXCEPTION À TOUS LES COMPTES)
  if (userBal < total) {
    var diff = (total - userBal).toFixed(2);
    showToast('Solde insuffisant. Veuillez recharger votre compte', 'error');
    promptDepositFromPurchase(Math.max(5, Math.ceil(parseFloat(diff))));
    return;
  }

  // DÉBIT IMMÉDIAT DU PRIX EXACT DU PRODUIT DU SOLDE DU CLIENT
  var newBal = Math.round((userBal - total) * 100) / 100;
  updateUserBalance(newBal);

  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = typeof Security !== 'undefined' ? Security.escapeHtml(rawContact) : rawContact;

  // Persister la commande et la déduction de solde côté serveur
  var session = DB.get('session');
  if (session && session.token) {
    fetch('/api/data/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.token
      },
      body: JSON.stringify({
        productId: selectedPayProd.id,
        quantity: qty,
        contactInfo: contactVal
      })
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res && typeof res.newBalance === 'number') {
        updateUserBalance(res.newBalance);
      }
    }).catch(function(e) { console.warn('Order sync:', e); });
  }

  deliverCompletedOrder(selectedPayProd, total, qty, contactVal, 'Solde Client', newBal);
}

// 2. RÈGLEMENT PAR CRYPTO INSTANTANÉ TRYBIT
async function startPurchaseTrybitPayment(total, qty) {
  var u = getCurrentUser();
  if (!u || !selectedPayProd) return;
  var prod = selectedPayProd;

  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = typeof Security !== 'undefined' ? Security.escapeHtml(rawContact) : rawContact;

  var cryptoSelect = document.getElementById('purchase-crypto-select');
  var selectedCrypto = cryptoSelect ? cryptoSelect.value : '';

  showToast('Génération de la facture crypto Trybit... ⏳', 'info');

  try {
    var session = DB.get('session');
    var token = session ? session.token : null;

    var safeEmail = '';
    if (rawContact && rawContact.includes('@')) {
      safeEmail = rawContact;
    } else {
      safeEmail = getActiveCustomerEmail();
    }
    if (safeEmail && (safeEmail.toLowerCase().includes('admin@') || safeEmail.toLowerCase().includes('virtushop.com'))) {
      safeEmail = '';
    }

    var res = await fetch('/api/payments/trybit/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify({
        userId: u.id || (session ? session.userId : 'usr_client'),
        amount: total,
        cryptocurrency: selectedCrypto || null,
        customerEmail: safeEmail || (u.email && !u.email.toLowerCase().includes('admin@') ? u.email : null),
        customerName: (u.role === 'admin' ? 'Client GetVirtu' : (u.name || 'Client')),
        returnUrl: window.location.origin + '/#catalog?order_crypto=success'
      })
    });
    var data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Erreur lors de la création de la facture Trybit.');
    }

    if (data.paymentUrl) {
      window.open(data.paymentUrl, '_blank');
    }

    var container = document.getElementById('pay-dynamic-content');
    if (container) {
      container.innerHTML = `
        <div class="momo-waiting-box" style="text-align: center; padding: 18px 12px;">
          <div class="pulse-spinner"></div>
          <div class="pulse-indicator">⏳ Facture Trybit Active (${escapeHtml(data.invoiceUuid || '')})</div>
          <h3 style="font-size: 16px; margin: 0 0 6px 0; color: var(--text-primary);">Paiement Crypto pour : ${escapeHtml(prod.name)}</h3>
          <p style="font-size: 12.5px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.45;">
            La page de paiement officielle Trybit est ouverte. Dès confirmation blockchain, votre produit sera automatiquement débloqué et livré ci-dessous !
          </p>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 14px; text-align: left; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Total :</span>
              <strong style="color: var(--primary-600);">$${total.toFixed(2)} USD</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Réf Facture :</span>
              <code>${escapeHtml(data.invoiceUuid || data.transactionId)}</code>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span>Livraison :</span>
              <span style="color: var(--emerald-600); font-weight: 600;">Instantanée dès confirmation</span>
            </div>
          </div>
          ${data.paymentUrl ? `<a href="${data.paymentUrl}" target="_blank" class="btn-primary" style="display: block; text-decoration: none; margin-bottom: 10px; width: 100%;">Ouvrir la page de paiement Trybit ↗</a>` : ''}
          <button type="button" class="btn-secondary" onclick="checkOrderTrybitStatus('${data.transactionId}', '${data.invoiceUuid || ''}', ${total}, ${qty}, '${escapeHtml(contactVal)}')" style="width: 100%;">
            Vérifier le statut du paiement 🔄
          </button>
        </div>
      `;
    }

    startOrderTrybitPolling(data.transactionId, data.invoiceUuid, prod, total, qty, contactVal);

  } catch (err) {
    showToast(err.message || 'Échec de génération du paiement Crypto.', 'error');
  }
}

function startOrderTrybitPolling(txId, invoiceUuid, prod, total, qty, contactVal) {
  if (orderTrybitPollingTimer) clearInterval(orderTrybitPollingTimer);
  var attempts = 0;
  var maxAttempts = 70;

  orderTrybitPollingTimer = setInterval(async function() {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(orderTrybitPollingTimer);
      orderTrybitPollingTimer = null;
      return;
    }

    try {
      var query = `transactionId=${encodeURIComponent(txId)}`;
      if (invoiceUuid) query += `&invoiceUuid=${encodeURIComponent(invoiceUuid)}`;
      var resp = await fetch(`/api/payments/trybit/verify?${query}`);
      var result = await resp.json();

      if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
        clearInterval(orderTrybitPollingTimer);
        orderTrybitPollingTimer = null;
        deliverCompletedOrder(prod, total, qty, contactVal, 'Crypto Instantané (Trybit)');
      }
    } catch (e) {}
  }, 3500);
}

async function checkOrderTrybitStatus(txId, invoiceUuid, total, qty, contactVal) {
  try {
    showToast('Vérification Trybit en cours...', 'info');
    var query = `transactionId=${encodeURIComponent(txId)}`;
    if (invoiceUuid) query += `&invoiceUuid=${encodeURIComponent(invoiceUuid)}`;
    var resp = await fetch(`/api/payments/trybit/verify?${query}`);
    var result = await resp.json();

    if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
      if (orderTrybitPollingTimer) clearInterval(orderTrybitPollingTimer);
      orderTrybitPollingTimer = null;
      if (selectedPayProd) {
        deliverCompletedOrder(selectedPayProd, total, qty, contactVal, 'Crypto Instantané (Trybit)');
      } else {
        showToast('Paiement confirmé avec succès !', 'success');
      }
    } else {
      showToast(result.message || 'Paiement en cours de détection sur la blockchain.', 'info');
    }
  } catch (err) {
    showToast('Erreur vérification : ' + err.message, 'error');
  }
}

// 3. RÈGLEMENT PAR MOBILE MONEY (SASPAY)
async function startPurchaseMomoPayment(total, qty) {
  var u = getCurrentUser();
  if (!u || !selectedPayProd) return;
  var prod = selectedPayProd;

  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = typeof Security !== 'undefined' ? Security.escapeHtml(rawContact) : rawContact;

  var phoneInput = document.getElementById('purchase-momo-phone');
  var phone = phoneInput ? phoneInput.value.trim() : '';

  if (!phone) {
    showToast('Veuillez renseigner votre numéro Mobile Money.', 'error');
    if (phoneInput) phoneInput.focus();
    return;
  }

  showToast('Initiation Mobile Money en cours... ⏳', 'info');

  try {
    var session = DB.get('session');
    var token = session ? session.token : null;

    var safeEmail = '';
    if (rawContact && rawContact.includes('@')) {
      safeEmail = rawContact;
    } else {
      safeEmail = getActiveCustomerEmail();
    }
    if (safeEmail && (safeEmail.toLowerCase().includes('admin@') || safeEmail.toLowerCase().includes('virtushop.com'))) {
      safeEmail = '';
    }

    var res = await fetch('/api/payments/saspay/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify({
        userId: u.id,
        amount: total,
        phone: phone,
        country: selectedMomoCountry,
        network: selectedMomoNetwork,
        customerName: (u.role === 'admin' ? 'Client GetVirtu' : u.name),
        customerEmail: safeEmail || null
      })
    });
    var data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Erreur lors de l\'initiation Mobile Money.');
    }

    var container = document.getElementById('pay-dynamic-content');
    if (container) {
      container.innerHTML = `
        <div class="momo-waiting-box" style="text-align: center; padding: 18px 12px;">
          <div class="pulse-spinner"></div>
          <div class="pulse-indicator">📱 Demande envoyée sur votre mobile</div>
          <h3 style="font-size: 16px; margin: 0 0 6px 0; color: var(--text-primary);">Validation Mobile Money Requise</h3>
          <p style="font-size: 12.5px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.45;">
            Veuillez confirmer le paiement sur votre smartphone (Wave ou notification push USSD). Dès confirmation, votre produit sera livré ici !
          </p>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 14px; text-align: left; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Total :</span>
              <strong style="color: var(--primary-600);">$${total.toFixed(2)} USD</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span>Numéro :</span>
              <strong>${escapeHtml(phone)}</strong>
            </div>
          </div>
          <button type="button" class="btn-primary" onclick="checkOrderMomoStatus('${data.transactionId}', ${total}, ${qty}, '${escapeHtml(contactVal)}')" style="width: 100%;">
            J'ai validé sur mon téléphone ⚡
          </button>
        </div>
      `;
    }

    startOrderMomoPolling(data.transactionId, prod, total, qty, contactVal);

  } catch (err) {
    showToast(err.message || 'Échec initiation Mobile Money.', 'error');
  }
}

function startOrderMomoPolling(txId, prod, total, qty, contactVal) {
  if (orderMomoPollingTimer) clearInterval(orderMomoPollingTimer);
  var attempts = 0;
  var maxAttempts = 60;

  orderMomoPollingTimer = setInterval(async function() {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(orderMomoPollingTimer);
      orderMomoPollingTimer = null;
      return;
    }

    try {
      var resp = await fetch(`/api/payments/saspay/verify?transactionId=${encodeURIComponent(txId)}`);
      var result = await resp.json();

      if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
        clearInterval(orderMomoPollingTimer);
        orderMomoPollingTimer = null;
        deliverCompletedOrder(prod, total, qty, contactVal, 'Mobile Money Instantané');
      }
    } catch (e) {}
  }, 3500);
}

async function checkOrderMomoStatus(txId, total, qty, contactVal) {
  try {
    showToast('Vérification Mobile Money...', 'info');
    var resp = await fetch(`/api/payments/saspay/verify?transactionId=${encodeURIComponent(txId)}`);
    var result = await resp.json();

    if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
      if (orderMomoPollingTimer) clearInterval(orderMomoPollingTimer);
      orderMomoPollingTimer = null;
      if (selectedPayProd) {
        deliverCompletedOrder(selectedPayProd, total, qty, contactVal, 'Mobile Money Instantané');
      } else {
        showToast('Paiement confirmé avec succès !', 'success');
      }
    } else {
      showToast(result.message || 'Paiement en cours de validation...', 'info');
    }
  } catch (err) {
    showToast('Erreur : ' + err.message, 'error');
  }
}

// ========== RECHARGEMENT DU SOLDE (+) ==========
function openDepositModal(suggestedAmount) {
  var s = DB.get('session');
  if (!s || !s.userId) { openAuthModal('login', 'Veuillez vous connecter pour recharger votre solde.'); return; }

  currentDepositProofBase64 = null;
  var min = getMinRecharge();

  var amountInput = document.getElementById('deposit-amount-input');
  if (amountInput) {
    var initial = (typeof suggestedAmount === 'number' && suggestedAmount >= min) ? suggestedAmount : min;
    amountInput.value = initial;
    amountInput.min = min;
  }

  var minNotice = document.getElementById('deposit-min-notice');
  if (minNotice) {
    minNotice.textContent = `Minimum requis : $${min.toFixed(2)}`;
  }

  var methods = DB.get('payment_methods', []).filter(function(m) { return m.enabled; });
  if (methods.length > 0) {
    if (!currentDepositMethodId || !methods.some(function(m) { return m.id == currentDepositMethodId; })) {
      currentDepositMethodId = methods[0].id;
    }
  }

  renderDepositMethodsTabs();
  renderDepositMethodContent();
  updateDepositCalculation();

  document.getElementById('modal-deposit').classList.add('active');
}

var selectedMomoCountry = 'CI';
var selectedMomoNetwork = 'wave_ci';
var momoPollingTimer = null;

var MOMO_COUNTRIES = [
  {
    code: 'CI',
    name: "Côte d'Ivoire 🇨🇮",
    currency: 'XOF',
    rate: 620,
    prefix: '+225',
    networks: [
      { id: 'wave_ci', name: 'Wave', icon: '🌊' },
      { id: 'orange_ci', name: 'Orange Money', icon: '🍊' },
      { id: 'mtn_ci', name: 'MTN MoMo', icon: '🟡' },
      { id: 'moov_ci', name: 'Moov Money', icon: '🔵' }
    ]
  },
  {
    code: 'CM',
    name: 'Cameroun 🇨🇲',
    currency: 'XAF',
    rate: 620,
    prefix: '+237',
    networks: [
      { id: 'orange_cm', name: 'Orange Money', icon: '🍊' },
      { id: 'mtn_cm', name: 'MTN MoMo', icon: '🟡' }
    ]
  },
  {
    code: 'SN',
    name: 'Sénégal 🇸🇳',
    currency: 'XOF',
    rate: 620,
    prefix: '+221',
    networks: [
      { id: 'wave_sn', name: 'Wave', icon: '🌊' },
      { id: 'orange_sn', name: 'Orange Money', icon: '🍊' },
      { id: 'freemoney_sn', name: 'Free Money', icon: '🟢' }
    ]
  },
  {
    code: 'BJ',
    name: 'Bénin 🇧🇯',
    currency: 'XOF',
    rate: 620,
    prefix: '+229',
    networks: [
      { id: 'mtn_bj', name: 'MTN MoMo', icon: '🟡' },
      { id: 'moov_bj', name: 'Moov Money', icon: '🔵' },
      { id: 'celtiis_bj', name: 'Celtiis', icon: '🟣' }
    ]
  },
  {
    code: 'BF',
    name: 'Burkina Faso 🇧🇫',
    currency: 'XOF',
    rate: 620,
    prefix: '+226',
    networks: [
      { id: 'orange_bf', name: 'Orange Money', icon: '🍊' },
      { id: 'moov_bf', name: 'Moov Money', icon: '🔵' }
    ]
  },
  {
    code: 'TG',
    name: 'Togo 🇹🇬',
    currency: 'XOF',
    rate: 620,
    prefix: '+228',
    networks: [
      { id: 'moov_tg', name: 'Moov Money', icon: '🔵' },
      { id: 'togocel', name: 'TMoney / Mixx', icon: '🟡' }
    ]
  },
  {
    code: 'GN',
    name: 'Guinée 🇬🇳',
    currency: 'GNF',
    rate: 8600,
    prefix: '+224',
    networks: [
      { id: 'mtn_gn', name: 'MTN MoMo', icon: '🟡' }
    ]
  },
  {
    code: 'ALL',
    name: 'Tous Pays (Passerelle SasPay) 🌍',
    currency: 'XOF',
    rate: 620,
    prefix: '',
    networks: [
      { id: 'checkout_hosted', name: 'SasPay Hosted Checkout', icon: '⚡' }
    ]
  }
];

function getSelectedMomoCountry() {
  return MOMO_COUNTRIES.find(function(c) { return c.code === selectedMomoCountry; }) || MOMO_COUNTRIES[0];
}

function onMomoCountryChange(code) {
  selectedMomoCountry = code;
  var c = getSelectedMomoCountry();
  if (c && c.networks && c.networks.length > 0) {
    selectedMomoNetwork = c.networks[0].id;
  }
  renderDepositMethodContent();
}

function onSelectMomoNetwork(netId) {
  selectedMomoNetwork = netId;
  var btns = document.querySelectorAll('.momo-network-btn');
  btns.forEach(function(b) {
    if (b.getAttribute('data-net') === netId) b.classList.add('active');
    else b.classList.remove('active');
  });
  var c = getSelectedMomoCountry();
  var net = c.networks.find(function(n) { return n.id === netId; });
  var submitBtn = document.getElementById('btn-submit-momo');
  if (submitBtn && net) {
    submitBtn.innerHTML = `Payer avec ${net.icon} ${escapeHtml(net.name)} ⚡`;
  }
}

function updateDepositCalculation() {
  var country = getSelectedMomoCountry();
  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 0;
  var localEl = document.getElementById('momo-calc-local');
  if (localEl && country) {
    var localAmount = Math.round(amount * country.rate);
    localEl.textContent = localAmount.toLocaleString('fr-FR') + ' ' + country.currency;
  }
  var cryptoBtnAmount = document.getElementById('trybit-btn-dynamic-amount');
  if (cryptoBtnAmount) {
    cryptoBtnAmount.textContent = '$' + amount.toFixed(2);
  }
}

function closeDepositModal() {
  document.getElementById('modal-deposit').classList.remove('active');
  currentDepositProofBase64 = null;
  if (momoPollingTimer) {
    clearInterval(momoPollingTimer);
    momoPollingTimer = null;
  }
}

function openSupportModal() {
  var u = getCurrentUser();
  var nameInput = document.getElementById('support-name-input');
  var contactInput = document.getElementById('support-contact-input');
  if (nameInput && u && u.name) nameInput.value = u.name;
  if (contactInput && u && u.email) contactInput.value = u.email;

  var modal = document.getElementById('modal-support');
  if (modal) modal.classList.add('active');
}

function closeSupportModal() {
  var modal = document.getElementById('modal-support');
  if (modal) modal.classList.remove('active');
}

function submitSupportTicket(event) {
  if (event && event.preventDefault) event.preventDefault();

  var name = (document.getElementById('support-name-input')?.value || '').trim();
  var contact = (document.getElementById('support-contact-input')?.value || '').trim();
  var subject = (document.getElementById('support-subject-select')?.value || 'Support Client').trim();
  var message = (document.getElementById('support-message-input')?.value || '').trim();

  if (!contact || !message) {
    showToast('Veuillez renseigner votre contact et votre message.', 'error');
    return;
  }

  var u = getCurrentUser();
  var ticketId = 'TCK-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
  var newTicket = {
    id: ticketId,
    userId: u ? u.id : null,
    userName: name || (u ? u.name : 'Client'),
    userContact: contact,
    subject: subject,
    message: message,
    status: 'Ouvert',
    date: new Date().toISOString()
  };

  var tickets = DB.get('tickets', []);
  tickets.unshift(newTicket);
  DB.set('tickets', tickets);

  // Synchronisation backend
  var session = DB.get('session');
  fetch('/api/data/tickets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': (session && session.token) ? 'Bearer ' + session.token : ''
    },
    body: JSON.stringify(newTicket)
  }).catch(function(e) { console.warn('Ticket sync:', e); });

  showToast('✓ Votre message a été envoyé à l\'équipe GetVirtu avec succès !', 'success');
  closeSupportModal();
  document.getElementById('support-ticket-form')?.reset();
}

function renderDepositMethodsTabs() {
  var container = document.getElementById('deposit-methods-tabs-container');
  if (!container) return;

  var methods = DB.get('payment_methods', []).filter(function(m) { return m.enabled; });
  var html = '';
  methods.forEach(function(m) {
    var icon = (m.type === 'crypto_trybit' || m.provider === 'trybit') ? '⚡' : (m.type === 'crypto' ? '🪙' : (m.type === 'mobile_money' ? '📱' : '💳'));
    var rawName = m.name || '';
    var mainTitle = rawName;
    var subTitle = '';

    if (m.type === 'mobile_money' || m.id === 'saspay-mobile-money' || m.id === 1) {
      mainTitle = 'Mobile Money';
      subTitle = 'Wave, Orange, MTN, Moov';
    } else if (m.type === 'crypto_trybit' || m.provider === 'trybit' || m.id === 2 || m.id === 'trybit') {
      mainTitle = 'Crypto Instantané';
      subTitle = 'Trybit (USDT, BTC, SOL...)';
    } else if (rawName.indexOf('(') !== -1) {
      mainTitle = rawName.substring(0, rawName.indexOf('(')).trim();
      subTitle = rawName.substring(rawName.indexOf('(') + 1).replace(')', '').trim();
    }

    html += `
      <div class="payment-method-tab ${currentDepositMethodId == m.id ? 'active' : ''}" onclick="selectDepositMethodTab('${m.id}')">
        <div class="pm-title"><span class="pm-icon">${icon}</span> <span>${escapeHtml(mainTitle)}</span></div>
        ${subTitle ? `<div class="pm-subtitle">${escapeHtml(subTitle)}</div>` : ''}
      </div>
    `;
  });
  container.innerHTML = html;
}

function selectDepositMethodTab(mId) {
  currentDepositMethodId = mId;
  renderDepositMethodsTabs();
  renderDepositMethodContent();
}

function renderDepositMethodContent() {
  var container = document.getElementById('deposit-dynamic-content');
  if (!container) return;

  var methods = DB.get('payment_methods', []);
  var m = methods.find(function(x) { return x.id == currentDepositMethodId; });
  if (!m) {
    container.innerHTML = '<p style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 20px;">Aucun moyen de paiement configuré.</p>';
    return;
  }

  // Si Crypto Automatique Trybit : rendu dédié officiel
  if (m.type === 'crypto_trybit' || m.provider === 'trybit' || m.id === 2 || m.id === 'trybit') {
    renderTrybitDepositContent(container);
    return;
  }

  // Si Mobile Money : rendu dédié SasPay
  if (m.type === 'mobile_money' || m.id === 'saspay-mobile-money' || m.id === 1) {
    renderSasPayDepositContent(container);
    return;
  }

  var isCrypto = m.type === 'crypto';
  var isBinance = m.isBinance || (m.name && m.name.toLowerCase().indexOf('binance') !== -1) || (m.instructions && m.instructions.toLowerCase().indexOf('binance') !== -1);
  var networkTag = m.network ? `<span class="network-badge">Réseau : ${escapeHtml(m.network)}</span>` : '';

  var qrHtml = '';
  if (isCrypto && m.qrCode) {
    var qrCaption = isBinance ? "Scanner avec l'application Binance" : "Scanner avec votre portefeuille crypto";
    qrHtml = `
      <div class="pay-qr-wrapper">
        <img src="${m.qrCode}" alt="QR Code">
        <span class="qr-caption-hint">${qrCaption}</span>
      </div>
    `;
  }

  var addressLabel = isCrypto ? 'Adresse du portefeuille' : 'Numéro de compte / Tél';

  container.innerHTML = `
    ${networkTag ? `<div style="text-align: center; margin-bottom: 8px;">${networkTag}</div>` : ''}
    ${qrHtml}

    <div class="field">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <label style="margin-bottom: 0;">${addressLabel}</label>
        <span style="font-size: 11px; color: var(--primary-600); font-weight: 600;">${escapeHtml(m.name)}</span>
      </div>
      <div class="pay-copy-group">
        <input type="text" id="deposit-addr-value" value="${escapeHtml(m.address)}" readonly>
        <button type="button" class="btn-copy-address" onclick="copyDepositAddress()">Copier</button>
      </div>
    </div>

    <div class="method-instructions-box">
      <span style="font-size: 14px;">ℹ️</span>
      <p style="margin: 0; font-size: 12.5px; line-height: 1.45;">${escapeHtml(m.instructions || 'Effectuez votre transfert puis joignez votre preuve ci-dessous.')}</p>
    </div>

    <div class="field" style="margin-top: 14px;">
      <label style="font-weight: 700; color: var(--primary-600);">📸 Capture d'écran ou Reçu du transfert</label>
      <div class="proof-dropzone-compact" onclick="document.getElementById('deposit-proof-file-input').click()">
        <input type="file" id="deposit-proof-file-input" accept="image/*" class="hidden" onchange="handleDepositProofSelected(event)">
        <div id="dep-prompt-text" class="${currentDepositProofBase64 ? 'hidden' : ''}">
          <span style="font-size: 20px;">📁</span>
          <p style="font-size: 12px; margin-top: 2px;">Cliquez pour joindre la preuve de transfert</p>
        </div>
        <div id="dep-preview-wrapper" class="${currentDepositProofBase64 ? '' : 'hidden'}">
          <img id="dep-preview-img" style="max-height: 100px; max-width: 100%; border-radius: 6px; margin-top: 4px; box-shadow: var(--shadow-sm);" src="${currentDepositProofBase64 || ''}" alt="Preuve">
          <p style="font-size: 11px; color: var(--emerald-600); margin-top: 3px; font-weight: 600;">✓ Capture prête pour vérification</p>
        </div>
      </div>
    </div>

    <button type="button" class="btn-primary btn-light-sweep" style="width: 100%; margin-top: 10px;" onclick="submitDepositRequest()">
      Valider la Recharge de Solde ⚡
    </button>
  `;
}

function renderSasPayDepositContent(container) {
  var country = getSelectedMomoCountry();
  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 10;
  var localAmount = Math.round(amount * country.rate);
  var formattedLocal = localAmount.toLocaleString('fr-FR') + ' ' + country.currency;

  var countryOptionsHtml = MOMO_COUNTRIES.map(function(c) {
    return `<option value="${c.code}" ${c.code === selectedMomoCountry ? 'selected' : ''}>${c.name}</option>`;
  }).join('');

  var networksHtml = country.networks.map(function(net) {
    var isActive = net.id === selectedMomoNetwork ? 'active' : '';
    return `
      <div class="momo-network-btn ${isActive}" data-net="${net.id}" onclick="onSelectMomoNetwork('${net.id}')">
        <span class="momo-network-icon">${net.icon}</span>
        <span class="momo-network-title">${escapeHtml(net.name)}</span>
      </div>
    `;
  }).join('');

  var currentNet = country.networks.find(function(n) { return n.id === selectedMomoNetwork; }) || country.networks[0];
  var isHosted = selectedMomoNetwork === 'checkout_hosted';

  var phoneFieldHtml = isHosted ? '' : `
    <div class="field" style="margin-top: 10px;">
      <label style="font-weight: 700; font-size: 13px;">Numéro Mobile Money (${country.name})</label>
      <div class="phone-input-group">
        <span class="phone-prefix">${country.prefix}</span>
        <input type="tel" id="momo-phone-input" placeholder="Ex: 0701020304" autocomplete="tel">
      </div>
      <p style="font-size: 11px; color: var(--text-muted); margin: 3px 0 0 0;">
        Notification de débit automatique ou invite USSD push envoyée sur ce numéro.
      </p>
    </div>
  `;

  container.innerHTML = `
    <div class="momo-country-wrapper">
      <label style="font-weight: 700; font-size: 13px; margin-bottom: 5px; display: block;">1. Choisissez votre Pays</label>
      <select id="momo-country-select" class="momo-select" onchange="onMomoCountryChange(this.value)">
        ${countryOptionsHtml}
      </select>
    </div>

    <div class="field" style="margin-bottom: 10px;">
      <label style="font-weight: 700; font-size: 13px; margin-bottom: 5px; display: block;">2. Choisissez votre Opérateur</label>
      <div class="momo-networks-grid">
        ${networksHtml}
      </div>
    </div>

    <div class="momo-convert-card">
      <div class="momo-convert-left">
        <span style="font-size: 20px;">💱</span>
        <div>
          <div class="momo-convert-label">Montant débité (Devise locale)</div>
          <div class="momo-convert-value" id="momo-calc-local">${formattedLocal}</div>
        </div>
      </div>
      <div style="text-align: right;">
        <span class="momo-badge-live">Taux SasPay direct</span>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">1 USD = ${country.rate} ${country.currency}</div>
      </div>
    </div>

    ${phoneFieldHtml}

    <div class="momo-ticker-box" style="margin: 6px 0 10px;">
      <span class="momo-ticker-icon">🔒</span>
      <div class="momo-ticker-track">
        <span class="momo-ticker-text">Passerelle officielle SasPay : votre solde est automatiquement crédité dès réception de la confirmation bancaire ou mobile ⚡ Cryptage bancaire TLS 1.3 direct • Sécurité 100% garantie</span>
      </div>
    </div>

    <button type="button" class="btn-primary btn-light-sweep" id="btn-submit-momo" style="width: 100%; margin-top: 6px; padding: 10px;" onclick="submitSasPayDeposit()">
      Payer avec ${currentNet ? currentNet.icon + ' ' + escapeHtml(currentNet.name) : 'Mobile Money'} ⚡
    </button>
  `;
}

function copyDepositAddress() {
  var input = document.getElementById('deposit-addr-value');
  if (!input) return;
  input.select();
  navigator.clipboard.writeText(input.value).then(function() { showToast('Copié dans le presse-papiers !', 'success'); });
}

async function handleDepositProofSelected(event) {
  var file = event.target.files[0];
  if (!file) return;

  if (typeof Security !== 'undefined') {
    var check = await Security.validateImageFile(file, 2);
    if (!check.valid) {
      showToast(check.error, 'error');
      event.target.value = '';
      return;
    }
  }

  var reader = new FileReader();
  reader.onload = function(e) {
    currentDepositProofBase64 = e.target.result;
    var previewImg = document.getElementById('dep-preview-img');
    var promptEl = document.getElementById('dep-prompt-text');
    var previewWrapper = document.getElementById('dep-preview-wrapper');
    if (previewImg) previewImg.src = currentDepositProofBase64;
    if (promptEl) promptEl.classList.add('hidden');
    if (previewWrapper) previewWrapper.classList.remove('hidden');
    showToast('Capture enregistrée !', 'success');
  };
  reader.readAsDataURL(file);
}

async function submitSasPayDeposit() {
  var u = getCurrentUser();
  if (!u) {
    openAuthModal('login', 'Veuillez vous connecter pour recharger votre solde.');
    return;
  }

  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 0;
  var min = getMinRecharge();

  if (amount < min) {
    showToast(`Montant inférieur au minimum requis ($${min.toFixed(2)} USD).`, 'error');
    if (amountInput) amountInput.focus();
    return;
  }

  var country = getSelectedMomoCountry();
  var phoneInput = document.getElementById('momo-phone-input');
  var rawPhone = phoneInput ? phoneInput.value.trim() : '';

  if (selectedMomoNetwork !== 'checkout_hosted') {
    if (!rawPhone || rawPhone.length < 6) {
      showToast('Veuillez renseigner un numéro de téléphone valide.', 'error');
      if (phoneInput) phoneInput.focus();
      return;
    }
  }

  var fullPhone = rawPhone;
  if (rawPhone && !rawPhone.startsWith('+') && country.prefix) {
    var clean = rawPhone.replace(/^0+/, '');
    var prefixDigits = country.prefix.replace('+', '');
    if (!clean.startsWith(prefixDigits)) {
      fullPhone = country.prefix + clean;
    } else {
      fullPhone = '+' + clean;
    }
  }

  var submitBtn = document.getElementById('btn-submit-momo');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Initialisation sécurisée SasPay... ⚡';
  }

  var session = DB.get('session');
  var token = session ? session.token : null;

  try {
    var resp = await fetch('/api/payments/saspay/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify({
        userId: u.id,
        amount: amount,
        country: selectedMomoCountry,
        network: selectedMomoNetwork,
        phone: fullPhone,
        customerName: u.name,
        customerEmail: u.email,
        returnUrl: window.location.origin
      })
    });

    var data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Erreur lors de l\'initialisation du paiement SasPay.');
    }

    if (data.checkoutUrl) {
      window.open(data.checkoutUrl, '_blank');
    }

    var localAmount = Math.round(amount * country.rate);
    var formattedLocal = localAmount.toLocaleString('fr-FR') + ' ' + country.currency;
    var container = document.getElementById('deposit-dynamic-content');

    if (container) {
      container.innerHTML = `
        <div class="deposit-active-flow">
          <div class="pulse-spinner"></div>
          <div class="pulse-indicator">● En attente de confirmation</div>
          <h3 style="font-size: 16px; margin: 0 0 6px 0; color: var(--text-primary);">Paiement SasPay Initié ⚡</h3>
          <p style="font-size: 12.5px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.45;">
            ${escapeHtml(data.instructions || 'Validez le prélèvement sur votre téléphone ou sur la page de paiement ouverte.')}
          </p>

          <div style="background: #ffffff; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 14px; text-align: left; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-secondary);">Montant crédité :</span>
              <strong style="color: var(--emerald-600); font-size: 13px;">+$${amount.toFixed(2)} USD</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-secondary);">Débit local :</span>
              <strong>${formattedLocal}</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-secondary);">Opérateur :</span>
              <span>${escapeHtml(selectedMomoNetwork.toUpperCase())}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Réf. Transaction :</span>
              <code style="font-size: 11px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px;">${escapeHtml(data.transactionId)}</code>
            </div>
          </div>

          ${data.checkoutUrl ? `
            <a href="${data.checkoutUrl}" target="_blank" class="btn-primary" style="display: block; text-decoration: none; margin-bottom: 8px; text-align: center;">
              Ouvrir le paiement ↗
            </a>
          ` : ''}

          <button type="button" class="btn-secondary" onclick="checkSasPayStatusManual('${data.transactionId}', '${data.providerTxId || ''}', ${amount})" style="width: 100%;">
            Vérifier maintenant 🔄
          </button>
        </div>
      `;
    }

    startSasPayPolling(data.transactionId, data.providerTxId, amount);

  } catch (err) {
    showToast(err.message || 'Impossible d\'initier le paiement.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      var cNet = country.networks.find(function(n) { return n.id === selectedMomoNetwork; }) || country.networks[0];
      submitBtn.innerHTML = `Payer avec ${cNet.icon} ${escapeHtml(cNet.name)} ⚡`;
    }
  }
}

function startSasPayPolling(txId, providerTxId, amount) {
  if (momoPollingTimer) clearInterval(momoPollingTimer);
  var attempts = 0;
  var maxAttempts = 50;

  momoPollingTimer = setInterval(async function() {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(momoPollingTimer);
      momoPollingTimer = null;
      return;
    }

    try {
      var query = `transactionId=${encodeURIComponent(txId)}`;
      if (providerTxId) query += `&providerTxId=${encodeURIComponent(providerTxId)}`;
      var resp = await fetch(`/api/payments/saspay/verify?${query}`);
      var result = await resp.json();

      if (resp.ok && result.status === 'SUCCESS') {
        clearInterval(momoPollingTimer);
        momoPollingTimer = null;
        onSasPayPaymentConfirmed(txId, amount, result.newBalance);
      } else if (result.status === 'FAILED' || result.status === 'EXPIRED') {
        clearInterval(momoPollingTimer);
        momoPollingTimer = null;
        showToast('Paiement non abouti ou expiré.', 'error');
      }
    } catch (e) {}
  }, 3500);
}

async function checkSasPayStatusManual(txId, providerTxId, amount) {
  try {
    showToast('Vérification auprès de SasPay...', 'info');
    var query = `transactionId=${encodeURIComponent(txId)}`;
    if (providerTxId) query += `&providerTxId=${encodeURIComponent(providerTxId)}`;
    var resp = await fetch(`/api/payments/saspay/verify?${query}`);
    var result = await resp.json();

    if (resp.ok && result.status === 'SUCCESS') {
      if (momoPollingTimer) clearInterval(momoPollingTimer);
      momoPollingTimer = null;
      onSasPayPaymentConfirmed(txId, amount, result.newBalance);
    } else {
      showToast(result.message || 'Paiement en cours de traitement par votre opérateur.', 'info');
    }
  } catch (err) {
    showToast('Erreur lors de la vérification : ' + err.message, 'error');
  }
}

function onSasPayPaymentConfirmed(txId, amount, newBalance) {
  var session = DB.get('session');
  if (session) {
    if (typeof newBalance === 'number') {
      session.balance = newBalance;
    } else {
      session.balance = (session.balance || 0) + amount;
    }
    DB.set('session', session);
  }

  var users = DB.get('users', []);
  var u = users.find(function(user) { return user.id === (session ? session.userId : null); });
  if (u) {
    if (typeof newBalance === 'number') {
      u.balance = newBalance;
    } else {
      u.balance = (u.balance || 0) + amount;
    }
    DB.set('users', users);
  }

  updateNavbar();
  renderConnectedCatalog();
  renderLandingCatalog();

  var container = document.getElementById('deposit-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="deposit-active-flow" style="border-color: #86efac; background: #f0fdf4;">
        <div style="font-size: 42px; margin-bottom: 8px;">🎉</div>
        <h3 style="font-size: 17px; margin: 0 0 6px 0; color: #166534;">Paiement Validé avec Succès !</h3>
        <p style="font-size: 13px; color: #15803d; margin: 0 0 16px 0;">
          Votre solde a été crédité de <strong>+$${amount.toFixed(2)} USD</strong>.
        </p>
        <button type="button" class="btn-primary" onclick="closeDepositModal()" style="width: 100%;">
          Parfait, Continuer mes achats ⚡
        </button>
      </div>
    `;
  }

  showToast(`🎉 Félicitations ! Solde crédité de +$${amount.toFixed(2)} USD.`, 'success');

  if (pendingPurchaseProductId) {
    setTimeout(function() {
      closeDepositModal();
      var prodId = pendingPurchaseProductId;
      pendingPurchaseProductId = null;
      startProductPurchase(prodId);
    }, 1200);
  }
}

// ========== PASSERELLE CRYPTO INSTANTANÉE TRYBIT ==========
var trybitPollingTimer = null;

function renderTrybitDepositContent(container) {
  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 10;

  container.innerHTML = `
    <div class="trybit-header-single-row">
      <div class="trybit-header-title-wrap">
        <span style="font-size: 15px;">⚡</span>
        <span class="trybit-header-title">Passerelle Crypto Instantanée</span>
      </div>
      <span class="status-indicator-pill online trybit-header-pill">Automatique 24/7</span>
    </div>

    <div class="field" style="margin-bottom: 6px;">
      <label style="font-size: 11.5px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px; display: block;">Sélectionnez votre devise crypto :</label>
      ${renderCryptoCardsHtml('trybit-deposit-crypto-cards-grid', 'trybit-crypto-select', '', true)}
    </div>

    <div class="crypto-ticker-box">
      <span class="crypto-ticker-icon">🔒</span>
      <div class="crypto-ticker-track">
        <span class="crypto-ticker-text">Facture Trybit officielle sécurisée : conversion et calcul du taux en temps réel ⚡ Crédit instantané après confirmation blockchain • Sécurité 100% garantie</span>
      </div>
    </div>

    <button type="button" class="btn-primary btn-light-sweep" id="btn-submit-trybit" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 13.5px; padding: 10px;" onclick="submitTrybitDeposit()">
      <span>Payer <span id="trybit-btn-dynamic-amount">$${amount.toFixed(2)}</span> ⚡</span>
    </button>
  `;
}

async function submitTrybitDeposit() {
  var u = getCurrentUser();
  if (!u) {
    openAuthModal('login', 'Veuillez vous connecter pour recharger votre solde.');
    return;
  }

  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 0;
  var min = getMinRecharge();

  if (amount < min) {
    showToast(`Montant inférieur au minimum ($${min.toFixed(2)} USD).`, 'error');
    if (amountInput) amountInput.focus();
    return;
  }

  var cryptoSelect = document.getElementById('trybit-crypto-select');
  var selectedCrypto = cryptoSelect ? cryptoSelect.value : '';

  var submitBtn = document.getElementById('btn-submit-trybit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Génération de la facture sécurisée Trybit... ⏳';
  }

  var session = DB.get('session');
  var token = session ? session.token : null;

  try {
    var resp = await fetch('/api/payments/trybit/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify({
        userId: u.id || (session ? session.userId : 'usr_client'),
        amount: amount,
        cryptocurrency: selectedCrypto || null,
        customerEmail: getActiveCustomerEmail() || (u.email && !u.email.toLowerCase().includes('admin@') ? u.email : null),
        customerName: (u.role === 'admin' ? 'Client GetVirtu' : (u.name || 'Client')),
        returnUrl: window.location.origin + '/#catalog?payment=success'
      })
    });

    var data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Erreur lors de la génération de la facture Trybit.');
    }

    if (data.paymentUrl) {
      window.open(data.paymentUrl, '_blank');
    }

    // Afficher l'interface de suivi dynamique en direct
    var container = document.getElementById('deposit-dynamic-content');
    if (container) {
      container.innerHTML = `
        <div class="momo-waiting-box" style="text-align: center; padding: 18px 12px;">
          <div class="pulse-spinner"></div>
          <div class="pulse-indicator">⏳ Facture Trybit Active (${escapeHtml(data.invoiceUuid || '')})</div>
          <h3 style="font-size: 16px; margin: 0 0 6px 0; color: var(--text-primary);">Paiement Crypto Initié ⚡</h3>
          <p style="font-size: 12.5px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.45;">
            La page de paiement officielle Trybit a été ouverte. Transférez les fonds vers l'adresse indiquée sur la page de paiement.
          </p>

          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 14px; text-align: left; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-secondary);">Montant à créditer :</span>
              <strong style="color: var(--emerald-600); font-size: 13px;">+$${amount.toFixed(2)} USD</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-secondary);">Réf Facture :</span>
              <code style="font-size: 11px; background: rgba(0,0,0,0.05); padding: 2px 5px; border-radius: 4px;">${escapeHtml(data.invoiceUuid || data.transactionId)}</code>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Validation :</span>
              <span style="color: var(--primary-600); font-weight: 600;">Automatique (Blockchain)</span>
            </div>
          </div>

          ${data.paymentUrl ? `
            <a href="${data.paymentUrl}" target="_blank" class="btn-primary" style="display: block; text-decoration: none; text-align: center; margin-bottom: 10px; width: 100%;">
              Ouvrir la page de paiement Trybit ↗
            </a>
          ` : ''}

          <button type="button" class="btn-secondary" onclick="checkTrybitStatusManual('${data.transactionId}', '${data.invoiceUuid || ''}', ${amount})" style="width: 100%;">
            Vérifier le statut maintenant 🔄
          </button>
        </div>
      `;
    }

    startTrybitPolling(data.transactionId, data.invoiceUuid, amount);

  } catch (err) {
    showToast(err.message || 'Impossible d\'initier le paiement en crypto.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `Payer $${amount.toFixed(2)} USD en Crypto ⚡`;
    }
  }
}

function startTrybitPolling(txId, invoiceUuid, amount) {
  if (trybitPollingTimer) clearInterval(trybitPollingTimer);
  var attempts = 0;
  var maxAttempts = 70; // ~4 minutes de polling

  trybitPollingTimer = setInterval(async function() {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(trybitPollingTimer);
      trybitPollingTimer = null;
      return;
    }

    try {
      var query = `transactionId=${encodeURIComponent(txId)}`;
      if (invoiceUuid) query += `&invoiceUuid=${encodeURIComponent(invoiceUuid)}`;
      var resp = await fetch(`/api/payments/trybit/verify?${query}`);
      var result = await resp.json();

      if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
        clearInterval(trybitPollingTimer);
        trybitPollingTimer = null;
        onTrybitPaymentConfirmed(txId, amount, result.newBalance);
      } else if (result.status === 'failed' || result.status === 'canceled') {
        clearInterval(trybitPollingTimer);
        trybitPollingTimer = null;
        showToast('Facture Trybit annulée ou expirée.', 'error');
      }
    } catch (e) {}
  }, 3500);
}

async function checkTrybitStatusManual(txId, invoiceUuid, amount) {
  try {
    showToast('Vérification auprès du serveur Trybit...', 'info');
    var query = `transactionId=${encodeURIComponent(txId)}`;
    if (invoiceUuid) query += `&invoiceUuid=${encodeURIComponent(invoiceUuid)}`;
    var resp = await fetch(`/api/payments/trybit/verify?${query}`);
    var result = await resp.json();

    if (resp.ok && (result.status === 'completed' || result.status === 'SUCCESS')) {
      if (trybitPollingTimer) clearInterval(trybitPollingTimer);
      trybitPollingTimer = null;
      onTrybitPaymentConfirmed(txId, amount, result.newBalance);
    } else {
      showToast(result.message || 'Paiement en attente de détection sur la blockchain.', 'info');
    }
  } catch (err) {
    showToast('Erreur lors de la vérification : ' + err.message, 'error');
  }
}

function onTrybitPaymentConfirmed(txId, amount, newBalance) {
  var session = DB.get('session');
  if (session) {
    if (typeof newBalance === 'number') {
      session.balance = newBalance;
    } else {
      session.balance = (session.balance || 0) + amount;
    }
    DB.set('session', session);
  }

  var users = DB.get('users', []);
  var u = getCurrentUser();
  if (u) {
    var idx = users.findIndex(function(x) { return x.id === u.id; });
    if (idx !== -1) {
      if (typeof newBalance === 'number') {
        users[idx].balance = newBalance;
      } else {
        users[idx].balance = (users[idx].balance || 0) + amount;
      }
      DB.set('users', users);
    }
  }

  updateNavbar();
  renderConnectedCatalog();
  renderLandingCatalog();

  var container = document.getElementById('deposit-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="deposit-active-flow" style="border-color: #86efac; background: #f0fdf4;">
        <div style="font-size: 42px; margin-bottom: 8px;">🎉</div>
        <h3 style="font-size: 17px; margin: 0 0 6px 0; color: #166534;">Paiement Crypto Confirmé !</h3>
        <p style="font-size: 13px; color: #15803d; margin: 0 0 16px 0;">
          Votre solde a été crédité de <strong>+$${amount.toFixed(2)} USD</strong>.
        </p>
        <button type="button" class="btn-primary" onclick="closeDepositModal()" style="width: 100%;">
          Parfait, Continuer mes achats ⚡
        </button>
      </div>
    `;
  }

  showToast(`🎉 Félicitations ! Votre recharge de +$${amount.toFixed(2)} USD en crypto a été confirmée !`, 'success');

  if (pendingPurchaseProductId) {
    setTimeout(function() {
      closeDepositModal();
      var prodId = pendingPurchaseProductId;
      pendingPurchaseProductId = null;
      startProductPurchase(prodId);
    }, 1200);
  }
}

async function submitDepositRequest() {
  var u = getCurrentUser();
  if (!u) { openAuthModal('login'); return; }

  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 0;
  var min = getMinRecharge();

  if (amount < min) {
    showToast(`Montant inférieur au minimum. Le montant minimum de recharge est de ${min.toFixed(2)} USD.`, 'error');
    if (amountInput) amountInput.focus();
    return;
  }

  if (!currentDepositProofBase64) {
    if (!confirm("Vous n'avez pas importé de capture de paiement. Confirmer la soumission de votre demande de recharge ?")) {
      return;
    }
  }

  var methods = DB.get('payment_methods', []);
  var m = methods.find(function(x) { return x.id == currentDepositMethodId; });
  var txId = 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

  // 1. Enregistrement côté backend de production si disponible
  try {
    var resp = await fetch('/api/payments/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: u.id,
        amount: amount,
        currency: 'USD',
        paymentMethodId: m ? m.id : null,
        proofImage: currentDepositProofBase64 || null
      })
    });
    var data = await resp.json();
    if (data && data.transaction && data.transaction.id) {
      txId = data.transaction.id;
    }
  } catch (err) {
    console.warn('[Payments] API locale/hors-ligne:', err.message);
  }

  // 2. Création de la transaction en statut STRICT "En attente" (Zéro solde crédité à ce stade)
  var recharges = DB.get('recharges', []);
  var newRecharge = {
    id: txId,
    userId: u.id,
    userName: u.name,
    userEmail: u.email,
    amount: amount,
    methodId: m ? m.id : null,
    methodName: m ? m.name : 'Recharge',
    network: m && m.network ? m.network : '',
    address: m ? m.address : '',
    instructions: m ? m.instructions : '',
    proofImage: currentDepositProofBase64 || null,
    status: 'En attente',
    date: new Date().toISOString()
  };

  recharges.unshift(newRecharge);
  DB.set('recharges', recharges);

  showToast(`Demande de transaction initiée (+${amount.toFixed(2)} USD). Statut : En attente de vérification.`, 'success');
  closeDepositModal();

  if (pendingPurchaseProductId) {
    alert(`Votre demande de recharge de ${amount.toFixed(2)} USD est en cours de vérification.\n\nDès que la transaction est confirmée par le serveur ou l'administrateur, votre solde sera crédité et votre commande sera débloquée.`);
  }
}

// ========== COMMANDES & COFFRE-FORT ==========
function openOrdersModal() {
  var session = DB.get('session');
  if (!session || !session.userId || (typeof Security !== 'undefined' && !Security.isSessionValid(session))) {
    if (session) DB.del('session');
    openAuthModal('login', 'Session expirée ou invalide. Veuillez vous reconnecter pour voir vos commandes.');
    return;
  }

  var currentUserIdStr = String(session.userId);
  var currentUserEmail = (session.email || '').toLowerCase();
  var allOrders = DB.get('orders', []);
  var orders = allOrders.filter(function(o) {
    if (!o) return false;
    var matchId = o.userId && String(o.userId) === currentUserIdStr;
    var matchEmail = o.userEmail && currentUserEmail && o.userEmail.toLowerCase() === currentUserEmail;
    return matchId || matchEmail;
  });

  // Synchronisation des commandes du compte depuis le serveur si en ligne
  if (session.token) {
    fetch('/api/data/orders', {
      headers: { 'Authorization': 'Bearer ' + session.token }
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.orders && Array.isArray(res.orders)) {
        var localList = DB.get('orders', []);
        var updated = false;
        res.orders.forEach(function(so) {
          if (!localList.some(function(lo) { return lo.id === so.id; })) {
            localList.unshift(so);
            updated = true;
          }
        });
        if (updated) {
          DB.set('orders', localList);
        }
      }
    }).catch(function() {});
  }

  var container = document.getElementById('orders-container-list');

  if (orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 36px 20px; color: var(--text-muted);">
        <p style="font-size: 15px; margin-bottom: 4px;">Aucune commande pour le moment.</p>
        <p style="font-size: 12px;">Vos achats et vos contenus débloqués apparaîtront ici.</p>
      </div>
    `;
  } else {
    var html = '';
    orders.forEach(function(o) {
      var dateStr = new Date(o.date).toLocaleString('fr-FR');
      var isValidated = o.status === 'Complété' || o.status === 'Livré';
      var isPending = o.status === 'En attente';
      var isCancelled = o.status === 'Annulé';
      var qtyText = o.quantity && o.quantity > 1 ? ` (x${o.quantity})` : '';

      var statusPill = isValidated
        ? `<span class="status-indicator-pill online">✓ Livré</span>`
        : (isPending
          ? `<span class="status-indicator-pill pending">⏳ En attente</span>`
          : `<span class="status-indicator-pill rejected">✕ Annulé</span>`);

      html += `
        <div class="order-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px;">
            <div>
              <div class="order-info-title">${escapeHtml(o.productName)}${qtyText}</div>
              <div class="order-info-meta">Réf : <strong>${o.id}</strong> • ${dateStr}</div>
              <div class="order-info-meta">Paiement : <strong>${escapeHtml(o.method || 'Solde Client')}</strong></div>
              ${o.contactInfo ? `<div class="order-info-meta" style="color: var(--primary-600); font-weight: 600;">📱 Notification : ${escapeHtml(o.contactInfo)}</div>` : ''}
            </div>
            <div style="text-align: right;">
              <div style="color: var(--primary-600); font-weight: 800; font-size: 16px;">$${o.amount.toFixed(2)}</div>
              ${statusPill}
            </div>
          </div>

          ${isPending ? `
            <div style="background: #fffbeb; border: 1px dashed #fde68a; border-radius: var(--radius-sm); padding: 12px; font-size: 12px; color: #b45309; line-height: 1.45;">
              ⏳ <strong>Commande en attente de validation</strong><br>
              Votre achat est en cours de traitement par l'administrateur. Vos identifiants ou fichiers seront automatiquement débloqués dans votre coffre-fort dès confirmation.
            </div>
          ` : ''}

          ${isCancelled ? `
            <div style="background: #fff1f2; border: 1px dashed #fecdd3; border-radius: var(--radius-sm); padding: 12px; font-size: 12px; color: #e11d48; line-height: 1.45;">
              ✕ <strong>Commande annulée par l'administrateur</strong><br>
              Cette commande a été annulée. Votre solde a été recrédité de $${o.amount.toFixed(2)}.
            </div>
          ` : ''}

          ${isValidated && o.vaultContent ? `
            <div class="vault-delivery-card">
              <div class="vault-header">
                <span>🔐 CONTENU DU PRODUIT DÉBLOQUÉ</span>
                <span style="font-size: 11px; color: var(--emerald-600); font-weight: 600;">● Accès vérifié</span>
              </div>
              ${renderVaultContentDisplay(o)}
            </div>
          ` : ''}
        </div>
      `;
    });
    container.innerHTML = html;
  }

  document.getElementById('modal-orders').classList.add('active');
}

function renderVaultContentDisplay(order) {
  var v = order.vaultContent;
  if (!v) return '<p style="color: var(--text-muted); font-size: 11px;">En attente de livraison.</p>';
  var orderId = order.id;

  if (v.type === 'link') {
    return `
      <div class="vault-content-field">
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(v.content)}</span>
        <button type="button" class="btn-vault-action" onclick="copyText('${escapeHtml(v.content)}')">Copier</button>
      </div>
      <div style="margin-top: 8px;">
        <a href="${escapeHtml(v.content)}" target="_blank" rel="noopener noreferrer" class="btn-vault-action" style="background: var(--gold-500); color: #000; text-decoration: none;">
          🔗 Ouvrir le Lien Sécurisé &rarr;
        </a>
      </div>
    `;
  } else if (v.type === 'file') {
    return `
      <div class="vault-content-field">
        <span>📄 Fichier : <strong>${escapeHtml(v.fileName || 'livraison.txt')}</strong></span>
      </div>
      <div style="margin-top: 8px;">
        <button type="button" class="btn-vault-action" style="background: var(--gold-500); color: #000;" onclick="downloadVaultFile('${escapeHtml(v.fileName || 'fichier.txt')}', '${encodeURIComponent(v.content)}')">
          📥 Télécharger le Fichier
        </button>
      </div>
    `;
  } else {
    return `
      <div class="vault-content-field">
        <span id="vault-text-${orderId}" data-real="${escapeHtml(v.content)}" data-hidden="true" style="letter-spacing: 2px;">
          ••••••••••••••••••••••••••••••••••••
        </span>
      </div>
      <div style="display: flex; gap: 6px; margin-top: 8px;">
        <button type="button" class="btn-vault-action" onclick="toggleVaultSecret('${orderId}')">
          <span id="vault-icon-${orderId}">👁️</span>
          <span id="vault-label-${orderId}">Révéler</span>
        </button>
        <button type="button" class="btn-vault-action" onclick="copyText('${escapeHtml(v.content)}')">
          📋 Copier
        </button>
      </div>
    `;
  }
}

function toggleVaultSecret(orderId) {
  var textEl = document.getElementById('vault-text-' + orderId);
  var iconEl = document.getElementById('vault-icon-' + orderId);
  var labelEl = document.getElementById('vault-label-' + orderId);
  if (!textEl) return;

  var isHidden = textEl.getAttribute('data-hidden') === 'true';
  if (isHidden) {
    textEl.textContent = textEl.getAttribute('data-real');
    textEl.style.letterSpacing = 'normal';
    textEl.setAttribute('data-hidden', 'false');
    if (iconEl) iconEl.textContent = '🙈';
    if (labelEl) labelEl.textContent = 'Masquer';
  } else {
    textEl.textContent = '••••••••••••••••••••••••••••••••••••';
    textEl.style.letterSpacing = '2px';
    textEl.setAttribute('data-hidden', 'true');
    if (iconEl) iconEl.textContent = '👁️';
    if (labelEl) labelEl.textContent = 'Révéler';
  }
}

function copyText(val) {
  navigator.clipboard.writeText(val).then(function() { showToast('Copié dans le presse-papiers !', 'success'); });
}

function downloadVaultFile(filename, encodedContent) {
  var content = decodeURIComponent(encodedContent);
  var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('Téléchargement lancé !', 'success');
}

function closeOrdersModal() {
  document.getElementById('modal-orders').classList.remove('active');
}

// ========== AUTHENTIFICATION & GOOGLE ==========
function openAuthModal(tab, msg) {
  switchAuthTab(tab || 'login');
  var err = document.getElementById('login-error-msg');
  if (err) {
    if (msg) { err.textContent = msg; err.style.color = 'var(--gold-500)'; err.classList.remove('hidden'); }
    else err.classList.add('hidden');
  }
  document.getElementById('auth-modal').classList.add('active');
  // Re-tenter l'initialisation de Google si nécessaire
  if (window.google && window.google.accounts && window.google.accounts.id) {
    initGoogleIdentity();
  }
}

function closeAuthModal() { document.getElementById('auth-modal').classList.remove('active'); }

function switchAuthTab(t) {
  var lf = document.getElementById('modal-login-form');
  var rf = document.getElementById('modal-register-form');
  var tl = document.getElementById('tab-modal-login');
  var tr = document.getElementById('tab-modal-register');
  if (t === 'login') {
    lf.classList.remove('hidden'); rf.classList.add('hidden');
    tl.classList.add('active'); tr.classList.remove('active');
  } else {
    rf.classList.remove('hidden'); lf.classList.add('hidden');
    tr.classList.add('active'); tl.classList.remove('active');
  }
}

// ========== AUTHENTIFICATION SÉCURISÉE PRODUCTION (EMAIL & GOOGLE OAUTH 2.0) ==========
var DEFAULT_GOOGLE_CLIENT_ID = '136687010554-fnp29c7llrd6vi2mmbu4sbfat9c5simj.apps.googleusercontent.com';
var configuredGoogleClientId = DEFAULT_GOOGLE_CLIENT_ID;
var isGoogleIdentityInitialized = false;
var googleCodeClient = null;

// Initialisation de Google Identity Services
async function initGoogleIdentity() {
  try {
    var res = await fetch('/api/auth/config');
    if (res.ok) {
      var conf = await res.json();
      if (conf && conf.googleClientId) {
        configuredGoogleClientId = conf.googleClientId;
      }
    }
  } catch (e) {
    console.log('[Google Auth] Initialisation locale avec Client ID configuré.');
  }

  var clientId = configuredGoogleClientId || DEFAULT_GOOGLE_CLIENT_ID;

  // 1. Initialiser le Code Client OAuth 2.0 officiel (pour ouverture directe du sélecteur au clic)
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    try {
      googleCodeClient = window.google.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope: 'openid email profile',
        ux_mode: 'popup',
        callback: function(resp) {
          if (resp && resp.code) {
            handleGoogleCodeExchange(resp.code);
          } else if (resp && resp.error) {
            console.warn('[Google Auth] Erreur popup OAuth:', resp.error);
          }
        }
      });
    } catch (e) {
      console.warn('[Google Auth] Erreur initCodeClient:', e);
    }
  }

  // 2. Initialiser One Tap et callback ID Token si supporté
  if (window.google && window.google.accounts && window.google.accounts.id) {
    try {
      if (!isGoogleIdentityInitialized) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleCredentialResponse,
          auto_select: false,
          cancel_on_tap_outside: true
        });
        isGoogleIdentityInitialized = true;
      }
    } catch (err) {
      console.warn('[Google Auth] Erreur initialisation Google Identity:', err);
    }
  }
}

function fallbackToGoogleRedirect() {
  var clientId = configuredGoogleClientId || DEFAULT_GOOGLE_CLIENT_ID;
  var redirectUri = window.location.origin + '/api/auth/google/callback';
  var googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    'client_id=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('openid email profile') +
    '&prompt=select_account';
  window.location.href = googleAuthUrl;
}

// Déclencheur du bouton "Continuer avec Google" (Ouvre DIRECTEMENT le sélecteur de compte Google)
function handleGoogleAuthTrigger() {
  var clientId = configuredGoogleClientId || DEFAULT_GOOGLE_CLIENT_ID;

  // 1. Ouvrir immédiatement la popup officielle Google OAuth 2.0 pour choisir son compte
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    try {
      if (!googleCodeClient) {
        googleCodeClient = window.google.accounts.oauth2.initCodeClient({
          client_id: clientId,
          scope: 'openid email profile',
          ux_mode: 'popup',
          callback: function(resp) {
            if (resp && resp.code) {
              handleGoogleCodeExchange(resp.code);
            } else if (resp && resp.error) {
              console.warn('[Google Auth] Erreur popup OAuth:', resp.error);
              if (resp.error === 'popup_closed_by_user') {
                showToast('Connexion Google annulée.', 'info');
              } else {
                fallbackToGoogleRedirect();
              }
            }
          },
          error_callback: function(err) {
            console.warn('[Google Auth] Error callback popup:', err);
            fallbackToGoogleRedirect();
          }
        });
      }
      googleCodeClient.requestCode();
      return;
    } catch (err) {
      console.warn('[Google Auth] Erreur codeClient.requestCode():', err);
    }
  }

  // 2. Si Google One Tap est disponible
  if (window.google && window.google.accounts && window.google.accounts.id) {
    try {
      window.google.accounts.id.prompt();
      return;
    } catch (e) {}
  }

  // 3. Fallback direct : redirection vers l'écran officiel Google de sélection de compte
  fallbackToGoogleRedirect();
}

function closeGoogleConfigModal() {
  var modal = document.getElementById('google-config-modal');
  if (modal) modal.classList.remove('active');
}

// Échange du code d'autorisation OAuth 2.0 auprès du serveur
async function handleGoogleCodeExchange(code) {
  try {
    showToast('Connexion Google en cours... ⏳', 'info');
    var res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, redirect_uri: 'postmessage' })
    });
    var data = await res.json();

    if (!res.ok || (!data.success && !data.session)) {
      throw new Error(data.error || 'Échec de vérification du compte Google.');
    }

    applyAuthenticatedSession(data);
  } catch (err) {
    showToast(err.message || 'Erreur lors de la connexion Google.', 'error');
  }
}

// Réception et vérification du jeton officiel Google ID Token (One Tap)
async function handleGoogleCredentialResponse(response) {
  if (!response || !response.credential) {
    showToast('Erreur lors de l\'authentification Google.', 'error');
    return;
  }

  try {
    var res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    var data = await res.json();

    if (!res.ok || (!data.success && !data.session)) {
      throw new Error(data.error || 'Vérification Google échouée.');
    }

    applyAuthenticatedSession(data);
  } catch (err) {
    showToast(err.message || 'Échec de connexion Google.', 'error');
  }
}

function applyAuthenticatedSession(data) {
  if (!data || !data.session) return;
  AuthState.setAuthenticatedSession(data.session, data.user, 'google');

  closeAuthModal();
  showToast(`Connecté avec succès : ${data.user.name} ! 👋`, 'success');
  if (window.location.hash !== '#catalog') {
    try { history.pushState(null, '', '#catalog'); } catch (e) {}
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
}

// 1. CONNEXION AVEC EMAIL OU NOM D'UTILISATEUR ET MOT DE PASSE
async function handleLoginSubmit(e) {
  e.preventDefault();
  var email = document.getElementById('login-email').value.trim().toLowerCase();
  var pass = document.getElementById('login-password').value;
  var err = document.getElementById('login-error-msg');
  err.classList.add('hidden');

  // Anti brute-force côté client
  if (typeof Security !== 'undefined') {
    var rl = Security.checkRateLimit('client_login', 5, 5 * 60 * 1000);
    if (!rl.allowed) {
      err.textContent = 'Trop de tentatives infructueuses. Veuillez patienter ' + rl.waitSeconds + ' secondes.';
      err.style.color = 'var(--rose-500)';
      err.classList.remove('hidden');
      return;
    }
  }

  // Tentative via l'API de production backend
  try {
    var res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, email: email, password: pass })
    });
    var data = await res.json();

    if (res.ok && (data.success || data.session)) {
      if (typeof Security !== 'undefined') Security.resetRateLimit('client_login');

      if (data.user && data.user.role === 'admin') {
        DB.set('session', data.session);
        showToast('Connexion administrateur réussie ! 🔒', 'success');
        setTimeout(function() { window.location.href = 'admin.html'; }, 350);
        return;
      }

      AuthState.setAuthenticatedSession(data.session, data.user, 'password');
      showToast('Bienvenue ' + data.user.name + ' ! 👋', 'success');
      closeAuthModal();

      if (window.location.hash !== '#catalog') {
        try { history.pushState(null, '', '#catalog'); } catch (e) {}
      }

      if (pendingPurchaseProductId) {
        var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
        startProductPurchase(pId);
      }
      return;
    } else if (res.status === 400 || res.status === 401 || res.status === 429) {
      err.textContent = data.error || 'Adresse e-mail, nom d\'utilisateur ou mot de passe incorrect.';
      err.style.color = 'var(--rose-500)';
      err.classList.remove('hidden');
      return;
    }
  } catch (apiErr) {
    console.warn('[Auth] Backend distant inaccessible, bascule sur authentification locale:', apiErr.message);
  }

  // Fallback local sécurisé
  var isAdminEmail = (email === 'admin@getvirtu.shop' || email === 'admin@virtushop.com' || email === 'admin');
  var isCorrectAdminPass = false;
  if (typeof Security !== 'undefined') {
    isCorrectAdminPass = await Security.verifyPassword(pass, ADMIN_HASH, ADMIN_SALT) || await Security.verifyPassword(pass, ADMIN_LEGACY_HASH, ADMIN_SALT);
  } else {
    isCorrectAdminPass = (pass === 'admin123' || pass === 'admin');
  }

  if (isAdminEmail && isCorrectAdminPass) {
    if (typeof Security !== 'undefined') {
      Security.resetRateLimit('client_login');
      DB.set('session', Security.createSession(ADMIN, 'admin'));
    } else {
      DB.set('session', { userId: ADMIN.id, role: 'admin', name: ADMIN.name, email: ADMIN.email });
    }
    showToast('Connexion administrateur réussie ! 🔒', 'success');
    setTimeout(function() { window.location.href = 'admin.html'; }, 350);
    return;
  }

  var users = DB.get('users', []);
  var matchedUser = null;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (!u) continue;
    var matchEmail = (u.email && u.email.toLowerCase() === email) ||
                     (u.username && u.username.toLowerCase() === email) ||
                     (u.name && u.name.toLowerCase() === email);
    if (!matchEmail) continue;

    var passMatch = false;
    if (u.passwordHash && typeof Security !== 'undefined') {
      passMatch = await Security.verifyPassword(pass, u.passwordHash, ADMIN_SALT);
    } else if (u.password_hash && typeof Security !== 'undefined') {
      passMatch = await Security.verifyPassword(pass, u.password_hash, ADMIN_SALT);
    }

    if (passMatch) {
      matchedUser = u;
      break;
    }
  }

  if (!matchedUser) {
    if (typeof Security !== 'undefined') {
      Security.recordFailedAttempt('client_login', 5 * 60 * 1000);
      var rlAfter = Security.checkRateLimit('client_login', 5, 5 * 60 * 1000);
      err.textContent = 'Adresse e-mail, identifiant ou mot de passe incorrect.' + (rlAfter.remaining <= 3 ? ' (' + rlAfter.remaining + ' tentative(s) restante(s))' : '');
    } else {
      err.textContent = 'Adresse e-mail, identifiant ou mot de passe incorrect.';
    }
    err.style.color = 'var(--rose-500)';
    err.classList.remove('hidden');
    return;
  }

  if (typeof Security !== 'undefined') {
    Security.resetRateLimit('client_login');
  }
  var sessionObj = (typeof Security !== 'undefined')
    ? Security.createSession(matchedUser, matchedUser.role || 'client')
    : { userId: matchedUser.id, role: matchedUser.role || 'client', name: matchedUser.name, email: matchedUser.email };

  AuthState.setAuthenticatedSession(sessionObj, matchedUser, 'password_local');
  showToast('Bienvenue ' + matchedUser.name + ' ! 👋', 'success');
  closeAuthModal();
  if (window.location.hash !== '#catalog') {
    try { history.pushState(null, '', '#catalog'); } catch (e) {}
  }
  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
}

// 2. INSCRIPTION AVEC EMAIL ET MOT DE PASSE (PRODUCTION : 0.00 $ DE SOLDE DE DÉPART)
async function handleRegisterSubmit(e) {
  e.preventDefault();
  var name = document.getElementById('reg-name').value.trim();
  var usernameInput = document.getElementById('reg-username');
  var username = usernameInput ? usernameInput.value.trim().toLowerCase() : '';
  var email = document.getElementById('reg-email').value.trim().toLowerCase();
  var pass = document.getElementById('reg-password').value;
  var passConfirm = document.getElementById('reg-password-confirm').value;
  var err = document.getElementById('reg-error-msg');
  err.classList.add('hidden');

  // Validations strictes de production
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    err.textContent = 'Veuillez saisir une adresse e-mail valide.';
    err.classList.remove('hidden'); return;
  }

  if (username && username.length < 3) {
    err.textContent = 'Le nom d\'utilisateur doit comporter au moins 3 caractères.';
    err.classList.remove('hidden'); return;
  }

  if (username && !/^[a-zA-Z0-9_]+$/.test(username)) {
    err.textContent = 'Le nom d\'utilisateur ne peut contenir que des lettres, chiffres et tirets bas (_).';
    err.classList.remove('hidden'); return;
  }

  if (pass.length < 8) {
    err.textContent = 'Le mot de passe doit comporter au moins 8 caractères.';
    err.classList.remove('hidden'); return;
  }

  if (!/[A-Za-z]/.test(pass) || !/[0-9]/.test(pass)) {
    err.textContent = 'Le mot de passe doit combiner au moins une lettre et un chiffre.';
    err.classList.remove('hidden'); return;
  }

  if (pass !== passConfirm) {
    err.textContent = 'Les deux mots de passe ne correspondent pas.';
    err.classList.remove('hidden'); return;
  }

  // 1. Appel du backend de production
  try {
    var res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        username: username,
        email: email,
        password: pass,
        confirmPassword: passConfirm
      })
    });
    var data = await res.json();

    if (res.ok && (data.success || data.session)) {
      AuthState.setAuthenticatedSession(data.session, data.user, 'register');
      showToast(`Compte créé avec succès ! Bienvenue ${data.user.name} ⚡`, 'success');
      closeAuthModal();

      if (window.location.hash !== '#catalog') {
        try { history.pushState(null, '', '#catalog'); } catch (e) {}
      }

      if (pendingPurchaseProductId) {
        var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
        startProductPurchase(pId);
      }
      return;
    } else if (res.status === 400 || res.status === 409) {
      err.textContent = data.error || 'Erreur lors de l\'inscription.';
      err.classList.remove('hidden');
      return;
    }
  } catch (apiErr) {
    console.warn('[Auth] Backend distant inaccessible, bascule sur inscription locale:', apiErr.message);
  }

  // Fallback local si backend hors-ligne
  var users = DB.get('users', []);
  if (users.some(function(u) { return u.email && u.email.toLowerCase() === email; })) {
    err.textContent = 'Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter.';
    err.classList.remove('hidden'); return;
  }
  if (username && users.some(function(u) { return u.username && u.username.toLowerCase() === username; })) {
    err.textContent = 'Ce nom d\'utilisateur est déjà pris. Veuillez en choisir un autre.';
    err.classList.remove('hidden'); return;
  }

  var passwordHash = typeof Security !== 'undefined'
    ? await Security.hashPassword(pass, ADMIN_SALT)
    : pass;

  var safeName = typeof Security !== 'undefined' ? Security.escapeHtml(name) : name;

  // Strict zéro solde de départ en production (0.00 USD)
  var newUser = {
    id: 'user-' + Date.now(),
    name: safeName,
    username: username || email.split('@')[0],
    email: email,
    password_hash: passwordHash,
    role: 'client',
    balance: 0.00, // Zéro strict
    avatarColor: '#2563eb',
    created_at: new Date().toISOString()
  };

  users.push(newUser);
  DB.set('users', users);

  var sessionObj = (typeof Security !== 'undefined')
    ? Security.createSession(newUser, 'client')
    : { userId: newUser.id, role: 'client', name: newUser.name, email: newUser.email };

  AuthState.setAuthenticatedSession(sessionObj, newUser, 'register_local');
  showToast(`Compte créé avec succès ! Bienvenue ${newUser.name} ⚡`, 'success');
  closeAuthModal();

  if (window.location.hash !== '#catalog') {
    try { history.pushState(null, '', '#catalog'); } catch (e) {}
  }

  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
}

async function handleLogout() {
  var s = AuthState.getSession();
  if (s && s.token) {
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + s.token }
      });
    } catch (e) {}
  }
  AuthState.clearSession();
  showToast('Déconnecté avec succès.', 'success');
  if (window.location.hash === '#catalog') {
    try { history.pushState(null, '', '#hero'); } catch (e) {}
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleFaq(btn) {
  var item = btn.parentElement;
  var wasActive = item.classList.contains('active');
  document.querySelectorAll('.faq-item').forEach(function(el) { el.classList.remove('active'); });
  if (!wasActive) item.classList.add('active');
}

function renderFooterBadges() {
  var c = document.getElementById('footer-payment-badges');
  if (!c) return;
  c.innerHTML = `
    <div class="footer-pay-card">
      <span class="footer-pay-icon">💳</span>
      <span class="footer-pay-name">Solde GetVirtu</span>
    </div>
    <div class="footer-pay-card">
      <span class="footer-pay-icon">📱</span>
      <span class="footer-pay-name">Mobile Money</span>
    </div>
    <div class="footer-pay-card">
      <span class="footer-pay-icon">⚡</span>
      <span class="footer-pay-name">Crypto Instantané</span>
    </div>
  `;
}

function showToast(msg, type) {
  var t = document.getElementById('toast');
  if (!t) return;
  var icon = type === 'success' ? '✓' : (type === 'error' ? '⚠️' : 'ℹ️');
  t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
  t.className = 'toast-' + (type || 'info');
  t.style.display = 'flex';
  t.style.animation = 'toastCenterIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    t.style.animation = 'toastCenterOut 0.22s ease forwards';
    setTimeout(function() {
      t.style.display = 'none';
      t.style.animation = '';
    }, 220);
  }, 3200);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('storage', function(e) {
  if (e.key && e.key.indexOf('vs_') === 0) routeUserExperience();
});

window.addEventListener('hashchange', function() {
  routeUserExperience();
});

window.addEventListener('popstate', function() {
  routeUserExperience();
});

window.addEventListener('focus', function() {
  syncUserSessionAndBalance();
});

setInterval(function() {
  var s = AuthState.getSession();
  if (s && s.userId) syncUserSessionAndBalance();
}, 15000);

function startApp() {
  console.log('[GetVirtu] Initialisation client (Production)...');
  try {
    initDB();

    // Nettoyage de sécurité : si la session courante en stockage est celle d'un admin, la détacher du client
    var currentS = DB.get('session');
    if (currentS && (currentS.role === 'admin' || (currentS.email && currentS.email.toLowerCase().includes('admin@')))) {
      DB.del('session');
      AuthState._session = null;
      AuthState._user = null;
    }

    // Nettoyage fluide du paramètre URL après retour Google OAuth
    if (window.location.search && window.location.search.includes('auth_success=google')) {
      try { history.replaceState(null, '', window.location.pathname + '#catalog'); } catch (e) {}
    }

    // Traçabilité des visites réelles (Prompt 8)
    trackVisitor();

    // Routage immédiat et synchrone
    routeUserExperience();
    initGoogleIdentity();
    syncUserSessionAndBalance();
  } catch (e) {
    console.error('[GetVirtu startApp]', e);
  }
}

// Basculement instantané vers le tableau de bord administrateur (Prompt 9)
function switchToAdmin() {
  var s = AuthState.getSession() || DB.get('admin_session');
  if (s) {
    DB.set('admin_session', s);
    DB.set('session', s);
  }
  window.location.href = 'admin.html';
}

// Traçabilité des visites réelles et visiteurs uniques
function trackVisitor() {
  try {
    var vid = localStorage.getItem('gv_visitor_id');
    var isNew = false;
    if (!vid) {
      vid = 'v_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('gv_visitor_id', vid);
      isNew = true;
    }
    var todayStr = new Date().toISOString().split('T')[0];
    var lastVisit = localStorage.getItem('gv_last_visit_date');
    if (lastVisit !== todayStr) {
      localStorage.setItem('gv_last_visit_date', todayStr);
      var visits = DB.get('visitor_logs', []);
      visits.push({
        id: 'vis_' + Date.now(),
        vid: vid,
        isNew: isNew,
        date: new Date().toISOString()
      });
      if (visits.length > 3000) visits = visits.slice(-3000);
      DB.set('visitor_logs', visits);

      fetch('/api/data/visitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vid: vid, isNew: isNew })
      }).catch(function() {});
    }
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
