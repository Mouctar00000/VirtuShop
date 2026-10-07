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

  // Méthodes de paiement prêtes pour la production (SasPay Mobile Money & Crypto)
  var methods = DB.get('payment_methods');
  var hasSasPay = Array.isArray(methods) && methods.some(function(m) { return m && (m.type === 'mobile_money' || m.id === 'saspay-mobile-money'); });
  if (!methods || !Array.isArray(methods) || methods.length === 0 || !hasSasPay) {
    DB.set('payment_methods', [
      {
        id: 1,
        name: "Mobile Money (Wave, Orange, MTN, Moov)",
        type: "mobile_money",
        network: "all",
        isBinance: false,
        address: "Passerelle SasPay Officielle",
        instructions: "Paiement direct sécurisé : validation automatique par Wave, Orange Money ou notification USSD push instantanée sur votre smartphone.",
        enabled: true
      },
      {
        id: 2,
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
        id: 3,
        name: "Bitcoin (BTC)",
        type: "crypto",
        network: "BTC",
        isBinance: false,
        address: "bc1q9v8h2p5w4k6f7s8d9a0m1n2b3c4x5y6z7w8",
        qrCode: generateQrSvg("Bitcoin BTC"),
        instructions: "Envoyez en BTC à cette adresse de portefeuille.",
        enabled: true
      }
    ]);
  }

  // Admin par défaut avec SOLDE INITIAL DE 0.00 $ (aucun faux solde en production)
  var users = DB.get('users', []);
  if (!Array.isArray(users)) users = [];
  var existingAdmin = users.find(function(u) { return u && u.role === 'admin'; });
  if (!existingAdmin) {
    users.push({
      id: ADMIN.id,
      name: ADMIN.name,
      email: ADMIN.email,
      passwordHash: ADMIN_HASH,
      role: 'admin',
      balance: 0.00, // Zéro strict en production
      createdAt: new Date().toISOString()
    });
    DB.set('users', users);
  } else if (existingAdmin.balance === 50.00) {
    existingAdmin.balance = 0.00;
    DB.set('users', users);
  }
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
}

function closeDepositModal() {
  document.getElementById('modal-deposit').classList.remove('active');
  currentDepositProofBase64 = null;
  if (momoPollingTimer) {
    clearInterval(momoPollingTimer);
    momoPollingTimer = null;
  }
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

    <button type="button" class="btn-primary" style="width: 100%; margin-top: 10px;" onclick="submitDepositRequest()">
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

    <div class="method-instructions-box" style="margin-top: 10px;">
      <span style="font-size: 14px;">🔒</span>
      <p style="margin: 0; font-size: 12px; line-height: 1.45;">
        Passerelle officielle SasPay : votre solde est automatiquement crédité dès réception de la confirmation bancaire ou mobile.
      </p>
    </div>

    <button type="button" class="btn-primary" id="btn-submit-momo" style="width: 100%; margin-top: 12px;" onclick="submitSasPayDeposit()">
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

// ========== AUTHENTIFICATION SÉCURISÉE PRODUCTION (EMAIL & GOOGLE OAUTH 2.0) ==========
var configuredGoogleClientId = null;

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
    console.log('[Google Auth] Mode local ou configuration par défaut.');
  }

  // Si l'API Google Identity Services est chargée et l'ID client configuré
  if (configuredGoogleClientId && window.google && window.google.accounts && window.google.accounts.id) {
    try {
      window.google.accounts.id.initialize({
        client_id: configuredGoogleClientId,
        callback: handleGoogleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true
      });

      var slot = document.getElementById('g_id_signin_slot');
      var triggerBtn = document.getElementById('btn-google-trigger');
      if (slot) {
        window.google.accounts.id.renderButton(slot, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: 320
        });
        if (triggerBtn) triggerBtn.style.display = 'none';
      }
    } catch (err) {
      console.warn('[Google Auth] Erreur d\'initialisation du bouton Google:', err);
    }
  }
}

// Déclencheur du bouton "Continuer avec Google"
function handleGoogleAuthTrigger() {
  if (configuredGoogleClientId && window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.prompt();
  } else {
    showToast('Connexion Google prête. Vous pouvez aussi vous inscrire ou vous connecter par e-mail ou pseudo.', 'info');
  }
}

function closeGoogleConfigModal() {
  var modal = document.getElementById('google-config-modal');
  if (modal) modal.classList.remove('active');
}

// Réception et vérification du jeton officiel Google ID Token
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

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Vérification Google échouée.');
    }

    // Authentification confirmée côté serveur
    DB.set('session', data.session);

    // Mettre à jour l'utilisateur local si nécessaire
    var users = DB.get('users', []);
    var uIdx = users.findIndex(function(u) { return u.id === data.user.id || u.email.toLowerCase() === data.user.email.toLowerCase(); });
    if (uIdx !== -1) {
      users[uIdx] = { ...users[uIdx], ...data.user };
    } else {
      users.push(data.user);
    }
    DB.set('users', users);

    closeAuthModal();
    showToast(`Connecté avec Google : ${data.user.name} ! 👋`, 'success');
    showConnectedCatalog();

    if (pendingPurchaseProductId) {
      var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
      startProductPurchase(pId);
    }
  } catch (err) {
    showToast(err.message || 'Échec de connexion Google.', 'error');
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

    if (res.ok && data.success) {
      if (typeof Security !== 'undefined') Security.resetRateLimit('client_login');
      DB.set('session', data.session);

      if (data.user.role === 'admin') {
        showToast('Connexion administrateur réussie ! 🔒', 'success');
        setTimeout(function() { window.location.href = 'admin.html'; }, 350);
      } else {
        showToast('Bienvenue ' + data.user.name + ' ! 👋', 'success');
        closeAuthModal();
        showConnectedCatalog();
        if (pendingPurchaseProductId) {
          var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
          startProductPurchase(pId);
        }
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
    DB.set('session', Security.createSession(matchedUser, matchedUser.role || 'client'));
  } else {
    DB.set('session', { userId: matchedUser.id, role: matchedUser.role || 'client', name: matchedUser.name, email: matchedUser.email });
  }

  showToast('Bienvenue ' + matchedUser.name + ' ! 👋', 'success');
  closeAuthModal();
  showConnectedCatalog();
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

    if (res.ok && data.success) {
      DB.set('session', data.session);

      var users = DB.get('users', []);
      users.push(data.user);
      DB.set('users', users);

      showToast(`Compte créé avec succès ! Bienvenue ${data.user.name} ⚡`, 'success');
      closeAuthModal();
      showConnectedCatalog();

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

  if (typeof Security !== 'undefined') {
    DB.set('session', Security.createSession(newUser, 'client'));
  } else {
    DB.set('session', { userId: newUser.id, role: 'client', name: newUser.name, email: newUser.email });
  }

  showToast(`Compte créé avec succès ! Bienvenue ${newUser.name} ⚡`, 'success');
  closeAuthModal();
  showConnectedCatalog();

  if (pendingPurchaseProductId) {
    var pId = pendingPurchaseProductId; pendingPurchaseProductId = null;
    startProductPurchase(pId);
  }
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
  console.log('[GetVirtu] Initialisation client (Production)...');
  try {
    initDB();
    routeUserExperience();
    initGoogleIdentity();
  } catch (e) {
    console.error(e);
  }
});
