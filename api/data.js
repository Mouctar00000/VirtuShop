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
    updated_at: u.updated_at || null,
    mustChangePassword: Boolean(u.must_change_password),
    purchasesSuspended: Boolean(u.purchasesSuspended),
    purchasesSuspensionUpdatedAt: u.purchasesSuspensionUpdatedAt || null,
    accountSuspended: Boolean(u.accountSuspended),
    accountSuspendedAt: u.accountSuspended ? (u.accountSuspendedAt || null) : null,
    accountSuspensionReason: u.accountSuspended ? (u.accountSuspensionReason || '') : '',
    accountSuspensionUpdatedAt: u.accountSuspensionUpdatedAt || null
  };
}

function adminProductsPayload() {
  // Administrators manage the key inventory from the dashboard: full vault (admin-only endpoint)
  return { products: db.getProducts(), vault: db.getVault() };
}

// ------------------------------------------------------------------ administrator activity log helpers
function audit(req, auth, action, target = {}) {
  db.audit(auth && auth.user, action, { ...target, ip: clientIp(req) });
}
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2) + ' $';
const PRODUCT_AUDIT_FIELDS = ['name', 'category', 'price', 'compareAtPrice', 'costPrice', 'published', 'deliveryMode', 'deliveryTiming', 'deliveryDelayMinutes',
  'purchaseMode', 'redirectUrl', 'showStock', 'stock', 'image', 'description', 'deliveryInfo', 'features', 'benefits', 'notices', 'purchasesSuspended'];
function productDiff(before, after) {
  const changes = {};
  for (const k of PRODUCT_AUDIT_FIELDS) {
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b)) changes[k] = { before: a === undefined ? null : a, after: b === undefined ? null : b };
  }
  return changes;
}
function productChangeSummary(changes) {
  const parts = [];
  const c = changes;
  if (c.price) parts.push(`prix ${money(c.price.before)} → ${money(c.price.after)}`);
  if (c.stock) parts.push(`stock ${c.stock.before === null ? '—' : c.stock.before} → ${c.stock.after === null ? '—' : c.stock.after}`);
  if (c.published) parts.push(c.published.after ? 'rendu visible' : 'masqué de la boutique');
  if (c.deliveryMode || c.deliveryTiming || c.deliveryDelayMinutes) parts.push('mode de livraison modifié');
  if (c.purchaseMode || c.redirectUrl) parts.push("mode d'achat modifié");
  if (c.compareAtPrice) parts.push('prix barré modifié');
  if (c.costPrice) parts.push("coût d'achat modifié");
  if (c.name) parts.push(`renommé (« ${c.name.before} » → « ${c.name.after} »)`);
  const other = Object.keys(c).filter(k => !['price', 'stock', 'published', 'deliveryMode', 'deliveryTiming', 'deliveryDelayMinutes', 'purchaseMode', 'redirectUrl', 'compareAtPrice', 'costPrice', 'name'].includes(k));
  if (other.length) parts.push('autres champs : ' + other.join(', '));
  return parts.join(' ; ');
}
function vaultCounts(pid) {
  const inv = db.getProductVaultKeys(pid);
  return inv ? { keysAvailable: inv.stock, keysSold: inv.sold } : null;
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
        if (auth.user.role !== 'admin' && !db.isOrderContentReleased(o)) throw httpError(404, 'Aucun fichier à télécharger pour cette commande.');
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
      const from = queryParam(req, 'from');
      const to = queryParam(req, 'to');
      const stats = await db.read(async () => {
        requireAdmin(req);
        // Date-range statistics (current dashboard); the former ?period= answer is kept for compatibility
        if (from || to) return db.getStatistics({ from: from ? String(from).slice(0, 10) : null, to: to ? String(to).slice(0, 10) : null, tz: queryParam(req, 'tz') });
        return db.getLiveStatistics(String(queryParam(req, 'period') || 'all'));
      });
      return res.status(200).json(stats);
    }

    // ------------------------------------------------------------------ administrator activity log (read-only)
    if (resource === 'audit' && method === 'GET') {
      await db.read(() => requireAdmin(req));
      const num = (k) => { const v = Date.parse(String(queryParam(req, k) || '')); return Number.isFinite(v) ? v : null; };
      const str = (k, max) => { const v = queryParam(req, k); return v ? String(v).slice(0, max) : null; };
      const out = await db.listAudit({
        limit: Math.min(200, Math.max(1, parseInt(queryParam(req, 'limit'), 10) || 50)),
        offset: Math.max(0, parseInt(queryParam(req, 'offset'), 10) || 0),
        filter: { action: str('action', 80), targetType: str('targetType', 40), targetId: str('targetId', 120), q: str('q', 100), fromMs: num('from'), toMs: num('to') }
      });
      return res.status(200).json({ success: true, ...out });
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
            const suspend = body.action === 'suspend_product_purchases';
            const product = db.setProductPurchaseSuspension(pid, suspend, { adminName: auth.user.name || 'Administrateur' });
            audit(req, auth, suspend ? 'product.purchases_suspended' : 'product.purchases_resumed', { targetType: 'product', targetId: pid, summary: `Achats ${suspend ? 'suspendus' : 'réactivés'} pour le produit « ${product.name} »` });
            return { success: true, product, ...adminProductsPayload() };
          });
          return res.status(200).json(out);
        }
        const isKeyUpdate = body.action === 'update_key' || (method === 'PUT' && (resource === 'keys' || body.keyId !== undefined || body.keyIndex !== undefined));
        const isAddKeys = !isKeyUpdate && (resource === 'keys' || body.action === 'add_keys');
        const media = (isKeyUpdate || isAddKeys) ? null : await prepareProductMedia(body);
        const out = await db.tx(() => {
          const auth = requireAdmin(req);
          if (isKeyUpdate) {
            const pid = parseInt(body.productId !== undefined ? body.productId : queryParam(req, 'productId'), 10);
            if (!pid) throw httpError(400, 'ID produit valide requis.');
            const idx = body.keyIndex !== undefined && body.keyIndex !== null && body.keyIndex !== '' ? parseInt(body.keyIndex, 10) : null;
            const beforeInv = db.getProductVaultKeys(pid);
            const beforeKey = beforeInv ? (beforeInv.keys.find(k => body.keyId && String(k.id) === String(body.keyId)) || (Number.isInteger(idx) ? beforeInv.keys[idx] : null)) : null;
            const r = db.updateProductKey(pid, body.keyId, body.content !== undefined ? body.content : body.newContent, idx);
            audit(req, auth, 'key.updated', { targetType: 'product', targetId: pid, summary: `Clé ${r.key.id} modifiée (produit « ${r.product.name} »)` + (r.key.used ? ' — clé déjà vendue : la commande ' + r.key.orderId + ' est corrigée' : ''), details: { keyId: r.key.id, before: beforeKey ? beforeKey.content : null, after: r.key.content, orderId: r.key.orderId || null } });
            return { success: true, key: r.key, stock: r.stock, product: r.product, inventory: r.inventory, ...adminProductsPayload() };
          }
          if (isAddKeys) {
            const pid = parseInt(body.productId, 10);
            if (!pid) throw httpError(400, 'Veuillez sélectionner un produit existant valide.');
            const stockBefore = (db.getProductById(pid) || {}).stock;
            const r = db.addKeysToProduct(pid, body.keys || body.newKeys || body.key);
            audit(req, auth, 'keys.added', { targetType: 'product', targetId: pid, summary: `${r.addedCount} clé(s) ajoutée(s) au produit « ${r.product.name} » (stock ${stockBefore} → ${r.stock})`, details: { added: r.addedCount, stockBefore, stockAfter: r.stock } });
            return { success: true, product: r.product, stock: r.stock, addedCount: r.addedCount, inventory: db.getProductVaultKeys(pid), ...adminProductsPayload() };
          }
          const payload = { ...body, image: media.image };
          if (media.deliveryFile) { delete payload.vaultContent; if (payload.vault) delete payload.vault.content; }
          const existing = (body.id !== undefined && body.id !== null && body.id !== '' ? db.getProductById(body.id) : null) || (body.name ? db.findProductByNormalizedName(body.name) : null);
          const before = existing ? JSON.parse(JSON.stringify(existing)) : null;
          const keysBefore = existing ? vaultCounts(existing.id) : null;
          const saved = db.saveProduct(payload, { newKeys: body.newKeys !== undefined ? body.newKeys : body.keys, replaceAvailableKeys: body.replaceAvailableKeys, deliveryFile: media.deliveryFile });
          const changes = productDiff(before, saved);
          const keysAfter = vaultCounts(saved.id);
          const keysChanged = JSON.stringify(keysBefore) !== JSON.stringify(keysAfter);
          if (!before) audit(req, auth, 'product.created', { targetType: 'product', targetId: saved.id, summary: `Produit « ${saved.name} » créé (${money(saved.price)}, ${saved.published ? 'visible' : 'masqué'})`, details: { product: saved, keys: keysAfter } });
          else if (Object.keys(changes).length || keysChanged || media.deliveryFile) {
            const s = productChangeSummary(changes);
            audit(req, auth, 'product.updated', { targetType: 'product', targetId: saved.id, summary: `Produit « ${saved.name} » modifié` + (s ? ' : ' + s : '') + (keysChanged ? ` ; clés ${keysBefore ? keysBefore.keysAvailable : 0} → ${keysAfter ? keysAfter.keysAvailable : 0} disponible(s)` : '') + (media.deliveryFile ? ' ; fichier de livraison remplacé' : ''), details: { changes, keysBefore, keysAfter } });
          }
          return { success: true, product: saved, inventory: db.getProductVaultKeys(saved.id), ...adminProductsPayload() };
        });
        return res.status(200).json(out);
      }

      if (method === 'DELETE') {
        const out = await db.tx(() => {
          const auth = requireAdmin(req);
          const keyId = body.keyId !== undefined ? body.keyId : queryParam(req, 'keyId');
          const rawIdx = body.keyIndex !== undefined ? body.keyIndex : queryParam(req, 'keyIndex');
          if (resource === 'keys' || body.action === 'delete_key' || keyId || (rawIdx !== null && rawIdx !== undefined && rawIdx !== '')) {
            const pid = parseInt(body.productId !== undefined ? body.productId : (queryParam(req, 'productId') || body.id || queryParam(req, 'id')), 10);
            if (!pid) throw httpError(400, 'ID produit requis.');
            const idx = rawIdx !== null && rawIdx !== undefined && rawIdx !== '' ? parseInt(rawIdx, 10) : null;
            const r = db.deleteProductKey(pid, keyId, idx);
            audit(req, auth, 'key.deleted', { targetType: 'product', targetId: pid, summary: `Clé ${r.deletedKey.id} supprimée du produit « ${r.product.name} » (stock → ${r.stock})`, details: { key: r.deletedKey } });
            return { success: true, deletedKey: r.deletedKey, stock: r.stock, product: r.product, inventory: r.inventory, ...adminProductsPayload() };
          }
          const pid = parseInt(body.id !== undefined ? body.id : queryParam(req, 'id'), 10);
          if (isNaN(pid)) throw httpError(400, 'ID produit requis.');
          const p = db.getProductById(pid);
          const snapshot = p ? { product: JSON.parse(JSON.stringify(p)), vault: JSON.parse(JSON.stringify(db.getVault()[p.id] || null)), manualStock: JSON.parse(JSON.stringify((db.data.manual_stock || {})[String(p.id)] || [])) } : null;
          db.deleteProduct(pid);
          audit(req, auth, 'product.deleted', { targetType: 'product', targetId: pid, summary: `Produit « ${snapshot ? snapshot.product.name : pid} » supprimé (copie complète conservée dans ce journal)`, details: snapshot });
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
          const orders = auth.user.role === 'admin' ? db.getOrders() : db.getOrders().filter(o => String(o.userId) === String(auth.user.id)).map(o => db.customerOrderView(o));
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
            success: true, order: db.customerOrderView(r.order), newBalance: r.newBalance,
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
            const o = result.order;
            audit(req, auth, 'order.cancelled', { targetType: 'order', targetId: o.id, summary: `Commande ${o.id} annulée (${o.productName} x${o.quantity || 1}, ${money(o.amount)})` + (result.refundTransaction ? ` — client ${o.userEmail || o.userId} remboursé de ${money(result.refundTransaction.amount)} (${result.refundTransaction.id})` : ' — sans remboursement'), details: { refundTransactionId: result.refundTransaction ? result.refundTransaction.id : null, keysReturned: result.keysReturned, keysRevoked: result.keysRevoked, reason: body.reason || null, wasDelivered: o.wasDeliveredBeforeCancel } });
          } else if (action === 'deliver' || action === 'update_content') {
            const o = db.getOrderById(orderId);
            if (!o) throw httpError(404, 'Commande introuvable.');
            const beforeContent = o.vaultContent ? JSON.parse(JSON.stringify(o.vaultContent)) : null;
            const order = db.deliverOrder(orderId, { content: vc.content !== undefined ? vc.content : body.content, type: vc.type || body.type, fileName: vc.fileName || body.fileName, deliveryFile, stockItemIds: body.stockItemIds, adminNote: body.adminNote, adminName });
            const last = (order.history || [])[order.history.length - 1] || {};
            const kind = ['content_updated', 'delivered_early', 'delivered'].includes(last.type) ? last.type : 'delivered';
            const label = kind === 'content_updated' ? 'contenu livré corrigé / remplacé' : (kind === 'delivered_early' ? 'livrée avant la fin du délai prévu' : 'livrée');
            audit(req, auth, 'order.' + kind, { targetType: 'order', targetId: order.id, summary: `Commande ${order.id} ${label} (${order.productName} x${order.quantity || 1}, client ${order.userEmail || order.userId})`, details: { before: beforeContent, after: order.vaultContent, stockItemIds: (order.delivery && order.delivery.stockItemIds) || [] } });
            result = { order };
          } else if (action === 'delivery_issue') {
            const order = db.setOrderDeliveryIssue(orderId, { issue: body.issue !== false, note: body.note, adminName });
            audit(req, auth, body.issue !== false ? 'order.issue_flagged' : 'order.issue_cleared', { targetType: 'order', targetId: order.id, summary: `Commande ${order.id} : problème de livraison ${body.issue !== false ? 'signalé' : 'levé'}` + (body.note ? ` (${String(body.note).slice(0, 120)})` : '') });
            result = { order };
          } else if (action === 'update_note') {
            const r = db.setOrderAdminNote(orderId, body.adminNote !== undefined ? body.adminNote : body.note, { adminName });
            if (r.before !== r.after) audit(req, auth, 'order.note_updated', { targetType: 'order', targetId: r.order.id, summary: `Commande ${r.order.id} : note privée ${r.after ? 'mise à jour' : 'effacée'}`, details: { before: r.before, after: r.after } });
            result = { order: r.order };
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
          const auth = requireAdmin(req);
          const r = db.deleteOrder(body.id || body.orderId || queryParam(req, 'id'));
          audit(req, auth, 'order.deleted', { targetType: 'order', targetId: r.deletedOrder.id, summary: `Commande annulée ${r.deletedOrder.id} supprimée définitivement (copie complète conservée dans ce journal)`, details: r.snapshot });
          delete r.snapshot;
          return { success: true, ...r, orders: db.getOrders() };
        });
        return res.status(200).json(out);
      }
    }

    // ------------------------------------------------------------------ manual stock (administrator only)
    if (resource === 'manual-stock') {
      if (method === 'GET') {
        return res.status(200).json(await db.read(() => {
          requireAdmin(req);
          return { success: true, ...db.getManualStock(parseInt(queryParam(req, 'productId'), 10)) };
        }));
      }
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          const auth = requireAdmin(req);
          const pid = parseInt(body.productId !== undefined ? body.productId : queryParam(req, 'productId'), 10);
          if (!pid) throw httpError(400, 'ID produit valide requis.');
          const action = method === 'DELETE' ? 'delete' : (body.action || 'add');
          const pname = (db.getProductById(pid) || {}).name || pid;
          if (action === 'add') {
            const r = db.addManualStockItems(pid, body.items, { note: body.note });
            audit(req, auth, 'manual_stock.added', { targetType: 'product', targetId: pid, summary: `${r.added} élément(s) ajouté(s) au stock manuel de « ${pname} »`, details: { added: r.added, counts: r.counts } });
            return { success: true, ...r };
          }
          if (action === 'update') {
            const itemId = String(body.itemId || '');
            const prev = (db.getManualStock(pid).items || []).find(x => x && x.id === itemId);
            const before = prev ? JSON.parse(JSON.stringify(prev)) : null;
            const r = db.updateManualStockItem(pid, itemId, { content: body.content, status: body.status, note: body.note });
            audit(req, auth, 'manual_stock.updated', { targetType: 'product', targetId: pid, summary: `Élément ${itemId} du stock manuel de « ${pname} » modifié`, details: { before, after: r.item } });
            return { success: true, ...r };
          }
          if (action === 'delete') {
            const itemId = String(body.itemId || queryParam(req, 'itemId') || '');
            const prev = (db.getManualStock(pid).items || []).find(x => x && x.id === itemId);
            const before = prev ? JSON.parse(JSON.stringify(prev)) : null;
            const r = db.deleteManualStockItem(pid, itemId);
            audit(req, auth, 'manual_stock.deleted', { targetType: 'product', targetId: pid, summary: `Élément ${itemId} supprimé du stock manuel de « ${pname} »`, details: { item: before } });
            return { success: true, ...r };
          }
          throw httpError(400, 'Action de stock inconnue.');
        }));
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
          const auth = requireAdmin(req);
          const t = db.updateTicket(body.id, { status: body.status || 'Résolu' });
          audit(req, auth, 'ticket.updated', { targetType: 'ticket', targetId: t.id, summary: `Ticket ${t.id} marqué « ${t.status} »` });
          return { success: true, ticket: t, tickets: db.getTickets() };
        }));
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          const auth = requireAdmin(req);
          const id = body.id || queryParam(req, 'id');
          const before = (db.getTickets() || []).find(x => x && String(x.id) === String(id));
          const snapshot = before ? JSON.parse(JSON.stringify(before)) : null;
          db.deleteTicket(id);
          audit(req, auth, 'ticket.deleted', { targetType: 'ticket', targetId: id, summary: `Ticket ${id} supprimé`, details: snapshot });
          return { success: true, tickets: db.getTickets() };
        }));
      }
    }

    // ------------------------------------------------------------------ visitors
    if (resource === 'visitors') {
      if (method === 'POST') {
        // Many mobile customers share one public IP (operator NAT): the cap only stops floods, not real visitors
        if (authService.hit('visit:' + clientIp(req), 240, 60 * 60 * 1000)) {
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
        const before = await db.getVisitorStats('all');
        await db.resetVisitorStats();
        await db.tx(() => {
          const auth = requireAdmin(req);
          audit(req, auth, 'stats.visits_reset', { targetType: 'stats', targetId: 'visits', summary: `Compteurs de visites remis à zéro (${before.totalVisits} visite(s), ${before.uniqueVisitors} visiteur(s) unique(s) effacés)`, details: before });
        });
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
          const adminName = auth.user.name || 'Administrateur';
          if (body.action === 'suspend_all_purchases' || body.action === 'resume_all_purchases') {
            const on = body.action === 'suspend_all_purchases';
            const purchaseControl = db.setGlobalPurchaseSuspension(on, { adminName });
            audit(req, auth, on ? 'purchases.global_suspended' : 'purchases.global_resumed', { targetType: 'settings', targetId: 'purchases', summary: on ? 'Achats suspendus pour TOUS les clients' : 'Achats réactivés pour tous les clients' });
            return { success: true, purchaseControl };
          }
          const userId = body.userId || body.id;
          if (!userId) throw httpError(400, 'Paramètre userId manquant.');
          const label = (u) => u ? `${u.name || 'Client'} (${u.email})` : String(userId);
          if (body.action === 'suspend_purchases' || body.action === 'resume_purchases') {
            const on = body.action === 'suspend_purchases';
            const u = db.setPurchaseSuspension(userId, on, { adminName });
            audit(req, auth, on ? 'customer.purchases_suspended' : 'customer.purchases_resumed', { targetType: 'customer', targetId: u.id, summary: `Achats ${on ? 'suspendus' : 'réactivés'} pour ${label(u)}` });
            return { success: true, user: safeUser(u) };
          }
          if (body.action === 'suspend_account' || body.action === 'reactivate_account') {
            const on = body.action === 'suspend_account';
            const u = db.setAccountSuspension(userId, on, { adminName, reason: body.reason });
            audit(req, auth, on ? 'customer.account_suspended' : 'customer.account_reactivated', { targetType: 'customer', targetId: u.id, summary: `Compte ${on ? 'suspendu (connexion bloquée, sessions fermées)' : 'réactivé'} : ${label(u)}` + (on && body.reason ? ` — motif : ${String(body.reason).slice(0, 150)}` : ''), details: { reason: body.reason || null } });
            return { success: true, user: safeUser(u) };
          }
          if (body.action === 'update_profile') {
            const r = db.adminUpdateCustomer(userId, { name: body.name, email: body.email });
            if (JSON.stringify(r.before) !== JSON.stringify(r.after)) audit(req, auth, 'customer.updated', { targetType: 'customer', targetId: r.user.id, summary: `Profil client modifié : ${label(r.user)}`, details: { before: r.before, after: r.after } });
            return { success: true, user: safeUser(r.user) };
          }
          if (body.action === 'reset_password') {
            const temp = authService.adminResetCustomerPassword(userId);
            const u = db.getUserById(userId);
            audit(req, auth, 'customer.password_reset', { targetType: 'customer', targetId: userId, summary: `Mot de passe temporaire généré pour ${label(u)} (le mot de passe n'est jamais enregistré dans ce journal)` });
            return { success: true, temporaryPassword: temp, user: safeUser(u) };
          }
          const r = db.adjustUserBalance(userId, { amount: body.amount, action: body.action || 'add', reason: body.reason, adminName });
          audit(req, auth, 'wallet.adjusted', { targetType: 'customer', targetId: r.user.id, summary: `Solde de ${label(r.user)} : ${money(r.oldBalance)} → ${money(r.newBalance)} (${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(2)} $, ${body.action || 'add'})` + (body.reason ? ` — motif : ${String(body.reason).slice(0, 150)}` : ''), details: { action: body.action || 'add', amount: body.amount, oldBalance: r.oldBalance, newBalance: r.newBalance, diff: r.diff, transactionId: r.transaction.id, reason: body.reason || null } });
          return { success: true, user: safeUser(r.user), transaction: publicTx(r.transaction), diff: r.diff, oldBalance: r.oldBalance, newBalance: r.newBalance };
        });
        return res.status(200).json(out);
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          const auth = requireAdmin(req);
          const r = db.deleteUser(body.id || body.userId || queryParam(req, 'id'));
          audit(req, auth, 'customer.deleted', { targetType: 'customer', targetId: r.deletedUser.id, summary: `Compte client supprimé : ${r.deletedUser.name || ''} (${r.deletedUser.email}) — copie conservée dans ce journal`, details: r.snapshot });
          delete r.snapshot;
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
          const auth = requireAdmin(req);
          const r = db.deleteTransaction(body.id || body.transactionId || queryParam(req, 'id'));
          const s = r.snapshot || {};
          audit(req, auth, 'transaction.deleted', { targetType: 'transaction', targetId: r.deletedTransaction.id, summary: `Transaction ${r.deletedTransaction.id} (${s.status || '?'}, ${money(s.amount)}, ${s.userEmail || s.userId || ''}) supprimée — copie conservée dans ce journal`, details: publicTx(s) });
          delete r.snapshot;
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
          const auth = requireAdmin(req);
          const prevId = payload.id !== undefined && payload.id !== null && payload.id !== '' ? parseInt(payload.id, 10) : null;
          const prev = prevId ? db.getPaymentMethods().find(m => m.id === prevId) : null;
          const before = prev ? JSON.parse(JSON.stringify(prev)) : null;
          const saved = db.savePaymentMethod(payload);
          audit(req, auth, before ? 'payment_method.updated' : 'payment_method.created', { targetType: 'payment_method', targetId: saved.id, summary: `Moyen de paiement « ${saved.name} » ${before ? 'modifié' : 'créé'}` + (before && before.enabled !== saved.enabled ? (saved.enabled ? ' (activé)' : ' (désactivé)') : ''), details: { before, after: saved } });
          return { success: true, method: saved, methods: db.getPaymentMethods() };
        }));
      }
      if (method === 'DELETE') {
        return res.status(200).json(await db.tx(() => {
          const auth = requireAdmin(req);
          const id = body.id !== undefined ? body.id : queryParam(req, 'id');
          const prev = db.getPaymentMethods().find(m => m.id === parseInt(id, 10));
          const before = prev ? JSON.parse(JSON.stringify(prev)) : null;
          db.deletePaymentMethod(id);
          audit(req, auth, 'payment_method.deleted', { targetType: 'payment_method', targetId: id, summary: `Moyen de paiement « ${before ? before.name : id} » supprimé`, details: before });
          return { success: true, methods: db.getPaymentMethods() };
        }));
      }
    }

    // ------------------------------------------------------------------ backup export (admin)
    if (resource === 'backup' || resource === 'export') {
      const backup = await db.read(() => { requireAdmin(req); return db.createBackup(); });
      await db.tx(() => {
        const auth = requireAdmin(req);
        audit(req, auth, 'backup.downloaded', { targetType: 'store', targetId: 'backup', summary: `Sauvegarde JSON complète téléchargée (${backup.counts.users} comptes, ${backup.counts.orders} commandes, ${backup.counts.transactions} transactions)` });
      }).catch(() => {});
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
        audit(req, auth, 'store.reset', { targetType: 'store', targetId: mode, summary: `Réinitialisation ${mode === 'full' ? 'COMPLÈTE' : 'des données de démonstration'} de la boutique (sauvegarde serveur prise avant)`, details: { mode, removed: result.removed, kept: result.kept } });
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
          const auth = requireAdmin(req);
          const before = db.getPublicSettings();
          const settings = db.updateCustomizableSettings(body);
          const changed = ['min_recharge', 'whatsapp_number'].filter(k => before[k] !== settings[k]);
          if (changed.length) audit(req, auth, 'settings.updated', { targetType: 'settings', targetId: 'shop', summary: 'Réglages modifiés : ' + changed.map(k => `${k} ${before[k]} → ${settings[k]}`).join(', '), details: { before, after: settings } });
          return { success: true, settings };
        }));
      }
    }

    throw httpError(404, 'Ressource non trouvée.');
  } catch (err) {
    return sendError(res, err, 'API Data');
  }
};
