/**
 * GetVirtu Production Database Engine (backend/db.js)
 * Système de stockage et modèles de données conformes aux exigences de production.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = isServerless ? os.tmpdir() : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, isServerless ? 'virtushop_database.json' : 'database.json');

// Assurer l'existence du dossier data
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const DEFAULT_ADMIN_HASH = '7bdd3fd0f0123548f0c15f8ca94f91b90799cbe476669fbd544784d4c3a2f1dc'; // Salted SHA-256

const INITIAL_DB = {
  users: [
    {
      id: 'admin-001',
      email: 'admin@virtushop.com',
      password_hash: DEFAULT_ADMIN_HASH,
      name: 'Administrateur VirtuShop',
      username: 'admin',
      profile_picture: null,
      google_id: null,
      auth_provider: 'email',
      email_verified: true,
      role: 'admin',
      balance: 0.00, // Zéro solde par défaut en production
      created_at: '2026-10-07T10:00:00.000Z',
      updated_at: '2026-10-07T10:00:00.000Z'
    }
  ],
  products: [], // Zéro produit de test - catalogue prêt à être alimenté par l'administrateur
  orders: [], // Zéro commande de test
  transactions: [], // Zéro fausse transaction
  vault: {}, // Zéro faux identifiant
  tickets: [], // Messages du support client
  visitor_logs: [], // Traçabilité des visites réelles et visiteurs uniques
  payment_methods: [
    {
      id: 1,
      name: 'Mobile Money Instantané (Wave, Orange, MTN, Moov)',
      type: 'mobile_money',
      provider: 'saspay',
      network: 'all',
      isBinance: false,
      address: 'Passerelle SasPay Officielle',
      instructions: 'Paiement direct sécurisé : validation automatique par Wave, Orange Money ou notification USSD push instantanée sur votre smartphone.',
      enabled: true
    },
    {
      id: 2,
      name: 'Crypto Instantané (Trybit - USDT, BTC, ETH, SOL, LTC...)',
      type: 'crypto_trybit',
      provider: 'trybit',
      network: 'multi',
      isBinance: false,
      address: 'Passerelle Trybit Officielle',
      instructions: 'Paiement crypto automatisé instantané avec génération d\'adresse et validation blockchain automatique en temps réel.',
      enabled: true
    }
  ],
  settings: {
    min_recharge: 5.00
  }
};

class Database {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          users: parsed.users || INITIAL_DB.users,
          products: parsed.products || [],
          orders: parsed.orders || [],
          transactions: parsed.transactions || [],
          vault: parsed.vault || {},
          tickets: parsed.tickets || [],
          visitor_logs: parsed.visitor_logs || [],
          payment_methods: parsed.payment_methods || INITIAL_DB.payment_methods,
          settings: parsed.settings || INITIAL_DB.settings
        };
      }
      const seedFile = path.join(__dirname, '..', 'data', 'database.json');
      if (fs.existsSync(seedFile)) {
        const rawSeed = fs.readFileSync(seedFile, 'utf8');
        const parsedSeed = JSON.parse(rawSeed);
        this.saveData(parsedSeed);
        return parsedSeed;
      }
    } catch (e) {
      console.error('[DB] Erreur chargement base:', e.message);
    }
    this.saveData(INITIAL_DB);
    return JSON.parse(JSON.stringify(INITIAL_DB));
  }

  saveData(data) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[DB] Erreur écriture base:', e.message);
    }
  }

  persist() {
    this.saveData(this.data);
  }

  // ========== MODÈLE UTILISATEURS ==========
  getUsers() {
    return this.data.users;
  }

  getUserById(id) {
    return this.data.users.find(u => u.id === id) || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    const clean = email.trim().toLowerCase();
    return this.data.users.find(u => u.email && u.email.toLowerCase() === clean) || null;
  }

  getUserByUsername(username) {
    if (!username) return null;
    const clean = username.trim().toLowerCase();
    return this.data.users.find(u => u.username && u.username.toLowerCase() === clean) || null;
  }

  getUserByIdentifier(identifier) {
    if (!identifier) return null;
    const clean = identifier.trim().toLowerCase();
    return this.data.users.find(u => 
      (u.email && u.email.toLowerCase() === clean) || 
      (u.username && u.username.toLowerCase() === clean)
    ) || null;
  }

  getUserByGoogleId(googleId) {
    if (!googleId) return null;
    return this.data.users.find(u => u.google_id === googleId) || null;
  }

  createUser({ email, password_hash, name, username, profile_picture, google_id, auth_provider, email_verified, role }) {
    const now = new Date().toISOString();
    const cleanEmail = email.trim().toLowerCase();
    const fallbackUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') || ('user_' + Math.random().toString(36).substring(2, 6));
    const newUser = {
      id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      email: cleanEmail,
      username: (username || fallbackUsername).trim().toLowerCase(),
      password_hash: password_hash || null,
      name: (name || cleanEmail.split('@')[0]).trim(),
      profile_picture: profile_picture || null,
      google_id: google_id || null,
      auth_provider: auth_provider || (google_id ? 'google' : 'email'),
      email_verified: !!email_verified,
      role: role || 'client',
      balance: 0.00, // Zéro solde initial strict en production
      created_at: now,
      updated_at: now
    };
    this.data.users.push(newUser);
    this.persist();
    return newUser;
  }

  updateUser(id, updates) {
    const u = this.getUserById(id);
    if (!u) return null;
    Object.assign(u, updates, { updated_at: new Date().toISOString() });
    this.persist();
    return u;
  }

  linkGoogleAccount(userId, { google_id, profile_picture, name }) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.google_id = google_id;
    if (profile_picture && !u.profile_picture) u.profile_picture = profile_picture;
    if (name && !u.name) u.name = name;
    u.email_verified = true;
    u.updated_at = new Date().toISOString();
    this.persist();
    return u;
  }

  // Ajustement manuel du solde client par l'administrateur avec traçabilité stricte
  adjustUserBalance(userId, { amount, action = 'add', reason = '', adminName = 'Administrateur' }) {
    const u = this.getUserById(userId) || this.getUserByEmail(userId);
    if (!u) throw new Error('Utilisateur introuvable.');

    const oldBal = parseFloat(u.balance) || 0;
    const numAmount = parseFloat(amount) || 0;
    let newBal = oldBal;

    if (action === 'set') {
      newBal = Math.max(0, numAmount);
    } else if (action === 'deduct') {
      newBal = Math.max(0, oldBal - numAmount);
    } else { // 'add' / 'credit'
      newBal = oldBal + numAmount;
    }
    newBal = Math.round(newBal * 100) / 100;
    const diff = Math.round((newBal - oldBal) * 100) / 100;

    u.balance = newBal;
    u.updated_at = new Date().toISOString();
    this.persist();

    // Consigner immédiatement l'ajustement manuel dans les transactions
    const tx = this.createTransaction({
      id: 'TXN-ADJUST-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase(),
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      amount: Math.abs(diff),
      currency: 'USD',
      paymentMethod: 'Ajustement Manuel Administrateur',
      provider: 'admin_manual',
      status: 'completed',
      type: diff >= 0 ? 'credit_manuel_admin' : 'debit_manuel_admin',
      failureReason: null,
      notes: reason || `Ajustement manuel par ${adminName} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} $)`,
      balanceBefore: oldBal,
      balanceAfter: newBal
    });

    return { user: u, transaction: tx, diff, oldBalance: oldBal, newBalance: newBal };
  }

  // ========== MODÈLE PRODUITS ==========
  getProducts() {
    return this.data.products;
  }

  getProductById(id) {
    return this.data.products.find(p => p.id === id) || null;
  }

  saveProduct(prod) {
    const now = new Date().toISOString();
    if (prod.id) {
      const idx = this.data.products.findIndex(p => p.id === prod.id);
      if (idx !== -1) {
        this.data.products[idx] = { ...this.data.products[idx], ...prod, updated_at: now };
      }
    } else {
      const newId = this.data.products.length > 0 ? Math.max(...this.data.products.map(p => p.id)) + 1 : 1;
      this.data.products.push({ ...prod, id: newId, created_at: now, updated_at: now });
    }
    this.persist();
  }

  deleteProduct(id) {
    this.data.products = this.data.products.filter(p => p.id !== id);
    if (this.data.vault && this.data.vault[id]) {
      delete this.data.vault[id];
    }
    this.persist();
  }

  // ========== MODÈLE COMMANDES ==========
  getOrders() {
    return this.data.orders;
  }

  getOrderById(id) {
    return this.data.orders.find(o => o.id === id) || null;
  }

  createOrder(order) {
    const now = new Date().toISOString();
    const newOrder = {
      ...order,
      id: order.id || 'ORD-' + Date.now().toString().slice(-6),
      status: order.status || 'En attente',
      date: now
    };
    this.data.orders.unshift(newOrder);
    this.persist();
    return newOrder;
  }

  updateOrder(id, updates) {
    const o = this.getOrderById(id);
    if (!o) return null;
    Object.assign(o, updates);
    this.persist();
    return o;
  }

  // ========== MODÈLE TRANSACTIONS / PAIEMENTS (PRODUCTION) ==========
  getTransactions(filter = {}) {
    let list = this.data.transactions;
    if (filter.userId) {
      list = list.filter(t => t.userId === filter.userId);
    }
    if (filter.status) {
      list = list.filter(t => t.status === filter.status);
    }
    return list;
  }

  getTransactionById(id) {
    return this.data.transactions.find(t => t.id === id) || null;
  }

  getTransactionByProviderTxId(providerTxId) {
    if (!providerTxId) return null;
    return this.data.transactions.find(t => t.providerTxId === providerTxId) || null;
  }

  createTransaction(tx) {
    const now = new Date().toISOString();
    const newTx = {
      id: tx.id || 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
      userId: tx.userId,
      userEmail: tx.userEmail || null,
      userName: tx.userName || null,
      amount: parseFloat(tx.amount) || 0,
      currency: tx.currency || 'USD',
      type: tx.type || 'deposit',
      paymentMethod: tx.paymentMethod || 'Inconnu',
      provider: tx.provider || 'manual',
      providerTxId: tx.providerTxId || null,
      status: tx.status || 'pending', // 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired'
      idempotencyKey: tx.idempotencyKey || null,
      proofImage: tx.proofImage || null,
      notes: tx.notes || null,
      balanceBefore: tx.balanceBefore !== undefined ? tx.balanceBefore : null,
      balanceAfter: tx.balanceAfter !== undefined ? tx.balanceAfter : null,
      createdAt: now,
      updatedAt: now,
      completedAt: tx.status === 'completed' ? now : null,
      failureReason: null
    };
    this.data.transactions.unshift(newTx);
    this.persist();
    return newTx;
  }

  updateTransaction(id, updates) {
    const t = this.getTransactionById(id);
    if (!t) return null;
    Object.assign(t, updates, { updatedAt: new Date().toISOString() });
    this.persist();
    return t;
  }

  // ========== COFFRE-FORT NUMÉRIQUE ==========
  getVault() {
    return this.data.vault || {};
  }

  saveVaultItem(prodId, item) {
    if (!this.data.vault) this.data.vault = {};
    this.data.vault[prodId] = item;
    this.persist();
  }

  // ========== SUPPORT CLIENT & TICKETS ==========
  getTickets() {
    return this.data.tickets || [];
  }

  createTicket(ticket) {
    const now = new Date().toISOString();
    const newT = {
      id: ticket.id || 'TCK-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase(),
      userId: ticket.userId || null,
      userName: ticket.userName || 'Client',
      userContact: ticket.userContact || '',
      subject: ticket.subject || 'Support Client',
      message: ticket.message || '',
      status: ticket.status || 'Ouvert',
      date: ticket.date || now,
      createdAt: now
    };
    if (!this.data.tickets) this.data.tickets = [];
    this.data.tickets.unshift(newT);
    this.persist();
    return newT;
  }

  updateTicket(id, updates) {
    if (!this.data.tickets) return null;
    const t = this.data.tickets.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, updates, { updatedAt: new Date().toISOString() });
    this.persist();
    return t;
  }

  // ========== MOYENS DE PAIEMENT ==========
  getPaymentMethods() {
    let list = this.data.payment_methods || [];
    if (!list.some(m => m.type === 'crypto_trybit' || m.provider === 'trybit')) {
      list.splice(1, 0, {
        id: 2,
        name: 'Crypto Instantané (Trybit - USDT, BTC, ETH, SOL, LTC...)',
        type: 'crypto_trybit',
        provider: 'trybit',
        network: 'multi',
        isBinance: false,
        address: 'Passerelle Trybit Officielle',
        instructions: 'Paiement crypto automatisé instantané avec génération d\'adresse et validation blockchain automatique en temps réel.',
        enabled: true
      });
      this.data.payment_methods = list;
      this.persist();
    }
    return list;
  }

  savePaymentMethod(method) {
    if (method.id) {
      const idx = this.data.payment_methods.findIndex(m => m.id === method.id);
      if (idx !== -1) this.data.payment_methods[idx] = { ...this.data.payment_methods[idx], ...method };
    } else {
      const newId = this.data.payment_methods.length > 0 ? Math.max(...this.data.payment_methods.map(m => m.id)) + 1 : 1;
      this.data.payment_methods.push({ ...method, id: newId });
    }
    this.persist();
  }

  deletePaymentMethod(id) {
    this.data.payment_methods = this.data.payment_methods.filter(m => m.id !== id);
    this.persist();
  }

  // ========== TRACKING DES VISITEURS (PRODUCTION) ==========
  trackVisitor({ vid, isNew, ip, userAgent }) {
    if (!this.data.visitor_logs) this.data.visitor_logs = [];
    const now = new Date();
    const entry = {
      id: 'vis_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      vid: vid || ('anon_' + Math.random().toString(36).substring(2, 10)),
      isNew: !!isNew,
      ip: ip || null,
      userAgent: userAgent || null,
      date: now.toISOString(),
      timestamp: now.getTime()
    };
    this.data.visitor_logs.push(entry);
    if (this.data.visitor_logs.length > 5000) {
      this.data.visitor_logs = this.data.visitor_logs.slice(-5000);
    }
    this.persist();
    return entry;
  }

  getVisitorStats(period = 'all') {
    const logs = this.data.visitor_logs || [];
    const now = new Date();
    let cutoff = 0;

    if (period === 'day') {
      cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (period === 'week') {
      cutoff = now.getTime() - (7 * 24 * 60 * 60 * 1000);
    } else if (period === 'month') {
      cutoff = now.getTime() - (30 * 24 * 60 * 60 * 1000);
    } else if (period === 'year') {
      cutoff = now.getTime() - (365 * 24 * 60 * 60 * 1000);
    } else {
      cutoff = 0;
    }

    const filtered = logs.filter(l => (l.timestamp || new Date(l.date).getTime()) >= cutoff);
    const totalVisits = filtered.length;
    const uniqueVids = new Set(filtered.map(l => l.vid)).size;

    return { totalVisits, uniqueVisitors: uniqueVids };
  }

  // ========== STATISTIQUES RÉELLES DYNAMIQUES AVEC FILTRES DE TEMPS ==========
  getLiveStatistics(period = 'all') {
    const orders = this.data.orders;
    const now = new Date();
    let cutoff = 0;

    if (period === 'day') {
      cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (period === 'week') {
      cutoff = now.getTime() - (7 * 24 * 60 * 60 * 1000);
    } else if (period === 'month') {
      cutoff = now.getTime() - (30 * 24 * 60 * 60 * 1000);
    } else if (period === 'year') {
      cutoff = now.getTime() - (365 * 24 * 60 * 60 * 1000);
    } else {
      cutoff = 0; // 'all'
    }

    const periodOrders = orders.filter(o => {
      if (!o.date) return true;
      const t = new Date(o.date).getTime();
      return isNaN(t) || t >= cutoff;
    });

    const completedOrders = periodOrders.filter(o => o.status === 'Complété' || o.status === 'Livré');
    const totalRevenue = completedOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
    const totalUnitsSold = completedOrders.reduce((sum, o) => sum + (o.quantity || 1), 0);
    const avgCart = totalUnitsSold > 0 ? totalRevenue / totalUnitsSold : 0;

    const pendingOrders = orders.filter(o => o.status === 'En attente').length;
    const pendingDeposits = this.data.transactions.filter(t => t.status === 'pending').length;
    const totalUsers = this.data.users.filter(u => u.role !== 'admin').length;

    // Calcul visiteurs réels
    const visitorStats = this.getVisitorStats(period);

    // Séries chronologiques dynamiques
    let chartLabels = [];
    let chartRevenue = [];
    let chartVolume = [];

    if (period === 'day') {
      for (let h = 0; h < 24; h += 2) {
        chartLabels.push((h < 10 ? '0' : '') + h + 'h');
        const slotOrders = completedOrders.filter(o => {
          if (!o.date) return false;
          const od = new Date(o.date);
          const hour = od.getHours();
          return hour >= h && hour < h + 2;
        });
        chartRevenue.push(Math.round(slotOrders.reduce((s, o) => s + (o.amount || 0), 0) * 100) / 100);
        chartVolume.push(slotOrders.reduce((s, o) => s + (o.quantity || 1), 0));
      }
    } else if (period === 'week') {
      const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        chartLabels.push(days[d.getDay()]);
        const dStr = d.toISOString().split('T')[0];
        const dayOrders = completedOrders.filter(o => o.date && o.date.startsWith(dStr));
        chartRevenue.push(Math.round(dayOrders.reduce((s, o) => s + (o.amount || 0), 0) * 100) / 100);
        chartVolume.push(dayOrders.reduce((s, o) => s + (o.quantity || 1), 0));
      }
    } else if (period === 'month') {
      for (let i = 25; i >= 0; i -= 5) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        chartLabels.push((d.getDate() < 10 ? '0' : '') + d.getDate() + '/' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1));
        const endD = new Date(d);
        endD.setDate(d.getDate() + 5);
        const chunkOrders = completedOrders.filter(o => {
          if (!o.date) return false;
          const od = new Date(o.date);
          return od >= d && od < endD;
        });
        chartRevenue.push(Math.round(chunkOrders.reduce((s, o) => s + (o.amount || 0), 0) * 100) / 100);
        chartVolume.push(chunkOrders.reduce((s, o) => s + (o.quantity || 1), 0));
      }
    } else {
      const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
      const curMonth = now.getMonth();
      for (let m = 11; m >= 0; m--) {
        const targetDate = new Date(now.getFullYear(), curMonth - m, 1);
        const mo = targetDate.getMonth();
        chartLabels.push(monthNames[mo]);
        const moPrefix = targetDate.getFullYear() + '-' + (mo + 1 < 10 ? '0' : '') + (mo + 1);
        const moOrders = completedOrders.filter(o => o.date && o.date.startsWith(moPrefix));
        chartRevenue.push(Math.round(moOrders.reduce((s, o) => s + (o.amount || 0), 0) * 100) / 100);
        chartVolume.push(moOrders.reduce((s, o) => s + (o.quantity || 1), 0));
      }
    }

    return {
      period,
      totalUsers,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalOrders: periodOrders.length,
      totalUnitsSold,
      avgCart: Math.round(avgCart * 100) / 100,
      totalVisitors: visitorStats.totalVisits,
      uniqueVisitors: visitorStats.uniqueVisitors,
      pendingOrders,
      pendingDeposits,
      chartLabels,
      chartRevenue,
      chartVolume
    };
  }
}

module.exports = new Database();
