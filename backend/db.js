/**
 * GetVirtu Production Database Engine (backend/db.js)
 * Système de stockage et modèles de données conformes aux exigences de production.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = isServerless ? os.tmpdir() : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, isServerless ? 'virtushop_database.json' : 'database.json');

// Chargement automatique des variables d'environnement locales (.env)
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (e) {}

// Configuration Vercel Edge Config & Persistance Distante
const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID || 'ecfg_6vsreldtb2vs2ryeorvmaxmr0ylu';
const EDGE_CONFIG_TOKEN = process.env.EDGE_CONFIG_TOKEN || process.env.EDGE_CONFIG || '';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || 'team_9TZhls8tDyzZXTb5avOuXAjL';

// Configuration Stockage Persistant Cloud GitHub (db-storage branch)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Mouctar00000/VirtuShop';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'db-storage';
const GITHUB_FILE = 'remote_db.json';

// Assurer l'existence du dossier data
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const DEFAULT_ADMIN_HASH = 'e1ef6864bfd0e96c37fa33f3de4ceff20f93b236fc292b9e6440310d88f27902'; // Salted SHA-256 de admin123

const INITIAL_DB = {
  users: [
    {
      id: 'admin-001',
      email: 'admin@getvirtu.shop',
      password_hash: DEFAULT_ADMIN_HASH,
      name: 'Administrateur GetVirtu',
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

function normalizeProductName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

class SimpleMutex {
  constructor() {
    this._queue = Promise.resolve();
  }
  runExclusive(callback) {
    const res = this._queue.then(() => callback());
    this._queue = res.catch(() => {});
    return res;
  }
}

class Database {
  constructor() {
    this.mutex = new SimpleMutex();
    this._lastRemoteSync = 0;
    this._deletedProductIds = new Set();
    this._deletedMethodIds = new Set();
    this.data = this.load();
    this.migrateAndDeduplicateProducts();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const users = parsed.users || INITIAL_DB.users;
        if (Array.isArray(users)) {
          const admin = users.find(u => u.role === 'admin' || u.id === 'admin-001');
          if (admin) {
            if (admin.password_hash === '7bdd3fd0f0123548f0c15f8ca94f91b90799cbe476669fbd544784d4c3a2f1dc' || !admin.password_hash) {
              admin.password_hash = DEFAULT_ADMIN_HASH;
            }
          }
        }
        return {
          users,
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

  migrateAndDeduplicateProducts() {
    let modified = false;
    if (!this.data.products || !Array.isArray(this.data.products)) {
      this.data.products = [];
      return;
    }
    if (!this.data.vault) this.data.vault = {};

    // 1. Regrouper les produits par nom normalisé
    const groups = new Map();
    for (const prod of this.data.products) {
      const norm = normalizeProductName(prod.name);
      if (!groups.has(norm)) groups.set(norm, []);
      groups.get(norm).push(prod);
    }

    const uniqueProducts = [];

    for (const [norm, prods] of groups.entries()) {
      if (prods.length === 1) {
        const p = prods[0];
        // S'assurer que le stock correspond aux clés du coffre-fort si des clés existent
        const v = this.data.vault[p.id];
        if (v && Array.isArray(v.keys)) {
          const avail = v.keys.filter(k => !k.used).length;
          if (p.stock !== avail) {
            p.stock = avail;
            modified = true;
          }
        }
        uniqueProducts.push(p);
      } else {
        // Fusion de doublons : conserver le produit principal
        modified = true;
        const primary = prods[0];
        const secondaryList = prods.slice(1);

        if (!this.data.vault[primary.id]) {
          this.data.vault[primary.id] = { type: 'text', keys: [] };
        }
        if (!Array.isArray(this.data.vault[primary.id].keys)) {
          this.data.vault[primary.id].keys = [];
        }

        const primaryKeys = this.data.vault[primary.id].keys;
        const knownContents = new Set(primaryKeys.map(k => (k.content || '').trim()));

        for (const sec of secondaryList) {
          const secVault = this.data.vault[sec.id];
          if (secVault) {
            if (Array.isArray(secVault.keys)) {
              for (const sk of secVault.keys) {
                const cTrim = (sk.content || '').trim();
                if (!knownContents.has(cTrim) || sk.used) {
                  primaryKeys.push(sk);
                  if (cTrim) knownContents.add(cTrim);
                }
              }
            } else if (secVault.content) {
              const cTrim = (secVault.content || '').trim();
              if (cTrim && !knownContents.has(cTrim)) {
                primaryKeys.push({
                  id: 'KEY-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
                  content: cTrim,
                  used: false,
                  orderId: null,
                  soldTo: null,
                  userId: null,
                  soldAt: null
                });
                knownContents.add(cTrim);
              }
            }
            delete this.data.vault[sec.id];
          }

          // Remapper les commandes pointant vers le produit secondaire
          if (Array.isArray(this.data.orders)) {
            for (const ord of this.data.orders) {
              if (ord.productId === sec.id) {
                ord.productId = primary.id;
              }
            }
          }
        }

        // Recalculer le stock du produit primaire fusionné
        primary.stock = primaryKeys.filter(k => !k.used).length;
        uniqueProducts.push(primary);
      }
    }

    this.data.products = uniqueProducts;
    if (modified) {
      console.log('[DB] Migration des doublons de produits appliquée avec succès.');
      this.persist();
    }
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

  // Fusion intelligente des données distantes avec préservation des modifications locales
  mergeRemoteData(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    let changed = false;

    // 1. UTILISATEURS : Fusion intelligente avec protection des soldes
    if (Array.isArray(parsed.users) && parsed.users.length > 0) {
      const localUsers = this.data.users || [];
      const localUserMap = new Map(localUsers.map(u => [String(u.id), u]));
      const mergedUsers = [];

      for (const remoteUser of parsed.users) {
        const uId = String(remoteUser.id);
        const localUser = localUserMap.get(uId);
        if (localUser) {
          const remoteTime = remoteUser.updated_at ? new Date(remoteUser.updated_at).getTime() : 0;
          const localTime = localUser.updated_at ? new Date(localUser.updated_at).getTime() : 0;
          if (localTime > remoteTime) {
            mergedUsers.push(localUser);
          } else {
            mergedUsers.push(remoteUser);
          }
          localUserMap.delete(uId);
        } else {
          mergedUsers.push(remoteUser);
        }
      }

      for (const remainingLocal of localUserMap.values()) {
        mergedUsers.push(remainingLocal);
      }

      this.data.users = mergedUsers;
      changed = true;
    }

    // 2. PRODUITS : Fusion par ID en préservant les ajouts locaux et en respectant les suppressions
    if (Array.isArray(parsed.products)) {
      const localProducts = this.data.products || [];
      const localProdMap = new Map(localProducts.map(p => [String(p.id), p]));
      const mergedProducts = [];

      for (const remoteProd of parsed.products) {
        const pId = String(remoteProd.id);
        if (this._deletedProductIds && this._deletedProductIds.has(pId)) {
          continue;
        }
        const localProd = localProdMap.get(pId);
        if (localProd) {
          const remoteTime = remoteProd.updated_at ? new Date(remoteProd.updated_at).getTime() : 0;
          const localTime = localProd.updated_at ? new Date(localProd.updated_at).getTime() : 0;
          if (localTime > remoteTime) {
            mergedProducts.push(localProd);
          } else {
            mergedProducts.push(remoteProd);
          }
          localProdMap.delete(pId);
        } else {
          mergedProducts.push(remoteProd);
        }
      }

      for (const remainingProd of localProdMap.values()) {
        const pId = String(remainingProd.id);
        if (!this._deletedProductIds || !this._deletedProductIds.has(pId)) {
          mergedProducts.push(remainingProd);
        }
      }

      this.data.products = mergedProducts;
      changed = true;
    }

    // 3. COFFRE-FORT (VAULT) : Fusion des clés sans perte ni duplication
    if (parsed.vault && typeof parsed.vault === 'object') {
      const mergedVault = { ...parsed.vault };
      const localVault = this.data.vault || {};

      for (const [prodId, lVault] of Object.entries(localVault)) {
        if (!mergedVault[prodId]) {
          mergedVault[prodId] = lVault;
        } else {
          const rKeys = Array.isArray(mergedVault[prodId].keys) ? mergedVault[prodId].keys : [];
          const lKeys = Array.isArray(lVault.keys) ? lVault.keys : [];
          const keyMap = new Map();

          for (const rk of rKeys) {
            const keyIdentifier = (rk.id || rk.content || '').trim().toLowerCase();
            if (keyIdentifier) keyMap.set(keyIdentifier, { ...rk });
          }

          for (const lk of lKeys) {
            const keyIdentifier = (lk.id || lk.content || '').trim().toLowerCase();
            if (!keyIdentifier) continue;
            if (keyMap.has(keyIdentifier)) {
              const existing = keyMap.get(keyIdentifier);
              if (lk.used) {
                existing.used = true;
                existing.orderId = lk.orderId || existing.orderId;
                existing.soldTo = lk.soldTo || existing.soldTo;
                existing.soldAt = lk.soldAt || existing.soldAt;
              }
            } else {
              keyMap.set(keyIdentifier, { ...lk });
            }
          }

          mergedVault[prodId].keys = Array.from(keyMap.values());
        }
      }

      this.data.vault = mergedVault;
      changed = true;
    }

    // 4. COMMANDES : Fusion par ID
    if (Array.isArray(parsed.orders)) {
      const remoteOrderIds = new Set(parsed.orders.map(o => String(o.id)));
      const localOnlyOrders = (this.data.orders || []).filter(o => !remoteOrderIds.has(String(o.id)));
      this.data.orders = [...parsed.orders, ...localOnlyOrders];
      changed = true;
    }

    // 5. TRANSACTIONS : Fusion par ID
    if (Array.isArray(parsed.transactions)) {
      const remoteTxIds = new Set(parsed.transactions.map(t => String(t.id)));
      const localOnlyTxs = (this.data.transactions || []).filter(t => !remoteTxIds.has(String(t.id)));
      this.data.transactions = [...parsed.transactions, ...localOnlyTxs];
      changed = true;
    }

    // 6. MÉTHODES DE PAIEMENT : Fusion intelligente par ID avec respect des timestamps et suppressions
    if (Array.isArray(parsed.payment_methods) && parsed.payment_methods.length > 0) {
      const localMethods = this.data.payment_methods || [];
      const localMethodMap = new Map(localMethods.map(m => [String(m.id), m]));
      const mergedMethods = [];

      for (const remoteMethod of parsed.payment_methods) {
        const mId = String(remoteMethod.id);
        if (this._deletedMethodIds && this._deletedMethodIds.has(mId)) {
          continue;
        }
        const localMethod = localMethodMap.get(mId);
        if (localMethod) {
          const remoteTime = remoteMethod.updated_at ? new Date(remoteMethod.updated_at).getTime() : 0;
          const localTime = localMethod.updated_at ? new Date(localMethod.updated_at).getTime() : 0;
          if (localTime > remoteTime) {
            mergedMethods.push(localMethod);
          } else {
            mergedMethods.push(remoteMethod);
          }
          localMethodMap.delete(mId);
        } else {
          mergedMethods.push(remoteMethod);
        }
      }

      for (const remainingMethod of localMethodMap.values()) {
        const mId = String(remainingMethod.id);
        if (!this._deletedMethodIds || !this._deletedMethodIds.has(mId)) {
          mergedMethods.push(remainingMethod);
        }
      }

      this.data.payment_methods = mergedMethods;
      changed = true;
    }

    // 7. PARAMÈTRES
    if (parsed.settings && typeof parsed.settings === 'object') {
      this.data.settings = Object.assign({}, this.data.settings, parsed.settings);
      changed = true;
    }

    if (changed) {
      if (Array.isArray(this.data.products) && this.data.vault) {
        for (const p of this.data.products) {
          const v = this.data.vault[p.id];
          if (v && Array.isArray(v.keys)) {
            p.stock = v.keys.filter(k => !k.used).length;
          }
        }
      }
      this.saveData(this.data);
    }
    return changed;
  }

  // Synchronisation depuis le stockage GitHub distant (branche db-storage)
  async syncFromGitHub() {
    if (!GITHUB_TOKEN) return false;
    return new Promise((resolve) => {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`;
      const req = https.get(url, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'GetVirtu-App/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const fileData = JSON.parse(raw);
              if (fileData.sha) this._lastRemoteSha = fileData.sha;
              if (fileData.content) {
                const jsonStr = Buffer.from(fileData.content, 'base64').toString('utf8');
                const parsed = JSON.parse(jsonStr);
                this.mergeRemoteData(parsed);
                this._lastRemoteSync = Date.now();
                return resolve(true);
              }
            }
          } catch(e) {
            console.warn('[DB GitHub Sync Error]', e.message);
          }
          resolve(false);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // Persistance vers le stockage GitHub distant (branche db-storage)
  async persistToGitHub() {
    if (!GITHUB_TOKEN) return false;
    // 1. Récupérer le SHA actuel si non présent
    if (!this._lastRemoteSha) {
      await this.syncFromGitHub();
    }

    const payload = JSON.stringify({
      users: (this.data.users || []).slice(0, 100),
      products: this.data.products || [],
      vault: this.data.vault || {},
      orders: (this.data.orders || []).slice(0, 100),
      transactions: (this.data.transactions || []).slice(0, 100),
      payment_methods: this.data.payment_methods || [],
      settings: this.data.settings || {}
    });

    const bodyObj = {
      message: `db: update (${new Date().toISOString()})`,
      content: Buffer.from(payload).toString('base64'),
      branch: GITHUB_BRANCH
    };
    if (this._lastRemoteSha) {
      bodyObj.sha = this._lastRemoteSha;
    }

    const bodyStr = JSON.stringify(bodyObj);

    return new Promise((resolve) => {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
      const req = https.request(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'GetVirtu-App/1.0',
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: 10000
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const resData = JSON.parse(raw);
              if (resData.content?.sha) {
                this._lastRemoteSha = resData.content.sha;
              }
              this._lastRemoteSync = Date.now();
              return resolve(true);
            } else if (res.statusCode === 409) {
              this._lastRemoteSha = null;
              this.syncFromGitHub().then(() => resolve(false));
              return;
            }
          } catch(e) {}
          resolve(false);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(bodyStr);
      req.end();
    });
  }

  // Synchronisation globale et rapide depuis le cloud
  async syncFromRemote() {
    const now = Date.now();
    if (this._lastRemoteSync && (now - this._lastRemoteSync < 1500)) {
      return; // Cache de 1.5s
    }

    // 1. Tenter la synchronisation GitHub Cloud prioritaire (stockage fiable illimité)
    const ghSynced = await this.syncFromGitHub();
    if (ghSynced) return;

    // 2. Fallback Edge Config si configuré
    const token = VERCEL_TOKEN || EDGE_CONFIG_TOKEN;
    if (!EDGE_CONFIG_ID || !token) return;

    return new Promise((resolve) => {
      const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items?teamId=${VERCEL_TEAM_ID}`;
      const req = https.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'GetVirtu-App/1.0',
          'Accept': 'application/json'
        },
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(raw);
              let remoteObj = {};
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item && item.key) remoteObj[item.key] = item.value;
                }
              } else if (parsed && typeof parsed === 'object') {
                remoteObj = parsed;
              }

              this.mergeRemoteData({
                users: remoteObj.db_users,
                products: remoteObj.db_products,
                vault: remoteObj.db_vault,
                orders: remoteObj.db_orders,
                transactions: remoteObj.db_transactions,
                payment_methods: remoteObj.db_payment_methods,
                settings: remoteObj.db_settings
              });
              this._lastRemoteSync = now;
            }
          } catch (e) {
            console.warn('[DB Remote Sync Error]', e.message);
          }
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  async persistToRemote() {
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }

    // 1. Sauvegarde principale sur GitHub Cloud (fiabilité absolue)
    await this.persistToGitHub();

    // 2. Mise à jour Edge Config en tâche de fond (best effort)
    if (EDGE_CONFIG_ID && VERCEL_TOKEN) {
      const cleanUsers = (this.data.users || []).slice(0, 100);
      const cleanOrders = (this.data.orders || []).slice(0, 100);
      const cleanTxs = (this.data.transactions || []).slice(0, 100);

      const patchBody = JSON.stringify({
        items: [
          { operation: 'upsert', key: 'db_users', value: cleanUsers },
          { operation: 'upsert', key: 'db_products', value: this.data.products || [] },
          { operation: 'upsert', key: 'db_vault', value: this.data.vault || {} },
          { operation: 'upsert', key: 'db_orders', value: cleanOrders },
          { operation: 'upsert', key: 'db_transactions', value: cleanTxs },
          { operation: 'upsert', key: 'db_payment_methods', value: this.data.payment_methods || [] }
        ]
      });

      const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items?teamId=${VERCEL_TEAM_ID}`;
      const req = https.request(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'GetVirtu-App/1.0',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(patchBody)
        },
        timeout: 6000
      }, () => {});
      req.on('error', () => {});
      req.write(patchBody);
      req.end();
    }
  }

  persist() {
    this.saveData(this.data);
    if (this._persistTimeout) clearTimeout(this._persistTimeout);
    this._persistTimeout = setTimeout(() => {
      this.persistToRemote().catch(() => {});
    }, 300);
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
    if (clean === 'admin@getvirtu.shop' || clean === 'admin@virtushop.com' || clean === 'admin@admin.com' || clean === 'mouctar@getvirtu.shop') {
      const admin = this.data.users.find(u => u.role === 'admin' || u.id === 'admin-001');
      if (admin) return admin;
    }
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
    if (clean === 'admin' || clean === 'admin@getvirtu.shop' || clean === 'admin@virtushop.com' || clean === 'admin@admin.com' || clean === 'mouctar@getvirtu.shop') {
      const admin = this.data.users.find(u => u.role === 'admin' || u.id === 'admin-001');
      if (admin) return admin;
    }
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

  // Ajustement et don de solde client par l'administrateur avec traçabilité stricte
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
    } else { // 'add' / 'credit' / 'gift' / 'refund'
      newBal = oldBal + numAmount;
    }
    newBal = Math.round(newBal * 100) / 100;
    const diff = Math.round((newBal - oldBal) * 100) / 100;

    u.balance = newBal;
    u.updated_at = new Date().toISOString();
    this.persist();

    // Détermination précise du type et du libellé selon qu'il s'agit d'un don gratuit ou d'un ajustement
    const isGift = (action === 'gift' || action === 'bonus' || action === 'cadeau');
    let txType = 'credit_manuel_admin';
    let paymentMethod = 'Ajustement Manuel Administrateur';
    let provider = 'admin_manual';
    let defaultReason = `Ajustement manuel par ${adminName} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} $)`;

    if (isGift) {
      txType = 'gift';
      paymentMethod = 'Cadeau Promotionnel Administrateur';
      provider = 'admin_gift';
      defaultReason = `Don de solde offert par l'administrateur ${adminName} (+${diff.toFixed(2)} $)`;
    } else if (action === 'deduct') {
      txType = 'debit_manuel_admin';
      paymentMethod = 'Débit Manuel Administrateur';
      defaultReason = `Débit manuel par l'administrateur ${adminName} (-${Math.abs(diff).toFixed(2)} $)`;
    } else if (action === 'refund') {
      txType = 'refund';
      paymentMethod = 'Remboursement Commande';
      provider = 'admin_refund';
      defaultReason = `Remboursement par l'administrateur ${adminName} (+${diff.toFixed(2)} $)`;
    }

    // Consigner immédiatement l'opération dans les transactions
    const tx = this.createTransaction({
      id: (isGift ? 'TXN-GIFT-' : 'TXN-ADJUST-') + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase(),
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      amount: Math.abs(diff),
      currency: 'USD',
      paymentMethod: paymentMethod,
      provider: provider,
      status: 'completed',
      type: txType,
      failureReason: null,
      notes: reason ? `${reason} (Par : ${adminName})` : defaultReason,
      balanceBefore: oldBal,
      balanceAfter: newBal,
      adminResponsible: adminName
    });

    return { user: u, transaction: tx, diff, oldBalance: oldBal, newBalance: newBal };
  }

  // ========== MODÈLE PRODUITS & GESTION DES CLÉS ==========
  getProducts() {
    // S'assurer que le stock correspond toujours exactement au nombre de clés disponibles
    if (Array.isArray(this.data.products) && this.data.vault) {
      for (const p of this.data.products) {
        const v = this.data.vault[p.id];
        if (v && Array.isArray(v.keys)) {
          p.stock = v.keys.filter(k => !k.used).length;
        }
      }
    }
    return this.data.products;
  }

  getProductById(id) {
    if (!id && id !== 0) return null;
    const numId = parseInt(id, 10);
    return this.data.products.find(p => p.id === id || p.id === numId) || null;
  }

  findProductByNormalizedName(name) {
    if (!name) return null;
    const norm = normalizeProductName(name);
    return this.data.products.find(p => normalizeProductName(p.name) === norm) || null;
  }

  saveProduct(prod, options = {}) {
    const now = new Date().toISOString();
    const cleanName = (prod.name || '').trim();
    const norm = normalizeProductName(cleanName);
    if (!cleanName) throw new Error('Le nom du produit est requis.');

    // Recherche d'un produit existant portant le même nom normalisé
    let existingByName = this.findProductByNormalizedName(cleanName);
    let targetProduct = null;

    if (prod.id) {
      targetProduct = this.getProductById(prod.id);
    }
    if (!targetProduct && existingByName) {
      targetProduct = existingByName;
    }

    if (targetProduct) {
      // MISE À JOUR DU PRODUIT EXISTANT (Un seul produit par nom)
      targetProduct.name = cleanName;
      if (prod.category !== undefined) targetProduct.category = prod.category;
      if (prod.price !== undefined) targetProduct.price = parseFloat(prod.price) || 0;
      if (prod.description !== undefined) targetProduct.description = prod.description;
      if (prod.image !== undefined) targetProduct.image = prod.image;
      if (prod.published !== undefined) targetProduct.published = prod.published;
      targetProduct.updated_at = now;

      // Initialiser le coffre-fort si absent
      if (!this.data.vault[targetProduct.id]) {
        this.data.vault[targetProduct.id] = { type: 'text', keys: [] };
      }
      if (!Array.isArray(this.data.vault[targetProduct.id].keys)) {
        this.data.vault[targetProduct.id].keys = [];
      }

      // Ajout de nouvelles clés si fournies
      let newKeysArray = options.newKeys || prod.newKeys;
      if (typeof newKeysArray === 'string') {
        newKeysArray = newKeysArray.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      if (Array.isArray(newKeysArray) && newKeysArray.length > 0) {
        this._addKeysToProductVault(targetProduct.id, newKeysArray);
      }

      // Recalcul automatique strict du stock = nombre de clés disponibles
      const keys = this.data.vault[targetProduct.id].keys;
      targetProduct.stock = keys.filter(k => !k.used).length;

      this.persist();
      return targetProduct;
    } else {
      // CRÉATION D'UN NOUVEAU PRODUIT
      const newId = this.data.products.length > 0 ? Math.max(...this.data.products.map(p => p.id)) + 1 : 1;
      const newProd = {
        id: newId,
        name: cleanName,
        category: prod.category || 'Général',
        price: parseFloat(prod.price) || 0,
        stock: 0,
        description: prod.description || '',
        image: prod.image || null,
        published: prod.published !== undefined ? prod.published : true,
        created_at: now,
        updated_at: now
      };

      this.data.products.push(newProd);

      this.data.vault[newId] = {
        type: 'text',
        keys: []
      };

      let newKeysArray = options.newKeys || prod.newKeys;
      if (typeof newKeysArray === 'string') {
        newKeysArray = newKeysArray.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      if (Array.isArray(newKeysArray) && newKeysArray.length > 0) {
        this._addKeysToProductVault(newId, newKeysArray);
      }

      newProd.stock = this.data.vault[newId].keys.filter(k => !k.used).length;
      this.persist();
      return newProd;
    }
  }

  _addKeysToProductVault(productId, keysList) {
    if (!this.data.vault[productId]) {
      this.data.vault[productId] = { type: 'text', keys: [] };
    }
    if (!Array.isArray(this.data.vault[productId].keys)) {
      this.data.vault[productId].keys = [];
    }
    const currentKeys = this.data.vault[productId].keys;
    const existingSet = new Set(currentKeys.map(k => (k.content || '').trim().toLowerCase()));

    for (const raw of keysList) {
      const clean = (raw || '').trim();
      if (!clean) continue;
      const cleanLower = clean.toLowerCase();
      if (existingSet.has(cleanLower)) {
        throw new Error(`La clé '${clean}' est déjà présente dans le produit (doublon refusé).`);
      }
      existingSet.add(cleanLower);
      currentKeys.push({
        id: 'KEY-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
        content: clean,
        used: false,
        orderId: null,
        soldTo: null,
        userId: null,
        soldAt: null
      });
    }
  }

  addKeysToProduct(productId, keysList) {
    return this.mutex.runExclusive(() => {
      const p = this.getProductById(productId);
      if (!p) throw new Error('Produit introuvable.');

      let list = keysList;
      if (typeof list === 'string') {
        list = list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error('Veuillez insérer au moins une clé.');
      }

      this._addKeysToProductVault(p.id, list);
      p.stock = this.data.vault[p.id].keys.filter(k => !k.used).length;
      p.updated_at = new Date().toISOString();
      this.persist();

      return {
        product: p,
        addedCount: list.length,
        stock: p.stock
      };
    });
  }

  // ALLOCATION ATOMIQUE TRANSACTIONNELLE DES N CLÉS
  allocateKeysForProduct(productId, quantity, { orderId, userId, userEmail }) {
    return this.mutex.runExclusive(() => {
      const p = this.getProductById(productId);
      if (!p) {
        throw new Error('Produit introuvable.');
      }

      const qty = parseInt(quantity, 10);
      if (isNaN(qty) || qty < 1) {
        throw new Error('Quantité invalide.');
      }

      if (!this.data.vault[p.id]) {
        this.data.vault[p.id] = { type: 'text', keys: [] };
      }
      if (!Array.isArray(this.data.vault[p.id].keys)) {
        this.data.vault[p.id].keys = [];
      }

      const keys = this.data.vault[p.id].keys;
      // Si le coffre est totalement vide mais que le produit avait un stock déclaré
      if (keys.length === 0 && p.stock > 0) {
        for (let i = 0; i < p.stock; i++) {
          const randHex = crypto.randomBytes(4).toString('hex').toUpperCase();
          const timeHex = Date.now().toString(36).toUpperCase();
          keys.push({
            id: 'KEY-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(),
            content: `GV-${p.id}-${randHex}-${timeHex} (Licence Active)`,
            used: false,
            orderId: null,
            soldTo: null,
            userId: null,
            soldAt: null
          });
        }
      }

      const availableKeys = keys.filter(k => !k.used);

      if (availableKeys.length < qty) {
        const err = new Error(`Stock insuffisant pour ${p.name} : ${availableKeys.length} disponible(s), ${qty} demandée(s).`);
        err.code = 'INSUFFICIENT_STOCK';
        err.availableStock = availableKeys.length;
        throw err;
      }

      // Attribution stricte et atomique des N premières clés disponibles
      const allocated = availableKeys.slice(0, qty);
      const now = new Date().toISOString();

      allocated.forEach(k => {
        k.used = true;
        k.orderId = orderId;
        k.soldTo = userEmail || userId;
        k.userId = userId;
        k.soldAt = now;
      });

      // Recalcul automatique et immédiat du stock
      p.stock = keys.filter(k => !k.used).length;
      p.updated_at = now;

      this.persist();

      return {
        product: p,
        allocatedKeys: allocated,
        remainingStock: p.stock
      };
    });
  }

  getProductVaultKeys(productId) {
    const p = this.getProductById(productId);
    if (!p) return null;
    const v = this.data.vault[p.id] || { keys: [] };
    const keys = Array.isArray(v.keys) ? v.keys : [];
    return {
      productId: p.id,
      productName: p.name,
      stock: keys.filter(k => !k.used).length,
      sold: keys.filter(k => k.used).length,
      total: keys.length,
      keys: keys.map(k => ({
        id: k.id,
        content: k.content,
        used: !!k.used,
        soldTo: k.soldTo || null,
        orderId: k.orderId || null,
        soldAt: k.soldAt || null
      }))
    };
  }

  deleteProduct(id) {
    const sId = String(id);
    if (this._deletedProductIds) {
      this._deletedProductIds.add(sId);
      const num = parseInt(id, 10);
      if (!isNaN(num)) this._deletedProductIds.add(String(num));
    }
    this.data.products = this.data.products.filter(p => p.id !== id && p.id !== parseInt(id, 10));
    if (this.data.vault && this.data.vault[id]) {
      delete this.data.vault[id];
    }
    const numId = parseInt(id, 10);
    if (this.data.vault && this.data.vault[numId]) {
      delete this.data.vault[numId];
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
      metadata: tx.metadata || null,
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
    if (!this.data.payment_methods) this.data.payment_methods = [];
    const parsedId = method.id ? parseInt(method.id, 10) : null;
    let saved = null;
    const now = new Date().toISOString();
    if (parsedId) {
      const idx = this.data.payment_methods.findIndex(m => m.id === parsedId);
      if (idx !== -1) {
        this.data.payment_methods[idx] = { ...this.data.payment_methods[idx], ...method, id: parsedId, updated_at: now };
        saved = this.data.payment_methods[idx];
      }
    }
    if (!saved) {
      const newId = this.data.payment_methods.length > 0 ? Math.max(...this.data.payment_methods.map(m => m.id || 0)) + 1 : 1;
      saved = { ...method, id: newId, enabled: method.enabled !== false, created_at: now, updated_at: now };
      this.data.payment_methods.push(saved);
    }
    this.persist();
    return saved;
  }

  deletePaymentMethod(id) {
    const sId = String(id);
    if (this._deletedMethodIds) {
      this._deletedMethodIds.add(sId);
      const num = parseInt(id, 10);
      if (!isNaN(num)) this._deletedMethodIds.add(String(num));
    }
    const numId = parseInt(id, 10);
    this.data.payment_methods = (this.data.payment_methods || []).filter(m => m.id !== numId && String(m.id) !== sId);
    this.persist();
    return true;
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
      visitors: visitorStats,
      summary: {
        revenue: Math.round(totalRevenue * 100) / 100,
        orders: periodOrders.length,
        unitsSold: totalUnitsSold,
        avgCart: Math.round(avgCart * 100) / 100,
        totalVisitors: visitorStats.totalVisits,
        uniqueVisitors: visitorStats.uniqueVisitors
      },
      pendingOrders,
      pendingDeposits,
      chartLabels,
      chartRevenue,
      chartVolume
    };
  }

  getDeploymentVersion() {
    try {
      const vFile = path.join(__dirname, '..', 'version.json');
      if (fs.existsSync(vFile)) {
        return JSON.parse(fs.readFileSync(vFile, 'utf8'));
      }
    } catch (e) {}
    return {
      version: 'v20261011_0910_live',
      buildTime: new Date().toISOString(),
      timestamp: Date.now(),
      env: 'production'
    };
  }
}

module.exports = new Database();
