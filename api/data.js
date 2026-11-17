/**
 * Vercel Serverless Function: /api/data
 * Catalogue, key vault, orders, customers, transactions, tickets, payment methods, settings, statistics,
 * media, backups and the store reset (System Management).
 *
 * Every authorization check and every mutation runs inside db.read()/db.tx(): the request sees one consistent
 * snapshot and its changes are committed atomically.
 */

'use strict';

const db = require('../backend/db');
const authService = require('../backend/auth');
const { publicTx } = require('../backend/payments');
const {
  httpError, apiHeaders, parseBody, clientIp, queryParam, pathParts,
  currentAuth, requireUser, requireAdmin, requireOwnerAdmin, sendError
} = require('../backend/http');

const RESET_PHRASE = 'RESET WEBSITE';

function resolveResource(req) {
  const r = queryParam(req, 'resource');
  if (r) return String(r);
  const p = queryParam(req, 'path');
  const parts = p ? String(p).split('/').filter(Boolean) : pathParts(req).filter(x => x !== 'api' && x !== 'data');
  if (String(req.url || '').split('?')[0] === '/api/version') return 'version';
  return parts[0] || '';
}

function safeUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, username: u.username, role: u.role,
    balance: u.balance || 0, auth_provider: u.auth_provider, created_at: u.created_at,
    mustChangePassword: Boolean(u.must_change_password),
    purchasesSuspended: Boolean(u.purchasesSuspended),
    purchasesSuspensionUpdatedAt: u.purchasesSuspensionUpdatedAt || null
  };
}

function adminProductsPayload() {
  // Administrators manage the key inventory from the dashboard: full vault (admin-only endpoint)
  return { products: db.getProducts(), vault: db.getVault() };
}

/** Converts uploaded data: URLs to stored media BEFORE the transaction (network/storage I/O outside the lock). */
async function prepareProductMedia(body) {
  const out = { image: body.image, deliveryFile: null };
  if (typeof body.image === 'string' && body.image.startsWith('data:')) {
    out.image = await db.saveImageDataUrl(body.image, { maxBytes: 2 * 1024 * 1024 });
  }
  const vType = body.vaultType || (body.vault && body.vault.type);
  const vContent = body.vaultContent !== undefined ? body.vaultContent : (body.vault && body.vault.content);
  if (vType === 'file' && typeof vContent === 'string' && vContent.startsWith('data:')) {
    out.deliveryFile = await db.saveDeliveryFile(vContent, body.fileName || (body.vault && body.vault.fileName));
  }
  return out;
}

module.exports = async function handler(req, res) {
  apiHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const resource = resolveResource(req);
  const method = req.method;

  try {
    const body = method === 'GET' || method === 'HEAD' ? {} : parseBody(req);

    // ------------------------------------------------------------------ version (public)
    if (resource === 'version') {
      return res.status(200).json(db.getDeploymentVersion());
    }

    // ------------------------------------------------------------------ media (public images / private proofs)
    if (resource === 'media' && method === 'GET') {
      const id = String(queryParam(req, 'id') || '');
      if (id.startsWith('prv_')) {
        await db.read(() => requireAdmin(req));
      } else {
        await db.ready();
      }
      const blob = await db.getBlob(id);
      if (!blob) return res.status(404).json({ error: 'Fichier introuvable.' });
      res.setHeader('Content-Type', blob.mime);
      res.setHeader('Content-Length', blob.data.length);
      if (id.startsWith('pub_')) {
        // Short edge cache: an image deleted by the admin (or by a reset) disappears from the CDN within minutes
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=600');
        res.setHeader('CDN-Cache-Control', 'public, max-age=600');
      } else {
        res.setHeader('Cache-Control', 'private, no-store');
      }
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      return res.status(200).end(blob.data);
    }

    // ------------------------------------------------------------------ delivered file download (order owner / admin)
    if (resource === 'download' && method === 'GET') {
      const orderId = String(queryParam(req, 'orderId') || '');
      const ref = await db.read(() => {
        const auth = requireUser(req);
        const o = db.getOrderById(orderId);
        if (!o || (auth.user.role !== 'admin' && String(o.userId) !== String(auth.user.id))) throw httpError(404, 'Commande introuvable.');
        if (!(o.status === 'Complété' || o.status === 'Livré') || !o.vaultContent || !o.vaultContent.blobId) throw httpError(404, 'Aucun fichier à télécharger pour cette commande.');
        return { blobId: o.vaultContent.blobId, fileName: o.vaultContent.fileName || 'livraison.bin' };
      });
      const blob = await db.getBlob(ref.blobId);
      if (!blob) return res.status(404).json({ error: 'Fichier introuvable.' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${ref.fileName.replace(/[^a-zA-Z0-9._ -]/g, '_')}"`);
      res.setHeader('Content-Length', blob.data.length);
      return res.status(200).end(blob.data);
    }

    // ------------------------------------------------------------------ statistics (admin)
    if (resource === 'stats' && method === 'GET') {
      const stats = await db.read(async () => {
        requireAdmin(req);
        return db.getLiveStatistics(String(queryParam(req, 'period') || 'all'));
      });
      return res.status(200).json(stats);
    }

    // ------------------------------------------------------------------ system status (admin)
    if (resource === 'system' && method === 'GET') {
      const info = await db.read(() => {
        const auth = requireAdmin(req);
        return {
          storage: db.storageInfo(),
          isOwner: db.isOwnerAdmin(auth.user),
          integrations: {
            saspay: Boolean(process.env.SASPAY_API_KEY),
            saspayWebhookSignature: Boolean(process.env.SASPAY_WEBHOOK_SECRET),
            google: Boolean(process.env.GOOGLE_CLIENT_ID),
            emailPasswordReset: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
            sessionSecret: Boolean(process.env.SESSION_SECRET)
          },
          lastReset: db.data.meta.last_reset || null,
          version: db.getDeploymentVersion()
        };
      });
      return res.status(200).json(info);
    }

    // ------------------------------------------------------------------ products & keys
    if (resource === 'products' || resource === 'keys') {
      if (method === 'GET') {
        const out = await db.read(() => {
          const auth = currentAuth(req);
          const isAdmin = Boolean(auth && auth.user.role === 'admin');
          const prodId = queryParam(req, 'productId');
          const checkName = queryParam(req, 'checkName');
          if ((resource === 'keys' || queryParam(req, 'keys') === '1') && prodId) {
            if (!isAdmin) requireAdmin(req);
            const inv = db.getProductVaultKeys(prodId);
            if (!inv) throw httpError(404, 'Produit introuvable.');
            return inv;
          }
          if (checkName) {
            if (!isAdmin) requireAdmin(req);
            const match = db.findProductByNormalizedName(checkName);
            return { exists: Boolean(match), product: match || null };
          }
          if (isAdmin) return adminProductsPayload();
          return { products: db.getPublicProducts() };
        });
        return res.status(200).json(out);
      }

      if (method === 'POST' || method === 'PUT') {
        await db.read(() => requireAdmin(req));
        if (body.action === 'suspend_product_purchases' || body.action === 'resume_product_purchases') {
          const out = await db.tx(() => {
            const auth = requireAdmin(req);
            const pid = parseInt(body.productId !== undefined ? body.productId : body.id, 10);
            if (!pid) throw httpError(400, 'ID produit valide requis.');
            const product = db.setProductPurchaseSuspension(pid, body.action === 'suspend_product_purchases', { adminName: auth.user.name || 'Administrateur' });
            return { success: true, product, ...adminProductsPayload() };
          });
          return res.status(200).json(out);
        }
        const isKeyUpdate = body.action === 'update_key' || (method === 'PUT' && (resource === 'keys' || body.keyId !== undefined || body.keyIndex !== undefined));
        const isAddKeys = !isKeyUpdate && (resource === 'keys' || body.action === 'add_keys');
        const media = (isKeyUpdate || isAddKeys) ? null : await prepareProductMedia(body);
        const out = await db.tx(() => {
          requireAdmin(req);
          if (isKeyUpdate) {
            const pid = parseInt(body.productId !== undefined ? body.productId : queryParam(req, 'productId'), 10);
            if (!pid) throw httpError(400, 'ID produit valide requis.');
            const idx = body.keyIndex !== undefined && body.keyIndex !== null && body.keyIndex !== '' ? parseInt(body.keyIndex, 10) : null;
            const r = db.updateProductKey(pid, body.keyId, body.content !== undefined ? body.content : body.newContent, idx);
            return { success: true, key: r.key, stock: r.stock, product: r.product, inventory: r.inventory, ...adminProductsPayload() };
          }
          if (isAddKeys) {
            const pid = parseInt(body.productId, 10);
            if (!pid) throw httpError(400, 'Veuillez sélectionner un produit existant valide.');
            const r = db.addKeysToProduct(pid, body.keys || body.newKeys || body.key);
            return { success: true, product: r.product, stock: r.stock, addedCount: r.addedCount, inventory: db.getProductVaultKeys(pid), ...adminProductsPayload() };
          }
          const payload = { ...body, image: media.image };
          if (media.deliveryFile) { delete payload.vaultContent; if (payload.vault) delete payload.vault.content; }
          const saved = db.saveProduct(payload, { newKeys: body.newKeys !== undefined ? body.newKeys : body.keys, replaceAvailableKeys: body.replaceAvailableKeys, deliveryFile: media.deliveryFile });
          return { success: true, product: saved, inventory: db.getProductVaultKeys(saved.id), ...adminProductsPayload() };
        });
        return res.status(200).json(out);
      }

      if (method === 'DELETE') {
        const out = await db.tx(() => {
          requireAdmin(req);
          const keyId = body.keyId !== undefined ? body.keyId : queryParam(req, 'keyId');
          const rawIdx = body.keyIndex !== undefined ? body.keyIndex : queryParam(req, 'keyIndex');
          if (resource === 'keys' || body.action === 'delete_key' || keyId || (rawIdx !== null && rawIdx !== undefined && rawIdx !== '')) {
            const pid = parseInt(body.productId !== undefined ? body.productId : (queryParam(req, 'productId') || body.id || queryParam(req, 'id')), 10);
            if (!pid) throw httpError(400, 'ID produit requis.');
            const idx = rawIdx !== null && rawIdx !== undefined && rawIdx !== '' ? parseInt(rawIdx, 10) : null;
            const r = db.deleteProductKey(pid, keyId, idx);
            return { success: true, deletedKey: r.deletedKey, stock: r.stock, product: r.product, inventory: r.inventory, ...adminProductsPayload() };
          }
          const pid = parseInt(body.id !== undefined ? body.id : queryParam(req, 'id'), 10);
          if (isNaN(pid)) throw httpError(400, 'ID produit requis.');
          db.deleteProduct(pid);
          return { success: true, ...adminProductsPayload() };
        });
        return res.status(200).json(out);
      }
    }

    // ------------------------------------------------------------------ orders
    if (resource === 'orders') {
      if (method === 'GET') {
        const out = await db.read(() => {
          const auth = requireUser(req);
          const orders = auth.user.role === 'admin' ? db.getOrders() : db.getOrders().filter(o => String(o.userId) === String(auth.user.id));
          return { orders };
        });
        return res.status(200).json(out);
      }

      if (method === 'POST') {
        const out = await db.tx(() => {
          const auth = requireUser(req);
          const r = db.purchaseWithBalance(auth.user, {
            productId: body.productId,
            productName: body.productName || body.name,
            quantity: body.quantity,
            contactInfo: body.contactInfo,
            idempotencyKey: body.idempotencyKey,
            paymentLabel: body.paymentLabel
          });
          // The remaining quantity is not revealed when the administrator hides the stock of this product
          const bought = db.getProductById(r.order && r.order.productId);
          const hideStock = Boolean(bought && bought.showStock === false);
          return {
            success: true, order: r.order, newBalance: r.newBalance,
            remainingStock: hideStock ? null : r.remainingStock,
            productAvailable: bought ? db.isProductAvailable(bought) : undefined,
            duplicate: Boolean(r.duplicate)
          };
        });
        return res.status(out.duplicate ? 200 : 201).json(out);
      }

      if (method === 'PUT') {
        const orderId = body.id || body.orderId || queryParam(req, 'id');
        if (!orderId) throw httpError(400, 'ID commande requis.');
        let deliveryFile = null;
        const action = body.action || (body.status === 'Annulé' ? 'cancel' : (body.status === 'Complété' || body.status === 'Livré' ? 'deliver' : (body.status === 'En attente' ? 'set_pending' : 'deliver')));
        const vc = body.vaultContent || {};
        if (action === 'deliver' && vc.type === 'file' && typeof vc.content === 'string' && vc.content.startsWith('data:')) {
          await db.read(() => requireAdmin(req));
          deliveryFile = await db.saveDeliveryFile(vc.content, vc.fileName);
        }
        const out = await db.tx(() => {
          const auth = requireAdmin(req);
          const adminName = auth.user.name || 'Administrateur';
          let result;
          if (action === 'cancel') {
            result = db.cancelOrder(orderId, { restockKeys: body.restockKeys === true, refund: body.refund !== false, reason: body.reason, adminName });
          } else if (action === 'deliver' || action === 'update_content') {
            const o = db.getOrderById(orderId);
            if (!o) throw httpError(404, 'Commande introuvable.');
            result = { order: db.deliverOrder(orderId, { content: vc.content !== undefined ? vc.content : body.content, type: vc.type || body.type, fileName: vc.fileName || body.fileName, deliveryFile }) };
          } else if (action === 'set_pending') {
            const o = db.getOrderById(orderId);
            if (!o) throw httpError(404, 'Commande introuvable.');
            if (o.status !== 'En attente') throw httpError(409, "Une commande livrée ou annulée ne peut pas repasser en attente (annulez-la pour rembourser le client).");
            result = { order: o };
          } else {
            throw httpError(400, 'Action de commande inconnue.');
          }
          return { success: true, ...result, orders: db.getOrders(), products: db.getProducts(), users: db.getUsers().map(safeUser) };
        });
        return res.status(200).json(out);
      }

      if (method === 'DELETE') {
        const out = await db.tx(() => {
          requireAdmin(req);
          const r = db.deleteOrder(body.id || body.orderId || queryParam(req, 'id'));
          return { success: true, ...r, orders: db.getOrders() };
        });
        return res.status(200).json(out);
      }
    }

    // ------------------------------------------------------------------ support tickets
    if (resource === 'tickets') {
      if (method === 'GET') {
        return res.status(200).json(await db.read(() => { requireAdmin(req); return { tickets: db.getTickets() }; }));
      }
      if (method === 'POST') {
        if (!authService.hit('ticket:' + clientIp(req), 8, 60 * 60 * 1000)) throw httpError(429, 'Trop de messages envoyés. Réessayez plus tard ou contactez-nous sur WhatsApp.');
        const out = await db.tx(() => {
          const auth = currentAuth(req);
          const t = db.createTicket({
            userId: auth ? auth.user.id : null,
            userName: body.userName || (auth ? auth.user.name : 'Client'),
            userContact: body.userContact || body.contact || (auth ? auth.user.email : ''),
            subject: body.subject,
            message: body.message
          });
          return { success: true, ticket: { id: t.id, status: t.status, date: t.date } };
        });
        return res.status(201).json(out);
      }
      if (method === 'PUT') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          const t = db.updateTicket(body.id, { status: body.status || 'Résolu' });
          return { success: true, ticket: t, tickets: db.getTickets() };
        }));
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          db.deleteTicket(body.id || queryParam(req, 'id'));
          return { success: true, tickets: db.getTickets() };
        }));
      }
    }

    // ------------------------------------------------------------------ visitors
    if (resource === 'visitors') {
      if (method === 'POST') {
        if (authService.hit('visit:' + clientIp(req), 20, 60 * 60 * 1000)) {
          await db.ready();
          await db.trackVisitor({ vid: body.vid, isNew: body.isNew });
        }
        return res.status(200).json({ success: true });
      }
      if (method === 'GET') {
        return res.status(200).json(await db.read(async () => { requireAdmin(req); return db.getVisitorStats(String(queryParam(req, 'period') || 'all')); }));
      }
      if (method === 'DELETE') {
        await db.read(() => requireAdmin(req));
        await db.resetVisitorStats();
        return res.status(200).json(await db.read(async () => ({ success: true, stats: await db.getLiveStatistics('all') })));
      }
    }

    // ------------------------------------------------------------------ customers & balances (admin)
    if (resource === 'users') {
      if (method === 'GET') {
        return res.status(200).json(await db.read(() => {
          requireAdmin(req);
          return { users: db.getUsers().map(safeUser), transactions: db.getTransactions().map(publicTx), purchaseControl: db.getPurchaseControl() };
        }));
      }
      if (method === 'POST' || method === 'PUT') {
        const out = await db.tx(() => {
          const auth = requireAdmin(req);
          if (body.action === 'suspend_all_purchases' || body.action === 'resume_all_purchases') {
            const purchaseControl = db.setGlobalPurchaseSuspension(body.action === 'suspend_all_purchases', { adminName: auth.user.name || 'Administrateur' });
            return { success: true, purchaseControl };
          }
          const userId = body.userId || body.id;
          if (!userId) throw httpError(400, 'Paramètre userId manquant.');
          if (body.action === 'suspend_purchases' || body.action === 'resume_purchases') {
            const u = db.setPurchaseSuspension(userId, body.action === 'suspend_purchases', { adminName: auth.user.name || 'Administrateur' });
            return { success: true, user: safeUser(u) };
          }
          if (body.action === 'reset_password') {
            const temp = authService.adminResetCustomerPassword(userId);
            return { success: true, temporaryPassword: temp, user: safeUser(db.getUserById(userId)) };
          }
          const r = db.adjustUserBalance(userId, { amount: body.amount, action: body.action || 'add', reason: body.reason, adminName: auth.user.name || 'Administrateur' });
          return { success: true, user: safeUser(r.user), transaction: publicTx(r.transaction), diff: r.diff, oldBalance: r.oldBalance, newBalance: r.newBalance };
        });
        return res.status(200).json(out);
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          const r = db.deleteUser(body.id || body.userId || queryParam(req, 'id'));
          return { success: true, ...r, users: db.getUsers().map(safeUser) };
        }));
      }
    }

    // ------------------------------------------------------------------ ledger (admin)
    if (resource === 'transactions') {
      if (method === 'GET') {
        return res.status(200).json(await db.read(() => { requireAdmin(req); return { transactions: db.getTransactions().map(publicTx) }; }));
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          const r = db.deleteTransaction(body.id || body.transactionId || queryParam(req, 'id'));
          return { success: true, ...r, transactions: db.getTransactions().map(publicTx) };
        }));
      }
    }

    // ------------------------------------------------------------------ payment methods
    if (resource === 'methods' || resource === 'payment-methods') {
      if (method === 'GET') {
        return res.status(200).json(await db.read(() => {
          const auth = currentAuth(req);
          return { methods: auth && auth.user.role === 'admin' ? db.getPaymentMethods() : db.getPublicPaymentMethods() };
        }));
      }
      if (method === 'POST' || method === 'PUT') {
        await db.read(() => requireAdmin(req));
        const payload = { ...body };
        if (typeof payload.qrCode === 'string' && payload.qrCode.startsWith('data:')) {
          payload.qrCode = await db.saveImageDataUrl(payload.qrCode, { maxBytes: 1024 * 1024 });
        }
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          const saved = db.savePaymentMethod(payload);
          return { success: true, method: saved, methods: db.getPaymentMethods() };
        }));
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          db.deletePaymentMethod(body.id !== undefined ? body.id : queryParam(req, 'id'));
          return { success: true, methods: db.getPaymentMethods() };
        }));
      }
    }

    // ------------------------------------------------------------------ backup export (admin)
    if (resource === 'backup' || resource === 'export') {
      const backup = await db.read(() => { requireAdmin(req); return db.createBackup(); });
      return res.status(200).json(backup);
    }

    // ------------------------------------------------------------------ System Management: reset preview & reset
    if (resource === 'reset-preview' && method === 'GET') {
      return res.status(200).json(await db.read(() => {
        const auth = requireAdmin(req);
        return { success: true, isOwner: db.isOwnerAdmin(auth.user), preview: db.getResetPreview(), storage: db.storageInfo() };
      }));
    }

    if (resource === 'reset' || resource === 'reset-website') {
      if (method !== 'POST') throw httpError(405, 'Méthode non autorisée.');
      const ip = clientIp(req);
      const rlKey = 'store-reset:' + ip;
      const rl = authService.checkRateLimit(rlKey, 5);
      if (!rl.allowed) throw httpError(429, `Trop de tentatives. Patientez ${rl.waitSeconds} secondes.`);

      const mode = body.mode === 'full' ? 'full' : (body.mode === 'demo' ? 'demo' : null);
      if (!mode) throw httpError(400, 'Choisissez le type de réinitialisation (démo ou complète).');
      if (String(body.confirmation || '') !== RESET_PHRASE) throw httpError(400, `Tapez exactement « ${RESET_PHRASE} » pour confirmer.`);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password) throw httpError(400, 'Saisissez votre mot de passe administrateur pour confirmer votre identité.');

      const out = await db.tx(() => {
        const auth = requireOwnerAdmin(req);
        if (!authService.verifyPassword(password, auth.user.password_hash)) {
          authService.recordFailedLogin(rlKey);
          throw httpError(401, 'Mot de passe administrateur incorrect.');
        }
        const backup = db.createBackup();
        const result = db.resetStore(mode, auth.user);
        return { success: true, message: mode === 'full' ? 'Boutique réinitialisée à son état initial.' : 'Données de démonstration supprimées.', ...result, backup, storage: db.storageInfo().kind };
      });
      authService.resetRateLimit(rlKey);
      const fresh = await db.read(async () => ({
        users: db.getUsers().map(safeUser),
        products: db.getProducts(),
        orders: db.getOrders(),
        transactions: db.getTransactions().map(publicTx),
        tickets: db.getTickets(),
        methods: db.getPaymentMethods(),
        settings: db.getPublicSettings(),
        stats: await db.getLiveStatistics('all'),
        preview: db.getResetPreview()
      }));
      return res.status(200).json({ ...out, ...fresh });
    }

    // ------------------------------------------------------------------ settings
    if (resource === 'settings') {
      if (method === 'GET') return res.status(200).json(await db.read(() => ({ success: true, settings: db.getPublicSettings() })));
      if (method === 'POST' || method === 'PUT') {
        return res.status(200).json(await db.tx(() => {
          requireAdmin(req);
          return { success: true, settings: db.updateCustomizableSettings(body) };
        }));
      }
    }

    throw httpError(404, 'Ressource non trouvée.');
  } catch (err) {
    return sendError(res, err, 'API Data');
  }
};
