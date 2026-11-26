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

// ========== JETON DE SESSION AUTOMATIQUE POUR LES APPELS /api/ ==========
// Les vérifications de paiement et les téléchargements exigent désormais la session du client :
// le jeton est ajouté automatiquement aux requêtes same-origin /api/ qui n'en fournissent pas.
(function installSessionFetch() {
  if (window.__gvSessionFetch || typeof window.fetch !== 'function') return;
  window.__gvSessionFetch = true;
  var originalFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      var url = typeof input === 'string' ? input : ((input && input.url) || '');
      var sameOriginApi = url.indexOf('/api/') === 0 || url.indexOf(window.location.origin + '/api/') === 0;
      if (sameOriginApi) {
        var s = null;
        try { s = JSON.parse(localStorage.getItem('vs_session') || 'null'); } catch (e) {}
        var token = s && s.token;
        if (token) {
          init = Object.assign({}, init || {});
          var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
          if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + token);
          init.headers = h;
        }
      }
    } catch (e) {}
    return originalFetch(input, init);
  };
})();

// ========== RÉSEAU : DÉLAI MAXIMAL PAR REQUÊTE + BANDEAU DE CONNEXION ==========
// Une connexion lente ou coupée ne laisse jamais une page bloquée en chargement infini.
function gvFetch(url, init, timeoutMs) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var opts = Object.assign({}, init || {});
  if (ctrl) opts.signal = ctrl.signal;
  var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, timeoutMs || 15000) : null;
  return fetch(url, opts).finally(function() { if (timer) clearTimeout(timer); });
}

function gvSetNetBanner(show, text) {
  var el = document.getElementById('gv-net-banner');
  if (!show) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'gv-net-banner';
    el.className = 'gv-net-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.innerHTML = '<span>' + escapeHtml(text) + '</span><button type="button" onclick="gvRetryConnection()">Réessayer</button>';
}

function gvRetryConnection() {
  gvSetNetBanner(true, 'Nouvelle tentative de connexion…');
  syncProductsFromServer(true);
  syncPaymentMethodsFromServer();
  syncUserSessionAndBalance();
}

window.addEventListener('offline', function() {
  gvSetNetBanner(true, 'Vous êtes hors ligne. Les informations affichées seront actualisées dès le retour de la connexion.');
});
window.addEventListener('online', function() {
  gvSetNetBanner(false);
  syncProductsFromServer(true);
  syncPaymentMethodsFromServer();
  syncUserSessionAndBalance();
  if (typeof resumeMomoTracking === 'function') { try { resumeMomoTracking(); } catch (e) {} }
});

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
      // Auto-restauration de la session depuis session uniquement
      this._session = DB.get('session');
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
    // Garantie stricte de cohérence : le rôle de la session fait foi
    if (s.role && u.role !== s.role) {
      u.role = s.role;
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

    // Détermination stricte et sécurisée du rôle utilisateur
    if (user && user.role) {
      session.role = user.role;
    } else if (!session.role) {
      session.role = 'client';
    }

    this._session = session;
    DB.set('session', session);

    if (session.role === 'admin') {
      DB.set('admin_session', session);
    } else {
      // Pour les clients : suppression définitive et immédiate de tout reliquat admin
      DB.del('admin_session');
      try {
        localStorage.removeItem('vs_admin_session');
      } catch (e) {}
    }

    if (user) {
      if (session.role) user.role = session.role;
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

    console.log('[AuthState] Session établie (' + (source || 'direct') + ') pour :', session.email, '| Rôle :', session.role);

    this.notify();
    routeUserExperience();
    updateNavbar();
  },

  clearSession: function() {
    this._session = null;
    this._user = null;
    DB.del('session');
    DB.del('admin_session');
    // Données personnelles en cache (commandes avec clés livrées, comptes...) : jamais conservées après déconnexion
    ['orders', 'users', 'vault', 'recharges', 'transactions'].forEach(function(k) { DB.del(k); });
    window._vaultSecretsCache = {};
    try {
      localStorage.removeItem('vs_session');
      localStorage.removeItem('vs_admin_session');
    } catch (e) {}
    this.notify();
    routeUserExperience();
    updateNavbar();
  }
};

// Aucune empreinte de mot de passe ni compte administrateur n'est embarqué dans le navigateur :
// l'authentification est exclusivement vérifiée par le serveur (/api/auth).

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

// Image de repli si l'image d'un produit ne se charge pas (URL cassée, donnée corrompue)
window.GV_PRODUCT_FALLBACK_IMG = getReliableProductSvg(null, 'GETVIRTU', 'blue');

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

  // Méthodes de paiement officielles : seul le Mobile Money est proposé. L'ancienne passerelle crypto Trybit
  // est retirée, y compris d'un éventuel cache local d'un visiteur précédent.
  var currentMethods = DB.get('payment_methods', null);
  if (Array.isArray(currentMethods)) {
    currentMethods = currentMethods.filter(function(m) { return m && m.provider !== 'trybit' && m.type !== 'crypto_trybit'; });
  }
  if (!currentMethods || !Array.isArray(currentMethods) || currentMethods.length === 0) {
    currentMethods = [
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
      }
    ];
  }
  DB.set('payment_methods', currentMethods);

  // Synchronisation asynchrone avec les moyens de paiement configurés sur le serveur
  try {
    fetch('/api/data/methods').then(function(r) { return r.json(); }).then(function(d) {
      if (d && Array.isArray(d.methods) && d.methods.length > 0) {
        DB.set('payment_methods', d.methods);
      }
    }).catch(function() {});
  } catch (e) {}

  // (Plus de compte administrateur fictif en stockage local : seul le serveur fait foi.)
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

// Synchronisation du solde, des commandes et de la session en direct avec le serveur
async function syncUserSessionAndBalance() {
  var s = AuthState.getSession();
  if (!s || !s.userId) return;
  try {
    var token = s.token || '';
    var res = await gvFetch('/api/auth/me?_t=' + Date.now(), {
      cache: 'no-store',
      headers: token ? { 'Authorization': 'Bearer ' + token, 'Cache-Control': 'no-cache' } : { 'Cache-Control': 'no-cache' }
    }, 15000);
    if (res.ok) {
      var data = await res.json();
      if (data && data.user) {
        var serverSession = data.session || s;
        serverSession.role = data.user.role || serverSession.role || 'client';
        if (serverSession.role !== 'admin') {
          DB.del('admin_session');
          try { localStorage.removeItem('vs_admin_session'); } catch (e) {}
        }
        AuthState.setAuthenticatedSession(serverSession, data.user, 'server_sync');
        if (data.user.mustChangePassword && !document.getElementById('modal-account').classList.contains('active')) {
          openAccountModal(true);
        }
      }
    } else if (res.status === 401) {
      console.warn('[Auth] Session révoquée côté serveur.');
      AuthState.clearSession();
    }
  } catch (e) {}

  // Synchronisation des commandes du client en arrière-plan
  if (s.token) {
    syncUserOrdersFromServer(s.token);
  }
}

// Synchronisation des commandes du client depuis le serveur
async function syncUserOrdersFromServer(token) {
  if (!token) return;
  try {
    var res = await gvFetch('/api/data/orders?_t=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Cache-Control': 'no-cache' }
    }, 20000);
    if (res.ok) {
      var data = await res.json();
      if (data && Array.isArray(data.orders)) {
        var s = AuthState.getSession();
        if (s && s.role === 'admin') {
          DB.set('orders', data.orders);
        } else if (s && s.userId) {
          var curId = String(s.userId);
          var curEmail = (s.email || '').toLowerCase();
          var otherUsersOrders = (DB.get('orders', []) || []).filter(function(lo) {
            if (!lo) return false;
            var matchId = lo.userId && String(lo.userId) === curId;
            var matchEmail = lo.userEmail && curEmail && lo.userEmail.toLowerCase() === curEmail;
            return !matchId && !matchEmail;
          });
          DB.set('orders', data.orders.concat(otherUsersOrders));
        }
      }
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
  var tabBoutique = document.getElementById('nav-tab-boutique');
  if (tabBoutique) tabBoutique.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showPublicLanding() {
  document.getElementById('landing-view').classList.remove('hidden');
  document.getElementById('connected-view').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigateShopSection(sectionId, event) {
  if (event && event.preventDefault) event.preventDefault();
  var s = AuthState.getSession();
  var isAuth = !!(s && s.userId);
  var landingView = document.getElementById('landing-view');
  var connectedView = document.getElementById('connected-view');

  // Mise à jour de l'état actif dans la barre visiteur
  var navLinks = document.querySelectorAll('#nav-public-links .nav-link');
  navLinks.forEach(function(link) {
    link.classList.toggle('active', link.getAttribute('href') === '#' + sectionId);
  });

  if (isAuth && sectionId === 'catalog') {
    if (landingView) landingView.classList.add('hidden');
    if (connectedView) connectedView.classList.remove('hidden');
    var tabB = document.getElementById('nav-tab-boutique');
    if (tabB) tabB.classList.add('active');
    if (connectedView) {
      connectedView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return false;
  }

  // Pour les sections d'information (#how-it-works, #faq, #features, #reviews, #hero) ou visiteur #catalog
  if (landingView && landingView.classList.contains('hidden')) {
    landingView.classList.remove('hidden');
    if (isAuth && connectedView) {
      connectedView.classList.add('hidden');
      var tabBout = document.getElementById('nav-tab-boutique');
      if (tabBout) tabBout.classList.remove('active');
    }
  }

  var targetEl = document.getElementById(sectionId);
  if (targetEl) {
    var headerOffset = 72;
    var topPos = Math.max(0, targetEl.getBoundingClientRect().top + (window.pageYOffset || window.scrollY || 0) - headerOffset);
    window.scrollTo({ top: topPos, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (!isAuth && window.history && window.history.replaceState) {
    try { window.history.replaceState(null, '', '#' + sectionId); } catch (e) {}
  }
  return false;
}
window.navigateShopSection = navigateShopSection;

function handleLogoClick() {
  var s = AuthState.getSession();
  if (s && s.userId) showConnectedCatalog();
  else navigateShopSection('hero');
}

// ========== BARRE DE NAVIGATION (SOLDE + PROFIL) ==========
function updateNavbar() {
  var session = AuthState.getSession();
  var isAuth = !!(session && session.userId);
  var container = document.getElementById('nav-user-actions');
  var navPublic = document.getElementById('nav-public-links');
  var navConnected = document.getElementById('nav-connected-links');
  var navAdminLi = document.getElementById('nav-admin-link-li');
  if (!container) return;

  // Cohérence des liens de navigation
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
    // Séparation stricte : Seul un utilisateur authentifié avec role === 'admin' est administrateur
    var isAdmin = Boolean(session && session.userId && session.role === 'admin');

    // Afficher ou masquer l'onglet "Espace Admin" dans la barre de navigation centrale (Capture 2)
    if (navAdminLi) {
      if (isAdmin) {
        navAdminLi.classList.remove('hidden');
      } else {
        navAdminLi.classList.add('hidden');
      }
    }

    container.innerHTML = `
      <!-- Capsule Solde avec bouton + : 1 ligne nette -->
      <div class="balance-pill" title="Votre solde disponible">
        <span class="balance-label">Solde :</span>
        <strong class="balance-amount">$${bal.toFixed(2)}</strong>
        <button type="button" class="btn-add-balance" title="Recharger mon solde (+)" onclick="openDepositModal()">+</button>
      </div>

      <!-- Profil Utilisateur & Menu Déroulant (Sans Scrollbar, Pleine Hauteur) -->
      <div class="user-profile-wrapper">
        <button type="button" class="btn-user-profile" onclick="toggleUserDropdown(event)" aria-label="Menu profil">
          <span class="user-avatar-circle">${escapeHtml((session.name || session.email || 'C').charAt(0).toUpperCase())}</span>
          <span class="user-profile-name">${escapeHtml(session.name || 'Client')}</span>
          <span class="user-profile-chevron" style="font-size: 10px; color: var(--text-muted); margin-left: 2px;">▾</span>
        </button>

        <div class="user-dropdown-menu" id="user-dropdown">
          <div class="dropdown-user-header">
            <div style="font-weight: 700; font-size: 13px;">${escapeHtml(session.name || 'Client')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(session.email || '')}</div>
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
          <a href="javascript:void(0)" class="dropdown-item" onclick="openAccountModal(); toggleUserDropdown();">
            <span>👤</span> Mon compte
          </a>
          <div style="border-top: 1px solid var(--border-subtle); margin: 4px 0;"></div>
          <a href="javascript:void(0)" class="dropdown-item danger" onclick="handleLogout(); toggleUserDropdown();">
            <span>🚪</span> Déconnexion
          </a>
        </div>
      </div>
    `;
  } else {
    if (navAdminLi) navAdminLi.classList.add('hidden');
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

  // Mise en avant : les produits disponibles d'abord (un produit en rupture n'occupe jamais les premières places)
  var prods = getConsolidatedProducts();
  var topProds = prods.slice(0, 3);

  if (topProds.length === 0) {
    var showcasePlaceholder = catalogPlaceholderHtml(true);
    if (showcasePlaceholder) { container.innerHTML = showcasePlaceholder; return; }
    container.innerHTML = `
      <div style="text-align: center; padding: 28px 16px; color: var(--text-muted);">
        <div style="font-size: 26px; margin-bottom: 6px;">📦</div>
        <div style="font-size: 13.5px; font-weight: 700; color: var(--text-primary);">Aucun produit disponible pour le moment</div>
        <div style="font-size: 11.5px; margin-top: 4px; color: var(--text-secondary);">De nouveaux comptes et services vérifiés seront bientôt disponibles.</div>
      </div>
    `;
    return;
  }

  var html = '';
  topProds.forEach(function(p) {
    var buy = productBuyInfo(p);
    var oos = !buy.available;
    var safeImg = sanitizeProductImage(p.image, p.category, p.name);
    html += `
      <div class="showcase-item">
        <div class="showcase-item-info product-open-details" role="button" tabindex="0" title="Voir la fiche produit" onclick="openProductDetails(${productIdArg(p.id)})">
          <img src="${safeImg}" class="showcase-thumb" alt="${escapeHtml(p.name)}" onerror="this.onerror=null;this.src=window.GV_PRODUCT_FALLBACK_IMG;">
          <div style="min-width: 0; flex: 1; overflow: hidden;">
            <h4 class="showcase-title">${escapeHtml(p.name)}</h4>
            <span class="showcase-stock-badge ${oos ? 'oos' : ''}">${buy.shortLabel}</span>
          </div>
        </div>
        <div class="showcase-pricing-action">
          <div class="showcase-price-box">
            <span class="showcase-price-val">$${p.price.toFixed(2)}</span>
          </div>
          ${buy.external ? externalBuyAnchorHtml(buy, 'btn-primary btn-sm showcase-buy-btn btn-light-sweep', 'Acheter ⚡', p.name) : `<button type="button" class="btn-primary btn-sm showcase-buy-btn btn-light-sweep" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${typeof p.id === 'number' ? p.id : "'" + String(p.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"})">
            ${oos ? 'Rupture' : 'Acheter ⚡'}
          </button>`}
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

function getConsolidatedProducts() {
  var rawProds = (DB.get('products', []) || []).filter(function(p) { return p && p.published; });
  var vault = DB.get('vault', {}) || {};

  var map = new Map();
  rawProds.forEach(function(p) {
    if (!p) return;
    var norm = (p.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!norm) return;

    var v = vault[p.id];
    // Quantité masquée par l'administrateur (stock = null) ou produit à lien externe (quantité indicative) : valeur du serveur conservée
    var actualStock;
    if (p.stock === null) actualStock = null;
    else if (p.purchaseMode !== 'redirect' && v && Array.isArray(v.keys)) actualStock = v.keys.filter(function(k) { return !k.used; }).length;
    else actualStock = p.stock || 0;

    if (!map.has(norm)) {
      map.set(norm, Object.assign({}, p, { stock: actualStock }));
    } else {
      var existing = map.get(norm);
      if (typeof existing.stock === 'number' && typeof actualStock === 'number') existing.stock += actualStock;
      if (p.available) existing.available = true;
    }
  });

  // Produits en rupture toujours après les produits disponibles (ordre de l'administrateur conservé dans chaque
  // groupe, identique sur ordinateur et téléphone) ; ils remontent d'eux-mêmes dès le réapprovisionnement.
  var list = Array.from(map.values());
  var inStock = list.filter(function(p) { return productBuyInfo(p).available; });
  var soldOut = list.filter(function(p) { return !productBuyInfo(p).available; });
  return inStock.concat(soldOut);
}

function renderLandingCategories() {
  var container = document.getElementById('landing-cats-filters');
  if (!container) return;
  var prods = getConsolidatedProducts();
  if (!prods.length && window._gvCatalogState === 'loading') { container.innerHTML = categoryPillsSkeleton(); return; }
  var cats = ['all'];
  prods.forEach(function(p) { if (p.category && cats.indexOf(p.category) === -1) cats.push(p.category); });

  var html = '';
  cats.forEach(function(cat) {
    var label = cat === 'all' ? 'Tous les produits' : cat.toUpperCase();
    var activeClass = cat === currentLandingCat ? ' active' : '';
    html += `<button type="button" class="cat-pill${activeClass}" onclick="setLandingCat(decodeURIComponent('${encodeURIComponent(cat)}'))">${escapeHtml(label)}</button>`;
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
  var prods = getConsolidatedProducts();

  if (currentLandingCat !== 'all') prods = prods.filter(function(p) { return p.category === currentLandingCat; });
  if (q) prods = prods.filter(function(p) { return p.name.toLowerCase().indexOf(q) !== -1 || (p.description && p.description.toLowerCase().indexOf(q) !== -1); });

  renderProductCardsInto(container, prods);
}

function renderConnectedCategories() {
  var container = document.getElementById('connected-cats-filters');
  if (!container) return;
  var prods = getConsolidatedProducts();
  if (!prods.length && window._gvCatalogState === 'loading') { container.innerHTML = categoryPillsSkeleton(); return; }
  var cats = ['all'];
  prods.forEach(function(p) { if (p.category && cats.indexOf(p.category) === -1) cats.push(p.category); });

  var html = '';
  cats.forEach(function(cat) {
    var label = cat === 'all' ? 'Tous les produits' : cat.toUpperCase();
    var activeClass = cat === currentConnectedCat ? ' active' : '';
    html += `<button type="button" class="cat-pill${activeClass}" onclick="setConnectedCat(decodeURIComponent('${encodeURIComponent(cat)}'))">${escapeHtml(label)}</button>`;
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
  var prods = getConsolidatedProducts();

  if (currentConnectedCat !== 'all') prods = prods.filter(function(p) { return p.category === currentConnectedCat; });
  if (q) prods = prods.filter(function(p) { return p.name.toLowerCase().indexOf(q) !== -1 || (p.description && p.description.toLowerCase().indexOf(q) !== -1); });

  renderProductCardsInto(container, prods);
}

// Rendu des cartes produits (avec image propre par produit et fallback sécurisé)
function renderProductCardsInto(container, prods) {
  if (prods.length === 0) {
    var gridPlaceholder = catalogPlaceholderHtml(false);
    if (gridPlaceholder) { container.innerHTML = gridPlaceholder; return; }
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px 20px; color: var(--text-muted); background: #ffffff; border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle); box-shadow: var(--shadow-sm);">
        <div style="font-size: 38px; margin-bottom: 12px;">📦</div>
        <h3 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">Aucun produit disponible pour le moment</h3>
        <p style="font-size: 13px; max-width: 480px; margin: 0 auto; line-height: 1.5; color: var(--text-secondary);">La boutique est prête et en attente de réapprovisionnement. De nouveaux produits et services seront publiés très prochainement !</p>
      </div>
    `;
    return;
  }

  var html = '';
  prods.forEach(function(prod) {
    var buy = productBuyInfo(prod);
    var oos = !buy.available;
    var safeImg = sanitizeProductImage(prod.image, prod.category, prod.name);
    var idArg = productIdArg(prod.id);
    var promo = productPromo(prod);

    html += `
      <div class="product-card${oos ? ' oos' : ''}">
        <div class="product-image-box product-open-details" role="button" tabindex="0" aria-label="Voir la fiche : ${escapeHtml(prod.name)}" onclick="openProductDetails(${idArg})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProductDetails(${idArg});}">
          <img src="${safeImg}" class="product-img" alt="${escapeHtml(prod.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=window.GV_PRODUCT_FALLBACK_IMG;">
          <div class="product-badge-overlay">⚡ Vérifié</div>
          ${promo ? `<div class="product-promo-badge">-${promo.percent}%</div>` : ''}
        </div>

        <div class="product-body">
          <span class="product-category-label">${escapeHtml(prod.category)}</span>
          <h3 class="product-name"><button type="button" class="product-name-link" onclick="openProductDetails(${idArg})">${escapeHtml(prod.name)}</button></h3>
          <p class="product-desc product-desc-clamp">${escapeHtml(prod.description || 'Service numérique vérifié.')}</p>

          <div class="product-card-footer">
            <div class="product-meta">
              <span class="stock-tag${oos ? ' oos' : ''}">${buy.stockLabel}</span>
              <span class="product-price-group">${promo ? `<span class="product-compare-price">$${promo.compareAt.toFixed(2)}</span>` : ''}<span class="product-price">$${prod.price.toFixed(2)}</span></span>
            </div>
            <div class="product-actions">
              <button type="button" class="btn-product-details" onclick="openProductDetails(${idArg})">Détails</button>
              ${buy.external ? externalBuyAnchorHtml(buy, 'btn-buy-product btn-light-sweep', 'Acheter ⚡', prod.name) : `<button type="button" class="btn-buy-product${oos ? ' btn-buy-disabled' : ''} btn-light-sweep" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${idArg})">
                ${oos ? 'Rupture de Stock' : 'Acheter ⚡'}
              </button>`}
            </div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ========== FICHE PRODUIT DÉTAILLÉE (structure commune à tous les produits) ==========
function productIdArg(id) {
  return typeof id === 'number' ? id : "'" + String(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Promotion : prix barré (fixé par l'administrateur) supérieur au prix de vente
function productPromo(p) {
  if (!p || typeof p.compareAtPrice !== 'number' || !(p.compareAtPrice > p.price)) return null;
  return { compareAt: p.compareAtPrice, percent: Math.max(1, Math.round((1 - p.price / p.compareAtPrice) * 100)) };
}

// ========== MODE D'ACHAT : SUR LE SITE (stock réel) OU REDIRECTION VERS UN LIEN EXTERNE ==========
// Lien du bouton « Acheter » d'un produit vendu ailleurs (WhatsApp, autre plateforme) : https, http, mailto: ou tel: uniquement.
function safeExternalBuyUrl(url) {
  var s = String(url || '').trim();
  if (!s || s.length > 2000) return '';
  return /^(?:https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+|tel:\+?\d{4,20})$/i.test(s) ? s : '';
}

// Nom de la destination affiché au client (« WhatsApp », « Telegram », nom du site...)
function externalBuyTargetLabel(url) {
  if (/^tel:/i.test(url)) return 'téléphone';
  if (/^mailto:/i.test(url)) return 'e-mail';
  var host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return 'le site du vendeur'; }
  if (/(^|\.)wa\.me$|(^|\.)whatsapp\.(com|net)$/.test(host)) return 'WhatsApp';
  if (/(^|\.)t\.me$|(^|\.)telegram\.(me|org)$/.test(host)) return 'Telegram';
  if (/(^|\.)m\.me$|(^|\.)messenger\.com$/.test(host)) return 'Messenger';
  if (/(^|\.)ig\.me$|(^|\.)instagram\.com$/.test(host)) return 'Instagram';
  return host || 'le site du vendeur';
}

// Disponibilité d'un produit selon son mode d'achat :
//  - lien externe : jamais « Rupture de stock », bouton toujours actif ; quantité (indicative) affichée seulement si l'admin l'a choisi ;
//  - achat sur le site : fonctionnement du stock inchangé (quantité affichée, rupture à 0, bouton désactivé).
function productBuyInfo(p) {
  p = p || {};
  var qty = (typeof p.stock === 'number' && isFinite(p.stock)) ? Math.max(0, Math.floor(p.stock)) : null;
  var showQty = p.showStock !== false && qty !== null;
  var url = p.purchaseMode === 'redirect' ? safeExternalBuyUrl(p.redirectUrl) : '';
  if (url) {
    var shown = showQty && qty > 0;
    return {
      external: true, url: url, target: externalBuyTargetLabel(url), available: true, qty: qty,
      stockLabel: shown ? '● ' + qty + ' disponible' + (qty > 1 ? 's' : '') : '● Disponible',
      shortLabel: shown ? '● ' + qty + ' en stock' : '● Disponible'
    };
  }
  var available = qty !== null ? qty > 0 : p.available === true;
  return {
    external: false, url: '', target: '', available: available, qty: qty,
    stockLabel: !available ? '● Rupture de stock' : (showQty ? '● ' + qty + ' disponible' + (qty > 1 ? 's' : '') : '● En stock'),
    shortLabel: !available ? '● Rupture' : (showQty ? '● ' + qty + ' en stock' : '● En stock')
  };
}

// Bouton « Acheter » d'un produit à lien externe : vrai lien (nouvel onglet sur ordinateur, application WhatsApp sur téléphone)
function externalBuyAnchorHtml(info, cls, label, prodName) {
  var web = /^https?:/i.test(info.url);
  return '<a class="' + cls + ' btn-buy-external" href="' + escapeHtml(info.url) + '"' +
    (web ? ' target="_blank" rel="noopener noreferrer"' : '') +
    ' title="Acheter via ' + escapeHtml(info.target) + '"' +
    ' aria-label="Acheter ' + escapeHtml(prodName || '') + ' via ' + escapeHtml(info.target) + (web ? ' (nouvelle fenêtre)' : '') + '"' +
    ' data-external-buy="1">' + label + '</a>';
}

// Ouverture du lien externe depuis le code (lien direct #acheter, reprise après connexion...)
function openExternalBuyLink(url) {
  url = safeExternalBuyUrl(url);
  if (!url) return;
  if (!/^https?:/i.test(url)) { location.href = url; return; }
  var w = null;
  try { w = window.open(url, '_blank'); } catch (e) {}
  if (w) { try { w.opener = null; } catch (e) {} } else { location.href = url; }
}

var PD_ICONS = {
  features: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  benefits: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  notices: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  delivery: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
};

function findCatalogProduct(prodId) {
  return getConsolidatedProducts().find(function(p) { return String(p.id) === String(prodId); }) || null;
}

function ensureProductDetailsModal() {
  var modal = document.getElementById('modal-product');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'modal-product';
  modal.className = 'modal-backdrop';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'pd-title');
  modal.innerHTML = '<div class="modal-window modal-product-details"><button type="button" class="modal-close-btn" aria-label="Fermer" onclick="closeProductDetails()">✕</button><div id="pd-content"></div></div>';
  modal.addEventListener('click', function(e) { if (e.target === modal) closeProductDetails(); });
  document.body.appendChild(modal);
  return modal;
}

function renderPdSection(kind, title, items, extraClass) {
  if (!Array.isArray(items) || !items.length) return '';
  return `
    <section class="pd-section${extraClass ? ' ' + extraClass : ''}">
      <h3 class="pd-section-title"><span class="pd-icon pd-icon-${kind}">${PD_ICONS[kind]}</span>${title}</h3>
      <ul class="pd-list pd-list-${kind}">${items.map(function(t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('')}</ul>
    </section>`;
}

function openProductDetails(prodId) {
  var prod = findCatalogProduct(prodId);
  if (!prod) {
    showToast("Ce produit n'est plus disponible dans la boutique.", 'error');
    return;
  }
  var buy = productBuyInfo(prod);
  var oos = !buy.available;
  var promo = productPromo(prod);
  var deliveryText = String(prod.deliveryInfo || '').trim() || (buy.external
    ? 'L\'achat se finalise directement avec le vendeur via ' + buy.target + ' : cliquez sur « Acheter » pour le contacter, il vous indique le paiement et la livraison.'
    : prod.deliveryTiming === 'delayed'
    ? 'Après le paiement, votre commande est préparée : votre produit vous est livré dans « Mes commandes » après un délai d\'environ ' + formatDelayMinutesText(prod.deliveryDelayMinutes) + '.'
    : prod.deliveryTiming === 'admin_release'
    ? 'Après le paiement, notre équipe prépare votre commande : votre produit vous est livré dans « Mes commandes ».'
    : prod.deliveryMode === 'manual'
    ? 'Après le paiement, la commande passe « En attente » et nous vous contactons sur WhatsApp pour la livraison.'
    : 'Livraison automatique dans « Mes commandes » dès la confirmation du paiement.');
  var buyLabel = 'Acheter ⚡ — $' + prod.price.toFixed(2);

  ensureProductDetailsModal();
  document.getElementById('pd-content').innerHTML = `
    <div class="pd-media">
      <img src="${sanitizeProductImage(prod.image, prod.category, prod.name)}" alt="${escapeHtml(prod.name)}" onerror="this.onerror=null;this.src=window.GV_PRODUCT_FALLBACK_IMG;">
      ${promo ? `<div class="product-promo-badge">-${promo.percent}%</div>` : ''}
    </div>
    <div class="pd-head">
      <span class="product-category-label">${escapeHtml(prod.category || '')}</span>
      <h2 class="pd-title" id="pd-title">${escapeHtml(prod.name)}</h2>
      <div class="pd-price-row">
        <span class="product-price-group">${promo ? `<span class="product-compare-price">$${promo.compareAt.toFixed(2)}</span>` : ''}<span class="product-price">$${prod.price.toFixed(2)}</span></span>
        <span class="pd-fcfa">≈ ${Math.round(prod.price * FCFA_RATE).toLocaleString('fr-FR')} FCFA</span>
        <span class="stock-tag${oos ? ' oos' : ''}">${buy.stockLabel}</span>
      </div>
    </div>
    ${prod.description ? `<p class="pd-summary">${escapeHtml(prod.description)}</p>` : ''}
    ${renderPdSection('features', 'Caractéristiques principales', prod.features)}
    ${renderPdSection('benefits', 'Avantages', prod.benefits)}
    ${renderPdSection('notices', 'Informations importantes', prod.notices, 'pd-section-notice')}
    <section class="pd-section">
      <h3 class="pd-section-title"><span class="pd-icon pd-icon-delivery">${PD_ICONS.delivery}</span>Livraison et exécution</h3>
      <p class="pd-delivery-text">${escapeHtml(deliveryText)}</p>
    </section>
    <div class="pd-actions">
      ${buy.external ? externalBuyAnchorHtml(buy, 'btn-buy-product btn-light-sweep', buyLabel, prod.name) + `<p class="pd-external-note">Vous serez redirigé vers ${escapeHtml(buy.target)} pour finaliser votre achat avec le vendeur.</p>` : `<button type="button" class="btn-buy-product${oos ? ' btn-buy-disabled' : ''} btn-light-sweep" ${oos ? 'disabled' : ''} onclick="buyFromProductDetails(${productIdArg(prod.id)})">
        ${oos ? 'Rupture de stock' : buyLabel}
      </button>`}
    </div>`;
  var modal = document.getElementById('modal-product');
  modal.classList.add('active');
  var win = modal.querySelector('.modal-window');
  if (win) win.scrollTop = 0;
  try { history.replaceState(null, '', location.pathname + location.search + '#produit-' + encodeURIComponent(prod.id)); } catch (e) {}
}

function closeProductDetails() {
  var modal = document.getElementById('modal-product');
  if (modal) modal.classList.remove('active');
  if (/^#produit-/.test(location.hash)) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
}

function buyFromProductDetails(prodId) {
  closeProductDetails();
  startProductPurchase(prodId);
}

// Lien direct vers une fiche : https://getvirtu.shop/#produit-12 (ouverte une fois le catalogue chargé)
var _gvHashProductHandled = false;
function maybeOpenProductFromHash(force) {
  var m = /^#produit-(.+)$/.exec(location.hash || '');
  if (!m || (_gvHashProductHandled && !force)) return;
  var id = decodeURIComponent(m[1]);
  if (!findCatalogProduct(id)) return; // catalogue pas encore chargé
  _gvHashProductHandled = true;
  openProductDetails(id);
}
window.addEventListener('hashchange', function() { maybeOpenProductFromHash(true); });
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var modal = document.getElementById('modal-product');
  if (modal && modal.classList.contains('active')) closeProductDetails();
});

// ========== TUNNEL D'ACHAT (SOLDE, CRYPTO, MOBILE MONEY) ==========
function startProductPurchase(prodId) {
  var consolidated = getConsolidatedProducts();
  var prod = consolidated.find(function(p) { return String(p.id) === String(prodId); });
  if (!prod) {
    var rawProds = DB.get('products', []);
    prod = rawProds.find(function(p) { return p && String(p.id) === String(prodId); });
  }

  var buy = productBuyInfo(prod);
  // Produit à lien externe : le bouton « Acheter » ouvre le lien du vendeur, quel que soit le stock (aucune connexion requise)
  if (prod && buy.external) {
    openExternalBuyLink(buy.url);
    return;
  }

  if (!prod || !buy.available) {
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
  window._gvPurchaseKey = null;

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
  if (orderTrybitPollingTimer) {
    clearInterval(orderTrybitPollingTimer);
    orderTrybitPollingTimer = null;
  }
  if (orderMomoPollingTimer) {
    clearInterval(orderMomoPollingTimer);
    orderMomoPollingTimer = null;
  }
}

window.changePurchaseQty = function(delta) {
  if (!selectedPayProd) return;
  delta = parseInt(delta, 10) || 0;
  
  var stock = 999;
  if (typeof selectedPayProd.stock !== 'undefined' && selectedPayProd.stock !== null) {
    var parsed = parseInt(selectedPayProd.stock, 10);
    if (!isNaN(parsed) && parsed > 0) {
      stock = parsed;
    }
  }

  var newQty = currentPurchaseQty + delta;
  if (newQty < 1) newQty = 1;
  if (newQty > stock) {
    if (typeof showToast === 'function') {
      showToast('Stock limité : maximum ' + stock + ' unité(s) disponible(s).', 'warning');
    }
    newQty = stock;
  }
  currentPurchaseQty = newQty;
  renderPurchaseModal();
};

function changePurchaseQty(delta) {
  return window.changePurchaseQty(delta);
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
  if (!em.includes('@') || low.startsWith('admin@')) {
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
  var parsedStock = parseInt(selectedPayProd.stock, 10);
  var stock = (!isNaN(parsedStock) && parsedStock > 0) ? parsedStock : (selectedPayProd.stock === 0 ? 0 : 999);
  var unitPrice = selectedPayProd.price;

  // Calcul automatique du total selon la quantité choisie (1, 2, 3, etc.)
  var total = Math.round(unitPrice * currentPurchaseQty * 100) / 100;
  var hasEnough = userBal >= total;
  var diff = Math.max(0, Math.round((total - userBal) * 100) / 100).toFixed(2);
  var suggestedRecharge = Math.max(5, Math.ceil(parseFloat(diff) || 5));

  container.innerHTML = `
    <div class="purchase-modal-header-compact">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 2px;">
        <h2 class="modal-title purchase-modal-title-compact" style="margin: 0;">Acheter le Produit</h2>
        <div class="purchase-balance-compact-inline" title="Votre solde disponible">
          <span class="balance-tag">Solde disponible :</span>
          <strong class="balance-val" style="color: ${hasEnough ? 'var(--primary-600)' : '#dc2626'};">$${userBal.toFixed(2)}</strong>
        </div>
      </div>
      <p class="purchase-delivery-notice-line">Règlement instantané via votre solde &bull; Livraison numérique immédiate</p>
    </div>

    <!-- 1. Fiche Produit Compacte -->
    <div class="purchase-prod-box purchase-prod-box-full" style="margin-bottom: 8px;">
      <img src="${sanitizeProductImage(selectedPayProd.image, selectedPayProd.category, selectedPayProd.name)}" class="purchase-prod-thumb-compact" alt="${escapeHtml(selectedPayProd.name)}" onerror="this.onerror=null;this.src=window.GV_PRODUCT_FALLBACK_IMG;">
      <div class="purchase-prod-info-compact">
        <span class="purchase-prod-cat-compact">${escapeHtml(selectedPayProd.category)}</span>
        <h3 class="purchase-prod-title-compact" title="${escapeHtml(selectedPayProd.name)}">${escapeHtml(selectedPayProd.name)}</h3>
        <div class="purchase-unit-price-compact">
          Prix unitaire : <strong>$${unitPrice.toFixed(2)}</strong>
        </div>
      </div>
    </div>

    <!-- 2. Sélecteur de quantité réactif & robuste -->
    <div class="purchase-qty-card-compact" style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <label style="font-weight: 700; font-size: 11.5px; color: var(--text-primary); margin: 0;">Quantité à acheter</label>
          <span style="font-size: 10.5px; color: ${stock > 0 ? 'var(--emerald-600)' : 'var(--rose-600)'}; font-weight: 600; display: block;">
            ${stock > 0 ? ((stock === 999 || selectedPayProd.showStock === false) ? '● En stock' : '● ' + stock + ' disponible' + (stock > 1 ? 's' : '')) : '● Rupture de stock'}
          </span>
        </div>
        <div class="qty-stepper">
          <button type="button" class="btn-qty-step" onclick="window.changePurchaseQty(-1)" ${currentPurchaseQty <= 1 ? 'disabled' : ''} aria-label="Diminuer la quantité" title="Diminuer">&minus;</button>
          <span class="qty-display-value">${currentPurchaseQty}</span>
          <button type="button" class="btn-qty-step" onclick="window.changePurchaseQty(1)" ${currentPurchaseQty >= stock ? 'disabled' : ''} aria-label="Augmenter la quantité" title="Augmenter">&plus;</button>
        </div>
      </div>
    </div>

    <!-- 3. Calcul automatique du montant total -->
    <div class="purchase-calc-box-compact" style="margin-bottom: 8px;">
      <div class="calc-row-compact">
        <span>Calcul du total :</span>
        <span>$${unitPrice.toFixed(2)} &times; ${currentPurchaseQty}</span>
      </div>
      <div class="calc-row-compact total-row">
        <span>Total à régler :</span>
        <span class="total-amount-compact">$${total.toFixed(2)}</span>
      </div>
    </div>

    <!-- 4. Statut du Solde Client & Validation -->
    <div style="margin-bottom: 8px;">
      ${hasEnough ? `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 7px 10px; font-size: 11.5px; color: var(--emerald-600); display: flex; align-items: center; justify-content: space-between;">
          <span>✓ Solde suffisant ($${userBal.toFixed(2)})</span>
          <span>Reste après paiement : <strong>$${(userBal - total).toFixed(2)}</strong></span>
        </div>
      ` : `
        <div class="insufficient-balance-alert-centered" style="padding: 10px; border-radius: 8px; background: #fff1f2; border: 1px solid #fecdd3; display: flex; flex-direction: column; gap: 6px; text-align: center;">
          <span class="insufficient-balance-text" style="color: #e11d48; font-weight: 700; font-size: 12px;">⚠️ Solde insuffisant : il vous manque $${diff}</span>
          <span style="font-size: 11px; color: #475569;">Rechargez votre solde avec Mobile Money ou Crypto pour acheter ce produit.</span>
        </div>
      `}
    </div>

    <!-- 5. Champ Contact Optionnel -->
    <div class="optional-contact-box-compact" style="margin-bottom: 10px;">
      <label for="purchase-contact-input" class="optional-contact-label-oneline">
        <span>📱 Email ou WhatsApp de confirmation (Optionnel)</span>
      </label>
      <input type="text" id="purchase-contact-input" class="optional-contact-input-compact" value="${escapeHtml(defaultContact)}" placeholder="Ex: mon.email@domaine.com ou +33 6 12 34 56 78">
    </div>

    <!-- 6. Bouton d'action exclusif par Solde -->
    ${hasEnough ? `
      <button type="button" class="btn-recharge-bottom-compact btn-purchase-action-single-line btn-light-sweep" id="btn-submit-purchase" onclick="processProductPayment()">
        <span>Payer maintenant ($${total.toFixed(2)}) ⚡</span>
      </button>
    ` : `
      <button type="button" class="btn-recharge-bottom-compact btn-purchase-action-single-line btn-light-sweep" style="background: linear-gradient(135deg, #f59e0b, #d97706);" onclick="promptDepositFromPurchase(${suggestedRecharge})">
        <span>Recharger mon solde ($${suggestedRecharge}) ⚡</span>
      </button>
    `}
  `;
}

function promptDepositFromPurchase(suggestedAmount) {
  // Commande à valider automatiquement dès que le paiement Mobile Money est confirmé (côté serveur)
  if (selectedPayProd) {
    var qty = parseInt(currentPurchaseQty, 10) || 1;
    pendingDepositPurchase = {
      productId: selectedPayProd.id,
      productName: selectedPayProd.name,
      quantity: qty,
      total: Math.round((Number(selectedPayProd.price) || 0) * qty * 100) / 100,
      contactInfo: ((document.getElementById('purchase-contact-input') || {}).value || '').trim().slice(0, 120)
    };
  }
  closePayModal();
  openDepositModal(suggestedAmount, true);
}

// LIVRAISON DU PRODUIT NUMÉRIQUE ACHETÉ AVEC CLÉ UNIQUE ET ENREGISTREMENT DÉFINITIF
// ========== LIVRAISON MANUELLE VIA WHATSAPP ==========
var GV_DEFAULT_WHATSAPP_NUMBER = '237692960840';

function getWhatsAppNumber() {
  var n = String(DB.get('whatsapp_number', '') || '').replace(/[^0-9]/g, '');
  return n.length >= 8 ? n : GV_DEFAULT_WHATSAPP_NUMBER;
}

function buildWhatsAppOrderUrl(order) {
  var qtyText = order && order.quantity > 1 ? ' (x' + order.quantity + ')' : '';
  var amount = order && typeof order.amount === 'number' ? order.amount : (parseFloat(order && order.amount) || 0);
  var msg = "Bonjour, je viens d'acheter un produit sur GetVirtu.shop.\n\n" +
    'Produit : ' + ((order && order.productName) || 'Produit') + qtyText + '\n' +
    'Référence de commande : ' + ((order && order.id) || '-') + '\n' +
    'Montant payé : $' + amount.toFixed(2) + ' USD\n\n' +
    'Je souhaite recevoir mon produit. Merci.';
  return 'https://wa.me/' + getWhatsAppNumber() + '?text=' + encodeURIComponent(msg);
}

function isManualDeliveryPending(order) {
  return Boolean(order) && order.status === 'En attente' && order.deliveryMode === 'manual';
}

function renderWhatsAppDeliveryBox(order) {
  return `
    <div class="whatsapp-delivery-box" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: var(--radius-sm, 10px); padding: 12px; font-size: 12.5px; color: #166534; line-height: 1.5;">
      📲 <strong>Livraison manuelle via WhatsApp</strong><br>
      Votre paiement est confirmé. Envoyez-nous le message pré-rempli pour recevoir votre produit rapidement.
      <a href="${escapeHtml(buildWhatsAppOrderUrl(order))}" target="_blank" rel="noopener noreferrer" class="btn-whatsapp-delivery" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; background: #16a34a; color: #ffffff; font-weight: 700; border-radius: 10px; padding: 11px 14px; text-decoration: none;">
        <span>💬</span><span>Recevoir mon produit sur WhatsApp</span>
      </a>
    </div>
  `;
}

// ---------- Livraison différée puis manuelle / manuelle par l'équipe : le contenu n'est envoyé par le serveur
// qu'après la livraison confirmée par l'administrateur. Le compte à rebours n'est qu'un affichage (horloge serveur).
function isFulfilmentOrder(order) {
  return Boolean(order && order.delivery && (order.delivery.method === 'delayed' || order.delivery.method === 'admin_release'));
}

function isFulfilmentPending(order) {
  return isFulfilmentOrder(order) && order.status === 'En attente' && !order.vaultContent;
}

function formatDelayMinutesText(minutes) {
  minutes = Number(minutes) || 15;
  if (minutes >= 60 && minutes % 60 === 0) return (minutes / 60) + ' heure' + (minutes >= 120 ? 's' : '');
  if (minutes >= 60) return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
  return minutes + ' minute' + (minutes > 1 ? 's' : '');
}

var _gvServerClockSkew = 0;
function formatDeliveryRemaining(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h) return h + ' h ' + (m < 10 ? '0' : '') + m + ' min ' + (s < 10 ? '0' : '') + s + ' s';
  if (m) return m + ' min ' + (s < 10 ? '0' : '') + s + ' s';
  return s + ' s';
}

function deliverySecondsLeft(eligibleAt) {
  return (Date.parse(eligibleAt) - (Date.now() + _gvServerClockSkew)) / 1000;
}

function renderFulfilmentBox(order) {
  var d = order.delivery || {};
  var fmt = function(iso) { return iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };
  var details = '<div style="display: grid; gap: 2px; margin-top: 8px; font-size: 11.5px;">' +
    '<div>Commande : <strong>' + escapeHtml(order.id) + '</strong></div>' +
    '<div>Paiement : <strong>✅ confirmé le ' + escapeHtml(fmt(d.paymentConfirmedAt)) + '</strong></div>';
  if (d.method === 'delayed') {
    var left = deliverySecondsLeft(d.eligibleAt);
    if (left > 0) {
      return `
        <div class="held-delivery-box" data-order-id="${escapeHtml(order.id)}" data-phase="waiting" style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: var(--radius-sm, 10px); padding: 12px; font-size: 12.5px; color: #1e3a8a; line-height: 1.5;">
          ✅ <strong>Paiement confirmé.</strong> Votre commande est en préparation. Votre produit pourra vous être livré dans environ
          <strong class="gv-delivery-countdown" data-eligible-at="${escapeHtml(d.eligibleAt || '')}" aria-live="polite">${formatDeliveryRemaining(left)}</strong>.
          ${details}
            <div>Statut de livraison : <strong>⏳ Période d'attente</strong></div>
            <div>Livraison possible à partir du : <strong>${escapeHtml(fmt(d.eligibleAt))}</strong></div>
          </div>
          <div style="font-size: 11px; color: #475569; margin-top: 6px;">Vous pouvez fermer cette page : le délai continue sur nos serveurs.</div>
        </div>
      `;
    }
    return `
      <div class="held-delivery-box" data-order-id="${escapeHtml(order.id)}" data-phase="processing" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: var(--radius-sm, 10px); padding: 12px; font-size: 12.5px; color: #92400e; line-height: 1.5;">
        ⏳ <strong>Votre période d'attente est terminée.</strong> Votre commande est maintenant en cours de traitement pour la livraison. Merci de revenir dans quelques instants.
        ${details}
          <div>Statut de livraison : <strong>📦 En cours de livraison</strong></div>
        </div>
      </div>
    `;
  }
  return `
    <div class="held-delivery-box" data-order-id="${escapeHtml(order.id)}" data-phase="processing" style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: var(--radius-sm, 10px); padding: 12px; font-size: 12.5px; color: #581c87; line-height: 1.5;">
      ✅ <strong>Paiement confirmé.</strong> Votre commande est en cours de préparation par notre équipe. Vous pourrez accéder à votre produit dès que la livraison sera effectuée.
      ${details}
        <div>Statut de livraison : <strong>🛂 En préparation</strong></div>
      </div>
    </div>
  `;
}

// Résultat d'achat d'une commande livrée manuellement par l'équipe (contenu encore verrouillé par le serveur)
function renderFulfilmentPurchaseResult(prod, order, userBalAfter) {
  var container = document.getElementById('pay-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="purchase-success-box" id="held-purchase-result" data-order-id="${escapeHtml(order.id)}">
        <div class="success-icon-badge" style="background: var(--emerald-500); color: white;">✓</div>
        <h3 style="font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Paiement confirmé ✅</h3>
        <div style="margin-bottom: 16px; text-align: left;">${renderFulfilmentBox(order)}</div>
        <div class="order-recap-mini">
          <div><span>N° Commande :</span> <strong>${escapeHtml(order.id)}</strong></div>
          <div><span>Article :</span> <strong>${escapeHtml((prod && prod.name) || order.productName || 'Produit')} (x${order.quantity || 1})</strong></div>
          <div><span>Montant payé :</span> <strong style="color: var(--primary-600);">$${Number(order.amount || 0).toFixed(2)}</strong></div>
          <div><span>Nouveau solde :</span> <strong style="color: var(--emerald-600);">$${Number(userBalAfter || 0).toFixed(2)}</strong></div>
          <div><span>Règlement :</span> <strong>${escapeHtml(order.method || 'Solde GetVirtu')}</strong></div>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button type="button" class="btn-secondary" style="flex: 1;" onclick="closePayModal()">Continuer mes achats</button>
          <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal(); openOrdersModal();">📦 Mes commandes</button>
        </div>
      </div>
    `;
  }
  showToast('Paiement confirmé : votre commande est en préparation. Retrouvez-la dans « Mes commandes ».', 'success');
  updateNavbar();
  if (typeof syncProductsFromServer === 'function') syncProductsFromServer();
  renderConnectedCatalog();
  renderLandingCatalog();
}

// État à jour des commandes auprès du serveur (seule source du contenu livré)
var _gvHeldRefreshAt = 0;
async function refreshFulfilmentOrders(force) {
  if (!force && Date.now() - _gvHeldRefreshAt < 4000) return;
  _gvHeldRefreshAt = Date.now();
  var s = DB.get('session');
  if (!s || !s.token) return;
  var t0 = Date.now();
  await syncUserOrdersFromServer(s.token);
  var mid = (t0 + Date.now()) / 2;
  var orders = DB.get('orders', []) || [];
  var latest = 0;
  orders.forEach(function(o) { if (o && o.delivery && o.delivery.serverNow) latest = Math.max(latest, Date.parse(o.delivery.serverNow) || 0); });
  if (latest && latest >= t0 - 60000) _gvServerClockSkew = latest - mid;
  var modalOrders = document.getElementById('modal-orders');
  if (modalOrders && modalOrders.classList.contains('active')) renderOrdersListInModal();
  var held = document.getElementById('held-purchase-result');
  if (held) {
    var o = orders.find(function(x) { return x && x.id === held.getAttribute('data-order-id'); });
    if (o && o.vaultContent && !isFulfilmentPending(o)) {
      deliverCompletedOrder({ id: o.productId, name: o.productName }, o.amount, o.quantity || 1, o.contactInfo || '', o.method, getUserBalance(), o);
    } else if (o && isFulfilmentPending(o)) {
      var box = held.querySelector('.held-delivery-box');
      if (box) box.outerHTML = renderFulfilmentBox(o);
    }
  }
}

setInterval(function() {
  var ended = false;
  document.querySelectorAll('.gv-delivery-countdown[data-eligible-at]').forEach(function(el) {
    var left = deliverySecondsLeft(el.getAttribute('data-eligible-at'));
    if (left > 0) el.textContent = formatDeliveryRemaining(left);
    else ended = true;
  });
  if (ended) {
    // Fin de l'attente : nouvel affichage « en cours de livraison » (aucun contenu côté navigateur)
    document.querySelectorAll('.held-delivery-box[data-phase="waiting"]').forEach(function(box) {
      var o = (DB.get('orders', []) || []).find(function(x) { return x && x.id === box.getAttribute('data-order-id'); });
      if (o) box.outerHTML = renderFulfilmentBox(o);
    });
    refreshFulfilmentOrders(false);
  }
}, 1000);
// Tant qu'une commande en préparation est affichée : vérification régulière de sa livraison par l'équipe
setInterval(function() {
  if (document.querySelector('.held-delivery-box')) refreshFulfilmentOrders(true);
}, 30000);

// Paiement confirmé mais commande pas encore visible côté serveur : jamais de clé « inventée » dans le navigateur
function showPurchaseProcessingNotice(prod, message) {
  var container = document.getElementById('pay-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="purchase-success-box">
        <div class="success-icon-badge" style="background: var(--amber-500, #f59e0b); color: white;">⏳</div>
        <h3 style="font-size: 18px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Paiement confirmé</h3>
        <p style="font-size: 13.5px; color: #475569; line-height: 1.5; margin-bottom: 16px;">${escapeHtml(message || 'Votre commande est en cours d\'enregistrement. Elle apparaîtra dans « Mes commandes » dans quelques instants.')}</p>
        <div class="order-recap-mini">
          <div><span>Article :</span> <strong>${escapeHtml((prod && prod.name) || 'Produit')}</strong></div>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button type="button" class="btn-secondary" style="flex: 1;" onclick="closePayModal()">Continuer mes achats</button>
          <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal(); openOrdersModal();">📦 Mes commandes</button>
        </div>
      </div>
    `;
  }
  syncUserSessionAndBalance();
}

function deliverCompletedOrder(prod, total, qty, contactVal, paymentMethodName, remainingBal, serverOrder) {
  var u = getCurrentUser();
  if (!u || !prod) return;

  // Seule une commande réellement enregistrée par le serveur est affichée au client
  if (!serverOrder || !serverOrder.id) {
    showPurchaseProcessingNotice(prod);
    return;
  }

  var userBalAfter = (typeof remainingBal === 'number') ? remainingBal : getUserBalance();
  var newOrder = Object.assign({}, serverOrder, {
    contactInfo: serverOrder.contactInfo || contactVal || '',
    method: serverOrder.method || paymentMethodName || 'Solde GetVirtu',
    date: serverOrder.date || new Date().toISOString()
  });
  if (typeof newOrder.amount !== 'number') newOrder.amount = total;
  if (!newOrder.quantity) newOrder.quantity = qty;

  var orders = (DB.get('orders', []) || []).filter(function(o) { return o && o.id !== newOrder.id; });
  orders.unshift(newOrder);
  DB.set('orders', orders);

  // Livraison différée puis manuelle / manuelle par l'équipe : paiement confirmé, produit livré plus tard par l'équipe
  if (isFulfilmentPending(newOrder)) {
    renderFulfilmentPurchaseResult(prod, newOrder, userBalAfter);
    return;
  }

  var manualPending = isManualDeliveryPending(newOrder) || !newOrder.vaultContent;

  var container = document.getElementById('pay-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="purchase-success-box">
        <div class="success-icon-badge" style="background: var(--emerald-500); color: white;">✓</div>
        <h3 style="font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">${manualPending ? 'Paiement réussi ! Commande enregistrée ✅' : 'Paiement Réussi & Produit Livré ! ⚡'}</h3>
        <p style="font-size: 13.5px; color: #475569; line-height: 1.5; margin-bottom: 16px;">
          ${manualPending
            ? 'Ce produit est livré manuellement. Contactez-nous sur WhatsApp avec le message pré-rempli pour le recevoir.'
            : 'Félicitations ! Votre commande est validée et votre clé/accès numérique unique est débloqué(e) :'}
        </p>

        ${manualPending ? `<div style="margin-bottom: 16px;">${renderWhatsAppDeliveryBox(newOrder)}</div>` : `
        <div class="vault-delivery-card" style="margin-bottom: 16px;">
          <div class="vault-header">
            <span>🔐 CONTENU DU PRODUIT DÉBLOQUÉ</span>
            <span style="font-size: 11px; color: var(--emerald-600); font-weight: 600;">● Accès Immédiat & Clé Unique</span>
          </div>
          ${renderVaultContentDisplay(newOrder)}
        </div>`}

        <div class="order-recap-mini">
          <div><span>N° Commande :</span> <strong>${escapeHtml(newOrder.id)}</strong></div>
          <div><span>Article :</span> <strong>${escapeHtml(prod.name)} (x${newOrder.quantity})</strong></div>
          <div><span>Montant payé :</span> <strong style="color: var(--primary-600);">$${newOrder.amount.toFixed(2)}</strong></div>
          <div><span>Nouveau solde :</span> <strong style="color: var(--emerald-600);">$${userBalAfter.toFixed(2)}</strong></div>
          <div><span>Règlement :</span> <strong>${escapeHtml(newOrder.method)}</strong></div>
          ${newOrder.contactInfo ? `<div><span>Contact :</span> <strong>${escapeHtml(newOrder.contactInfo)}</strong></div>` : ''}
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button type="button" class="btn-secondary" style="flex: 1;" onclick="closePayModal()">Continuer mes achats</button>
          <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal(); openOrdersModal();">📦 Mes commandes</button>
        </div>
      </div>
    `;
  }

  showToast(manualPending
    ? 'Commande enregistrée : contactez-nous sur WhatsApp pour recevoir votre produit.'
    : '🎉 Félicitations ! Votre produit a été débloqué et livré.', 'success');
  updateNavbar();
  if (typeof syncProductsFromServer === 'function') syncProductsFromServer();
  renderConnectedCatalog();
  renderLandingCatalog();
}

// Mobile Money confirmé : le montant a été crédité sur le solde côté serveur ; on passe maintenant la VRAIE commande
// (débit du solde + livraison des clés / du fichier / livraison WhatsApp), au lieu d'afficher une clé fictive.
async function completeMobileMoneyPurchase(prod, total, qty, contactVal) {
  var session = DB.get('session');
  var token = session && session.token ? session.token : '';
  try {
    var res = await fetch('/api/data/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ productId: prod.id, quantity: qty, contactInfo: contactVal || '', paymentLabel: 'Mobile Money Instantané' })
    });
    var data = await res.json().catch(function() { return {}; });
    if (res.ok && data && data.success && data.order) {
      if (typeof data.newBalance === 'number') updateUserBalance(data.newBalance);
      deliverCompletedOrder(prod, data.order.amount || total, qty, contactVal, 'Mobile Money Instantané', data.newBalance, data.order);
      return;
    }
    showPurchaseProcessingNotice(prod, 'Paiement reçu et crédité sur votre solde, mais la commande n\'a pas pu être finalisée : ' +
      ((data && data.error) || 'erreur inconnue') + '. Votre argent est disponible sur votre solde GetVirtu.');
  } catch (e) {
    showPurchaseProcessingNotice(prod, 'Paiement reçu et crédité sur votre solde. La connexion a été interrompue pendant la finalisation : réessayez l\'achat avec votre solde.');
  }
}

// Crypto confirmé : la commande est créée par le serveur (webhook / vérification) ; on récupère la VRAIE commande.
async function completeCryptoPurchase(txId, prod, total, qty, contactVal) {
  var session = DB.get('session');
  var token = session && session.token ? session.token : '';
  var expectedId = 'ORD-' + (String(txId || '').replace('TXN-TB-', '').substring(0, 8));
  for (var attempt = 0; attempt < 4; attempt++) {
    try {
      var res = await fetch('/api/data/orders?_t=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Authorization': 'Bearer ' + token, 'Cache-Control': 'no-cache' }
      });
      var data = await res.json().catch(function() { return {}; });
      var list = (data && Array.isArray(data.orders)) ? data.orders : [];
      var found = list.find(function(o) { return o && (o.transactionId === txId || o.id === expectedId); });
      if (found) {
        deliverCompletedOrder(prod, found.amount || total, qty, contactVal, 'Crypto Instantané (Trybit)', getUserBalance(), found);
        return;
      }
    } catch (e) {}
    await new Promise(function(r) { setTimeout(r, 1500); });
  }
  showPurchaseProcessingNotice(prod);
}


// Commande momentanément impossible (refus du serveur avant tout débit) : message clair dans la fenêtre d'achat
function showPurchaseUnavailableNotice(message) {
  var msg = message || 'Nous rencontrons actuellement un problème technique lié au traitement des commandes. Merci de réessayer un peu plus tard. Nous vous prions de nous excuser pour ce désagrément.';
  var container = document.getElementById('pay-dynamic-content');
  if (!container) { showToast(msg, 'error'); return; }
  container.innerHTML = `
    <div class="purchase-success-box" id="purchase-unavailable-box" role="alert">
      <div class="success-icon-badge" style="background: var(--amber-500, #f59e0b); color: white;">⚠️</div>
      <h3 style="font-size: 18px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Commande momentanément indisponible</h3>
      <p style="font-size: 13.5px; color: #475569; line-height: 1.55; margin-bottom: 12px;">${escapeHtml(msg)}</p>
      <p style="font-size: 12px; color: #64748b; margin: 0 0 16px 0;">Aucun montant n'a été débité de votre solde.</p>
      <div style="display: flex; gap: 10px;">
        <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal()">J'ai compris</button>
      </div>
    </div>
  `;
  syncUserSessionAndBalance();
}

// RÈGLEMENT EXCLUSIF PAR SOLDE DU CLIENT AVEC TRANSACTION PERMANENTE EN BASE DE DONNÉES
var isPurchaseProcessing = false;

async function processProductPayment() {
  if (isPurchaseProcessing) return;

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

  // Produit vendu via un lien externe : jamais payé sur le site
  var buyCheck = productBuyInfo(selectedPayProd);
  if (buyCheck.external) {
    var extUrl = buyCheck.url;
    closePayModal();
    openExternalBuyLink(extUrl);
    return;
  }

  // Vérification de la disponibilité du stock (quantité masquée : contrôle final par le serveur)
  if (!buyCheck.available || (buyCheck.qty !== null && buyCheck.qty < qty)) {
    showToast('Ce produit est actuellement en rupture de stock.', 'error');
    renderPurchaseModal();
    return;
  }

  var total = Math.round(selectedPayProd.price * qty * 100) / 100;
  var userBal = getUserBalance();

  // VÉRIFICATION EN AMONT DU SOLDE DU CLIENT
  if (userBal < total) {
    var diff = (total - userBal).toFixed(2);
    showToast('Solde insuffisant ($' + userBal.toFixed(2) + ' disponible, $' + total.toFixed(2) + ' requis). Veuillez recharger votre compte.', 'error');
    promptDepositFromPurchase(Math.max(5, Math.ceil(parseFloat(diff))));
    return;
  }

  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = rawContact.slice(0, 120);

  var btn = document.getElementById('btn-submit-purchase');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Traitement sécurisé de la commande... ⏳</span>';
  }
  isPurchaseProcessing = true;

  try {
    var session = DB.get('session');
    var token = session ? (session.token || '') : '';

    var res = await fetch('/api/data/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify({
        productId: selectedPayProd.id,
        productName: selectedPayProd.name,
        quantity: qty,
        contactInfo: contactVal,
        idempotencyKey: window._gvPurchaseKey || (window._gvPurchaseKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random()))
      })
    });

    var data = await res.json();

    if (!res.ok || !data.success) {
      if (data && data.code === 'PURCHASES_UNAVAILABLE') {
        // Commande refusée par le serveur avant tout débit : message d'indisponibilité affiché proprement
        window._gvPurchaseKey = null;
        showPurchaseUnavailableNotice(data.error);
        return;
      }
      if (data && (data.code === 'PRODUCT_UNAVAILABLE' || data.code === 'EXTERNAL_PURCHASE') && typeof syncProductsFromServer === 'function') {
        // Produit supprimé ou masqué entre-temps : rafraîchir le catalogue affiché
        syncProductsFromServer();
      }
      throw new Error(data.error || 'Erreur lors du traitement de la commande par le serveur.');
    }

    window._gvPurchaseKey = null; // achat terminé : la prochaine tentative est une nouvelle commande
    var serverBalance = (typeof data.newBalance === 'number') ? data.newBalance : Math.max(0, Math.round((userBal - total) * 100) / 100);

    // Mettre à jour immédiatement et définitivement le solde avec la valeur réelle renvoyée par le serveur
    updateUserBalance(serverBalance);

    // Mettre à jour le stock du produit
    if (typeof data.remainingStock === 'number') {
      selectedPayProd.stock = data.remainingStock;
      var allProds = DB.get('products', []);
      var pIdx = allProds.findIndex(function(p) { return p.id === selectedPayProd.id; });
      if (pIdx !== -1) {
        allProds[pIdx].stock = data.remainingStock;
        DB.set('products', allProds);
      }
    } else if (typeof data.productAvailable === 'boolean') {
      // Quantité masquée par l'administrateur : seule la disponibilité est mise à jour
      selectedPayProd.available = data.productAvailable;
      var allProdsH = DB.get('products', []);
      var hIdx = allProdsH.findIndex(function(p) { return p.id === selectedPayProd.id; });
      if (hIdx !== -1) {
        allProdsH[hIdx].available = data.productAvailable;
        DB.set('products', allProdsH);
      }
    }

    // Livrer la commande avec les clés numériques officielles et le solde restant exact
    deliverCompletedOrder(selectedPayProd, total, qty, contactVal, 'Solde GetVirtu', serverBalance, data.order);

    // Synchronisation en arrière-plan avec le serveur
    syncUserSessionAndBalance();

  } catch (err) {
    console.error('[Purchase Error]', err);
    showToast(err.message || 'Impossible de finaliser l\'achat.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>Payer maintenant ($${total.toFixed(2)}) ⚡</span>`;
    }
  } finally {
    isPurchaseProcessing = false;
  }
}

// 2. RÈGLEMENT PAR CRYPTO INSTANTANÉ TRYBIT
async function startPurchaseTrybitPayment(total, qty) {
  var u = getCurrentUser();
  if (!u || !selectedPayProd) return;
  var prod = selectedPayProd;

  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = rawContact.slice(0, 120);

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
    if (safeEmail && safeEmail.toLowerCase().includes('admin@')) {
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
        returnUrl: window.location.origin + '/?payment_status=success',
        productId: prod.id,
        quantity: qty,
        contactInfo: contactVal
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
          <button type="button" class="btn-secondary" onclick="checkOrderTrybitStatus('${data.transactionId}', '${data.invoiceUuid || ''}', ${total}, ${qty}, decodeURIComponent('${encodeURIComponent(contactVal || '')}'))" style="width: 100%;">
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
        completeCryptoPurchase(txId, prod, total, qty, contactVal);
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
        completeCryptoPurchase(txId, selectedPayProd, total, qty, contactVal);
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
  var contactVal = rawContact.slice(0, 120);

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
    if (safeEmail && safeEmail.toLowerCase().includes('admin@')) {
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
        customerEmail: safeEmail || null,
        isPurchase: true,
        productId: prod.id,
        quantity: qty
      })
    });
    var data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error('Erreur de communication avec le serveur de paiement.');
    }
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
          <button type="button" class="btn-primary" onclick="checkOrderMomoStatus('${data.transactionId}', ${total}, ${qty}, decodeURIComponent('${encodeURIComponent(contactVal || '')}'))" style="width: 100%;">
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
        completeMobileMoneyPurchase(prod, total, qty, contactVal);
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
        completeMobileMoneyPurchase(selectedPayProd, total, qty, contactVal);
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
function openDepositModal(suggestedAmount, fromPurchase) {
  var s = DB.get('session');
  if (!s || !s.userId) { openAuthModal('login', 'Veuillez vous connecter pour recharger votre solde.'); return; }

  if (fromPurchase !== true) pendingDepositPurchase = null;
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

  // Un paiement Mobile Money récent est encore en attente : on affiche son suivi plutôt qu'un nouveau formulaire
  if (!fromPurchase && momoTrack && !momoTrack.done && (Date.now() - momoTrack.startedAt) < 15 * 60 * 1000) {
    renderMomoWaitingState('Paiement en attente de confirmation : vérification en cours…');
    startMomoTracking();
  }

  document.getElementById('modal-deposit').classList.add('active');

  var tabsContainer = document.getElementById('deposit-methods-tabs-container');
  if (tabsContainer) {
    tabsContainer.scrollLeft = 0;
  }
}

var selectedMomoCountry = 'CM';
var selectedMomoNetwork = 'orange_cm';
var momoPollingTimer = null;

var MOMO_COUNTRIES = [
  {
    code: 'CM',
    name: 'Cameroun 🇨🇲',
    currency: 'XAF',
    rate: 620,
    prefix: '+237',
    networks: [
      { id: 'orange_cm', name: 'Orange Money', icon: '🍊', otp_required: false, instruction: 'Tapez #150*50#' },
      { id: 'mtn_cm', name: 'MTN MoMo', icon: '🟡', otp_required: false, instruction: 'Validez la notification USSD sur votre écran ou composez *126#.' }
    ]
  },
  {
    code: 'CI',
    name: "Côte d'Ivoire 🇨🇮",
    currency: 'XOF',
    rate: 620,
    prefix: '+225',
    networks: [
      { id: 'wave_ci', name: 'Wave', icon: '🌊', otp_required: false, instruction: 'Ouvrez votre application Wave pour valider le paiement.' },
      { id: 'orange_ci', name: 'Orange Money', icon: '🍊', otp_required: true, otp_prompt: '#144*82# option 2', instruction: 'Composez #144*82# puis l\'option 2 sur votre téléphone pour générer votre code OTP à 4 chiffres.' },
      { id: 'mtn_ci', name: 'MTN MoMo', icon: '🟡', otp_required: false, instruction: 'Validez l\'invite USSD sur votre écran ou composez *133#.' },
      { id: 'moov_ci', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez la demande de débit avec votre code PIN Moov.' },
      { id: 'djamo_ci', name: 'Djamo', icon: '💳', otp_required: false, instruction: 'Confirmez la transaction dans l\'application Djamo.' }
    ]
  },
  {
    code: 'SN',
    name: 'Sénégal 🇸🇳',
    currency: 'XOF',
    rate: 620,
    prefix: '+221',
    networks: [
      { id: 'wave_sn', name: 'Wave', icon: '🌊', otp_required: false, instruction: 'Ouvrez votre application Wave pour confirmer le paiement.' },
      { id: 'orange_sn', name: 'Orange Money', icon: '🍊', otp_required: false, instruction: 'Validez la notification sur votre mobile ou composez #144#.' },
      { id: 'freemoney_sn', name: 'Free Money', icon: '🟢', otp_required: false, instruction: 'Approuvez la demande sur votre compte Free Money.' },
      { id: 'expresso_sn', name: 'Expresso Sénégal', icon: '🔵', otp_required: false, instruction: 'Validez le paiement sur votre mobile Expresso.' }
    ]
  },
  {
    code: 'BJ',
    name: 'Bénin 🇧🇯',
    currency: 'XOF',
    rate: 620,
    prefix: '+229',
    networks: [
      { id: 'mtn_bj', name: 'MTN MoMo', icon: '🟡', otp_required: false, instruction: 'Validez l\'invite USSD sur votre écran MTN MoMo ou composez *880#.' },
      { id: 'moov_bj', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez la demande avec votre code PIN Moov.' },
      { id: 'celtiis_bj', name: 'Celtiis Cash', icon: '🟣', otp_required: false, instruction: 'Validez la transaction sur votre compte Celtiis Cash.' }
    ]
  },
  {
    code: 'BF',
    name: 'Burkina Faso 🇧🇫',
    currency: 'XOF',
    rate: 620,
    prefix: '+226',
    networks: [
      { id: 'orange_bf', name: 'Orange Money', icon: '🍊', otp_required: true, otp_prompt: '*144*4*6*{montant}#', instruction: 'Composez *144*4*6*{amount}# sur votre mobile pour générer votre code de paiement.' },
      { id: 'moov_bf', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez la notification USSD sur votre mobile Moov.' }
    ]
  },
  {
    code: 'TG',
    name: 'Togo 🇹🇬',
    currency: 'XOF',
    rate: 620,
    prefix: '+228',
    networks: [
      { id: 'moov_tg', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez l\'invite USSD sur votre mobile Moov.' },
      { id: 'togocel', name: 'TMoney / Togocel', icon: '🟡', otp_required: false, instruction: 'Validez la notification TMoney avec votre code PIN.' }
    ]
  },
  {
    code: 'GA',
    name: 'Gabon 🇬🇦',
    currency: 'XAF',
    rate: 620,
    prefix: '+241',
    networks: [
      { id: 'airtel_ga', name: 'Airtel Gabon', icon: '🔴', otp_required: false, instruction: 'Validez la demande de débit sur votre mobile Airtel Money.' },
      { id: 'moov_ga', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez l\'invite sur votre mobile Moov.' }
    ]
  },
  {
    code: 'CG',
    name: 'Congo-Brazzaville 🇨🇬',
    currency: 'XAF',
    rate: 620,
    prefix: '+242',
    networks: [
      { id: 'airtel_cg', name: 'Airtel Congo', icon: '🔴', otp_required: false, instruction: 'Validez le paiement sur votre mobile Airtel Money.' },
      { id: 'mtn_cg', name: 'MTN MoMo', icon: '🟡', otp_required: false, instruction: 'Validez l\'invite USSD sur votre écran MTN MoMo.' }
    ]
  },
  {
    code: 'ML',
    name: 'Mali 🇲🇱',
    currency: 'XOF',
    rate: 620,
    prefix: '+223',
    networks: [
      { id: 'orange_ml', name: 'Orange Money', icon: '🍊', otp_required: false, instruction: 'Validez la demande avec votre code secret Orange Money.' },
      { id: 'moov_ml', name: 'Moov Money', icon: '🔵', otp_required: false, instruction: 'Validez l\'invite sur votre téléphone Moov.' },
      { id: 'mobi_cash_ml', name: 'Mobi Cash', icon: '🟣', otp_required: false, instruction: 'Validez la transaction sur votre compte Mobi Cash.' }
    ]
  },
  {
    code: 'NE',
    name: 'Niger 🇳🇪',
    currency: 'XOF',
    rate: 620,
    prefix: '+227',
    networks: [
      { id: 'airtel_ne', name: 'Airtel Niger', icon: '🔴', otp_required: false, instruction: 'Validez l\'invite de prélèvement sur votre téléphone Airtel.' }
    ]
  },
  {
    code: 'GN',
    name: 'Guinée 🇬🇳',
    currency: 'GNF',
    rate: 8600,
    prefix: '+224',
    networks: [
      { id: 'mtn_gn', name: 'MTN MoMo Guinea', icon: '🟡', otp_required: false, instruction: 'Validez l\'invite USSD reçue sur votre téléphone MTN MoMo.' }
    ]
  },
  {
    code: 'GH',
    name: 'Ghana 🇬🇭',
    currency: 'GHS',
    rate: 15.5,
    prefix: '+233',
    networks: [
      { id: 'mtn_gh', name: 'MTN MoMo Ghana', icon: '🟡', otp_required: false, instruction: 'Approve the prompt on your phone or dial *170#.' },
      { id: 'vodafone_gh', name: 'Telecel / Vodafone', icon: '🔴', otp_required: false, instruction: 'Approve the payment request on your mobile.' },
      { id: 'tigo_gh', name: 'AirtelTigo Ghana', icon: '🔵', otp_required: false, instruction: 'Approve the prompt on your phone.' }
    ]
  },
  {
    code: 'KE',
    name: 'Kenya 🇰🇪',
    currency: 'KES',
    rate: 130,
    prefix: '+254',
    networks: [
      { id: 'mpesa_ke', name: 'M-Pesa Kenya', icon: '🟢', otp_required: false, instruction: 'Enter your secret M-Pesa PIN on the prompt.' },
      { id: 'airtel_ke', name: 'Airtel Money Kenya', icon: '🔴', otp_required: false, instruction: 'Approve the Airtel Money prompt.' }
    ]
  },
  {
    code: 'CD',
    name: 'Rép. Dém. du Congo 🇨🇩',
    currency: 'CDF',
    rate: 2850,
    prefix: '+243',
    networks: [
      { id: 'orange_cd', name: 'Orange RDC', icon: '🍊', otp_required: false, instruction: 'Validez la demande sur votre mobile Orange Money.' },
      { id: 'vodacom_cd', name: 'Vodacom M-Pesa', icon: '🔴', otp_required: false, instruction: 'Validez l\'invite M-Pesa avec votre code secret.' },
      { id: 'airtel_cd', name: 'Airtel RDC', icon: '🔴', otp_required: false, instruction: 'Validez le prélèvement Airtel Money.' },
      { id: 'afrimoney_cd', name: 'Afrimoney', icon: '🟣', otp_required: false, instruction: 'Validez la transaction sur votre compte Afrimoney.' }
    ]
  },
  {
    code: 'RW',
    name: 'Rwanda 🇷🇼',
    currency: 'RWF',
    rate: 1350,
    prefix: '+250',
    networks: [
      { id: 'mtn_rw', name: 'MTN MoMo Rwanda', icon: '🟡', otp_required: false, instruction: 'Enter your MoMo PIN to complete payment.' },
      { id: 'airtel_rw', name: 'Airtel Rwanda', icon: '🔴', otp_required: false, instruction: 'Approve the Airtel Money prompt.' }
    ]
  },
  {
    code: 'UG',
    name: 'Ouganda 🇺🇬',
    currency: 'UGX',
    rate: 3700,
    prefix: '+256',
    networks: [
      { id: 'mtn_ug', name: 'MTN MoMo Uganda', icon: '🟡', otp_required: false, instruction: 'Approve the USSD prompt on your phone.' },
      { id: 'airtel_ug', name: 'Airtel Uganda', icon: '🔴', otp_required: false, instruction: 'Approve the Airtel Money prompt.' }
    ]
  },
  {
    code: 'TZ',
    name: 'Tanzanie 🇹🇿',
    currency: 'TZS',
    rate: 2600,
    prefix: '+255',
    networks: [
      { id: 'mpesa_tz', name: 'Vodacom M-Pesa', icon: '🔴', otp_required: false, instruction: 'Enter your M-Pesa PIN on your phone.' },
      { id: 'tigo_tz', name: 'Tigo Pesa', icon: '🔵', otp_required: false, instruction: 'Approve the Tigo Pesa prompt.' },
      { id: 'airtel_tz', name: 'Airtel Money', icon: '🔴', otp_required: false, instruction: 'Approve the Airtel Money prompt.' },
      { id: 'halopesa_tz', name: 'Halopesa', icon: '🟠', otp_required: false, instruction: 'Approve the Halopesa prompt.' }
    ]
  },
  {
    code: 'SL',
    name: 'Sierra Leone 🇸🇱',
    currency: 'SLE',
    rate: 23,
    prefix: '+232',
    networks: [
      { id: 'orange_sl', name: 'Orange Sierra Leone', icon: '🍊', otp_required: false, instruction: 'Approve the Orange Money prompt on your phone.' }
    ]
  },
  {
    code: 'NG',
    name: 'Nigeria 🇳🇬',
    currency: 'NGN',
    rate: 1600,
    prefix: '+234',
    networks: [
      { id: 'allbanks_ng', name: 'Virement bancaire (Swychr)', icon: '🏦', otp_required: false, instruction: 'Suivez les instructions bancaires sécurisées.' }
    ]
  },
  {
    code: 'ALL',
    name: 'Tous Pays & Cartes Bancaires 🌍',
    currency: 'USD',
    rate: 1,
    prefix: '',
    networks: [
      { id: 'checkout_hosted', name: 'Guichet SasPay (Cartes, Visa/Mastercard & Mobile Money)', icon: '⚡', otp_required: false, instruction: 'Accédez au guichet sécurisé officiel SasPay pour choisir librement votre mode de règlement.' }
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
  var prevPhone = document.getElementById('momo-phone-input')?.value;
  var prevOtp = document.getElementById('momo-otp-input')?.value;
  selectedMomoNetwork = netId;
  renderDepositMethodContent();
  var phoneEl = document.getElementById('momo-phone-input');
  if (phoneEl && prevPhone) phoneEl.value = prevPhone;
  var otpEl = document.getElementById('momo-otp-input');
  if (otpEl && prevOtp) otpEl.value = prevOtp;
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
  // Le suivi est mémorisé : il reprend à la prochaine ouverture / au prochain chargement de page
  stopMomoTracking();
  if (trybitPollingTimer) {
    clearInterval(trybitPollingTimer);
    trybitPollingTimer = null;
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

var _isSubmittingSupport = false;
async function submitSupportTicket(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (_isSubmittingSupport) return;

  var name = (document.getElementById('support-name-input')?.value || '').trim();
  var contact = (document.getElementById('support-contact-input')?.value || '').trim();
  var subject = (document.getElementById('support-subject-select')?.value || 'Support Client').trim();
  var message = (document.getElementById('support-message-input')?.value || '').trim();

  if (!contact || !message) {
    showToast('Veuillez renseigner votre contact et votre message.', 'error');
    return;
  }

  _isSubmittingSupport = true;
  var submitBtn = document.getElementById('btn-support-submit');
  var prevBtnHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Envoi en cours... ⚡</span>';
  }

  try {
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

    // Synchronisation backend immédiate
    var session = DB.get('session');
    try {
      await fetch('/api/data/tickets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session && session.token ? { 'Authorization': 'Bearer ' + session.token } : {})
        },
        body: JSON.stringify(newTicket)
      });
    } catch (e) {
      console.warn('Ticket sync:', e);
    }

    showToast('✓ Votre message a été envoyé à l\'équipe GetVirtu avec succès !', 'success');
    closeSupportModal();
    document.getElementById('support-ticket-form')?.reset();
  } finally {
    _isSubmittingSupport = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = prevBtnHtml || '<span>Envoyer mon Message ⚡</span>';
    }
  }
}

function renderDepositMethodsTabs() {
  var container = document.getElementById('deposit-methods-tabs-container');
  if (!container) return;

  var methods = DB.get('payment_methods', []).filter(function(m) { return m.enabled; });
  var isScrollable = methods.length > 4;

  container.classList.toggle('scrollable', isScrollable);

  var navBtns = document.getElementById('pm-scroll-nav-btns');
  if (navBtns) {
    navBtns.style.display = isScrollable ? 'flex' : 'none';
  }

  var savedScrollLeft = container.scrollLeft;

  // Si le nombre de méthodes dépasse 4, organiser les méthodes pour que les deux premières colonnes
  // affichent exactement les 4 premières méthodes dans la disposition 2x2 de la capture 1 :
  // Col 1 : methods[0] (haut-gauche), methods[2] (bas-gauche)
  // Col 2 : methods[1] (haut-droite), methods[3] (bas-droite)
  // Col 3+ : methods[4] (haut), methods[5] (bas)...
  // Pour <= 4 méthodes, la liste normale est conservée avec la grille 2 colonnes par défaut.
  var displayMethods = methods;
  if (isScrollable) {
    displayMethods = [];
    if (methods[0]) displayMethods.push(methods[0]);
    if (methods[2]) displayMethods.push(methods[2]);
    if (methods[1]) displayMethods.push(methods[1]);
    if (methods[3]) displayMethods.push(methods[3]);
    for (var i = 4; i < methods.length; i += 2) {
      if (methods[i]) displayMethods.push(methods[i]);
      if (methods[i + 1]) displayMethods.push(methods[i + 1]);
    }
  }

  var html = '';
  displayMethods.forEach(function(m) {
    var icon = (m.type === 'crypto_trybit' || m.provider === 'trybit') ? '⚡' : (m.type === 'crypto' ? '🪙' : (m.type === 'mobile_money' ? '📱' : '💳'));
    var rawName = m.name || '';
    var mainTitle = rawName;
    var subTitle = '';

    if (m.type === 'mobile_money' || m.id === 'saspay-mobile-money' || m.id === 1) {
      mainTitle = 'Mobile Money';
      subTitle = 'Wave, Orange, MTN';
    } else if (m.type === 'crypto_trybit' || m.provider === 'trybit' || m.id === 2 || m.id === 'trybit') {
      mainTitle = 'Crypto Instant';
      subTitle = 'Trybit (USDT, BTC)';
    } else if (rawName.indexOf('(') !== -1) {
      mainTitle = rawName.substring(0, rawName.indexOf('(')).trim();
      subTitle = rawName.substring(rawName.indexOf('(') + 1).replace(')', '').trim();
    }

    html += `
      <div class="payment-method-tab ${currentDepositMethodId == m.id ? 'active' : ''}" onclick="selectDepositMethodTab('${m.id}')" data-method-id="${m.id}">
        <div class="pm-title"><span class="pm-icon">${icon}</span> <span>${escapeHtml(mainTitle)}</span></div>
        ${subTitle ? `<div class="pm-subtitle">${escapeHtml(subTitle)}</div>` : ''}
      </div>
    `;
  });
  container.innerHTML = html;

  if (isScrollable && savedScrollLeft > 0) {
    container.scrollLeft = savedScrollLeft;
  }

  initDepositModalScroll();
}

function selectDepositMethodTab(mId) {
  if (window._isPaymentTabDragging) return;
  currentDepositMethodId = mId;
  renderDepositMethodsTabs();
  renderDepositMethodContent();

  var container = document.getElementById('deposit-methods-tabs-container');
  if (container && container.classList.contains('scrollable')) {
    var activeTab = container.querySelector(`.payment-method-tab[data-method-id="${mId}"]`);
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
}

function scrollDepositMethodsTabs(dir) {
  var container = document.getElementById('deposit-methods-tabs-container');
  if (!container) return;
  var step = Math.max(160, container.clientWidth * 0.75);
  if (dir === 'left') {
    container.scrollBy({ left: -step, behavior: 'smooth' });
  } else {
    container.scrollBy({ left: step, behavior: 'smooth' });
  }
}

function initDepositModalScroll() {
  var container = document.getElementById('deposit-methods-tabs-container');
  if (!container || container._scrollInitDone) return;
  container._scrollInitDone = true;

  // Défilement horizontal avec la molette de souris
  container.addEventListener('wheel', function(e) {
    if (!container.classList.contains('scrollable')) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      container.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // Glisser-déplacer à la souris sur ordinateur (Mouse drag-to-scroll)
  var isDown = false;
  var startX = 0;
  var scrollLeftStart = 0;
  var dragMoved = false;

  container.addEventListener('mousedown', function(e) {
    if (!container.classList.contains('scrollable')) return;
    isDown = true;
    dragMoved = false;
    startX = e.pageX - container.getBoundingClientRect().left;
    scrollLeftStart = container.scrollLeft;
  });

  window.addEventListener('mouseup', function() {
    if (isDown) {
      isDown = false;
      if (dragMoved) {
        window._isPaymentTabDragging = true;
        setTimeout(function() { window._isPaymentTabDragging = false; }, 60);
      }
    }
  });

  container.addEventListener('mousemove', function(e) {
    if (!isDown) return;
    var x = e.pageX - container.getBoundingClientRect().left;
    var walk = (x - startX);
    if (Math.abs(walk) > 4) {
      dragMoved = true;
      container.scrollLeft = scrollLeftStart - walk;
    }
  });
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
      <div class="pay-qr-wrapper" style="margin-bottom: 6px;">
        <img src="${m.qrCode}" alt="QR Code" style="max-height: 85px;">
        <span class="qr-caption-hint">${qrCaption}</span>
      </div>
    `;
  }

  var addressLabel = isCrypto ? 'Adresse du portefeuille' : 'Numéro de compte / Tél';

  container.innerHTML = `
    ${networkTag ? `<div style="text-align: center; margin-bottom: 4px;">${networkTag}</div>` : ''}
    ${qrHtml}

    <div class="field" style="margin-bottom: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
        <label style="margin-bottom: 0; font-size: 11px; font-weight: 700;">${addressLabel}</label>
        <span style="font-size: 10.5px; color: var(--primary-600); font-weight: 600;">${escapeHtml(m.name)}</span>
      </div>
      <div class="pay-copy-group" style="margin-bottom: 0;">
        <input type="text" id="deposit-addr-value" value="${escapeHtml(m.address)}" readonly style="height: 32px; font-size: 11.5px;">
        <button type="button" class="btn-copy-address" onclick="copyDepositAddress()" style="height: 32px; font-size: 11.5px; padding: 0 10px;">Copier</button>
      </div>
    </div>

    <div class="method-instructions-box" style="padding: 6px 8px; margin-bottom: 6px;">
      <span style="font-size: 13px;">ℹ️</span>
      <p style="margin: 0; font-size: 11.5px; line-height: 1.35;">${escapeHtml(m.instructions || 'Effectuez votre transfert puis joignez votre preuve ci-dessous.')}</p>
    </div>

    <div class="field" style="margin-top: 6px; margin-bottom: 6px;">
      <label style="font-weight: 700; font-size: 11px; color: var(--primary-600); margin-bottom: 2px;">📸 Preuve du transfert (Capture d'écran)</label>
      <div class="proof-dropzone-compact" onclick="document.getElementById('deposit-proof-file-input').click()" style="padding: 8px;">
        <input type="file" id="deposit-proof-file-input" accept="image/*" class="hidden" onchange="handleDepositProofSelected(event)">
        <div id="dep-prompt-text" class="${currentDepositProofBase64 ? 'hidden' : ''}">
          <span style="font-size: 18px;">📁</span>
          <p style="font-size: 11px; margin-top: 1px;">Cliquez pour joindre votre capture de paiement</p>
        </div>
        <div id="dep-preview-wrapper" class="${currentDepositProofBase64 ? '' : 'hidden'}">
          <img id="dep-preview-img" style="max-height: 70px; max-width: 100%; border-radius: 4px; margin-top: 2px; box-shadow: var(--shadow-sm);" src="${currentDepositProofBase64 || ''}" alt="Preuve">
          <p style="font-size: 10.5px; color: var(--emerald-600); margin-top: 2px; font-weight: 600;">✓ Capture prête pour vérification</p>
        </div>
      </div>
    </div>

    <div style="display: flex; justify-content: center; width: 100%; margin-top: 6px;">
      <button type="button" class="btn-primary btn-light-sweep" id="btn-submit-manual" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; text-align: center; height: 38px; font-size: 13px; font-weight: 700; border-radius: 8px; margin: 0 auto;" onclick="submitDepositRequest()">
        Valider la Recharge de Solde ⚡
      </button>
    </div>
  `;
}

function renderSasPayDepositContent(container) {
  var country = getSelectedMomoCountry();
  var amountInput = document.getElementById('deposit-amount-input');
  var amount = parseFloat(amountInput ? amountInput.value : 0) || 10;
  var localAmount = Math.round(amount * country.rate);
  var formattedLocal = localAmount.toLocaleString('fr-FR') + ' ' + country.currency;

  var countryOptionsHtml = MOMO_COUNTRIES.map(function(c) {
    return `<option value="${c.code}" ${c.code === selectedMomoCountry ? 'selected' : ''}>${c.name} (${c.currency})</option>`;
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

  var otpFieldHtml = (currentNet && currentNet.otp_required) ? `
    <div class="field" style="margin-top: 4px; margin-bottom: 4px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; padding: 6px 8px;">
      <label class="momo-phone-label" style="color: #92400e; font-weight: 700; font-size: 11.5px;">
        🔑 Code d'autorisation temporaire / OTP (Requis)
      </label>
      <div style="font-size: 11px; color: #92400e; margin: 0 0 4px 0; line-height: 1.35;">${escapeHtml(currentNet.instruction || 'Générez votre code de paiement depuis votre téléphone.')}</div>
      <input type="text" id="momo-otp-input" placeholder="Code reçu" autocomplete="one-time-code" inputmode="numeric" style="height: 32px; font-size: 13px; font-weight: 700; letter-spacing: 2px;">
    </div>
  ` : '';

  // Ce que le client devra faire sur son téléphone, affiché AVANT de lancer le paiement
  var tipText = '';
  if (!isHosted && currentNet) {
    if (currentNet.id === 'orange_cm') tipText = 'Après avoir cliqué sur « Payer », gardez votre téléphone en main : validez la demande Orange Money avec votre code secret. Si rien ne s\'affiche, composez #150*50#. Vous avez environ 3 minutes.';
    else if (currentNet.id === 'mtn_cm') tipText = 'Après avoir cliqué sur « Payer », validez la demande MTN MoMo avec votre code PIN. Si rien ne s\'affiche, composez *126#. Vous avez environ 3 minutes.';
    else if (!currentNet.otp_required) tipText = 'Après avoir cliqué sur « Payer », validez la demande sur votre téléphone dans les 3 minutes (' + (currentNet.instruction || 'code secret Mobile Money') + ').';
  }
  var cmTipHtml = tipText ? `
    <div style="background: #fff7ed; border: 1px solid #ffedd5; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; font-size: 11.5px; color: #9a3412; text-align: left; font-weight: 600; line-height: 1.4;">
      📱 ${escapeHtml(tipText)}
    </div>
  ` : '';

  var phoneExamples = { CM: '6XX XX XX XX', CI: '07 XX XX XX XX', SN: '7X XXX XX XX', BJ: '01 XX XX XX XX', BF: 'XX XX XX XX', TG: '9X XX XX XX', ML: 'XX XX XX XX', NE: '9X XX XX XX', GN: '6XX XX XX XX', CG: '06 XXX XX XX', GH: '24X XXX XXX', KE: '7XX XXX XXX', CD: '8X XXX XXXX', RW: '78X XXX XXX', UG: '7XX XXX XXX', TZ: '7XX XXX XXX', NG: '80X XXX XXXX', SL: '7X XXX XXX' };
  var phoneFieldHtml = isHosted ? '' : `
    <div class="field" style="margin-top: 4px; margin-bottom: 4px;">
      <label class="momo-phone-label">Numéro Mobile Money (${country.name})</label>
      <div class="phone-input-group">
        <span class="phone-prefix">${country.prefix || '+'}</span>
        <input type="tel" id="momo-phone-input" placeholder="${escapeHtml(phoneExamples[country.code] || '')}" autocomplete="tel" inputmode="tel">
      </div>
    </div>
  `;

  var autoPurchaseHtml = pendingDepositPurchase ? `
    <label style="display: flex; gap: 8px; align-items: flex-start; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; border-radius: 6px; padding: 7px 10px; margin: 4px 0 6px 0; font-size: 11.5px; line-height: 1.4; cursor: pointer;">
      <input type="checkbox" id="momo-auto-purchase" checked style="margin-top: 2px; width: auto; min-height: 0;">
      <span>Valider automatiquement ma commande <strong>${escapeHtml(pendingDepositPurchase.productName || 'produit')}</strong> (x${pendingDepositPurchase.quantity}, $${Number(pendingDepositPurchase.total || 0).toFixed(2)}) dès que le paiement est confirmé.</span>
    </label>
  ` : '';

  container.innerHTML = `
    <div class="momo-country-wrapper">
      <label class="momo-networks-label">1. Choisissez votre Pays</label>
      <select id="momo-country-select" class="momo-select" onchange="onMomoCountryChange(this.value)">
        ${countryOptionsHtml}
      </select>
    </div>

    <div class="field" style="margin-bottom: 4px;">
      <label class="momo-networks-label">2. Choisissez votre Opérateur</label>
      <div class="momo-networks-grid">
        ${networksHtml}
      </div>
    </div>

    ${cmTipHtml}

    <div class="momo-convert-card">
      <div class="momo-convert-left">
        <span style="font-size: 16px;">💱</span>
        <div>
          <div class="momo-convert-label">Montant crédité (Devise locale)</div>
          <div class="momo-convert-value" id="momo-calc-local">${formattedLocal}</div>
        </div>
      </div>
      <div style="text-align: right;">
        <span class="momo-badge-live">Taux SasPay direct</span>
        <div style="font-size: 9.5px; color: var(--text-muted); margin-top: 1px;">1 USD = ${country.rate} ${country.currency}</div>
      </div>
    </div>
    <div style="font-size: 10px; color: var(--text-muted); margin: 3px 0 6px 2px; line-height: 1.35;">
      💡 Prévoyez au moins <strong>~${Math.ceil(localAmount * 1.06).toLocaleString('fr-FR')} ${country.currency}</strong> sur votre compte Mobile Money : les frais de l'opérateur (≈ 3,5 à 6 %) s'ajoutent au montant.
    </div>

    ${phoneFieldHtml}
    ${otpFieldHtml}
    ${autoPurchaseHtml}

    <div style="display: flex; justify-content: center; width: 100%; margin-top: 8px;">
      <button type="button" class="btn-primary btn-light-sweep" id="btn-submit-momo" onclick="submitSasPayDeposit()" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; text-align: center; height: 38px; font-size: 13px; font-weight: 700; border-radius: 8px; margin: 0 auto;">
        Payer avec ${currentNet ? currentNet.icon + ' ' + escapeHtml(currentNet.name) : 'Mobile Money'} ⚡
      </button>
    </div>
  `;
}

function copyToClipboard(text, successMsg) {
  var str = String(text || '');
  if (!str) return Promise.resolve(false);
  var fallbackCopy = function() {
    try {
      var ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  };
  if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str).then(function() {
      if (successMsg) showToast(successMsg, 'success');
      return true;
    }).catch(function() {
      var ok = fallbackCopy();
      if (ok && successMsg) showToast(successMsg, 'success');
      return ok;
    });
  }
  var okSync = fallbackCopy();
  if (okSync && successMsg) showToast(successMsg, 'success');
  return Promise.resolve(okSync);
}
window.copyToClipboard = copyToClipboard;

function copyDepositAddress() {
  var input = document.getElementById('deposit-addr-value');
  if (!input) return;
  copyToClipboard(input.value, 'Copié dans le presse-papiers !');
}

function compressImageFile(file, maxDim, quality) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onerror = function() { resolve(null); };
    reader.onload = function(e) {
      var original = e.target.result;
      var img = new Image();
      img.onerror = function() { resolve(original); };
      img.onload = function() {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        var scale = Math.min(1, maxDim / Math.max(w, h || 1));
        try {
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          var out = c.toDataURL('image/jpeg', quality);
          resolve(out.length < original.length ? out : original);
        } catch (err) { resolve(original); }
      };
      img.src = original;
    };
    reader.readAsDataURL(file);
  });
}

async function handleDepositProofSelected(event) {
  var file = event.target.files[0];
  if (!file) return;

  if (typeof Security !== 'undefined') {
    // Capture d'écran de téléphone acceptée jusqu'à 10 Mo : elle est compressée avant l'envoi
    var check = await Security.validateImageFile(file, 10);
    if (!check.valid) {
      showToast(check.error, 'error');
      event.target.value = '';
      return;
    }
  }

  var dataUrl = await compressImageFile(file, 1600, 0.82);
  if (!dataUrl || dataUrl.length > 2.6 * 1024 * 1024) {
    showToast('Image trop lourde : choisissez une capture plus légère.', 'error');
    event.target.value = '';
    return;
  }
  currentDepositProofBase64 = dataUrl;
  var previewImg = document.getElementById('dep-preview-img');
  var promptEl = document.getElementById('dep-prompt-text');
  var previewWrapper = document.getElementById('dep-preview-wrapper');
  if (previewImg) previewImg.src = currentDepositProofBase64;
  if (promptEl) promptEl.classList.add('hidden');
  if (previewWrapper) previewWrapper.classList.remove('hidden');
  showToast('Capture enregistrée !', 'success');
}

// ========== MOBILE MONEY (SASPAY) : PAIEMENT SUIVI JUSQU'À SA CONFIRMATION OU SON ÉCHEC ==========
// Le suivi est mémorisé (localStorage) : un rechargement, un retour depuis la page de paiement ou une fermeture
// de la fenêtre ne perd jamais un paiement. Le serveur vérifie toujours le statut réel auprès de SasPay.
var MOMO_TRACK_KEY = 'gv_momo_pending';
var momoTrack = null;
var momoCountdownTimer = null;
var pendingDepositPurchase = null;

function saveMomoTrack(t) {
  try { localStorage.setItem(MOMO_TRACK_KEY, JSON.stringify(t)); } catch (e) {}
}
function loadMomoTrack() {
  try {
    var t = JSON.parse(localStorage.getItem(MOMO_TRACK_KEY) || 'null');
    if (t && t.txId && (Date.now() - (t.startedAt || 0)) < 72 * 3600 * 1000) return t;
    if (t) localStorage.removeItem(MOMO_TRACK_KEY);
  } catch (e) {}
  return null;
}
function clearMomoTrack(txId) {
  try {
    var t = loadMomoTrack();
    if (!txId || !t || t.txId === txId) localStorage.removeItem(MOMO_TRACK_KEY);
  } catch (e) {}
}
function stopMomoTracking() {
  if (momoPollingTimer) { clearTimeout(momoPollingTimer); clearInterval(momoPollingTimer); momoPollingTimer = null; }
  if (momoCountdownTimer) { clearInterval(momoCountdownTimer); momoCountdownTimer = null; }
}

async function submitSasPayDeposit(forcedMode) {
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
  var isCheckoutMode = (forcedMode === 'checkout' || selectedMomoNetwork === 'checkout_hosted');
  var phoneInput = document.getElementById('momo-phone-input');
  var rawPhone = phoneInput ? phoneInput.value.trim() : '';

  if (!isCheckoutMode && rawPhone.replace(/\D/g, '').length < 6) {
    showMomoFormError('Veuillez renseigner votre numéro Mobile Money complet.');
    if (phoneInput) phoneInput.focus();
    return;
  }

  var currentNet = country.networks.find(function(n) { return n.id === selectedMomoNetwork; });
  var otpInput = document.getElementById('momo-otp-input');
  var otpVal = otpInput ? otpInput.value.trim() : '';
  if (!isCheckoutMode && currentNet && currentNet.otp_required && !otpVal) {
    showMomoFormError('Ce réseau exige un code de paiement : ' + (currentNet.instruction || 'générez-le depuis votre téléphone') + ' Saisissez-le puis relancez.');
    if (otpInput) otpInput.focus();
    return;
  }

  // Le numéro est envoyé tel que saisi : le serveur le valide et le met au format de l'opérateur (règles par pays)
  var phoneToSend = rawPhone;
  if (rawPhone && !/^\s*(\+|00)/.test(rawPhone) && country.prefix) {
    var digits = rawPhone.replace(/\D/g, '');
    var cc = country.prefix.replace('+', '');
    phoneToSend = digits.indexOf(cc) === 0 && digits.length > cc.length + 7 ? '+' + digits : digits;
  }

  var autoBox = document.getElementById('momo-auto-purchase');
  var purchase = (pendingDepositPurchase && (!autoBox || autoBox.checked)) ? {
    productId: pendingDepositPurchase.productId,
    quantity: pendingDepositPurchase.quantity,
    contactInfo: pendingDepositPurchase.contactInfo || ''
  } : null;

  var submitBtn = document.getElementById('btn-submit-momo');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Envoi de la demande à l\'opérateur... ⏳';
  }
  var alertBox0 = document.getElementById('momo-error-alert');
  if (alertBox0) alertBox0.style.display = 'none';

  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 32000);

  try {
    var resp = await fetch('/api/payments/saspay/create', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amount,
        country: country.code,
        network: isCheckoutMode ? 'checkout_hosted' : selectedMomoNetwork,
        preferredMode: isCheckoutMode ? 'checkout' : 'push',
        phone: phoneToSend,
        otp: otpVal,
        customerName: u.name,
        customerEmail: u.email,
        returnUrl: window.location.origin + '/',
        purchase: purchase
      })
    });
    clearTimeout(timeoutId);

    var data = null;
    try {
      data = await resp.json();
    } catch (parseErr) {
      throw new Error('Réponse illisible du serveur de paiement (erreur ' + resp.status + '). Aucun paiement n\'a été lancé.');
    }

    if (!resp.ok || !data.success) {
      var e = new Error(data.error || data.message || 'Le paiement n\'a pas pu être lancé.');
      e.code = data.code;
      if (data.status === 'failed' && data.transactionId) e.code = 'PAYMENT_FAILED';
      throw e;
    }

    momoTrack = {
      txId: data.transactionId,
      amount: amount,
      mode: data.mode || (isCheckoutMode ? 'checkout' : 'push'),
      startedAt: Date.now(),
      windowSec: data.validationWindowSec || 180,
      network: data.network || selectedMomoNetwork,
      networkName: data.networkName || (currentNet ? currentNet.name : 'Mobile Money'),
      countryName: country.name,
      phone: data.phone || '',
      localAmount: data.localAmount ? Math.round(parseFloat(data.localAmount)).toLocaleString('fr-FR') + ' ' + (data.currency || country.currency) : '',
      checkoutUrl: data.checkoutUrl || null,
      instructions: Array.isArray(data.instructions) ? data.instructions : (data.instructions ? [String(data.instructions)] : []),
      purchase: purchase && pendingDepositPurchase ? { productId: pendingDepositPurchase.productId, productName: pendingDepositPurchase.productName, quantity: pendingDepositPurchase.quantity, total: pendingDepositPurchase.total } : null
    };
    saveMomoTrack(momoTrack);
    pendingDepositPurchase = null;

    if (data.status === 'completed') { handleMomoResult(data); return; }
    renderMomoWaitingState('Demande envoyée. En attente de votre validation…');
    startMomoTracking();
  } catch (err) {
    clearTimeout(timeoutId);
    var errMsg = err.name === 'AbortError'
      ? 'Le serveur de paiement n\'a pas répondu à temps. Si une demande arrive sur votre téléphone, vous pouvez la valider : le paiement sera vérifié automatiquement. Sinon, réessayez.'
      : (err.message || 'Impossible d\'initier le paiement.');
    showToast(errMsg, 'error');
    showMomoFormError(errMsg);
    if (err.code === 'INVALID_PHONE' && phoneInput) phoneInput.focus();
    if (err.code === 'OTP_REQUIRED' && otpInput) otpInput.focus();

    if (submitBtn) {
      submitBtn.disabled = false;
      var cNet = country.networks.find(function(n) { return n.id === selectedMomoNetwork; }) || country.networks[0];
      submitBtn.innerHTML = `Payer avec ${cNet.icon} ${escapeHtml(cNet.name)} ⚡`;
    }
  }
}

// Bandeau d'erreur bien visible au-dessus du bouton « Payer » (motif exact renvoyé par le serveur / l'opérateur)
function showMomoFormError(message) {
  var submitBtn = document.getElementById('btn-submit-momo');
  var alertBox = document.getElementById('momo-error-alert');
  if (!alertBox && submitBtn && submitBtn.parentElement) {
    alertBox = document.createElement('div');
    alertBox.id = 'momo-error-alert';
    alertBox.setAttribute('role', 'alert');
    alertBox.style.cssText = 'background: #fff1f2; border: 1px solid #fecdd3; color: #be123c; border-radius: 6px; padding: 8px 10px; font-size: 11.5px; margin-bottom: 8px; line-height: 1.45; text-align: left; font-weight: 500;';
    submitBtn.parentElement.parentElement.insertBefore(alertBox, submitBtn.parentElement);
  }
  if (alertBox) {
    alertBox.innerHTML = `⚠️ ${escapeHtml(message)}`;
    alertBox.style.display = 'block';
  }
}

function momoFormatClock(sec) {
  sec = Math.max(0, Math.round(sec));
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function renderMomoWaitingState(statusMessage) {
  var t = momoTrack;
  var container = document.getElementById('deposit-dynamic-content');
  if (!container || !t) return;
  var isPush = t.mode === 'push';
  var title = isPush ? '📱 Validez le paiement sur votre téléphone' : (t.mode === 'bank_transfer' ? '🏦 Effectuez le virement indiqué' : '🔐 Finalisez le paiement sur la page sécurisée');
  var steps = (t.instructions || []).map(function(s) { return `<li style="margin-bottom: 4px;">${escapeHtml(s)}</li>`; }).join('');
  var openBtn = t.checkoutUrl ? `
    <a href="${escapeHtml(t.checkoutUrl)}" target="_blank" rel="noopener noreferrer" class="btn-primary btn-light-sweep" style="display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; padding: 10px; font-weight: 700; font-size: 13px; margin-bottom: 8px; border-radius: 6px;">
      ⚡ Ouvrir la page de paiement (${escapeHtml(t.networkName || 'SasPay')}) ↗
    </a>` : '';
  var purchaseLine = t.purchase ? `
    <div style="background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; border-radius: 6px; padding: 7px 10px; margin-bottom: 8px; font-size: 11.5px; text-align: left; line-height: 1.4;">
      🛒 Dès que le paiement est confirmé, votre commande <strong>${escapeHtml(t.purchase.productName || 'produit')}</strong> (x${escapeHtml(String(t.purchase.quantity || 1))}) est validée automatiquement.
    </div>` : '';

  container.innerHTML = `
    <div class="deposit-active-flow" id="deposit-momo-status-box" style="text-align: center; padding: 10px 6px;">
      <div class="pulse-spinner"></div>
      <div class="pulse-indicator">● En attente de confirmation</div>
      <h3 style="font-size: 15px; margin: 0 0 6px 0; color: var(--text-primary);">${title}</h3>
      ${isPush ? `<div id="momo-validate-timer" style="font-size: 12px; font-weight: 700; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 5px 8px; margin-bottom: 8px;">Temps restant pour valider : <span id="momo-validate-clock">${momoFormatClock(t.windowSec - (Date.now() - t.startedAt) / 1000)}</span></div>` : ''}
      ${steps ? `<ol style="background: #f8fafc; border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px 10px 8px 26px; margin: 0 0 10px 0; font-size: 11.5px; color: var(--text-secondary); line-height: 1.45; text-align: left;">${steps}</ol>` : ''}
      ${openBtn}
      ${purchaseLine}
      <div style="background: #ffffff; border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; text-align: left; font-size: 11.5px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="color: var(--text-secondary);">Montant crédité :</span>
          <strong style="color: var(--emerald-600); font-size: 12.5px;">+$${Number(t.amount || 0).toFixed(2)} USD</strong>
        </div>
        ${t.localAmount ? `<div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="color: var(--text-secondary);">Débit opérateur :</span>
          <strong id="momo-charged">${escapeHtml(t.charged || t.localAmount)}${t.charged ? '' : ' + frais'}</strong>
        </div>` : ''}
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="color: var(--text-secondary);">Opérateur :</span>
          <span>${escapeHtml(t.networkName || 'Mobile Money')}${t.phone ? ' · ' + escapeHtml(t.phone) : ''}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--text-secondary);">Réf. transaction :</span>
          <code style="font-size: 10.5px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px;">${escapeHtml(t.txId)}</code>
        </div>
      </div>
      <div id="momo-status-line" role="status" aria-live="polite" style="font-size: 11.5px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">${escapeHtml(statusMessage || 'Vérification en temps réel active…')}</div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn-secondary" id="btn-manual-verify-momo" onclick="checkSasPayStatusManual()" style="flex: 1; padding: 7px; font-size: 12px;">
          Vérifier maintenant 🔄
        </button>
        <button type="button" class="btn-secondary" onclick="abandonMomoTracking()" style="padding: 7px 10px; font-size: 12px;" title="Lancer un nouveau paiement">
          Nouveau paiement
        </button>
      </div>
      <div id="momo-polling-countdown" style="font-size: 10px; color: var(--text-muted); margin-top: 6px;">
        Le statut est vérifié automatiquement auprès de l'opérateur.
      </div>
    </div>
  `;
}

function updateMomoStatusLine(message, isWarning) {
  var el = document.getElementById('momo-status-line');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isWarning ? '#b45309' : 'var(--text-secondary)';
}

function startMomoTracking() {
  stopMomoTracking();
  if (!momoTrack) return;
  var t = momoTrack;
  if (t.mode === 'push') {
    momoCountdownTimer = setInterval(function() {
      var clock = document.getElementById('momo-validate-clock');
      var box = document.getElementById('momo-validate-timer');
      var left = t.windowSec - (Date.now() - t.startedAt) / 1000;
      if (clock) clock.textContent = momoFormatClock(left);
      if (left <= 0 && box) {
        box.textContent = 'Délai de validation écoulé : en attente de la réponse finale de l\'opérateur…';
        clearInterval(momoCountdownTimer);
        momoCountdownTimer = null;
      }
    }, 1000);
  }
  var tick = async function() {
    momoPollingTimer = null;
    if (!momoTrack || momoTrack !== t || t.done) return;
    var r = await fetchMomoStatus(t.txId);
    if (!momoTrack || momoTrack !== t || t.done) return;
    handleMomoResult(r);
    if (t.done) return;
    var elapsed = (Date.now() - t.startedAt) / 1000;
    var limit = t.mode === 'push' ? 900 : Math.max(900, t.windowSec + 120);
    if (elapsed > limit) {
      var cd = document.getElementById('momo-polling-countdown');
      if (cd) cd.innerHTML = '<span style="color: var(--amber-600);">Toujours aucune réponse finale de l\'opérateur. Vous pouvez fermer cette fenêtre : le paiement continue d\'être vérifié automatiquement et votre solde sera crédité dès sa confirmation. Cliquez sur « Vérifier maintenant » pour relancer la vérification.</span>';
      return;
    }
    momoPollingTimer = setTimeout(tick, elapsed < 240 ? 4000 : 10000);
  };
  momoPollingTimer = setTimeout(tick, 3000);
}

async function fetchMomoStatus(txId) {
  try {
    var resp = await fetch('/api/payments/saspay/verify?transactionId=' + encodeURIComponent(txId) + '&_t=' + Date.now(), { cache: 'no-store' });
    var data = await resp.json().catch(function() { return {}; });
    if (resp.status === 401 || resp.status === 403) return { status: 'auth', message: 'Votre session a expiré : reconnectez-vous pour suivre ce paiement (il reste enregistré et sera vérifié automatiquement).' };
    if (resp.status === 404) return { status: 'unknown_tx', message: data.error || 'Paiement introuvable.' };
    if (!resp.ok) return { status: 'error', message: (data && data.error) || ('Serveur momentanément indisponible (erreur ' + resp.status + '). Nouvelle tentative…') };
    return data;
  } catch (e) {
    return { status: 'network', message: 'Connexion internet instable : nouvelle vérification dans quelques secondes…' };
  }
}

function handleMomoResult(r) {
  var t = momoTrack;
  if (!t || !r) return;
  if (r.status === 'completed' || r.status === 'SUCCESS') {
    t.done = true;
    stopMomoTracking();
    clearMomoTrack(t.txId);
    onSasPayPaymentConfirmed(t.txId, typeof r.creditedAmount === 'number' ? r.creditedAmount : t.amount, r.newBalance, r);
    return;
  }
  if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'FAILED' || r.status === 'EXPIRED') {
    t.done = true;
    stopMomoTracking();
    clearMomoTrack(t.txId);
    showSasPayFailedState(r.message, t.txId);
    return;
  }
  if (r.status === 'unknown_tx') {
    t.done = true;
    stopMomoTracking();
    clearMomoTrack(t.txId);
    showSasPayFailedState(r.message, t.txId);
    return;
  }
  if (r.charged && r.charged !== t.charged) {
    t.charged = r.charged;
    saveMomoTrack(t);
    var ch = document.getElementById('momo-charged');
    if (ch) ch.textContent = r.charged;
  }
  var warn = r.status === 'auth' || r.status === 'network' || r.status === 'error' || r.providerReachable === false;
  if (r.message) updateMomoStatusLine(r.message, warn);
  if (r.status === 'auth') stopMomoTracking();
}

function retryMomoPayment() {
  stopMomoTracking();
  momoTrack = null;
  renderDepositMethodContent();
}

function abandonMomoTracking() {
  stopMomoTracking();
  if (momoTrack) clearMomoTrack(momoTrack.txId);
  momoTrack = null;
  renderDepositMethodContent();
}

// Écran d'échec : motif exact transmis par l'opérateur / SasPay + conseil pour réussir le prochain paiement
function showSasPayFailedState(message, txId) {
  stopMomoTracking();
  var container = document.getElementById('deposit-dynamic-content');
  if (!container) return;
  container.innerHTML = `
    <div class="deposit-active-flow" style="text-align: center; padding: 14px 10px;">
      <div style="font-size: 34px; margin-bottom: 6px;">❌</div>
      <h3 style="color: var(--rose-600); font-size: 15.5px; margin: 0 0 6px 0;">Paiement non abouti</h3>
      <div role="alert" style="background: #fff1f2; border: 1px solid #fecdd3; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 12px; color: #9f1239; line-height: 1.5; text-align: left;">
        ${escapeHtml(message || 'Le paiement a été refusé ou a expiré auprès de votre opérateur.')}
      </div>
      <p style="font-size: 11px; color: var(--text-muted); margin: 0 0 12px 0; white-space: normal; overflow-wrap: anywhere;">Votre solde GetVirtu n'a pas été modifié${txId ? ' · Réf. ' + escapeHtml(txId) : ''}.</p>
      <button type="button" class="btn-primary" onclick="retryMomoPayment()" style="width: 100%; margin-bottom: 6px; padding: 8px;">
        Réessayer le paiement 🔄
      </button>
      <button type="button" class="btn-secondary" onclick="closeDepositModal()" style="width: 100%; padding: 7px;">
        Fermer
      </button>
    </div>
  `;
}

async function checkSasPayStatusManual() {
  if (!momoTrack) return;
  var btn = document.getElementById('btn-manual-verify-momo');
  if (btn) { btn.disabled = true; btn.textContent = 'Vérification en cours... 🔄'; }
  try {
    var r = await fetchMomoStatus(momoTrack.txId);
    handleMomoResult(r);
    if (momoTrack && !momoTrack.done) {
      if (r.message) showToast(r.message, r.status === 'pending' ? 'info' : 'warning');
      if (!momoPollingTimer) startMomoTracking();
    }
  } finally {
    var b = document.getElementById('btn-manual-verify-momo');
    if (b) { b.disabled = false; b.textContent = 'Vérifier maintenant 🔄'; }
  }
}

function onSasPayPaymentConfirmed(txId, amount, newBalance, result) {
  result = result || {};
  amount = Number(amount) || 0;
  if (typeof newBalance === 'number') updateUserBalance(newBalance);
  else {
    var session = DB.get('session');
    if (session) { session.balance = (session.balance || 0) + amount; DB.set('session', session); }
  }
  updateNavbar();
  renderConnectedCatalog();
  renderLandingCatalog();

  // Commande validée automatiquement par le serveur dès la confirmation du paiement : on livre la VRAIE commande
  if (result.order && result.order.id) {
    var order = result.order;
    var prod = (DB.get('products', []) || []).find(function(p) { return p && String(p.id) === String(order.productId); }) ||
      { id: order.productId, name: order.productName || 'Produit', category: '', image: '' };
    closeDepositModal();
    selectedPayProd = prod;
    var payModal = document.getElementById('modal-pay');
    if (payModal) payModal.classList.add('active');
    deliverCompletedOrder(prod, order.amount, order.quantity, order.contactInfo, order.method || 'Mobile Money', newBalance, order);
    pendingPurchaseProductId = null;
    return;
  }

  var container = document.getElementById('deposit-dynamic-content');
  var orderWarn = result.orderError ? `
        <div style="background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 6px; padding: 8px 10px; margin: 0 0 12px 0; font-size: 12px; line-height: 1.45; text-align: left;">
          ⚠️ La commande n'a pas pu être validée automatiquement : ${escapeHtml(result.orderError)}<br>Le montant reste disponible sur votre solde.
        </div>` : '';
  if (container) {
    var modal = document.getElementById('modal-deposit');
    if (modal && !modal.classList.contains('active')) modal.classList.add('active');
    container.innerHTML = `
      <div class="deposit-active-flow" style="border-color: #86efac; background: #f0fdf4;">
        <div style="font-size: 42px; margin-bottom: 8px;">🎉</div>
        <h3 style="font-size: 17px; margin: 0 0 6px 0; color: #166534;">Paiement confirmé par l'opérateur !</h3>
        <p style="font-size: 13px; color: #15803d; margin: 0 0 12px 0;">
          Votre solde a été crédité de <strong>+$${amount.toFixed(2)} USD</strong>${typeof newBalance === 'number' ? ' (nouveau solde : $' + newBalance.toFixed(2) + ')' : ''}.
        </p>
        ${orderWarn}
        <button type="button" class="btn-primary" onclick="closeDepositModal()" style="width: 100%;">
          Parfait, Continuer mes achats ⚡
        </button>
      </div>
    `;
  }

  showToast(`🎉 Paiement confirmé ! Solde crédité de +$${amount.toFixed(2)} USD.`, 'success');

  if (pendingPurchaseProductId && !result.orderError) {
    setTimeout(function() {
      closeDepositModal();
      var prodId = pendingPurchaseProductId;
      pendingPurchaseProductId = null;
      startProductPurchase(prodId);
    }, 1200);
  }
}

// Paiements Mobile Money restés en attente (autre appareil, navigateur fermé) : revérifiés auprès de SasPay
// au retour du client (au plus une fois toutes les 10 minutes par navigateur).
function reconcileMyPendingPayments() {
  try {
    var last = parseInt(localStorage.getItem('gv_momo_reconcile_at') || '0', 10) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    localStorage.setItem('gv_momo_reconcile_at', String(Date.now()));
  } catch (e) {}
  fetch('/api/payments/saspay/reconcile', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(r) {
      var results = (r && Array.isArray(r.results)) ? r.results : [];
      if (results.some(function(x) { return x.status === 'completed'; })) {
        showToast('Paiement Mobile Money confirmé par l\'opérateur : votre solde a été mis à jour.', 'success');
        syncUserSessionAndBalance();
      } else if (results.some(function(x) { return x.status === 'failed'; })) {
        showToast('Un paiement Mobile Money en attente n\'a pas abouti : aucun montant n\'a été crédité.', 'info');
      }
    })
    .catch(function() {});
}

// Reprise automatique d'un paiement en cours (retour depuis la page de paiement, rechargement, nouvel onglet)
function resumeMomoTracking() {
  var ret = null;
  try {
    var params = new URLSearchParams(window.location.search);
    ret = params.get('momo_return');
    if (ret) {
      params.delete('momo_return');
      var q = params.toString();
      history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    }
  } catch (e) {}
  var t = loadMomoTrack();
  if (ret && /^TXN-[A-Z0-9-]{4,40}$/i.test(ret) && (!t || t.txId !== ret)) {
    t = { txId: ret, amount: 0, mode: 'checkout', startedAt: Date.now(), windowSec: 1800, networkName: 'SasPay', instructions: [] };
  }
  var s = DB.get('session');
  if (!s || !s.token) return;
  if (!t) { reconcileMyPendingPayments(); return; }
  momoTrack = t;
  fetchMomoStatus(t.txId).then(function(r) {
    if (momoTrack !== t) return;
    var openModal = function() {
      var modal = document.getElementById('modal-deposit');
      if (modal) modal.classList.add('active');
    };
    if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled' || r.status === 'unknown_tx') {
      if (!r.order) openModal();
      if (!t.amount && r.transaction && typeof r.transaction.amount === 'number') t.amount = r.transaction.amount;
      handleMomoResult(r);
      return;
    }
    if (r.status === 'pending') {
      var recent = (Date.now() - t.startedAt) < 15 * 60 * 1000;
      if (ret || recent) {
        openModal();
        renderMomoWaitingState(r.message);
        startMomoTracking();
      } else {
        showToast('Un paiement Mobile Money (' + t.txId + ') attend encore la confirmation de l\'opérateur. Il sera crédité automatiquement dès sa validation.', 'info');
      }
    }
  });
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

    <div style="display: flex; justify-content: center; width: 100%; margin-top: 6px;">
      <button type="button" class="btn-primary btn-light-sweep" id="btn-submit-trybit" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; text-align: center; height: 38px; font-size: 13.5px; font-weight: 700; border-radius: 8px; margin: 0 auto; padding: 6px 12px;" onclick="submitTrybitDeposit()">
        <span>Payer <span id="trybit-btn-dynamic-amount">$${amount.toFixed(2)}</span> ⚡</span>
      </button>
    </div>
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
        returnUrl: window.location.origin + '/?payment_status=success'
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
      var paymentBtnHtml = data.paymentUrl ? `
        <a href="${data.paymentUrl}" target="_blank" rel="noopener noreferrer" class="btn-primary btn-light-sweep" style="display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; text-align: center; margin-bottom: 8px; width: 100%; padding: 10px; font-weight: 700; font-size: 13px; border-radius: 6px;">
          ⚡ Ouvrir la page de paiement Trybit (${escapeHtml(selectedCrypto || 'Crypto')}) ↗
        </a>
      ` : '';

      container.innerHTML = `
        <div class="momo-waiting-box" style="text-align: center; padding: 12px 8px;">
          <div class="pulse-spinner"></div>
          <div class="pulse-indicator">⏳ Facture Trybit Active (${escapeHtml(data.invoiceUuid || '')})</div>
          <h3 style="font-size: 15px; margin: 0 0 4px 0; color: var(--text-primary);">Paiement Crypto Initié ⚡</h3>
          <p style="font-size: 11.5px; color: var(--text-secondary); margin: 0 0 10px 0; line-height: 1.4;">
            La facture officielle Trybit a été générée. Cliquez sur le bouton ci-dessous pour payer l'adresse exacte.
          </p>

          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; text-align: left; font-size: 11.5px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="color: var(--text-secondary);">Montant à créditer :</span>
              <strong style="color: var(--emerald-600); font-size: 12.5px;">+$${amount.toFixed(2)} USD</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="color: var(--text-secondary);">Réf Facture :</span>
              <code style="font-size: 10.5px; background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px;">${escapeHtml(data.invoiceUuid || data.transactionId)}</code>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Validation :</span>
              <span style="color: var(--primary-600); font-weight: 600;">Automatique (Blockchain)</span>
            </div>
          </div>

          ${paymentBtnHtml}

          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn-secondary" onclick="checkTrybitStatusManual('${data.transactionId}', '${data.invoiceUuid || ''}', ${amount})" style="flex: 1; padding: 7px; font-size: 12px;">
              Vérifier le statut 🔄
            </button>
            <button type="button" class="btn-secondary" onclick="renderDepositMethodContent()" style="padding: 7px 10px; font-size: 12px;" title="Changer de moyen">
              Modifier
            </button>
          </div>
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

function showTrybitFailedState(message) {
  if (trybitPollingTimer) {
    clearInterval(trybitPollingTimer);
    trybitPollingTimer = null;
  }
  var container = document.getElementById('deposit-dynamic-content');
  if (!container) return;
  container.innerHTML = `
    <div class="deposit-active-flow" style="text-align: center; padding: 14px 10px;">
      <div style="font-size: 34px; margin-bottom: 6px;">❌</div>
      <h3 style="color: var(--rose-600); font-size: 15.5px; margin: 0 0 4px 0;">Facture non complétée</h3>
      <p style="font-size: 12px; color: var(--text-secondary); margin: 0 0 12px 0; line-height: 1.45;">
        ${escapeHtml(message || 'La facture crypto a été annulée ou a expiré.')}
      </p>
      <button type="button" class="btn-primary" onclick="renderDepositMethodContent()" style="width: 100%; margin-bottom: 6px; padding: 8px;">
        Générer une nouvelle facture 🔄
      </button>
      <button type="button" class="btn-secondary" onclick="closeDepositModal()" style="width: 100%; padding: 7px;">
        Fermer
      </button>
    </div>
  `;
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
      } else if (result.status === 'failed' || result.status === 'canceled' || result.status === 'expired') {
        clearInterval(trybitPollingTimer);
        trybitPollingTimer = null;
        showTrybitFailedState(result.message);
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
    } else if (result.status === 'failed' || result.status === 'canceled' || result.status === 'expired') {
      showTrybitFailedState(result.message);
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

var _isSubmittingManualDeposit = false;
async function submitDepositRequest() {
  if (_isSubmittingManualDeposit) return;
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

  _isSubmittingManualDeposit = true;
  var manualBtn = document.getElementById('btn-submit-manual');
  var prevBtnHtml = manualBtn ? manualBtn.innerHTML : '';
  if (manualBtn) {
    manualBtn.disabled = true;
    manualBtn.innerHTML = 'Envoi en cours... ⚡';
  }

  try {
    var methods = DB.get('payment_methods', []);
    var m = methods.find(function(x) { return x.id == currentDepositMethodId; });
    var txId = 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    var session = DB.get('session');
    var token = session ? session.token : null;

    // 1. Enregistrement côté backend de production si disponible
    try {
      var resp = await fetch('/api/payments/deposit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': 'Bearer ' + token } : {})
        },
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

    closeDepositModal();
    if (pendingPurchaseProductId) {
      showToast(`Demande de recharge de $${amount.toFixed(2)} envoyée ! Votre solde sera crédité dès validation.`, 'success');
    } else {
      showToast(`Demande de transaction initiée (+${amount.toFixed(2)} USD). Statut : En attente de vérification.`, 'success');
    }
  } finally {
    _isSubmittingManualDeposit = false;
    if (manualBtn) {
      manualBtn.disabled = false;
      manualBtn.innerHTML = prevBtnHtml || 'Valider la Recharge de Solde ⚡';
    }
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

  // Rendu immédiat (commandes déjà connues), squelette tant que le serveur n'a pas répondu
  window._gvOrdersState = session.token ? 'loading' : 'ready';
  renderOrdersListInModal();
  document.getElementById('modal-orders').classList.add('active');

  // Synchronisation des commandes du compte depuis le serveur si en ligne
  if (session.token) {
    gvFetch('/api/data/orders?_t=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + session.token, 'Cache-Control': 'no-cache' }
    }, 20000).then(function(r) {
      if (r.status === 401) { AuthState.clearSession(); throw new Error('session'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(res) {
      if (res && res.orders && Array.isArray(res.orders)) {
        window._gvOrdersState = 'ready';
        if (session.role === 'admin') {
          DB.set('orders', res.orders);
        } else {
          var curId = String(session.userId);
          var curEmail = (session.email || '').toLowerCase();
          var otherOrders = (DB.get('orders', []) || []).filter(function(lo) {
            if (!lo) return false;
            var matchId = lo.userId && String(lo.userId) === curId;
            var matchEmail = lo.userEmail && curEmail && lo.userEmail.toLowerCase() === curEmail;
            return !matchId && !matchEmail;
          });
          DB.set('orders', res.orders.concat(otherOrders));
        }
        var modalOrders = document.getElementById('modal-orders');
        if (modalOrders && modalOrders.classList.contains('active')) {
          renderOrdersListInModal();
        }
      }
    }).catch(function() {
      window._gvOrdersState = 'error';
      var modalOrders = document.getElementById('modal-orders');
      if (modalOrders && modalOrders.classList.contains('active')) renderOrdersListInModal();
    });
  }
}

function renderOrdersListInModal() {
  var session = DB.get('session');
  if (!session || !session.userId) return;

  var currentUserIdStr = String(session.userId);
  var currentUserEmail = (session.email || '').toLowerCase();
  var allOrders = DB.get('orders', []);
  var orders = allOrders.filter(function(o) {
    if (!o) return false;
    var matchId = o.userId && String(o.userId) === currentUserIdStr;
    var matchEmail = o.userEmail && currentUserEmail && o.userEmail.toLowerCase() === currentUserEmail;
    return matchId || matchEmail;
  });

  var container = document.getElementById('orders-container-list');
  if (!container) return;

  var ordersStatusNote = '';
  if (window._gvOrdersState === 'error') {
    ordersStatusNote = '<div class="gv-load-error gv-load-error-compact" style="margin-bottom: 12px;"><strong>Impossible d\'actualiser vos commandes</strong> (connexion lente ou interrompue).' +
      ' <button type="button" class="btn-primary btn-sm" style="margin-top: 8px;" onclick="openOrdersModal()">Réessayer</button></div>';
  }
  if (orders.length === 0 && window._gvOrdersState === 'loading') {
    var sk = '<span class="gv-sr-only" role="status">Chargement de vos commandes…</span>';
    for (var si = 0; si < 3; si++) sk += '<div class="gv-skel-order" aria-hidden="true"><span class="gv-skel gv-skel-line" style="width: 45%;"></span><span class="gv-skel gv-skel-line" style="width: 75%; margin-top: 10px;"></span><span class="gv-skel gv-skel-line" style="width: 30%; margin-top: 10px;"></span></div>';
    container.innerHTML = sk;
    return;
  }
  if (orders.length === 0 && ordersStatusNote) {
    container.innerHTML = ordersStatusNote;
    return;
  }

  if (orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 36px 20px; color: var(--text-muted);">
        <p style="font-size: 15px; margin-bottom: 4px;">Aucune commande pour le moment.</p>
        <p style="font-size: 12px;">Vos achats et vos contenus débloqués apparaîtront ici.</p>
      </div>
    `;
    return;
  }

  var html = '';
  orders.forEach(function(o) {
    var dateStr = new Date(o.date).toLocaleString('fr-FR');
    var isValidated = o.status === 'Complété' || o.status === 'Livré';
    var isPending = o.status === 'En attente';
    var isCancelled = o.status === 'Annulé';
    var qtyText = o.quantity && o.quantity > 1 ? ` (x${o.quantity})` : '';

    var statusPill = isValidated
      ? `<span class="order-status-pill online"><span class="order-status-icon">✓</span><span class="order-status-text">Livré</span></span>`
      : (isPending
        ? `<span class="order-status-pill pending"><span class="order-status-icon">⏳</span><span class="order-status-text">En attente</span></span>`
        : `<span class="order-status-pill rejected"><span class="order-status-icon">✕</span><span class="order-status-text">Annulé</span></span>`);

    html += `
      <div class="order-card">
        <div class="order-card-header">
          <div class="order-card-info">
            <div class="order-info-title">${escapeHtml(o.productName)}${qtyText}</div>
            <div class="order-info-meta">Réf : <strong>${escapeHtml(o.id)}</strong> • ${dateStr}</div>
            <div class="order-info-meta">Paiement : <strong>${escapeHtml(o.method || 'Solde Client')}</strong></div>
            ${o.contactInfo ? `<div class="order-info-meta" style="color: var(--primary-600); font-weight: 600;">📱 Notification : ${escapeHtml(o.contactInfo)}</div>` : ''}
          </div>
          <div class="order-pricing-box">
            <div class="order-amount-display">$${Number(o.amount || 0).toFixed(2)}</div>
            ${statusPill}
          </div>
        </div>

        ${isPending && isFulfilmentOrder(o) ? renderFulfilmentBox(o) : ''}

        ${isPending && o.deliveryMode === 'manual' && !isFulfilmentOrder(o) ? renderWhatsAppDeliveryBox(o) : ''}

        ${isPending && o.deliveryMode !== 'manual' ? `
          <div style="background: #fffbeb; border: 1px dashed #fde68a; border-radius: var(--radius-sm); padding: 12px; font-size: 12px; color: #b45309; line-height: 1.45;">
            ⏳ <strong>Commande en attente de validation</strong><br>
            Votre achat est en cours de traitement par l'administrateur. Vos identifiants ou fichiers seront automatiquement débloqués dans votre coffre-fort dès confirmation.
          </div>
        ` : ''}

        ${isCancelled ? `
          <div style="background: #fff1f2; border: 1px dashed #fecdd3; border-radius: var(--radius-sm); padding: 12px; font-size: 12px; color: #e11d48; line-height: 1.45;">
            ✕ <strong>Commande annulée par l'administrateur</strong><br>
            Cette commande a été annulée.${o.refunded ? ' Votre solde a été recrédité de $' + Number(o.amount || 0).toFixed(2) + '.' : ''}
          </div>
        ` : ''}

        ${isValidated && o.vaultContent && isFulfilmentOrder(o) ? `
          <div class="fulfilment-delivered-note" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: var(--radius-sm, 10px); padding: 9px 12px; font-size: 12.5px; color: #166534; margin-bottom: 8px;">
            ✅ <strong>Votre produit a été livré avec succès.</strong>${o.delivery && o.delivery.deliveredAt ? ' Le ' + new Date(o.delivery.deliveredAt).toLocaleString('fr-FR') + '.' : ''}
          </div>
        ` : ''}

        ${isValidated && o.vaultContent ? `
          <div class="vault-delivery-card">
            <div class="vault-header">
              <span class="vault-header-title"><span class="vault-title-icon">🔐</span> Contenu du produit débloqué</span>
              <span class="vault-header-badge"><span class="badge-dot">●</span> Accès vérifié</span>
            </div>
            ${renderVaultContentDisplay(o)}
          </div>
        ` : ''}
      </div>
    `;
  });
  container.innerHTML = ordersStatusNote + html;
}

function jsStr(val) {
  return String(val === null || val === undefined ? '' : val).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '\\x3c').replace(/\r?\n/g, ' ');
}

function isHttpUrl(u) {
  try { var x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:'; } catch (e) { return false; }
}

function renderVaultContentDisplay(order) {
  var v = order.vaultContent;
  if (!v) return '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">En attente de livraison.</p>';
  var orderId = String(order.id);
  var domId = orderId.replace(/[^a-zA-Z0-9_-]/g, '');
  var safeIdJs = jsStr(orderId);

  var rawContent = '';
  var contentType = 'text';
  var fileName = 'licence.txt';
  if (typeof v === 'string') {
    rawContent = v.trim();
  } else if (typeof v === 'object' && v !== null) {
    contentType = v.type || 'text';
    fileName = v.fileName || 'licence.txt';
    if (v.content) rawContent = typeof v.content === 'string' ? v.content.trim() : JSON.stringify(v.content);
    else if (v.key) rawContent = String(v.key).trim();
    else if (Array.isArray(v.keys) && v.keys.length) rawContent = v.keys.map(function(k) { return (k && typeof k === 'object' ? (k.content || k.key || '') : String(k || '')).trim(); }).filter(Boolean).join('\n');
  }

  // Fichier stocké sur le serveur : téléchargement authentifié
  if (contentType === 'file' && v.blobId) {
    return `
      <div class="vault-content-field">
        <span id="vault-text-${domId}">📄 Fichier : <strong>${escapeHtml(fileName)}</strong></span>
      </div>
      <div class="vault-actions-row">
        <button type="button" class="btn-vault-action" style="background: var(--gold-500, #f59e0b); color: #000;" onclick="downloadOrderFile('${safeIdJs}', '${jsStr(fileName)}')" title="Télécharger le fichier">📥 Télécharger</button>
      </div>
    `;
  }

  if (!rawContent) {
    // Jamais de clé inventée : le contenu manquant est signalé honnêtement
    return '<p style="color: #b45309; font-size: 12px; margin: 0;">Contenu en cours de préparation. Contactez le support si vous ne le recevez pas rapidement.</p>';
  }

  if (!window._vaultSecretsCache) window._vaultSecretsCache = {};
  window._vaultSecretsCache[orderId] = rawContent;
  var safeContent = escapeHtml(rawContent);
  var singleLine = rawContent.split(/\r?\n/).filter(Boolean).length === 1;

  if ((contentType === 'link' || /^https?:\/\//i.test(rawContent)) && singleLine && isHttpUrl(rawContent)) {
    return `
      <div class="vault-content-field">
        <span id="vault-text-${domId}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${safeContent}</span>
      </div>
      <div class="vault-actions-row">
        <button type="button" class="btn-vault-action" id="btn-copy-${domId}" onclick="copyOrderVaultSecret('${safeIdJs}')" title="Copier le lien">
          <span id="vault-copy-icon-${domId}">📋</span>
          <span id="vault-copy-label-${domId}">Copier</span>
        </button>
        <a href="${safeContent}" target="_blank" rel="noopener noreferrer" class="btn-vault-action" style="background: var(--gold-500, #f59e0b); color: #000; text-decoration: none;" title="Ouvrir le lien sécurisé">🔗 Ouvrir le Lien &rarr;</a>
      </div>
    `;
  }
  if (contentType === 'file') {
    return `
      <div class="vault-content-field">
        <span id="vault-text-${domId}">📄 Fichier : <strong>${escapeHtml(fileName)}</strong></span>
      </div>
      <div class="vault-actions-row">
        <button type="button" class="btn-vault-action" id="btn-copy-${domId}" onclick="copyOrderVaultSecret('${safeIdJs}')" title="Copier le contenu">
          <span id="vault-copy-icon-${domId}">📋</span>
          <span id="vault-copy-label-${domId}">Copier</span>
        </button>
        <button type="button" class="btn-vault-action" style="background: var(--gold-500, #f59e0b); color: #000;" onclick="downloadVaultFile('${jsStr(fileName)}', '${encodeURIComponent(rawContent)}')" title="Télécharger le fichier">📥 Télécharger</button>
      </div>
    `;
  }
  return `
    <div class="vault-content-field">
      <span id="vault-text-${domId}" data-real="${safeContent}" data-hidden="true" class="vault-secret-masked">••••••••••••••••</span>
    </div>
    <div id="vault-breakdown-${domId}" class="vault-breakdown-box" style="display: none; margin-top: 8px;"></div>
    <div class="vault-actions-row">
      <button type="button" class="btn-vault-action" id="btn-reveal-${domId}" onclick="toggleVaultSecret('${safeIdJs}')" title="Afficher ou masquer la clé">
        <span id="vault-icon-${domId}">👁️</span>
        <span id="vault-label-${domId}">Révéler</span>
      </button>
      <button type="button" class="btn-vault-action" id="btn-copy-${domId}" onclick="copyOrderVaultSecret('${safeIdJs}')" title="Copier la clé complète au format original">
        <span id="vault-copy-icon-${domId}">📋</span>
        <span id="vault-copy-label-${domId}">Copier la clé complète</span>
      </button>
    </div>
  `;
}

// Téléchargement d'un fichier livré (stocké sur le serveur) avec la session du client
async function downloadOrderFile(orderId, fileName) {
  try {
    var res = await fetch('/api/data/download?orderId=' + encodeURIComponent(orderId), { cache: 'no-store' });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'Téléchargement impossible.');
    }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'livraison';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 2000);
  } catch (e) {
    showToast(e.message || 'Téléchargement impossible.', 'error');
  }
}
window.downloadOrderFile = downloadOrderFile;

function renderKeyBreakdownHtml(keyString) {
  if (!keyString || typeof keyString !== 'string') return '';
  var lines = keyString.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return '';
  
  var hasPipe = lines.some(function(l) { return l.includes('|'); });
  if (!hasPipe) return '';

  var html = '<div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; margin-top: 6px; font-size: 11.5px; display: flex; flex-direction: column; gap: 8px;">';
  html += '<div style="font-weight: 700; color: #334155; font-size: 11px; display: flex; align-items: center; justify-content: space-between;">';
  html += '<span>Détail des éléments de la clé (séparés par <code>|</code>) :</span>';
  html += '<span style="font-size: 10px; color: #059669; font-weight: 600;">Ordre original préservé ✓</span>';
  html += '</div>';

  lines.forEach(function(line, lineIdx) {
    var parts = line.split('|').map(function(p) { return p.trim(); });
    if (lines.length > 1) {
      html += '<div style="font-weight: 700; color: var(--primary-600); font-size: 11px; margin-top: 4px;">Clé #' + (lineIdx + 1) + ' :</div>';
    }
    html += '<div style="display: flex; flex-direction: column; gap: 4px;">';
    parts.forEach(function(part, idx) {
      if (!part) return;
      var safePart = escapeHtml(part);
      var isUrl = /^https?:\/\//i.test(part);
      var isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part);
      var isPhone = /^\+?[0-9\s\-()]{8,20}$/.test(part);

      var icon = '📄';
      var label = 'Info ' + (idx + 1);

      if (idx === 0 && isEmail) {
        icon = '📧';
        label = 'Email principal';
      } else if (idx === 1 && !isUrl) {
        icon = '🔑';
        label = 'Mot de passe';
      } else if (isUrl) {
        icon = '🔗';
        label = 'URL de service';
      } else if (isPhone) {
        icon = '📱';
        label = 'Téléphone';
      } else if (isEmail) {
        icon = '✉️';
        label = 'Email secondaire';
      } else if (/^[A-Za-z0-9\-_]{5,30}$/.test(part)) {
        icon = '🛡️';
        label = 'Code 2FA / Récupération';
      }

      html += `
        <div style="display: flex; align-items: center; justify-content: space-between; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 5px 8px; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 5px; overflow: hidden; flex: 1;">
            <span style="font-size: 12px; flex-shrink: 0;">${icon}</span>
            <span style="font-size: 10px; color: #64748b; font-weight: 600; white-space: nowrap; flex-shrink: 0;">${label} :</span>
            <span style="font-family: monospace; font-size: 11px; color: #0f172a; word-break: break-all; font-weight: 600;">${safePart}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
            ${isUrl ? `<a href="${safePart}" target="_blank" rel="noopener noreferrer" class="btn-vault-action" style="padding: 2px 6px; font-size: 10px; background: #fef3c7; color: #92400e; text-decoration: none;" title="Ouvrir le lien">Ouvrir ↗</a>` : ''}
            <button type="button" class="btn-vault-action" style="padding: 2px 6px; font-size: 10px;" onclick="copySingleKeyPart(decodeURIComponent('${encodeURIComponent(part)}'), '${escapeHtml(label)}')" title="Copier uniquement cet élément">
              📋 Copier
            </button>
          </div>
        </div>
      `;
    });
    html += '</div>';
  });

  html += '</div>';
  return html;
}

window.copySingleKeyPart = function(part, label) {
  copyToClipboard(part, (label || 'Élément') + ' copié dans le presse-papiers !');
};

window.toggleVaultSecret = function(orderId) {
  var textEl = document.getElementById('vault-text-' + orderId);
  var iconEl = document.getElementById('vault-icon-' + orderId);
  var labelEl = document.getElementById('vault-label-' + orderId);
  var breakdownEl = document.getElementById('vault-breakdown-' + orderId);
  if (!textEl) return;

  // Sécurité : Vérifier le statut de la commande
  var allOrders = DB.get('orders', []);
  var order = allOrders.find(function(o) { return o && String(o.id) === String(orderId); });

  if (order && order.status !== 'Complété' && order.status !== 'Livré') {
    showToast("Votre commande est en attente : le contenu sera débloqué dès confirmation.", 'warning');
    return;
  }

  var isHidden = textEl.getAttribute('data-hidden') === 'true';
  if (isHidden) {
    var realSecret = (window._vaultSecretsCache && window._vaultSecretsCache[orderId])
      || textEl.getAttribute('data-real');

    if (!realSecret || realSecret === '{}') {
      if (order && order.vaultContent) {
        if (typeof order.vaultContent === 'string') realSecret = order.vaultContent;
        else if (order.vaultContent.content) realSecret = order.vaultContent.content;
      }
    }
    if (!realSecret || realSecret === '{}') {
      realSecret = 'GV-' + (order ? order.productId || 'PROD' : 'PROD') + '-' + String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase() + '-KEY-ACTIF';
    }

    textEl.textContent = realSecret;
    textEl.className = 'vault-secret-revealed';
    textEl.setAttribute('data-hidden', 'false');
    if (iconEl) iconEl.textContent = '🙈';
    if (labelEl) labelEl.textContent = 'Masquer';

    if (breakdownEl) {
      var breakdownHtml = renderKeyBreakdownHtml(realSecret);
      if (breakdownHtml) {
        breakdownEl.innerHTML = breakdownHtml;
        breakdownEl.style.display = 'block';
      } else {
        breakdownEl.innerHTML = '';
        breakdownEl.style.display = 'none';
      }
    }

    showToast('Contenu du produit révélé avec succès.', 'info');
  } else {
    textEl.textContent = '••••••••••••••••';
    textEl.className = 'vault-secret-masked';
    textEl.setAttribute('data-hidden', 'true');
    if (iconEl) iconEl.textContent = '👁️';
    if (labelEl) labelEl.textContent = 'Révéler';

    if (breakdownEl) {
      breakdownEl.innerHTML = '';
      breakdownEl.style.display = 'none';
    }

    showToast('Contenu masqué pour votre sécurité.', 'info');
  }
};

window.copyOrderVaultSecret = function(orderId) {
  var btn = document.getElementById('btn-copy-' + orderId);
  var iconEl = document.getElementById('vault-copy-icon-' + orderId);
  var labelEl = document.getElementById('vault-copy-label-' + orderId);
  var textEl = document.getElementById('vault-text-' + orderId);

  // Sécurité : Vérifier le statut de la commande
  var allOrders = DB.get('orders', []);
  var order = allOrders.find(function(o) { return o && String(o.id) === String(orderId); });

  if (order && order.status !== 'Complété' && order.status !== 'Livré') {
    showToast("Commande non validée : aucun contenu à copier pour le moment.", 'warning');
    return;
  }

  var contentToCopy = (window._vaultSecretsCache && window._vaultSecretsCache[orderId])
    || (textEl ? textEl.getAttribute('data-real') : null);

  if (!contentToCopy || contentToCopy === '{}') {
    if (order && order.vaultContent) {
      if (typeof order.vaultContent === 'string') {
        contentToCopy = order.vaultContent;
      } else if (order.vaultContent.content) {
        contentToCopy = typeof order.vaultContent.content === 'string'
          ? order.vaultContent.content
          : JSON.stringify(order.vaultContent.content);
      } else if (order.vaultContent.key) {
        contentToCopy = order.vaultContent.key;
      }
    }
  }

  if (!contentToCopy || contentToCopy === '{}') {
    contentToCopy = 'GV-' + (order ? order.productId || 'PROD' : 'PROD') + '-' + String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase() + '-KEY-ACTIF';
  }

  var doCopy = function() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(contentToCopy);
    } else {
      return new Promise(function(resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = contentToCopy;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.top = '-9999px';
          ta.setAttribute('readonly', '');
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) resolve(); else reject(new Error('execCommand copy failed'));
        } catch (e) {
          reject(e);
        }
      });
    }
  };

  doCopy().then(function() {
    showToast('✓ Clé / contenu copié dans le presse-papiers avec succès !', 'success');
    if (btn) btn.classList.add('copied');
    if (iconEl) iconEl.textContent = '✓';
    if (labelEl) labelEl.textContent = 'Copié !';

    setTimeout(function() {
      if (btn) btn.classList.remove('copied');
      if (iconEl) iconEl.textContent = '📋';
      if (labelEl) labelEl.textContent = 'Copier';
    }, 2000);
  }).catch(function() {
    try {
      var ta = document.createElement('textarea');
      ta.value = contentToCopy;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✓ Clé / contenu copié dans le presse-papiers avec succès !', 'success');
      if (btn) btn.classList.add('copied');
      if (iconEl) iconEl.textContent = '✓';
      if (labelEl) labelEl.textContent = 'Copié !';
      setTimeout(function() {
        if (btn) btn.classList.remove('copied');
        if (iconEl) iconEl.textContent = '📋';
        if (labelEl) labelEl.textContent = 'Copier';
      }, 2000);
    } catch(err) {
      console.warn('Presse-papiers indisponible :', err);
      showToast('Presse-papiers indisponible. Veuillez copier manuellement.', 'warning');
    }
  });
};

window.copyText = function(val) {
  copyToClipboard(val, '✓ Copié dans le presse-papiers !');
};

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
              } else if (resp.error === 'origin_mismatch' || (resp.error && resp.error.indexOf('origin') !== -1)) {
                showToast('Origine non autorisée : ajoutez ' + window.location.origin + ' dans la Google Cloud Console.', 'warning');
              } else {
                showToast('Erreur Google: ' + (resp.error_description || resp.error), 'error');
              }
            }
          },
          error_callback: function(err) {
            console.warn('[Google Auth] Error callback popup:', err);
            showToast('Autorisation Google non validée pour ' + window.location.origin + '.', 'warning');
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
var _isLoginSubmitting = false;
async function handleLoginSubmit(e) {
  e.preventDefault();
  if (_isLoginSubmitting) return;
  var email = document.getElementById('login-email').value.trim().toLowerCase();
  var pass = document.getElementById('login-password').value;
  var err = document.getElementById('login-error-msg');
  var loginBtn = document.getElementById('btn-login-submit');
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

  _isLoginSubmitting = true;
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connexion en cours... ⚡';
  }

  try {
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
          DB.set('admin_session', data.session);
          showToast('Connexion administrateur réussie ! 🔒', 'success');
          setTimeout(function() { window.location.href = 'admin.html'; }, 200);
          return;
        }

        AuthState.setAuthenticatedSession(data.session, data.user, 'password');
        showToast('Bienvenue ' + data.user.name + ' ! 👋', 'success');
        closeAuthModal();
        if (data.user && data.user.mustChangePassword) {
          setTimeout(function() { openAccountModal(true); }, 250);
          return;
        }

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
      err.textContent = (data && data.error) || 'Connexion impossible pour le moment. Veuillez réessayer.';
      err.style.color = 'var(--rose-500)';
      err.classList.remove('hidden');
      return;
    } catch (apiErr) {
      // Pas de connexion « locale » de secours : une session sans jeton serveur ne permettrait aucun achat.
      err.textContent = 'Serveur injoignable. Vérifiez votre connexion internet puis réessayez.';
      err.style.color = 'var(--rose-500)';
      err.classList.remove('hidden');
      return;
    }
  } finally {
    _isLoginSubmitting = false;
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Se connecter';
    }
  }
}

// 2. INSCRIPTION AVEC EMAIL ET MOT DE PASSE (PRODUCTION : 0.00 $ DE SOLDE DE DÉPART)
var _isRegisterSubmitting = false;
async function handleRegisterSubmit(e) {
  e.preventDefault();
  if (_isRegisterSubmitting) return;
  var name = document.getElementById('reg-name').value.trim();
  var usernameInput = document.getElementById('reg-username');
  var username = usernameInput ? usernameInput.value.trim().toLowerCase() : '';
  var email = document.getElementById('reg-email').value.trim().toLowerCase();
  var pass = document.getElementById('reg-password').value;
  var passConfirm = document.getElementById('reg-password-confirm').value;
  var err = document.getElementById('reg-error-msg');
  var regBtn = document.getElementById('btn-register-submit');
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

  _isRegisterSubmitting = true;
  if (regBtn) {
    regBtn.disabled = true;
    regBtn.textContent = 'Création du compte... ⚡';
  }

  try {
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
      err.textContent = (data && data.error) || 'Inscription impossible pour le moment. Veuillez réessayer.';
      err.classList.remove('hidden');
      return;
    } catch (apiErr) {
      // Pas de compte « local » de secours : il n'existerait pas sur le serveur.
      err.textContent = 'Serveur injoignable. Vérifiez votre connexion internet puis réessayez.';
      err.classList.remove('hidden');
      return;
    }
  } finally {
    _isRegisterSubmitting = false;
    if (regBtn) {
      regBtn.disabled = false;
      regBtn.textContent = "S'inscrire";
    }
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

// ========== MON COMPTE : PROFIL & MOT DE PASSE ==========
var _accountForced = false;
function openAccountModal(forced) {
  var s = AuthState.getSession();
  if (!s || !s.userId) { openAuthModal('login'); return; }
  _accountForced = Boolean(forced);
  var u = AuthState.getUser() || {};
  document.getElementById('account-subtitle').textContent = (u.email || s.email || '') + (u.username ? ' • @' + u.username : '');
  document.getElementById('account-name').value = u.name || s.name || '';
  document.getElementById('account-force-banner').classList.toggle('hidden', !_accountForced);
  document.getElementById('account-current-pwd-field').classList.toggle('hidden', _accountForced);
  document.getElementById('account-close-btn').classList.toggle('hidden', _accountForced);
  ['account-current-pwd', 'account-new-pwd', 'account-confirm-pwd'].forEach(function(id) { document.getElementById(id).value = ''; });
  document.getElementById('account-pwd-msg').classList.add('hidden');
  document.getElementById('modal-account').classList.add('active');
}
function closeAccountModal() {
  if (_accountForced) return; // changement obligatoire après un mot de passe temporaire
  document.getElementById('modal-account').classList.remove('active');
}
async function saveAccountProfile(e) {
  e.preventDefault();
  var name = document.getElementById('account-name').value.trim();
  var btn = document.getElementById('btn-account-profile');
  btn.disabled = true;
  try {
    var res = await fetch('/api/auth/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(data.error || 'Mise à jour impossible.');
    var s = AuthState.getSession();
    if (s) { s.name = data.user.name; AuthState.setAuthenticatedSession(s, data.user, 'profile'); }
    showToast('Nom mis à jour.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally { btn.disabled = false; }
}
async function saveAccountPassword(e) {
  e.preventDefault();
  var cur = document.getElementById('account-current-pwd').value;
  var nw = document.getElementById('account-new-pwd').value;
  var conf = document.getElementById('account-confirm-pwd').value;
  var msg = document.getElementById('account-pwd-msg');
  var btn = document.getElementById('btn-account-password');
  msg.classList.add('hidden');
  var fail = function(t) { msg.textContent = t; msg.style.color = 'var(--rose-500)'; msg.classList.remove('hidden'); };
  if (nw.length < 8 || !/[A-Za-z]/.test(nw) || !/[0-9]/.test(nw)) return fail('Le mot de passe doit contenir au moins 8 caractères, avec des lettres et des chiffres.');
  if (nw !== conf) return fail('Les deux mots de passe ne correspondent pas.');
  btn.disabled = true;
  try {
    var body = { newPassword: nw, confirmPassword: conf };
    if (!_accountForced) body.currentPassword = cur;
    var res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(data.error || 'Changement impossible.');
    if (data.session) AuthState.setAuthenticatedSession(data.session, Object.assign({}, AuthState.getUser(), { mustChangePassword: false }), 'password_change');
    _accountForced = false;
    document.getElementById('account-close-btn').classList.remove('hidden');
    document.getElementById('modal-account').classList.remove('active');
    showToast('Mot de passe modifié. Vos autres appareils ont été déconnectés.', 'success');
  } catch (err) {
    fail(err.message);
  } finally { btn.disabled = false; }
}

// ========== MOT DE PASSE OUBLIÉ ==========
function openForgotPasswordModal() {
  closeAuthModal();
  document.getElementById('forgot-result').classList.add('hidden');
  document.getElementById('forgot-form').classList.remove('hidden');
  var em = document.getElementById('login-email');
  var f = document.getElementById('forgot-email');
  if (em && f && em.value.indexOf('@') > 0) f.value = em.value.trim();
  document.getElementById('modal-forgot').classList.add('active');
}
function closeForgotPasswordModal() { document.getElementById('modal-forgot').classList.remove('active'); }
async function submitForgotPassword(e) {
  e.preventDefault();
  var btn = document.getElementById('btn-forgot-submit');
  var out = document.getElementById('forgot-result');
  btn.disabled = true;
  try {
    var res = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('forgot-email').value.trim() }) });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(data.error || 'Demande impossible pour le moment.');
    var wa = getWhatsAppNumber ? getWhatsAppNumber() : '';
    out.innerHTML = escapeHtml(data.message) + (data.emailDelivery ? '' :
      '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
      (wa ? '<a class="btn-primary btn-sm" style="text-decoration:none;" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + encodeURIComponent(wa) + '?text=' + encodeURIComponent('Bonjour, je souhaite réinitialiser le mot de passe de mon compte GetVirtu (' + document.getElementById('forgot-email').value.trim() + ').') + '">💬 WhatsApp</a>' : '') +
      '<button type="button" class="btn-secondary btn-sm" onclick="closeForgotPasswordModal(); openSupportModal();">Formulaire de support</button></div>');
    out.classList.remove('hidden');
    document.getElementById('forgot-form').classList.add('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  } finally { btn.disabled = false; }
}

// ========== NOUVEAU MOT DE PASSE VIA LIEN (#reset-password=<jeton>) ==========
var _pendingResetToken = null;
function checkResetPasswordLink() {
  var m = /^#reset-password=([A-Za-z0-9_\-%]+)$/.exec(window.location.hash || '');
  if (!m) return;
  _pendingResetToken = decodeURIComponent(m[1]);
  try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
  document.getElementById('modal-reset-password').classList.add('active');
}
function closeResetPasswordModal() { _pendingResetToken = null; document.getElementById('modal-reset-password').classList.remove('active'); }
async function submitResetPassword(e) {
  e.preventDefault();
  var nw = document.getElementById('reset-new-pwd').value;
  var conf = document.getElementById('reset-confirm-pwd').value;
  var msg = document.getElementById('reset-pwd-msg');
  var btn = document.getElementById('btn-reset-pwd-submit');
  msg.classList.add('hidden');
  btn.disabled = true;
  try {
    var res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: _pendingResetToken, newPassword: nw, confirmPassword: conf }) });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok) throw new Error(data.error || 'Réinitialisation impossible.');
    closeResetPasswordModal();
    showToast(data.message || 'Mot de passe réinitialisé.', 'success');
    openAuthModal('login', 'Connectez-vous avec votre nouveau mot de passe.');
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = 'var(--rose-500)';
    msg.classList.remove('hidden');
  } finally { btn.disabled = false; }
}
window.openAccountModal = openAccountModal;
window.closeAccountModal = closeAccountModal;
window.saveAccountProfile = saveAccountProfile;
window.saveAccountPassword = saveAccountPassword;
window.openForgotPasswordModal = openForgotPasswordModal;
window.closeForgotPasswordModal = closeForgotPasswordModal;
window.submitForgotPassword = submitForgotPassword;
window.closeResetPasswordModal = closeResetPasswordModal;
window.submitResetPassword = submitResetPassword;

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
  if (window._toastHideTimer) clearTimeout(window._toastHideTimer);
  var icon = type === 'success' ? '✓' : (type === 'error' ? '⚠️' : 'ℹ️');
  t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
  t.className = 'toast-' + (type || 'info');
  t.style.display = 'flex';
  t.style.animation = 'toastCenterIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    t.style.animation = 'toastCenterOut 0.22s ease forwards';
    window._toastHideTimer = setTimeout(function() {
      t.style.display = 'none';
      t.style.animation = '';
    }, 220);
  }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.addEventListener('storage', function(e) {
  if (e.key && e.key.indexOf('vs_') === 0) routeUserExperience();
});

window.addEventListener('hashchange', function() {
  var h = (window.location.hash || '').replace('#', '').trim();
  if (h && ['how-it-works', 'faq', 'features', 'reviews', 'hero'].indexOf(h) !== -1) {
    navigateShopSection(h);
    return;
  }
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
    // Le catalogue affiché provient toujours du serveur (jamais d'un cache potentiellement périmé)
    DB.set('products', []);
    window._gvCatalogState = 'loading';

    // Vérification d'intégrité : si la session active est un compte client, purger tout reliquat d'admin_session
    var currentS = DB.get('session');
    if (currentS && currentS.role !== 'admin') {
      DB.del('admin_session');
      try { localStorage.removeItem('vs_admin_session'); } catch (e) {}
    }

    // Nettoyage fluide du paramètre URL après retour Google OAuth
    if (window.location.search && window.location.search.includes('auth_success=google')) {
      try { history.replaceState(null, '', window.location.pathname + '#catalog'); } catch (e) {}
    }

    // Gestion du retour de paiement Trybit Crypto (Succès / Annulation)
    if (window.location.search) {
      try {
        var searchParams = new URLSearchParams(window.location.search);
        var payStatus = searchParams.get('payment_status');
        var invUuid = searchParams.get('invoice_uuid');
        var ordId = searchParams.get('order_id');

        if (payStatus === 'success' || searchParams.has('order_crypto') || searchParams.has('deposit_success')) {
          showToast('Paiement Crypto validé ! Vérification et synchronisation en cours...', 'success');
          if (invUuid || ordId) {
            fetch(`/api/payments/trybit/verify?transactionId=${encodeURIComponent(ordId || '')}&invoiceUuid=${encodeURIComponent(invUuid || '')}`)
              .then(function(r) { return r.json(); })
              .then(function(res) {
                if (res && res.status === 'completed') {
                  if (typeof res.newBalance === 'number') updateUserBalance(res.newBalance);
                  showToast('Votre solde a été mis à jour avec succès !', 'success');
                }
              }).catch(function() {});
          }
          history.replaceState(null, '', window.location.pathname + '#catalog');
        } else if (payStatus === 'failed' || payStatus === 'fail' || payStatus === 'canceled') {
          showToast('Le paiement en cryptomonnaie a été annulé ou a expiré.', 'info');
          history.replaceState(null, '', window.location.pathname + '#catalog');
        }
      } catch (e) {}
    }

    // Nettoyage proactif des caches et vérification de la dernière version
    VersionManager.init();

    // Traçabilité des visites réelles (Prompt 8)
    trackVisitor();

    // Routage immédiat et synchrone
    initMobileViewportUX();
    initModalInteractionsUX();
    routeUserExperience();
    checkResetPasswordLink();
    initGoogleIdentity();
    syncUserSessionAndBalance();
    syncProductsFromServer();
    syncPaymentMethodsFromServer();
    // Paiement Mobile Money en cours (retour de la page de paiement, rechargement) : reprise du suivi
    setTimeout(function() { try { resumeMomoTracking(); } catch (err) { console.error('[GetVirtu momo resume]', err); } }, 700);
  } catch (e) {
    console.error('[GetVirtu startApp]', e);
  }
}

var _modalUXInitialized = false;
function initModalInteractionsUX() {
  if (_modalUXInitialized) return;
  _modalUXInitialized = true;

  var authModal = document.getElementById('auth-modal');
  if (authModal) {
    authModal.addEventListener('click', function(e) {
      if (e.target === authModal) closeAuthModal();
    });
  }

  document.querySelectorAll('.modal-backdrop').forEach(function(backdrop) {
    backdrop.addEventListener('click', function(e) {
      if (e.target !== backdrop) return;
      if (backdrop.id === 'modal-pay') closePayModal();
      else if (backdrop.id === 'modal-deposit') closeDepositModal();
      else if (backdrop.id === 'modal-support') closeSupportModal();
      else if (backdrop.id === 'modal-orders') closeOrdersModal();
      else backdrop.classList.remove('active');
    });
  });

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (authModal && authModal.classList.contains('active')) closeAuthModal();
    var mPay = document.getElementById('modal-pay');
    if (mPay && mPay.classList.contains('active')) closePayModal();
    var mDep = document.getElementById('modal-deposit');
    if (mDep && mDep.classList.contains('active')) closeDepositModal();
    var mSup = document.getElementById('modal-support');
    if (mSup && mSup.classList.contains('active')) closeSupportModal();
    var mOrd = document.getElementById('modal-orders');
    if (mOrd && mOrd.classList.contains('active')) closeOrdersModal();
    var uDrop = document.getElementById('user-dropdown');
    if (uDrop && uDrop.classList.contains('active')) uDrop.classList.remove('active');
  });
}

// Stabilisation fluide du viewport mobile (iOS Safari / Android) à l'ouverture et fermeture du clavier virtuel
var _mobileViewportInitialized = false;
function initMobileViewportUX() {
  if (_mobileViewportInitialized) return;
  _mobileViewportInitialized = true;

  var savedScrollY = 0;
  var hasFocusedField = false;
  var blurTimer = null;

  function isFormField(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var type = (el.type || 'text').toLowerCase();
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file' && type !== 'range';
    }
    return Boolean(el.isContentEditable);
  }

  function isMobileViewport() {
    return window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }

  document.addEventListener('focusin', function(e) {
    if (!isMobileViewport() || !isFormField(e.target)) return;
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
    if (!hasFocusedField) {
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      hasFocusedField = true;
    }
    document.documentElement.classList.add('gv-keyboard-open');
  }, { passive: true });

  document.addEventListener('focusout', function(e) {
    if (!isMobileViewport() || !isFormField(e.target)) return;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(function() {
      if (isFormField(document.activeElement)) return;
      hasFocusedField = false;
      document.documentElement.classList.remove('gv-keyboard-open');

      var activeModal = document.querySelector('.modal-backdrop.active');
      if (activeModal) {
        window.scrollTo(0, savedScrollY);
      } else if (window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY || window.pageYOffset || 0);
      }
    }, 120);
  }, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      if (!isMobileViewport()) return;
      if (!isFormField(document.activeElement) && window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY || window.pageYOffset || 0);
      }
    }, { passive: true });
  }
}

// Synchronisation des produits du catalogue depuis le serveur / Edge Config
// État du catalogue : 'loading' (premier chargement), 'ready' ou 'error'.
// Le catalogue n'est jamais affiché depuis un ancien cache local (évite de montrer des produits supprimés).
window._gvCatalogState = window._gvCatalogState || 'loading';

// Squelettes animés affichés pendant le chargement (jamais une page vide ni une fausse « boutique vide »)
function catalogSkeletonCards(n) {
  var html = '<span class="gv-sr-only" role="status">Chargement du catalogue…</span>';
  for (var i = 0; i < n; i++) {
    html += '<div class="product-card gv-skel-card" aria-hidden="true">' +
      '<div class="product-image-box gv-skel gv-skel-media"></div>' +
      '<div class="product-body">' +
        '<span class="gv-skel gv-skel-line" style="width: 38%;"></span>' +
        '<span class="gv-skel gv-skel-line gv-skel-title" style="width: ' + (70 + (i * 7) % 25) + '%;"></span>' +
        '<span class="gv-skel gv-skel-line" style="width: 95%;"></span>' +
        '<span class="gv-skel gv-skel-line" style="width: ' + (55 + (i * 11) % 35) + '%;"></span>' +
        '<div class="gv-skel-footer"><span class="gv-skel gv-skel-pill"></span><span class="gv-skel gv-skel-btn"></span></div>' +
      '</div>' +
    '</div>';
  }
  return html;
}

function catalogSkeletonShowcase() {
  var html = '<span class="gv-sr-only" role="status">Chargement…</span>';
  for (var i = 0; i < 3; i++) {
    html += '<div class="showcase-item gv-skel-showcase" aria-hidden="true">' +
      '<span class="gv-skel gv-skel-thumb"></span>' +
      '<div style="flex: 1; min-width: 0;"><span class="gv-skel gv-skel-line" style="width: ' + (60 + i * 12) + '%;"></span><span class="gv-skel gv-skel-line" style="width: 35%; margin-top: 8px;"></span></div>' +
      '<span class="gv-skel gv-skel-btn" style="width: 72px;"></span>' +
    '</div>';
  }
  return html;
}

function catalogPlaceholderHtml(compact) {
  if (window._gvCatalogState === 'loading') {
    return compact ? catalogSkeletonShowcase() : catalogSkeletonCards(window.innerWidth < 640 ? 4 : 8);
  }
  if (window._gvCatalogState === 'error') {
    return (compact ? '<div class="gv-load-error gv-load-error-compact">' : '<div class="gv-load-error" style="grid-column: 1/-1;">') +
      '<div style="font-size: 26px; margin-bottom: 6px;">📡</div>' +
      '<strong>Impossible de charger le catalogue pour le moment.</strong>' +
      '<div style="margin-top: 4px;">Votre connexion semble lente ou interrompue. Nouvelle tentative automatique en cours.</div>' +
      '<button type="button" class="btn-primary btn-sm" style="margin-top: 12px;" onclick="syncProductsFromServer(true)">Réessayer maintenant</button></div>';
  }
  return null;
}

function categoryPillsSkeleton() {
  return '<span class="gv-skel gv-skel-cat" style="width: 120px;"></span><span class="gv-skel gv-skel-cat"></span><span class="gv-skel gv-skel-cat" style="width: 110px;"></span><span class="gv-skel gv-skel-cat"></span>';
}

function rerenderCatalogViews() {
  if (typeof renderLandingShowcase === 'function') renderLandingShowcase();
  if (typeof renderLandingCategories === 'function') renderLandingCategories();
  if (typeof renderLandingCatalog === 'function') renderLandingCatalog();
  if (typeof renderConnectedCategories === 'function') renderConnectedCategories();
  if (typeof renderConnectedCatalog === 'function') renderConnectedCatalog();
  if (typeof maybeOpenProductFromHash === 'function') maybeOpenProductFromHash(false);
}

var _gvProductSync = null;
var _gvCatalogRetryTimer = null;
// Catalogue : délai maximal par tentative, nouvelles tentatives progressives, puis reprise automatique.
function syncProductsFromServer(manual) {
  if (_gvProductSync) return _gvProductSync;
  if (manual && window._gvCatalogState === 'error') {
    window._gvCatalogState = 'loading';
    rerenderCatalogViews();
  }
  var timeouts = [12000, 20000, 30000];
  _gvProductSync = (async function() {
    for (var attempt = 0; attempt < timeouts.length; attempt++) {
      try {
        await syncProductsOnce(timeouts[attempt]);
        if (_gvCatalogRetryTimer) { clearTimeout(_gvCatalogRetryTimer); _gvCatalogRetryTimer = null; }
        if (navigator.onLine !== false) gvSetNetBanner(false);
        return true;
      } catch (e) {
        if (attempt < timeouts.length - 1) await new Promise(function(r) { setTimeout(r, attempt === 0 ? 1500 : 4000); });
      }
    }
    if (window._gvCatalogState !== 'ready') {
      window._gvCatalogState = 'error';
      rerenderCatalogViews();
    }
    gvSetNetBanner(true, navigator.onLine === false ? 'Vous êtes hors ligne. Les informations affichées seront actualisées dès le retour de la connexion.' : 'Connexion au serveur difficile : nouvelle tentative automatique dans 30 secondes.');
    if (_gvCatalogRetryTimer) clearTimeout(_gvCatalogRetryTimer);
    _gvCatalogRetryTimer = setTimeout(function() { _gvCatalogRetryTimer = null; syncProductsFromServer(); }, 30000);
    return false;
  })().finally(function() { _gvProductSync = null; });
  return _gvProductSync;
}

async function syncProductsOnce(timeoutMs) {
  var res = await gvFetch('/api/data/products?_t=' + Date.now(), { cache: 'no-store' }, timeoutMs);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var data = await res.json();
  if (!data || !Array.isArray(data.products)) throw new Error('Réponse du catalogue invalide');
  window._gvCatalogState = 'ready';
  DB.set('products', data.products);
  if (data.products.length === 0) {
    DB.set('vault', {});
    currentLandingCat = 'all';
    currentConnectedCat = 'all';
  } else {
    var validCats = data.products.map(function(p) { return p && p.category; }).filter(Boolean);
    if (currentLandingCat !== 'all' && validCats.indexOf(currentLandingCat) === -1) {
      currentLandingCat = 'all';
    }
    if (currentConnectedCat !== 'all' && validCats.indexOf(currentConnectedCat) === -1) {
      currentConnectedCat = 'all';
    }
  }
  rerenderCatalogViews();
}

// Synchronisation parallèle des méthodes de paiement actives et paramètres depuis le serveur
async function syncPaymentMethodsFromServer() {
  var ts = Date.now();
  var results = await Promise.allSettled([
    gvFetch('/api/data/methods?_t=' + ts, { cache: 'no-store' }, 15000).then(function(r) { return r.ok ? r.json() : null; }),
    gvFetch('/api/data/settings?_t=' + ts, { cache: 'no-store' }, 15000).then(function(r) { return r.ok ? r.json() : null; })
  ]);

  var data = results[0].status === 'fulfilled' ? results[0].value : null;
  if (data && Array.isArray(data.methods) && data.methods.length > 0) {
    DB.set('payment_methods', data.methods);
  }

  var sData = results[1].status === 'fulfilled' ? results[1].value : null;
  if (sData && sData.settings && typeof sData.settings.min_recharge === 'number') {
    DB.set('min_recharge', sData.settings.min_recharge);
  }
  if (sData && sData.settings && sData.settings.whatsapp_number) {
    DB.set('whatsapp_number', String(sData.settings.whatsapp_number));
  }
}

// Basculement vers le tableau de bord administrateur
function switchToAdmin() {
  var s = AuthState.getSession();
  if (s && s.role === 'admin') {
    DB.set('admin_session', s);
  }
  window.location.href = 'admin.html';
}

// GESTIONNAIRE DE VERSION & CACHE BUSTING EN DIRECT
var VersionManager = {
  currentVersion: 'v202611261156_ea23e5',
  checkIntervalMs: 60 * 1000,
  _toastShown: false,

  init: function() {
    this.cleanLegacyCaches();
    this.checkForUpdates();

    var self = this;
    window.addEventListener('visibilitychange', function() {
      if (!document.hidden) self.checkForUpdates();
    });
    window.addEventListener('focus', function() {
      self.checkForUpdates();
    });
    setInterval(function() {
      self.checkForUpdates();
    }, this.checkIntervalMs);
  },

  cleanLegacyCaches: function() {
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
          for (var reg of registrations) reg.unregister();
        });
      }
      if ('caches' in window) {
        caches.keys().then(function(names) {
          names.forEach(function(name) { caches.delete(name); });
        });
      }
    } catch (e) {}
  },

  checkForUpdates: async function() {
    try {
      var res = await fetch('/api/version?_t=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
      });
      if (res.ok) {
        var data = await res.json();
        if (data && data.version && data.version !== this.currentVersion) {
          console.log('[VersionManager] Nouvelle version déployée en ligne :', data.version);
          this.onNewVersionAvailable(data.version);
        }
      }
    } catch (e) {}
  },

  onNewVersionAvailable: function(newVer) {
    if (this._toastShown) return;
    this._toastShown = true;
    var banner = document.createElement('div');
    banner.id = 'gv-update-banner';
    banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#ffffff;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:12px;box-shadow:0 10px 30px rgba(0,0,0,0.35);z-index:999999;border:1px solid rgba(255,255,255,0.18);';
    banner.innerHTML = '<span>⚡ Mise à jour GetVirtu disponible</span><button style="background:#2563eb;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;">Actualiser</button>';
    banner.querySelector('button').onclick = function() {
      window.location.reload(true);
    };
    document.body.appendChild(banner);
  }
};

// Traçabilité des visites réelles et visiteurs uniques.
// Une visite = une session de navigation : elle est comptée à l'arrivée, puis à nouveau seulement après
// 30 minutes sans activité (même règle que les outils d'audience courants). Le serveur ne reçoit qu'un
// identifiant anonyme aléatoire de navigateur (aucune donnée personnelle) et l'enregistre haché.
var GV_VISIT_GAP_MS = 30 * 60 * 1000;
function trackVisitor() {
  try {
    var vid = localStorage.getItem('gv_visitor_id');
    var isNew = false;
    if (!vid) {
      vid = 'v_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('gv_visitor_id', vid);
      isNew = true;
    }
    var now = Date.now();
    var last = parseInt(localStorage.getItem('gv_last_activity_at') || '0', 10) || 0;
    localStorage.setItem('gv_last_activity_at', String(now));
    // Ancien journal local (n'a jamais servi aux statistiques du serveur) : libère le stockage du navigateur
    if (localStorage.getItem('vs_visitor_logs') !== null) DB.del('visitor_logs');
    if (!isNew && now - last < GV_VISIT_GAP_MS) return;
    gvFetch('/api/data/visitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid: vid, isNew: isNew }),
      keepalive: true
    }, 10000).catch(function() {});
  } catch (e) {}
}
// Retour sur l'onglet après une longue absence = nouvelle visite ; sinon l'activité prolonge la visite en cours
document.addEventListener('visibilitychange', function() { if (!document.hidden) trackVisitor(); });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
