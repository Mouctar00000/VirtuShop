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

var ADMIN_SALT = 'getvirtu_sec_salt_2026';
var ADMIN_HASH = 'e1ef6864bfd0e96c37fa33f3de4ceff20f93b236fc292b9e6440310d88f27902'; // Salted SHA-256 de admin123
var ADMIN_LEGACY_HASH = '0b8c4d28479e0a29486cff2db1709f61b0c0fdb261e3d6f1bfd8eb34421df6fd'; // Salted SHA-256 de admin

var ADMIN = {
  id: 'admin-001',
  name: 'Administrateur GetVirtu',
  email: 'admin@getvirtu.shop',
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

// QR Code SVG Helper
function generateQrSvg(label) {
  var encoded = encodeURIComponent(label);
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="160" height="160"><rect width="200" height="200" fill="%23ffffff"/><rect x="20" y="20" width="45" height="45" fill="%230f172a"/><rect x="28" y="28" width="29" height="29" fill="%23ffffff"/><rect x="34" y="34" width="17" height="17" fill="%230f172a"/><rect x="135" y="20" width="45" height="45" fill="%230f172a"/><rect x="143" y="28" width="29" height="29" fill="%23ffffff"/><rect x="149" y="34" width="17" height="17" fill="%230f172a"/><rect x="20" y="135" width="45" height="45" fill="%230f172a"/><rect x="28" y="143" width="29" height="29" fill="%23ffffff"/><rect x="34" y="149" width="17" height="17" fill="%230f172a"/><rect x="85" y="25" width="12" height="25" fill="%230f172a"/><rect x="105" y="45" width="15" height="15" fill="%230f172a"/><rect x="85" y="85" width="30" height="30" fill="%23f59e0b"/><rect x="135" y="90" width="15" height="25" fill="%230f172a"/><rect x="30" y="90" width="20" height="15" fill="%230f172a"/><rect x="80" y="135" width="25" height="15" fill="%230f172a"/><rect x="115" y="130" width="20" height="45" fill="%230f172a"/><rect x="145" y="145" width="30" height="30" fill="%230f172a"/><text x="100" y="192" font-family="sans-serif" font-size="8" font-weight="bold" text-anchor="middle" fill="%230f172a">${encoded}</text></svg>`;
}

// ========== INITIALISATION DE LA BASE ==========
function initDB() {
  console.log('[Init] Démarrage GetVirtu (getvirtu.shop)...');

  // Produits avec images dédiées, distinctes et stables
  var prods = DB.get('products');
  var needProdsInit = !prods || !Array.isArray(prods) || prods.length === 0 || prods.some(function(p) { return !p.image || p.image.indexOf('base64') === -1; });
  if (needProdsInit) {
    DB.set('products', [
      {
        id: 1,
        name: "Compte Gmail Vérifié (2FA + Secours)",
        price: 0.86,
        stock: 68,
        category: "gmail",
        published: true,
        description: "Compte propre vérifié avec 2FA activé & codes de secours inclus.",
        image: getReliableProductSvg("gmail", "GMAIL 2FA VÉRIFIÉ", "blue")
      },
      {
        id: 2,
        name: "Gmail Ancien 2020-2025 (Aged)",
        price: 1.23,
        stock: 12,
        category: "gmail",
        published: true,
        description: "Compte âgé (Aged), excellente réputation pour éviter les blocages.",
        image: getReliableProductSvg("gmail", "GMAIL AGED 2020-2025", "amber")
      },
      {
        id: 3,
        name: "Gmail Aléatoire + Portail OTP Direct",
        price: 1.69,
        stock: 435,
        category: "gmail",
        published: true,
        description: "Accès automatique en 1 clic à vos codes de vérification OTP.",
        image: getReliableProductSvg("gmail", "GMAIL + OTP DIRECT", "emerald")
      },
      {
        id: 4,
        name: "Chaîne YouTube Monétisée (1k+ Abonnés)",
        price: 45.00,
        stock: 4,
        category: "youtube",
        published: true,
        description: "1 000+ abonnés, 4 000h visionnage validées, éligible AdSense.",
        image: getReliableProductSvg("youtube", "YOUTUBE MONÉTISÉE", "red")
      },
      {
        id: 5,
        name: "Discord Nitro 1 Mois (2 Boosts Inclus)",
        price: 4.50,
        stock: 25,
        category: "discord",
        published: true,
        description: "Lien officiel Discord Nitro 1 mois avec 2 boosts de serveur.",
        image: getReliableProductSvg("discord", "DISCORD NITRO 1 MOIS", "purple")
      }
    ]);
  }

  // Coffre-fort numérique sécurisé
  var vault = DB.get('vault');
  if (!vault || typeof vault !== 'object') {
    DB.set('vault', {
      1: { type: 'text', content: 'identifiant: user_pro_2026@gmail.com | pass: Gml$889!SecurPass | 2FA_Key: JBSWY3DPEHPK3PXP | Code_Secours: 84920481' },
      2: { type: 'text', content: 'identifiant: vintage.account2021@gmail.com | pass: K9#PassVintage2021 | 2FA: Désactivé | Mail_Recup: sec-rec@proton.me' },
      3: { type: 'link', content: 'https://getvirtu.shop/otp-portal/access?token=VK-OTP-99283-SECURE' },
      4: { type: 'text', content: 'Chaîne: TechTrend Pulse (1.25k abonnés) | Owner_Transfer: Envoyez votre email à support@getvirtu.shop | Token: {"session_token":"yt_monetized_88291"}' },
      5: { type: 'link', content: 'https://discord.gift/XkJ89qZbWw662YtP' }
    });
  }

  // Méthodes de paiement (avec flag qrCode conditionnel)
  var methods = DB.get('payment_methods');
  if (!methods || !Array.isArray(methods) || methods.length === 0) {
    DB.set('payment_methods', [
      {
        id: 1,
        name: "USDT (TRC20)",
        type: "crypto",
        address: "TWej9xKqPzL8VnR4mB81sCgNqYe86F7zLm",
        qrCode: generateQrSvg("USDT TRC20"),
        instructions: "Envoyez en USDT TRC20. Consigne : Scanner avec Binance ou TrustWallet.",
        enabled: true
      },
      {
        id: 2,
        name: "Bitcoin (BTC)",
        type: "crypto",
        address: "bc1q9v8h2p5w4k6f7s8d9a0m1n2b3c4x5y6z7w8",
        qrCode: generateQrSvg("Bitcoin BTC"),
        instructions: "Envoyez en BTC à cette adresse. Consigne : Scanner avec votre application de portefeuille.",
        enabled: true
      },
      {
        id: 3,
        name: "Orange Money",
        type: "mobile_money",
        address: "+237 690 123 456",
        qrCode: null, // Pas de QR code pour mobile money !
        instructions: "Effectuez un dépôt direct vers ce numéro (Nom : GetVirtu Services).",
        enabled: true
      }
    ]);
  }

  if (!DB.get('orders')) DB.set('orders', []);
  if (!DB.get('recharges')) DB.set('recharges', []);
  if (!DB.get('min_recharge')) DB.set('min_recharge', 5);

  // Méthodes de paiement (avec options Binance, réseau, et consignes éditables)
  var methods = DB.get('payment_methods');
  var needMethodsInit = !methods || !Array.isArray(methods) || methods.length === 0;
  if (needMethodsInit) {
    DB.set('payment_methods', [
      {
        id: 1,
        name: "USDT (Binance / TRC20)",
        type: "crypto",
        network: "TRC20",
        isBinance: true,
        address: "TWej9xKqPzL8VnR4mB81sCgNqYe86F7zLm",
        qrCode: generateQrSvg("USDT TRC20"),
        instructions: "Envoyez en USDT TRC20 — Consigne : Scanner avec l'application Binance ou TrustWallet.",
        enabled: true
      },
      {
        id: 2,
        name: "Bitcoin (BTC)",
        type: "crypto",
        network: "BTC",
        isBinance: false,
        address: "bc1q9v8h2p5w4k6f7s8d9a0m1n2b3c4x5y6z7w8",
        qrCode: generateQrSvg("Bitcoin BTC"),
        instructions: "Envoyez en BTC à cette adresse de portefeuille.",
        enabled: true
      },
      {
        id: 3,
        name: "Orange Money",
        type: "mobile_money",
        network: "",
        isBinance: false,
        address: "+237 690 123 456",
        qrCode: null, // Pas de QR code pour mobile money !
        instructions: "Effectuez un dépôt direct vers ce numéro Orange Money (Nom : GetVirtu Services).",
        enabled: true
      }
    ]);
  }

  // Admin par défaut (aucun mot de passe stocké en clair)
  var users = DB.get('users', []);
  if (!Array.isArray(users)) users = [];
  users = users.filter(function(u) { return u && u.role !== 'admin'; });
  users.push({
    id: ADMIN.id, name: ADMIN.name, email: ADMIN.email,
    passwordHash: ADMIN_HASH, role: 'admin', balance: 50.00,
    createdAt: new Date().toISOString()
  });
  DB.set('users', users);
}

function getMinRecharge() {
  var v = DB.get('min_recharge', 5);
  return typeof v === 'number' && v > 0 ? v : 5;
}

// ========== GESTION DU SOLDE CLIENT ==========
function getCurrentUser() {
  var s = DB.get('session');
  if (!s || !s.userId) return null;
  if (typeof Security !== 'undefined' && !Security.isSessionValid(s)) {
    DB.del('session'); // Purge de session expirée ou contrefaite
    return null;
  }
  var users = DB.get('users', []);
  return users.find(function(u) { return u.id === s.userId; }) || null;
}

function getUserBalance() {
  var u = getCurrentUser();
  return u && typeof u.balance === 'number' ? u.balance : 0;
}

function updateUserBalance(newBalance) {
  var s = DB.get('session');
  if (!s || !s.userId) return false;
  var users = DB.get('users', []);
  var u = users.find(function(x) { return x.id === s.userId; });
  if (u) {
    u.balance = Math.max(0, newBalance);
    DB.set('users', users);
    updateNavbar();
    return true;
  }
  return false;
}

// Formatage FCFA
function formatFcfa(usdAmount) {
  return Math.round(usdAmount * FCFA_RATE).toLocaleString('fr-FR') + ' FCFA';
}

// ========== ROUTAGE & PARCOURS UTILISATEUR ==========
function routeUserExperience() {
  var session = DB.get('session');
  var landingView = document.getElementById('landing-view');
  var connectedView = document.getElementById('connected-view');
  var navPublic = document.getElementById('nav-public-links');
  var navConnected = document.getElementById('nav-connected-links');

  // Toujours rendre les composants du catalogue
  renderLandingShowcase();
  renderLandingCategories();
  renderLandingCatalog();

  if (session && session.userId) {
    if (navPublic) navPublic.classList.add('hidden');
    if (navConnected) navConnected.classList.remove('hidden');

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
    if (navPublic) navPublic.classList.remove('hidden');
    if (navConnected) navConnected.classList.add('hidden');
  }

  updateNavbar();
  renderFooterBadges();
}

function showConnectedCatalog() {
  var s = DB.get('session');
  if (!s || !s.userId) { openAuthModal('login'); return; }
  document.getElementById('landing-view').classList.add('hidden');
  document.getElementById('connected-view').classList.remove('hidden');
  renderConnectedCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showPublicLanding() {
  document.getElementById('landing-view').classList.remove('hidden');
  document.getElementById('connected-view').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleLogoClick() {
  var s = DB.get('session');
  if (s && s.userId) showConnectedCatalog();
  else showPublicLanding();
}

// ========== BARRE DE NAVIGATION (SOLDE + PROFIL) ==========
function updateNavbar() {
  var session = DB.get('session');
  var container = document.getElementById('nav-user-actions');
  if (!container) return;

  if (session && session.userId) {
    var bal = getUserBalance();

    container.innerHTML = `
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

      <!-- Profil Utilisateur & Menu Déroulant -->
      <div class="user-profile-wrapper">
        <button type="button" class="btn-user-profile" onclick="toggleUserDropdown()" aria-label="Menu profil">
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
      <button type="button" class="btn-secondary btn-sm" onclick="openAuthModal('login')">Connexion</button>
      <button type="button" class="btn-primary btn-sm" onclick="openAuthModal('register')">S'inscrire ⚡</button>
    `;
  }
}

function toggleUserDropdown() {
  var menu = document.getElementById('user-dropdown');
  if (menu) menu.classList.toggle('active');
}

// Fermer le dropdown si clic extérieur
document.addEventListener('click', function(e) {
  var wrapper = document.querySelector('.user-profile-wrapper');
  var menu = document.getElementById('user-dropdown');
  if (menu && wrapper && !wrapper.contains(e.target)) {
    menu.classList.remove('active');
  }
});

// ========== CATALOGUE VISITEUR & ARTICLES EN VEDETTE ==========
function renderLandingShowcase() {
  var container = document.getElementById('hero-featured-items');
  if (!container) return;

  var prods = DB.get('products', []).filter(function(p) { return p.published; });
  var topProds = prods.slice(0, 3);

  var html = '';
  topProds.forEach(function(p) {
    var oos = p.stock <= 0;
    html += `
      <div class="showcase-item">
        <div class="showcase-item-info">
          <img src="${p.image}" class="showcase-thumb" alt="${escapeHtml(p.name)}">
          <div style="min-width: 0;">
            <h4 class="showcase-title">${escapeHtml(p.name)}</h4>
            <span class="showcase-stock-badge ${oos ? 'oos' : ''}">${oos ? '● Rupture' : '● ' + p.stock + ' en stock'}</span>
          </div>
        </div>
        <div class="showcase-pricing-action">
          <div class="showcase-price-box">
            <span class="showcase-price-val">$${p.price.toFixed(2)}</span>
          </div>
          <button type="button" class="btn-primary btn-sm showcase-buy-btn" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${p.id})">
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
      <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
        <p style="font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Aucun produit trouvé</p>
        <p style="font-size: 12.5px;">Essayez avec un autre terme ou une autre catégorie.</p>
      </div>
    `;
    return;
  }

  var html = '';
  prods.forEach(function(prod) {
    var oos = prod.stock <= 0;
    var fallbackSvg = getReliableProductSvg(prod.category, prod.name, 'blue');

    html += `
      <div class="product-card${oos ? ' oos' : ''}">
        <div class="product-image-box">
          <img src="${prod.image}" class="product-img" alt="${escapeHtml(prod.name)}">
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
            <button type="button" class="btn-buy-product" ${oos ? 'disabled' : ''} onclick="startProductPurchase(${prod.id})">
              ${oos ? 'Indisponible' : 'Acheter ⚡'}
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
    showToast('Ce produit est en rupture de stock.', 'error');
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

function renderPurchaseModal() {
  var container = document.getElementById('pay-dynamic-content');
  if (!container || !selectedPayProd) return;

  var u = getCurrentUser();
  var userBal = getUserBalance();
  var stock = selectedPayProd.stock || 0;
  var unitPrice = selectedPayProd.price;

  // Calcul automatique du total selon la quantité choisie (1, 2, 3, etc.)
  var total = unitPrice * currentPurchaseQty;
  var hasEnough = userBal >= total;
  var diff = (total - userBal).toFixed(2);

  container.innerHTML = `
    <div style="margin-bottom: 14px;">
      <h2 class="modal-title" style="margin-bottom: 3px;">Acheter le Produit</h2>
      <p style="font-size: 12.5px; color: var(--text-secondary); margin: 0;">Réglez directement en un clic avec votre solde GetVirtu.</p>
    </div>

    <!-- 1. Récapitulatif du produit sélectionné -->
    <div class="purchase-header">
      <img src="${selectedPayProd.image}" class="purchase-prod-thumb" alt="${escapeHtml(selectedPayProd.name)}">
      <div class="purchase-prod-info">
        <span class="purchase-prod-cat">${escapeHtml(selectedPayProd.category)}</span>
        <h3 class="purchase-prod-title">${escapeHtml(selectedPayProd.name)}</h3>
        <div class="purchase-unit-price-line">
          Prix unitaire : <strong>$${unitPrice.toFixed(2)}</strong>
        </div>
      </div>
    </div>

    <!-- 2. Solde disponible du client -->
    <div class="purchase-balance-pill">
      <span>Votre solde disponible :</span>
      <strong style="color: var(--primary-600); font-size: 14.5px;">$${userBal.toFixed(2)}</strong>
    </div>

    <!-- 3. Sélecteur de quantité interactive (1, 2, 3, 4, etc.) -->
    <div class="purchase-qty-card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <label style="font-weight: 700; font-size: 13px; color: var(--text-primary); margin: 0;">Quantité à acheter</label>
          <span style="font-size: 11.5px; color: ${stock > 0 ? 'var(--emerald-600)' : 'var(--rose-600)'}; font-weight: 600; display: block; margin-top: 2px;">
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

    <!-- 4. Calcul automatique du montant total -->
    <div class="purchase-calc-box">
      <div class="calc-row">
        <span>Calcul du total :</span>
        <span>$${unitPrice.toFixed(2)} &times; ${currentPurchaseQty}</span>
      </div>
      <div class="calc-row total-row">
        <span>Total à régler :</span>
        <div style="text-align: right;">
          <span class="total-amount-large">$${total.toFixed(2)}</span>
        </div>
      </div>
    </div>

    <!-- 5. Vérification du solde -->
    <div style="margin-bottom: 14px;">
      ${hasEnough ? `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: var(--radius-sm); padding: 9px 12px; font-size: 12px; color: var(--emerald-600); display: flex; align-items: center; justify-content: space-between;">
          <span>✓ Solde suffisant pour cet achat</span>
          <span>Reste après paiement : <strong>$${(userBal - total).toFixed(2)}</strong></span>
        </div>
      ` : `
        <div style="background: #fff1f2; border: 1px solid #fecdd3; border-radius: var(--radius-sm); padding: 9px 12px; font-size: 12px; color: var(--rose-600); display: flex; align-items: center; justify-content: space-between;">
          <span>⚠️ Solde insuffisant (Il vous manque $${diff})</span>
          <a href="javascript:void(0)" onclick="promptDepositFromPurchase(${Math.max(5, Math.ceil(parseFloat(diff)))})" style="color: var(--primary-600); font-weight: 700; text-decoration: underline;">+ Recharger</a>
        </div>
      `}
    </div>

    <!-- 6. Coordonnées de notification OPTIONNELLES -->
    <div class="optional-contact-box">
      <label for="purchase-contact-input">
        <span>📱 Numéro WhatsApp ou Email pour notification (Optionnel)</span>
      </label>
      <input type="text" id="purchase-contact-input" placeholder="Ex: +33 6 12 34 56 78 ou mon.email@domaine.com">
      <p style="font-size: 11px; color: var(--text-muted); margin: 4px 0 0 0;">Totalement facultatif. Si renseigné, nous pourrons vous avertir dès que l'administrateur aura validé la livraison.</p>
    </div>

    <!-- 7. Bouton d'action pro : Payer maintenant -->
    ${hasEnough ? `
      <button type="button" class="btn-pay-now" onclick="processProductPayment()">
        Payer maintenant ⚡ ($${total.toFixed(2)})
      </button>
    ` : `
      <button type="button" class="btn-pay-now" style="background: var(--primary-600);" onclick="promptDepositFromPurchase(${Math.max(5, Math.ceil(parseFloat(diff)))})">
        + Recharger mon solde pour payer ($${Math.max(5, Math.ceil(parseFloat(diff))).toFixed(2)} min.)
      </button>
    `}
  `;
}

function promptDepositFromPurchase(suggestedAmount) {
  closePayModal();
  openDepositModal(suggestedAmount);
}

// TRAITEMENT DU PAIEMENT & CRÉATION DE COMMANDE EN ATTENTE DE VALIDATION ADMIN
function processProductPayment() {
  var u = getCurrentUser();
  if (!u || !selectedPayProd) return;

  var qty = parseInt(currentPurchaseQty, 10);
  if (isNaN(qty) || qty < 1) {
    showToast('Quantité invalide.', 'error');
    return;
  }

  // Vérification de stock suffisant
  if (selectedPayProd.stock < qty) {
    showToast('Stock insuffisant pour cette quantité (' + selectedPayProd.stock + ' disponible(s)).', 'error');
    return;
  }

  var total = Math.round(selectedPayProd.price * qty * 100) / 100;

  if (u.balance < total) {
    showToast('Solde insuffisant pour cette quantité.', 'error');
    renderPurchaseModal();
    return;
  }

  // 1. Déduire immédiatement le montant du solde client (arrondi sécurisé)
  var newBal = Math.round((u.balance - total) * 100) / 100;
  updateUserBalance(newBal);

  // 2. Décrémenter le stock selon la quantité achetée
  var prods = DB.get('products', []);
  var pIndex = prods.findIndex(function(p) { return p.id === selectedPayProd.id; });
  if (pIndex !== -1) {
    prods[pIndex].stock = Math.max(0, prods[pIndex].stock - qty);
    DB.set('products', prods);
  }

  // 3. Récupérer et assainir les informations de contact optionnelles
  var rawContact = (document.getElementById('purchase-contact-input')?.value || '').trim();
  var contactVal = typeof Security !== 'undefined' ? Security.escapeHtml(rawContact) : rawContact;

  // 4. Créer la commande en statut "En attente" de validation administrateur
  var orders = DB.get('orders', []);
  var newOrder = {
    id: 'ORD-' + Date.now().toString().slice(-6),
    userId: u.id,
    userEmail: u.email,
    userName: u.name,
    productId: selectedPayProd.id,
    productName: selectedPayProd.name,
    unitPrice: selectedPayProd.price,
    quantity: qty,
    amount: total,
    contactInfo: contactVal,
    method: 'Solde Client',
    status: 'En attente', // En attente de validation par l'administrateur !
    proofImage: null,
    vaultContent: null, // Le contenu du coffre sera accessible APRÈS validation par l'administrateur
    date: new Date().toISOString()
  };
  orders.unshift(newOrder);
  DB.set('orders', orders);

  // 5. Afficher le message clair et rassurant de confirmation
  var container = document.getElementById('pay-dynamic-content');
  if (container) {
    container.innerHTML = `
      <div class="purchase-success-box">
        <div class="success-icon-badge">✓</div>
        <h3 style="font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Votre commande a été passée avec succès !</h3>
        <p style="font-size: 13.5px; color: #475569; line-height: 1.5; margin-bottom: 18px;">
          Vous recevrez votre produit sous peu. Veuillez consulter votre section <strong>« Mes commandes »</strong> dans quelques instants dès validation par l'administrateur.
        </p>
        <div class="order-recap-mini">
          <div><span>N° Commande :</span> <strong>${newOrder.id}</strong></div>
          <div><span>Article :</span> <strong>${escapeHtml(selectedPayProd.name)} (x${newOrder.quantity})</strong></div>
          <div><span>Montant débité :</span> <strong style="color: var(--primary-600);">$${total.toFixed(2)}</strong></div>
          <div><span>Nouveau solde :</span> <strong style="color: var(--emerald-600);">$${newBal.toFixed(2)}</strong></div>
          ${contactVal ? `<div><span>Notification :</span> <strong>${escapeHtml(contactVal)}</strong></div>` : ''}
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button type="button" class="btn-secondary" style="flex: 1;" onclick="closePayModal()">Continuer mes achats</button>
          <button type="button" class="btn-primary" style="flex: 1;" onclick="closePayModal(); openOrdersModal();">📦 Mes commandes</button>
        </div>
      </div>
    `;
  }

  showToast('🎉 Paiement effectué ! Commande en attente de validation.', 'success');
  updateNavbar();
  renderConnectedCatalog();
  renderLandingCatalog();
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

function closeDepositModal() {
  document.getElementById('modal-deposit').classList.remove('active');
  currentDepositProofBase64 = null;
}

function updateDepositCalculation() {
  // Calcul simplifié en $
}

function openSupportModal(channel) {
  var isTg = channel === 'telegram';
  var msg = isTg
    ? '💬 Assistance Telegram GetVirtu : Rejoignez notre support direct via @GetVirtu_Support ou https://t.me/GetVirtu_Support\n\nNos conseillers sont disponibles 24/7 pour vos demandes de lots et commandes spéciales.'
    : '📱 Assistance WhatsApp GetVirtu : Contactez notre équipe au +237 690 000 000 pour toute assistance immédiate ou commande personnalisée.';
  alert(msg);
}

function renderDepositMethodsTabs() {
  var container = document.getElementById('deposit-methods-tabs-container');
  if (!container) return;

  var methods = DB.get('payment_methods', []).filter(function(m) { return m.enabled; });
  var html = '';
  methods.forEach(function(m) {
    var icon = m.type === 'crypto' ? '🪙' : (m.type === 'mobile_money' ? '📱' : '💳');
    html += `
      <div class="payment-method-tab ${currentDepositMethodId == m.id ? 'active' : ''}" onclick="selectDepositMethodTab('${m.id}')">
        ${icon} ${escapeHtml(m.name)}
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

  var isCrypto = m.type === 'crypto';
  var isBinance = m.isBinance || (m.name && m.name.toLowerCase().indexOf('binance') !== -1) || (m.instructions && m.instructions.toLowerCase().indexOf('binance') !== -1);
  var networkTag = m.network ? `<span class="network-badge">Réseau : ${escapeHtml(m.network)}</span>` : '';

  var qrHtml = '';
  // QR Code affiché uniquement pour les paiements crypto (JAMAIS pour Orange Money)
  if (isCrypto && m.qrCode) {
    var qrCaption = isBinance ? "Scanner avec l'application Binance" : "Scanner avec votre portefeuille crypto";
    qrHtml = `
      <div class="pay-qr-wrapper">
        <img src="${m.qrCode}" alt="QR Code">
        <span class="qr-caption-hint">${qrCaption}</span>
      </div>
    `;
  }

  var addressLabel = isCrypto ? 'Adresse du portefeuille' : 'Numéro Orange Money / Mobile';

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

    <!-- Consignes et instructions configurées par l'administrateur -->
    <div class="method-instructions-box">
      <span style="font-size: 14px;">ℹ️</span>
      <p style="margin: 0; font-size: 12.5px; line-height: 1.45;">${escapeHtml(m.instructions || 'Effectuez votre transfert puis joignez votre preuve ci-dessous.')}</p>
    </div>

    <div class="field" style="margin-top: 14px;">
      <label style="font-weight: 700; color: var(--primary-600);">📸 Capture d'écran ou Reçu du paiement</label>
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

    <button type="button" class="btn-primary" style="width: 100%; margin-top: 10px;" onclick="submitDepositRequest()">
      Valider la Recharge de Solde ⚡
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

function submitDepositRequest() {
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

  // Création d'une demande de recharge en attente de validation administrateur
  var recharges = DB.get('recharges', []);
  var newRecharge = {
    id: 'RCH-' + Date.now().toString().slice(-6),
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

  showToast(`Demande de recharge de +${amount.toFixed(2)} USD soumise ! Validation par l'administrateur sous peu.`, 'success');
  closeDepositModal();

  if (pendingPurchaseProductId) {
    alert(`Votre demande de recharge de ${amount.toFixed(2)} USD est en attente de validation.\n\nDès que l'administrateur confirme votre paiement, votre solde sera crédité et votre produit pourra être débloqué.`);
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

  var orders = DB.get('orders', []).filter(function(o) { return o && o.userId === session.userId; });
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

async function handleLoginSubmit(e) {
  e.preventDefault();
  var email = document.getElementById('login-email').value.trim().toLowerCase();
  var pass = document.getElementById('login-password').value;
  var err = document.getElementById('login-error-msg');
  err.classList.add('hidden');

  // 1. Protection Anti Brute-Force
  if (typeof Security !== 'undefined') {
    var rl = Security.checkRateLimit('client_login', 5, 5 * 60 * 1000);
    if (!rl.allowed) {
      err.textContent = 'Trop de tentatives infructueuses. Veuillez patienter ' + rl.waitSeconds + ' secondes.';
      err.style.color = 'var(--rose-500)';
      err.classList.remove('hidden');
      return;
    }
  }

  // 2. Détection du compte administrateur avec vérification salée SHA-256
  var isAdminEmail = (email === 'admin@getvirtu.shop' || email === 'admin@virtushop.com' || email === 'admin' || email === 'admin@admin.com');
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

  // 3. Vérification des utilisateurs clients
  var users = DB.get('users', []);
  var matchedUser = null;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (!u) continue;
    var matchEmail = (u.email && u.email.toLowerCase() === email) || (u.name && u.name.toLowerCase() === email);
    if (!matchEmail) continue;

    var passMatch = false;
    if (u.passwordHash && typeof Security !== 'undefined') {
      passMatch = await Security.verifyPassword(pass, u.passwordHash, ADMIN_SALT);
    } else if (u.password) {
      passMatch = (u.password === pass);
      // Migration transparente vers hachage salé SHA-256
      if (passMatch && typeof Security !== 'undefined') {
        u.passwordHash = await Security.hashPassword(pass, ADMIN_SALT);
        delete u.password;
        DB.set('users', users);
      }
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

  // Connexion réussie : réinitialisation du compteur d'essais
  if (typeof Security !== 'undefined') {
    Security.resetRateLimit('client_login');
    DB.set('session', Security.createSession(matchedUser, matchedUser.role || 'client'));
  } else {
    DB.set('session', { userId: matchedUser.id, role: matchedUser.role || 'client', name: matchedUser.name, email: matchedUser.email, avatarColor: matchedUser.avatarColor });
  }

  if (matchedUser.role === 'admin') {
    showToast('Connexion administrateur en cours...', 'success');
    setTimeout(function() { window.location.href = 'admin.html'; }, 350);
  } else {
    showToast('Bienvenue ' + matchedUser.name + ' ! 👋', 'success');
    closeAuthModal();
    // Parcours direct : Connexion -> Catalogue des produits
    showConnectedCatalog();
    if (pendingPurchaseProductId) {
      var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
      startProductPurchase(pId);
    }
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  var name = document.getElementById('reg-name').value.trim();
  var email = document.getElementById('reg-email').value.trim().toLowerCase();
  var phone = (document.getElementById('reg-phone')?.value || '').trim();
  var pass = document.getElementById('reg-password').value;
  var passConfirm = document.getElementById('reg-password-confirm')?.value || pass;
  var err = document.getElementById('reg-error-msg');
  err.classList.add('hidden');

  if (pass.length < 6) {
    err.textContent = 'Le mot de passe doit comporter au moins 6 caractères.';
    err.classList.remove('hidden'); return;
  }

  if (pass !== passConfirm) {
    err.textContent = 'Les deux mots de passe ne correspondent pas.';
    err.classList.remove('hidden'); return;
  }

  var users = DB.get('users', []);
  if (users.some(function(u) { return u.email && u.email.toLowerCase() === email; })) {
    err.textContent = 'Un compte existe déjà avec cette adresse e-mail.';
    err.classList.remove('hidden'); return;
  }

  // Hachage cryptographique salé SHA-256 (Web Crypto API)
  var passwordHash = typeof Security !== 'undefined'
    ? await Security.hashPassword(pass, ADMIN_SALT)
    : pass;

  var safeName = typeof Security !== 'undefined' ? Security.escapeHtml(name) : name;
  var safePhone = typeof Security !== 'undefined' ? Security.escapeHtml(phone) : phone;

  var newUser = {
    id: 'user-' + Date.now(),
    name: safeName,
    email: email,
    phone: safePhone,
    passwordHash: passwordHash,
    role: 'client',
    balance: 5.00, // Bonus de bienvenue de 5 USD
    avatarColor: '#2563eb',
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  DB.set('users', users);

  if (typeof Security !== 'undefined') {
    DB.set('session', Security.createSession(newUser, 'client'));
  } else {
    DB.set('session', { userId: newUser.id, role: 'client', name: newUser.name, email: newUser.email, avatarColor: newUser.avatarColor });
  }

  showToast('Compte créé avec succès ! Bonus de bienvenue : 5.00 USD ⚡', 'success');
  closeAuthModal();
  // Parcours direct : Inscription -> Catalogue des produits
  showConnectedCatalog();

  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
}

// ========== GOOGLE ACCOUNT SELECTOR & GOOGLE OAUTH ==========
function openGoogleModal() {
  var m = document.getElementById('google-account-modal');
  if (m) m.classList.add('active');
}

function closeGoogleModal() {
  var m = document.getElementById('google-account-modal');
  if (m) m.classList.remove('active');
}

function toggleCustomGoogleAccountForm() {
  var f = document.getElementById('google-custom-form');
  if (f) f.classList.toggle('hidden');
}

function selectGoogleAccount(name, email, avatarColor) {
  if (!email) return;
  var cleanEmail = email.trim().toLowerCase();
  var rawName = name ? name.trim() : cleanEmail.split('@')[0];
  var cleanName = typeof Security !== 'undefined' ? Security.escapeHtml(rawName) : rawName;

  var users = DB.get('users', []);
  var u = users.find(function(x) { return x && x.email && x.email.toLowerCase() === cleanEmail; });

  if (!u) {
    var oauthSecureHash = typeof Security !== 'undefined' ? Security.generateSecureToken(16) : 'g-oauth-secured';
    u = {
      id: 'google-' + Date.now(),
      name: cleanName,
      email: cleanEmail,
      passwordHash: oauthSecureHash,
      role: 'client',
      balance: 15.00, // Solde initial Google
      avatarColor: avatarColor || '#2563eb',
      isGoogle: true,
      createdAt: new Date().toISOString()
    };
    users.push(u);
    DB.set('users', users);
  }

  if (typeof Security !== 'undefined') {
    DB.set('session', Security.createSession(u, u.role || 'client'));
  } else {
    DB.set('session', { userId: u.id, role: u.role || 'client', name: u.name, email: u.email, avatarColor: u.avatarColor || avatarColor });
  }

  closeGoogleModal();
  closeAuthModal();
  showToast('Connecté avec Google : ' + u.name + ' ! 🎉', 'success');
  // Parcours direct : Google Login -> Catalogue des produits
  showConnectedCatalog();

  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
}

function submitCustomGoogleAccount() {
  var name = document.getElementById('custom-google-name').value.trim();
  var email = document.getElementById('custom-google-email').value.trim();

  if (!email || email.indexOf('@') === -1) {
    alert('Veuillez renseigner une adresse e-mail Google valide (ex: votre.nom@gmail.com).');
    return;
  }

  selectGoogleAccount(name || email.split('@')[0], email, '#ea4335');
}

function handleLogout() {
  DB.del('session');
  showToast('Déconnecté avec succès.', 'success');
  routeUserExperience();
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
  var methods = DB.get('payment_methods', []).filter(function(m) { return m.enabled; });
  var html = '<span style="font-size: 11.5px; margin-right: 4px;">Paiements acceptés :</span><span class="pay-badge">Solde GetVirtu</span>';
  methods.forEach(function(m) { html += `<span class="pay-badge">${escapeHtml(m.name)}</span>`; });
  c.innerHTML = html;
}

function showToast(msg, type) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.borderColor = type === 'success' ? 'var(--emerald-400)' : (type === 'error' ? 'var(--rose-500)' : 'var(--gold-500)');
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.style.display = 'none'; }, 3200);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('storage', function(e) {
  if (e.key && e.key.indexOf('vs_') === 0) routeUserExperience();
});

document.addEventListener('DOMContentLoaded', function() {
  console.log('[GetVirtu] Initialisation client...');
  try {
    initDB();
    routeUserExperience();
  } catch (e) {
    console.error(e);
  }
});
