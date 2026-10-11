/**
 * Vercel Serverless Function: /api/data
 * Données réelles dynamiques (Produits, Commandes, Statistiques en direct).
 */

const db = require('../backend/db');
const authService = require('../backend/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  let resource = urlParts[urlParts.length - 1]; // 'products', 'orders', 'stats', 'vault', 'version'
  if (req.query && req.query.resource) {
    resource = req.query.resource;
  }
  if ((req.url || '').includes('/version')) {
    resource = 'version';
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const auth = authService.verifySession(token);

    // Synchronisation automatique préalable avec Vercel Edge Config
    try {
      await db.syncFromRemote();
    } catch (e) {}

    // 0. VÉRIFICATION DE LA VERSION DU DÉPLOIEMENT EN DIRECT
    if (resource === 'version') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      const vInfo = db.getDeploymentVersion();
      return res.status(200).json(vInfo);
    }

    // 1. STATISTIQUES RÉELLES DYNAMIQUES AVEC FILTRES
    if (req.method === 'GET' && resource === 'stats') {
      if (!auth || auth.user.role !== 'admin') {
        return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
      }
      const period = req.query?.period || (req.url && req.url.includes('period=') ? req.url.split('period=')[1].split('&')[0] : 'all');
      const stats = db.getLiveStatistics(period);
      return res.status(200).json(stats);
    }

    // 2. PRODUITS & GESTION DES CLÉS
    if (resource === 'products' || resource === 'keys') {
      if (req.method === 'GET') {
        const prodId = req.query?.productId || (req.url && req.url.includes('productId=') ? req.url.split('productId=')[1].split('&')[0] : null);
        const checkName = req.query?.checkName || (req.url && req.url.includes('checkName=') ? decodeURIComponent(req.url.split('checkName=')[1].split('&')[0]) : null);
        const withKeys = resource === 'keys' || req.query?.keys === '1' || (req.url && req.url.includes('keys=1'));

        // Inspection des clés du coffre-fort réservée à l'administrateur
        if (withKeys && prodId) {
          if (!auth || auth.user.role !== 'admin') {
            return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
          }
          const keysData = db.getProductVaultKeys(prodId);
          return res.status(200).json(keysData || { error: 'Produit introuvable.' });
        }

        // Vérification / autocomplétion par nom existant
        if (checkName) {
          const match = db.findProductByNormalizedName(checkName);
          return res.status(200).json({ exists: !!match, product: match || null });
        }

        const prods = db.getProducts();
        return res.status(200).json({ products: prods });
      }

      if (req.method === 'POST') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée à l\'administrateur.' });
        }
        try {
          // Ajout direct de clés à un produit existant (sans créer de nouveau produit)
          if (resource === 'keys' || body.action === 'add_keys') {
            const prodId = parseInt(body.productId, 10);
            if (!prodId) {
              return res.status(400).json({ error: 'Veuillez sélectionner un produit existant valide.' });
            }
            const existingProduct = db.getProductById(prodId);
            if (!existingProduct) {
              return res.status(404).json({ error: 'Produit introuvable dans le catalogue.' });
            }
            const rawKeys = body.keys || body.newKeys || body.key;
            const resKeys = await db.addKeysToProduct(prodId, rawKeys);
            await db.persistToRemote();
            return res.status(200).json({
              success: true,
              product: resKeys.product,
              stock: resKeys.stock,
              addedCount: resKeys.addedCount,
              products: db.getProducts()
            });
          }

          const savedProd = db.saveProduct(body, { newKeys: body.newKeys || body.keys });
          await db.persistToRemote();
          return res.status(200).json({ success: true, product: savedProd, products: db.getProducts() });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }

      if (req.method === 'DELETE') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée à l\'administrateur.' });
        }
        const prodId = parseInt(body.id || req.query?.id, 10);
        db.deleteProduct(prodId);
        await db.persistToRemote();
        return res.status(200).json({ success: true, products: db.getProducts() });
      }
    }

    // 3. COMMANDES
    if (resource === 'orders') {
      if (req.method === 'GET') {
        if (!auth) {
          return res.status(401).json({ error: 'Authentification requise.' });
        }
        // Si admin -> toutes les commandes, si client -> uniquement ses commandes
        let orders = db.getOrders();
        if (auth.user.role !== 'admin') {
          orders = orders.filter(o => o.userId === auth.user.id);
        }
        return res.status(200).json({ orders });
      }

      if (req.method === 'POST') {
        if (!auth) {
          return res.status(401).json({ error: 'Veuillez vous connecter pour passer commande.' });
        }

        // Validation commande côté serveur
        let prod = db.getProductById(body.productId);
        if (!prod && (body.productName || body.name)) {
          prod = db.findProductByNormalizedName(body.productName || body.name);
        }
        if (!prod && body.productInfo) {
          try { prod = db.saveProduct(body.productInfo); } catch (e) {}
        }
        if (!prod) {
          return res.status(404).json({ error: 'Produit introuvable dans le catalogue.' });
        }

        const qty = parseInt(body.quantity, 10) || 1;
        if (qty < 1) {
          return res.status(400).json({ error: 'La quantité doit être supérieure ou égale à 1.' });
        }
        if (prod.stock < qty && prod.stock > 0) {
          return res.status(400).json({
            error: `Stock insuffisant : maximum ${prod.stock} unité(s) disponible(s).`,
            availableStock: prod.stock
          });
        }

        const total = Math.round(prod.price * qty * 100) / 100;

        // Récupération stricte du solde frais en base de données
        const freshUser = db.getUserById(auth.user.id) || db.getUserByEmail(auth.user.email);
        if (!freshUser) {
          return res.status(401).json({ error: 'Compte client introuvable.' });
        }

        const currentBalance = parseFloat(freshUser.balance) || 0;
        if (currentBalance < total) {
          const missing = Math.round((total - currentBalance) * 100) / 100;
          return res.status(400).json({
            error: `Solde insuffisant ($${currentBalance.toFixed(2)} disponible, $${total.toFixed(2)} requis). Veuillez recharger votre compte.`,
            code: 'INSUFFICIENT_BALANCE',
            currentBalance: currentBalance,
            requiredAmount: total,
            missingAmount: missing
          });
        }

        const orderId = body.orderId || ('ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase());

        // Attribution atomique transactionnelle de N clés via le Mutex de la base
        let allocatedResult = null;
        try {
          allocatedResult = await db.allocateKeysForProduct(prod.id, qty, {
            orderId: orderId,
            userId: freshUser.id,
            userEmail: freshUser.email
          });
        } catch (err) {
          return res.status(400).json({ error: err.message, code: err.code });
        }

        // Déduction sécurisée et définitive du solde en base de données
        const newBalance = Math.max(0, Math.round((currentBalance - total) * 100) / 100);
        db.updateUser(freshUser.id, { balance: newBalance });

        // Formatage clair des N clés attribuées
        const deliveredKeysList = allocatedResult.allocatedKeys || [];
        const deliveredString = deliveredKeysList.map(k => k.content).join('\n');

        const deliveredContent = {
          type: 'text',
          content: deliveredString,
          keys: deliveredKeysList,
          fileName: 'licences.txt'
        };

        const newOrder = db.createOrder({
          id: orderId,
          userId: freshUser.id,
          userEmail: freshUser.email,
          userName: freshUser.name,
          productId: prod.id,
          productName: prod.name,
          unitPrice: prod.price,
          quantity: qty,
          amount: total,
          remainingBalance: newBalance,
          userBalanceAfter: newBalance,
          contactInfo: body.contactInfo || '',
          method: 'Solde GetVirtu',
          status: 'Complété',
          vaultContent: deliveredContent
        });

        db.createTransaction({
          userId: freshUser.id,
          userEmail: freshUser.email,
          userName: freshUser.name,
          amount: total,
          currency: 'USD',
          paymentMethod: 'Solde GetVirtu',
          provider: 'balance',
          status: 'completed',
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          notes: `Achat ${prod.name} (x${qty})`
        });

        // Persistance immédiate vers Vercel Edge Config pour réplication globale
        await db.persistToRemote();

        return res.status(201).json({
          success: true,
          order: newOrder,
          newBalance: newBalance,
          remainingStock: allocatedResult.remainingStock
        });
      }
    }

    // 4. TICKETS SUPPORT CLIENT
    if (resource === 'tickets') {
      if (req.method === 'GET') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
        }
        return res.status(200).json({ tickets: db.getTickets() });
      }

      if (req.method === 'POST') {
        const newTicket = db.createTicket({
          userId: auth ? auth.user.id : (body.userId || null),
          userName: body.userName || (auth ? auth.user.name : 'Client'),
          userContact: body.userContact || body.contact || '',
          subject: body.subject || 'Support Client',
          message: body.message || '',
          status: 'Ouvert'
        });
        return res.status(201).json({ success: true, ticket: newTicket });
      }

      if (req.method === 'PUT') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
        }
        const updated = db.updateTicket(body.id, { status: body.status || 'Résolu' });
        return res.status(200).json({ success: true, ticket: updated });
      }
    }

    // 5. VISITEURS ET TRAÇABILITÉ DES VISITES
    if (resource === 'visitors') {
      if (req.method === 'POST') {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
        const userAgent = req.headers['user-agent'] || '';
        db.trackVisitor({ vid: body.vid, isNew: body.isNew, ip, userAgent });
        return res.status(200).json({ success: true });
      }
      if (req.method === 'GET') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
        }
        const period = req.query?.period || (req.url && req.url.includes('period=') ? req.url.split('period=')[1].split('&')[0] : 'all');
        const vStats = db.getVisitorStats(period);
        return res.status(200).json(vStats);
      }
    }

    // 6. UTILISATEURS & GESTION DES SOLDES CLIENTS
    if (resource === 'users') {
      if (req.method === 'GET') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
        }
        const users = db.getUsers().map(u => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          balance: u.balance || 0,
          created_at: u.created_at
        }));
        const txs = db.getTransactions();
        return res.status(200).json({ users, transactions: txs });
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée à l\'administrateur.' });
        }
        const userId = body.userId;
        const amount = parseFloat(body.amount);
        const action = body.action || 'add'; // 'add' | 'deduct' | 'set'
        const reason = body.reason || 'Ajustement manuel par administrateur';
        if (!userId || isNaN(amount)) {
          return res.status(400).json({ error: 'Paramètres manquants ou invalides (userId, amount).' });
        }

        const resAdjust = db.adjustUserBalance(userId, {
          amount,
          action,
          reason,
          adminName: auth.user.name || 'Administrateur'
        });

        return res.status(200).json({ success: true, ...resAdjust });
      }
    }

    // 7. MOYENS DE PAIEMENT POUR LA RECHARGE (GESTION ADMINISTRATEUR & LECTURE BOUTIQUE)
    if (resource === 'methods' || resource === 'payment-methods') {
      if (req.method === 'GET') {
        const methods = db.getPaymentMethods();
        return res.status(200).json({ methods });
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée exclusivement à l\'administrateur.' });
        }
        const saved = db.savePaymentMethod(body);
        return res.status(200).json({ success: true, method: saved, methods: db.getPaymentMethods() });
      }

      if (req.method === 'DELETE') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée exclusivement à l\'administrateur.' });
        }
        const mId = parseInt(body.id || req.query?.id, 10);
        db.deletePaymentMethod(mId);
        return res.status(200).json({ success: true, methods: db.getPaymentMethods() });
      }
    }

    return res.status(404).json({ error: 'Ressource non trouvée.' });
  } catch (error) {
    console.error('[API Data Error]', error.message);
    return res.status(400).json({ error: error.message });
  }
};
