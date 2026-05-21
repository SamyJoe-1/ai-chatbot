'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('../db/db');
const { tokenValidator } = require('../middleware/tokenValidator');
const { invalidateBusinessItemsCache, parseMetadata } = require('../brains/shared/catalogStore');
const { readRecordsFromSheet } = require('../services/googleSheets');
const { getBrain } = require('../brains');
const { COMMON_RESPONSES } = require('../brains/shared/commonResponses');

const router = express.Router();

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function serializeBusiness(business) {
  return {
    ...business,
    suggestions_en: parseList(business.suggestions_en),
    suggestions_ar: parseList(business.suggestions_ar),
  };
}

function serializeItem(item) {
  return {
    ...item,
    metadata: parseMetadata(item.metadata),
  };
}

function getBusinessByToken(token) {
  return db.prepare('SELECT * FROM businesses WHERE token = ? AND active = 1').get(token);
}

router.post('/auth/login', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'missing_token' });
  }

  const business = getBusinessByToken(token);
  if (!business) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  return res.json({
    token,
    business: serializeBusiness(business),
  });
});

router.use(tokenValidator);

router.get('/auth/me', (req, res) => {
  return res.json({
    token: req.business.token,
    business: serializeBusiness(req.business),
  });
});

router.get('/business', (req, res) => {
  return res.json(serializeBusiness(req.business));
});

router.put('/business', (req, res) => {
  const business = req.business;
  const body = req.body || {};

  const nextServiceType = body.service_type ?? business.service_type;
  db.prepare(`
    UPDATE businesses SET
      service_type = ?, name = ?, name_ar = ?, primary_color = ?, secondary_color = ?, logo_url = ?,
      about_en = ?, about_ar = ?, phone = ?, email = ?, address_en = ?, address_ar = ?,
      working_hours_en = ?, working_hours_ar = ?, catalog_link = ?, drive_folder_id = ?, sheet_id = ?, sheet_name = ?,
      welcome_en = ?, welcome_ar = ?, suggestions_en = ?, suggestions_ar = ?, active = ?
    WHERE id = ?
  `).run(
    nextServiceType,
    body.name ?? business.name,
    body.name_ar ?? business.name_ar,
    body.primary_color ?? business.primary_color,
    body.secondary_color ?? business.secondary_color,
    body.logo_url ?? business.logo_url,
    body.about_en ?? business.about_en,
    body.about_ar ?? business.about_ar,
    body.phone ?? business.phone,
    body.email ?? business.email,
    body.address_en ?? business.address_en,
    body.address_ar ?? business.address_ar,
    body.working_hours_en ?? business.working_hours_en,
    body.working_hours_ar ?? business.working_hours_ar,
    body.catalog_link ?? business.catalog_link,
    body.drive_folder_id ?? business.drive_folder_id,
    body.sheet_id ?? business.sheet_id,
    body.sheet_name ?? business.sheet_name,
    body.welcome_en ?? business.welcome_en,
    body.welcome_ar ?? business.welcome_ar,
    JSON.stringify(body.suggestions_en !== undefined ? parseList(body.suggestions_en) : parseList(business.suggestions_en)),
    JSON.stringify(body.suggestions_ar !== undefined ? parseList(body.suggestions_ar) : parseList(business.suggestions_ar)),
    body.active !== undefined ? Number(body.active) : business.active,
    business.id
  );

  if (nextServiceType !== business.service_type) {
    db.prepare('UPDATE service_items SET service_type = ? WHERE business_id = ?').run(nextServiceType, business.id);
    invalidateBusinessItemsCache(business.id);
  }

  const refreshed = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
  return res.json({
    success: true,
    business: serializeBusiness(refreshed),
  });
});

router.post('/business/regenerate-token', (req, res) => {
  const business = req.business;
  const newToken = uuidv4().replace(/-/g, '');
  db.prepare('UPDATE businesses SET token = ? WHERE id = ?').run(newToken, business.id);

  const refreshed = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
  return res.json({
    success: true,
    token: newToken,
    business: serializeBusiness(refreshed),
  });
});

router.get('/catalog', (req, res) => {
  const items = db.prepare('SELECT * FROM service_items WHERE business_id = ? ORDER BY category_en, title_en').all(req.business.id);
  return res.json(items.map(serializeItem));
});

router.post('/catalog', (req, res) => {
  const body = req.body || {};
  const metadata = typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata || {});
  const result = db.prepare(`
    INSERT INTO service_items
      (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.business.id,
    req.business.service_type,
    body.title_en,
    body.title_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    metadata,
    body.available === false || body.available === 0 ? 0 : 1
  );

  invalidateBusinessItemsCache(req.business.id);
  return res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/catalog/:itemId', (req, res) => {
  const body = req.body || {};
  const metadata = typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata || {});
  db.prepare(`
    UPDATE service_items SET
      title_en = ?, title_ar = ?, category_en = ?, category_ar = ?,
      description_en = ?, description_ar = ?, price = ?, currency = ?, metadata = ?, available = ?
    WHERE id = ? AND business_id = ?
  `).run(
    body.title_en,
    body.title_ar || '',
    body.category_en || '',
    body.category_ar || '',
    body.description_en || '',
    body.description_ar || '',
    body.price ? Number(body.price) : null,
    body.currency || 'EGP',
    metadata,
    body.available === false || body.available === 0 ? 0 : 1,
    req.params.itemId,
    req.business.id
  );

  invalidateBusinessItemsCache(req.business.id);
  return res.json({ success: true });
});

router.delete('/catalog/:itemId', (req, res) => {
  db.prepare('DELETE FROM service_items WHERE id = ? AND business_id = ?').run(req.params.itemId, req.business.id);
  invalidateBusinessItemsCache(req.business.id);
  return res.json({ success: true });
});

router.post('/catalog/sync', async (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.business.id);
  let records = [];
  if (req.body?.json_data && Array.isArray(req.body.json_data)) {
    records = req.body.json_data;
  } else {
    if (!business?.sheet_id) {
      return res.status(400).json({ error: 'no_sheet_id' });
    }
    const brain = getBrain(business.service_type);
    const sheetName = req.body?.sheet_name || business.sheet_name || brain.defaultSheetName;
    records = await readRecordsFromSheet(business.sheet_id, sheetName);
  }

  try {
    const brain = getBrain(business.service_type);
    const items = brain.mapSheetRecords(records);
    const deleteItems = db.prepare('DELETE FROM service_items WHERE business_id = ?');
    const insertItem = db.prepare(`
      INSERT INTO service_items
        (business_id, service_type, title_en, title_ar, category_en, category_ar, description_en, description_ar, price, currency, metadata, available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      deleteItems.run(business.id);
      items.forEach((item) => {
        insertItem.run(
          business.id,
          business.service_type,
          item.title_en,
          item.title_ar,
          item.category_en,
          item.category_ar,
          item.description_en,
          item.description_ar,
          item.price,
          item.currency,
          item.metadata,
          item.available
        );
      });
    })();

    invalidateBusinessItemsCache(business.id);
    return res.json({ synced: items.length });
  } catch (error) {
    console.error('[portal-catalog-sync]', error);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/orders', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
           (SELECT json_group_array(json_object(
              'id', oi.id,
              'title_en', oi.title_en,
              'title_ar', oi.title_ar,
              'quantity', oi.quantity,
              'unit_price', oi.unit_price,
              'currency', oi.currency
            )) FROM order_items oi WHERE oi.order_id = o.id) as items
    FROM orders o
    WHERE o.business_id = ?
    ORDER BY o.created_at DESC
    LIMIT 500
  `).all(req.business.id);

  return res.json(orders.map((order) => ({
    ...order,
    items: JSON.parse(order.items || '[]'),
  })));
});

router.patch('/orders/:orderId/status', (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'missing_status' });

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?")
    .run(status, req.params.orderId, req.business.id);
  return res.json({ success: true });
});

router.get('/orders/export', (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.guest_name, o.guest_phone, o.status, o.address, o.confirmed_at, o.created_at,
           (SELECT group_concat(oi.title_en || ' x' || oi.quantity, '; ') FROM order_items oi WHERE oi.order_id = o.id) as items_summary
    FROM orders o
    WHERE o.business_id = ?
    ORDER BY o.created_at DESC
  `).all(req.business.id);

  let csv = 'Order ID,Customer,Phone,Status,Address,Items,Created At\n';
  orders.forEach((order) => {
    const row = [
      order.id,
      order.guest_name || 'Guest',
      order.guest_phone,
      order.status,
      (order.address || '').replace(/,/g, ' '),
      (order.items_summary || '').replace(/,/g, ';'),
      order.created_at,
    ];
    csv += row.join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=orders_${req.business.id}.csv`);
  return res.send(csv);
});

router.get('/sessions', (req, res) => {
  const sessions = db.prepare(`
    SELECT
      s.*,
      COUNT(m.id) AS message_count,
      CASE
        WHEN s.automated = 0 THEN (
          SELECT COUNT(*)
          FROM messages pending
          WHERE pending.session_id = s.id
            AND pending.role = 'user'
            AND pending.id > COALESCE((
              SELECT MAX(anchor.id)
              FROM messages anchor
              WHERE anchor.session_id = s.id
                AND anchor.role != 'user'
                AND anchor.intent IN ('human_joined', 'admin_manual')
            ), 0)
        )
        ELSE 0
      END AS pending_human_messages
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.business_id = ?
    GROUP BY s.id
    ORDER BY s.last_active DESC
    LIMIT 200
  `).all(req.business.id);

  return res.json(sessions);
});

router.get('/sessions/:sessionId/messages', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND business_id = ?').get(req.params.sessionId, req.business.id);
  if (!session) {
    return res.status(404).json({ error: 'not_found' });
  }

  const messages = db.prepare(`
    SELECT role, content, intent, created_at
    FROM messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(session.id);

  return res.json({
    session: {
      id: session.id,
      guest_name: session.guest_name,
      guest_phone: session.guest_phone,
      automated: Number(session.automated) !== 0,
      phase: session.phase,
      last_active: session.last_active,
    },
    messages,
  });
});

router.post('/sessions/:sessionId/messages', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND business_id = ?').get(req.params.sessionId, req.business.id);
  if (!session) return res.status(404).json({ error: 'not_found' });

  const { content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'empty_message' });

  if (Number(session.automated) !== 0) {
    db.prepare("UPDATE sessions SET automated = 0, last_active = datetime('now') WHERE id = ?").run(session.id);
    db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)').run(
      session.id,
      'bot',
      COMMON_RESPONSES.human_joined[session.language === 'ar' ? 'ar' : 'en'](),
      'human_joined'
    );
  }

  db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)').run(
    session.id,
    'bot',
    String(content).trim(),
    'admin_manual'
  );
  db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(session.id);
  return res.json({ success: true });
});

router.delete('/sessions/:sessionId', (req, res) => {
  db.prepare('DELETE FROM messages WHERE session_id = (SELECT id FROM sessions WHERE id = ? AND business_id = ?)').run(req.params.sessionId, req.business.id);
  db.prepare('DELETE FROM sessions WHERE id = ? AND business_id = ?').run(req.params.sessionId, req.business.id);
  return res.json({ success: true });
});

router.delete('/sessions', (req, res) => {
  db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE business_id = ?)').run(req.business.id);
  db.prepare('DELETE FROM sessions WHERE business_id = ?').run(req.business.id);
  return res.json({ success: true });
});

module.exports = router;
