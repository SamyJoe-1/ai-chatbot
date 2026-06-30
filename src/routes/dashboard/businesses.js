'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db/db');
const { authMiddleware, adminOnly } = require('../../middleware/auth');
const { getBrain, listServiceTypes } = require('../../brains');
const { invalidateBusinessItemsCache } = require('../../brains/shared/catalogStore');
const { getBrandProfileMeta, saveBrandProfile } = require('../../brains/shared/brandProfile');
const { generateBrandProfile, isAiConfigured } = require('../../engine/brandProfile');
const { COMMON_RESPONSES } = require('../../brains/shared/commonResponses');
const { parseFaqList } = require('../../engine/faqMatcher');

const router = express.Router();
router.use(authMiddleware);

const allBusinesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC');
const getBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?');
const createBusiness = db.prepare(`
  INSERT INTO businesses (
    token, service_type, name, name_ar, primary_color, secondary_color, logo_url,
    about_en, about_ar, phone, email, address_en, address_ar,
    working_hours_en, working_hours_ar, catalog_link, contact_link, drive_folder_id, sheet_id, sheet_name,
    welcome_en, welcome_ar, suggestions_en, suggestions_ar, faq_en, faq_ar, ai_enabled, franco_enabled, sourcing_mode, active
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateBusiness = db.prepare(`
  UPDATE businesses SET
    service_type = ?, name = ?, name_ar = ?, primary_color = ?, secondary_color = ?, logo_url = ?,
    about_en = ?, about_ar = ?, phone = ?, email = ?, address_en = ?, address_ar = ?,
    working_hours_en = ?, working_hours_ar = ?, catalog_link = ?, contact_link = ?, drive_folder_id = ?, sheet_id = ?, sheet_name = ?,
    welcome_en = ?, welcome_ar = ?, suggestions_en = ?, suggestions_ar = ?, faq_en = ?, faq_ar = ?, ai_enabled = ?, franco_enabled = ?, sourcing_mode = ?, active = ?
  WHERE id = ?
`);
const deleteBusiness = db.prepare('DELETE FROM businesses WHERE id = ?');

const listUsers = db.prepare('SELECT id, username, role, business_id, created_at FROM admins ORDER BY created_at DESC');
const createUser = db.prepare('INSERT INTO admins (username, password, role, business_id) VALUES (?, ?, ?, ?)');
const deleteUser = db.prepare("DELETE FROM admins WHERE id = ? AND role != 'admin'");

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

function normalizeFaq(value) {
  return parseFaqList(value)
    .map((entry) => ({
      q: String(entry.q || entry.question || '').trim(),
      a: String(entry.a || entry.answer || '').trim(),
    }))
    .filter((entry) => entry.q && entry.a);
}

function serializeBusiness(business) {
  return {
    ...business,
    suggestions_en: parseList(business.suggestions_en),
    suggestions_ar: parseList(business.suggestions_ar),
    faq_en: normalizeFaq(business.faq_en),
    faq_ar: normalizeFaq(business.faq_ar),
  };
}

function ensureAccess(admin, businessId) {
  return admin.role === 'admin' || Number(admin.business_id) === Number(businessId);
}

function buildDefaultBusinessPayload(serviceType) {
  const brain = getBrain(serviceType);
  return {
    service_type: serviceType,
    name: brain.defaultBusinessName,
    name_ar: '',
    welcome_en: '',
    welcome_ar: '',
  };
}

router.get('/meta/service-types', (_req, res) => {
  return res.json({ service_types: listServiceTypes() });
});

router.get('/', (req, res) => {
  if (req.admin.role === 'admin') {
    return res.json(allBusinesses.all().map(serializeBusiness));
  }

  if (!req.admin.business_id) {
    return res.json([]);
  }

  const business = getBusiness.get(req.admin.business_id);
  return res.json(business ? [serializeBusiness(business)] : []);
});

router.get('/users/all', adminOnly, (_req, res) => {
  return res.json(listUsers.all());
});

router.post('/users', adminOnly, async (req, res) => {
  const { username, password, business_id: businessId } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = createUser.run(username, hash, 'user', businessId || null);
    return res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username_taken' });
    }
    throw error;
  }
});

router.delete('/users/:id', adminOnly, (req, res) => {
  deleteUser.run(req.params.id);
  return res.json({ success: true });
});

router.get('/:id/sessions', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

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
  `).all(businessId);

  return res.json(sessions);
});

router.get('/:id/sessions/:sessionId/messages', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND business_id = ?').get(req.params.sessionId, businessId);
  if (!session) {
    return res.status(404).json({ error: 'not_found' });
  }

  const messages = db.prepare(`
    SELECT role, content, intent, ai_score, created_at
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

router.get('/:id', (req, res) => {
  const business = getBusiness.get(req.params.id);
  if (!business) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!ensureAccess(req.admin, business.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  return res.json(serializeBusiness(business));
});

router.post('/', adminOnly, (req, res) => {
  const body = req.body || {};
  const token = uuidv4().replace(/-/g, '');
  const serviceType = listServiceTypes().includes(body.service_type) ? body.service_type : 'cafe';
  const defaults = buildDefaultBusinessPayload(serviceType);
  const welcomeSource = {
    service_type: serviceType,
    name: body.name || defaults.name,
    name_ar: body.name_ar || defaults.name_ar,
    welcome_en: body.welcome_en || '',
    welcome_ar: body.welcome_ar || '',
  };

  const result = createBusiness.run(
    token,
    serviceType,
    body.name || defaults.name,
    body.name_ar || '',
    body.primary_color || '#17443a',
    body.secondary_color || '#f6efe4',
    body.logo_url || '',
    body.about_en || '',
    body.about_ar || '',
    body.phone || '',
    body.email || '',
    body.address_en || '',
    body.address_ar || '',
    body.working_hours_en || '',
    body.working_hours_ar || '',
    body.catalog_link || '',
    body.contact_link || '',
    body.drive_folder_id || '',
    body.sheet_id || '',
    body.sheet_name || getBrain(serviceType).defaultSheetName,
    body.welcome_en || defaults.welcome_en || getBrain(serviceType).getWelcomeMessage(welcomeSource, 'en'),
    body.welcome_ar || defaults.welcome_ar || getBrain(serviceType).getWelcomeMessage(welcomeSource, 'ar'),
    JSON.stringify(parseList(body.suggestions_en)),
    JSON.stringify(parseList(body.suggestions_ar)),
    JSON.stringify(normalizeFaq(body.faq_en)),
    JSON.stringify(normalizeFaq(body.faq_ar)),
    body.ai_enabled === 1 || body.ai_enabled === true ? 1 : 0,
    body.franco_enabled === 0 || body.franco_enabled === false ? 0 : 1,
    body.sourcing_mode === 1 || body.sourcing_mode === true ? 1 : 0,
    body.active === 0 ? 0 : 1
  );

  return res.status(201).json({ id: result.lastInsertRowid, token });
});

router.put('/:id', (req, res) => {
  const business = getBusiness.get(req.params.id);
  if (!business) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!ensureAccess(req.admin, business.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  const serviceType = listServiceTypes().includes(body.service_type) ? body.service_type : business.service_type;
  updateBusiness.run(
    serviceType,
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
    body.contact_link ?? business.contact_link,
    body.drive_folder_id ?? business.drive_folder_id,
    body.sheet_id ?? business.sheet_id,
    body.sheet_name ?? business.sheet_name,
    body.welcome_en ?? business.welcome_en,
    body.welcome_ar ?? business.welcome_ar,
    JSON.stringify(body.suggestions_en !== undefined ? parseList(body.suggestions_en) : parseList(business.suggestions_en)),
    JSON.stringify(body.suggestions_ar !== undefined ? parseList(body.suggestions_ar) : parseList(business.suggestions_ar)),
    JSON.stringify(body.faq_en !== undefined ? normalizeFaq(body.faq_en) : normalizeFaq(business.faq_en)),
    JSON.stringify(body.faq_ar !== undefined ? normalizeFaq(body.faq_ar) : normalizeFaq(business.faq_ar)),
    body.ai_enabled !== undefined ? Number(body.ai_enabled) : business.ai_enabled,
    body.franco_enabled !== undefined ? Number(body.franco_enabled) : business.franco_enabled,
    body.sourcing_mode !== undefined ? Number(body.sourcing_mode) : business.sourcing_mode,
    body.active !== undefined ? Number(body.active) : business.active,
    business.id
  );

  if (serviceType !== business.service_type) {
    db.prepare('UPDATE service_items SET service_type = ? WHERE business_id = ?').run(serviceType, business.id);
    invalidateBusinessItemsCache(business.id);
  }

  return res.json({ success: true });
});

router.delete('/:id', adminOnly, (req, res) => {
  deleteBusiness.run(req.params.id);
  return res.json({ success: true });
});

router.patch('/:id/toggle', (req, res) => {
  const business = getBusiness.get(req.params.id);
  if (!business) return res.status(404).json({ error: 'not_found' });
  if (!ensureAccess(req.admin, business.id)) return res.status(403).json({ error: 'forbidden' });

  const newActive = business.active ? 0 : 1;
  db.prepare('UPDATE businesses SET active = ? WHERE id = ?').run(newActive, business.id);
  return res.json({ success: true, active: newActive });
});

router.post('/:id/regenerate-token', adminOnly, (req, res) => {
  const business = getBusiness.get(req.params.id);
  if (!business) return res.status(404).json({ error: 'not_found' });

  const newToken = uuidv4().replace(/-/g, '');
  db.prepare('UPDATE businesses SET token = ? WHERE id = ?').run(newToken, business.id);
  return res.json({ success: true, token: newToken });
});

router.delete('/:id/sessions/:sessionId', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  db.prepare('DELETE FROM messages WHERE session_id = (SELECT id FROM sessions WHERE id = ? AND business_id = ?)').run(req.params.sessionId, businessId);
  db.prepare('DELETE FROM sessions WHERE id = ? AND business_id = ?').run(req.params.sessionId, businessId);
  return res.json({ success: true });
});

router.delete('/:id/sessions', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE business_id = ?)').run(businessId);
  db.prepare('DELETE FROM sessions WHERE business_id = ?').run(businessId);
  return res.json({ success: true });
});

router.post('/:id/sessions/:sessionId/messages', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND business_id = ?').get(req.params.sessionId, businessId);
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

/* ═══════ BRAND PROFILE (AI concept map) ═══════ */

// Current stored profile + metadata. Shape kept simple for the admin panel:
// { identity, concepts: {key: [titles]}, generated_at, model, ai_configured }.
router.get('/:id/brand-profile', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  const meta = getBrandProfileMeta(businessId);
  return res.json({
    identity: meta ? meta.profile.identity : '',
    concepts: meta ? meta.profile.concepts : {},
    generated_at: meta ? meta.generated_at : null,
    model: meta ? meta.model : null,
    ai_configured: isAiConfigured(),
  });
});

// Save an admin-edited profile (identity + concepts). Lets owners hand-tune the
// map — add a synonym, drop a wrong mapping — without an AI call. We clear the
// source_hash so the next sync still regenerates from the (changed) catalog.
router.put('/:id/brand-profile', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  const concepts = body.concepts && typeof body.concepts === 'object' && !Array.isArray(body.concepts) ? body.concepts : {};
  // Keep only well-formed entries: non-empty key -> array of title strings.
  const cleanConcepts = {};
  for (const [key, titles] of Object.entries(concepts)) {
    if (!String(key).trim() || !Array.isArray(titles)) continue;
    const list = titles.map((t) => String(t || '').trim()).filter(Boolean);
    if (list.length) cleanConcepts[String(key).trim()] = list;
  }

  saveBrandProfile(businessId, {
    profile: { identity: String(body.identity || '').slice(0, 400), concepts: cleanConcepts, item_keywords: {} },
    sourceHash: null,
    model: 'manual-edit',
  });
  return res.json({ success: true });
});

// Force an AI regeneration now (admin "Regenerate" button). Runs the one-time
// profile call against the current catalog and returns the fresh result.
router.post('/:id/brand-profile/regenerate', async (req, res) => {
  const business = getBusiness.get(req.params.id);
  if (!business) return res.status(404).json({ error: 'not_found' });
  if (!ensureAccess(req.admin, business.id)) return res.status(403).json({ error: 'forbidden' });
  if (!isAiConfigured()) return res.status(400).json({ error: 'ai_not_configured' });

  const result = await generateBrandProfile(business, { force: true });
  if (!result.ok) return res.status(502).json({ error: 'generation_failed', detail: result.error || result.reason });

  const meta = getBrandProfileMeta(business.id);
  return res.json({
    success: true,
    concepts: meta ? meta.profile.concepts : {},
    identity: meta ? meta.profile.identity : '',
    generated_at: meta ? meta.generated_at : null,
    model: meta ? meta.model : null,
  });
});

/* ═══════ ORDERS ═══════ */
router.get('/:id/orders', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

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
  `).all(businessId);

  return res.json(orders.map(o => ({
    ...o,
    items: JSON.parse(o.items || '[]')
  })));
});

router.patch('/:id/orders/:orderId/status', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'missing_status' });

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?")
    .run(status, req.params.orderId, businessId);
    
  return res.json({ success: true });
});

router.get('/:id/orders/export', (req, res) => {
  const businessId = Number(req.params.id);
  if (!ensureAccess(req.admin, businessId)) return res.status(403).json({ error: 'forbidden' });

  const orders = db.prepare(`
    SELECT o.id, o.guest_name, o.guest_phone, o.email, o.country, o.note, o.status, o.address, o.confirmed_at, o.created_at,
           (SELECT group_concat(oi.title_en || ' x' || oi.quantity, '; ') FROM order_items oi WHERE oi.order_id = o.id) as items_summary
    FROM orders o
    WHERE o.business_id = ?
    ORDER BY o.created_at DESC
  `).all(businessId);

  const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  let csv = 'Order ID,Customer,Phone,Email,Country,Note,Status,Address,Items,Created At\n';
  orders.forEach(o => {
    const row = [
      o.id,
      o.guest_name || 'Guest',
      o.guest_phone,
      o.email || '',
      o.country || '',
      o.note || '',
      o.status,
      o.address || '',
      (o.items_summary || '').replace(/,/g, ';'),
      o.created_at
    ];
    csv += row.map(csvCell).join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=orders_${businessId}.csv`);
  return res.send(csv);
});

module.exports = router;
