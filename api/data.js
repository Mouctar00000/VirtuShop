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
  const resource = urlParts[urlParts.length - 1]; // 'products', 'orders', 'stats', 'vault'

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    body = body || {};

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const auth = authService.verifySession(token);

    // 1. STATISTIQUES RÉELLES DYNAMIQUES
    if (req.method === 'GET' && resource === 'stats') {
      if (!auth || auth.user.role !== 'admin') {
        return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });
      }
      const stats = db.getLiveStatistics();
      return res.status(200).json(stats);
    }

    // 2. PRODUITS
    if (resource === 'products') {
      if (req.method === 'GET') {
        const prods = db.getProducts();
        return res.status(200).json({ products: prods });
      }

      if (req.method === 'POST') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée à l\'administrateur.' });
        }
        db.saveProduct(body);
        return res.status(200).json({ success: true, products: db.getProducts() });
      }

      if (req.method === 'DELETE') {
        if (!auth || auth.user.role !== 'admin') {
          return res.status(403).json({ error: 'Action réservée à l\'administrateur.' });
        }
        const prodId = parseInt(body.id || req.query?.id, 10);
        db.deleteProduct(prodId);
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
        const prod = db.getProductById(body.productId);
        if (!prod) {
          return res.status(404).json({ error: 'Produit introuvable.' });
        }
        const qty = parseInt(body.quantity, 10) || 1;
        if (qty < 1 || prod.stock < qty) {
          return res.status(400).json({ error: 'Quantité invalide ou stock insuffisant.' });
        }
        const total = Math.round(prod.price * qty * 100) / 100;
        if ((auth.user.balance || 0) < total) {
          return res.status(400).json({ error: 'Solde insuffisant pour cet achat.' });
        }

        // Déduction du solde et du stock côté serveur
        db.updateUser(auth.user.id, { balance: Math.round((auth.user.balance - total) * 100) / 100 });
        db.saveProduct({ id: prod.id, stock: Math.max(0, prod.stock - qty) });

        const newOrder = db.createOrder({
          userId: auth.user.id,
          userEmail: auth.user.email,
          userName: auth.user.name,
          productId: prod.id,
          productName: prod.name,
          unitPrice: prod.price,
          quantity: qty,
          amount: total,
          contactInfo: body.contactInfo || '',
          method: 'Solde GetVirtu',
          status: 'En attente',
          vaultContent: null
        });

        return res.status(201).json({ success: true, order: newOrder, newBalance: auth.user.balance - total });
      }
    }

    return res.status(404).json({ error: 'Ressource non trouvée.' });
  } catch (error) {
    console.error('[API Data Error]', error.message);
    return res.status(400).json({ error: error.message });
  }
};
