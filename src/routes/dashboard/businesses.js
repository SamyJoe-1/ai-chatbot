'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db/db');
const { authMiddleware, adminOnly } = require('../../middleware/auth');
const { getBrain, listServiceTypes } = require('../../brains');
const { invalidateBusinessItemsCache } = require('../../brains/shared/catalogStore');

const router = express.Router();
router.use(authMiddleware);

const allBusinesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC');
const getBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?');
const createBusiness = db.prepare(`
  INSERT INTO businesses (
    token, service_type, name, name_ar, primary_color, secondary_color, logo_url,
    about_en, about_ar, phone, email, address_en, address_ar,
    working_hours_en, working_hours_ar, catalog_link, drive_folder_id, sheet_id, sheet_name,
    welcome_en, welcome_ar, suggestions_en, suggestions_ar, active
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateBusiness = db.prepare(`
  UPDATE businesses SET
    service_type = ?, name = ?, name_ar = ?, primary_color = ?, secondary_color = ?, logo_url = ?,
    about_en = ?, about_ar = ?, phone = ?, email = ?, address_en = ?, address_ar = ?,
    working_hours_en = ?, working_hours_ar = ?, catalog_link = ?, drive_folder_id = ?, sheet_id = ?, sheet_name = ?,
    welcome_en = ?, welcome_ar = ?, suggestions_en = ?, suggestions_ar = ?, active = ?
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

function serializeBusiness(business) {
  return {
    ...business,
    suggestions_en: parseList(business.suggestions_en),
    suggestions_ar: parseList(business.suggestions_ar),
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
    body.drive_folder_id || '',
    body.sheet_id || '',
    body.sheet_name || getBrain(serviceType).defaultSheetName,
    body.welcome_en || defaults.welcome_en || getBrain(serviceType).getWelcomeMessage(welcomeSource, 'en'),
    body.welcome_ar || defaults.welcome_ar || getBrain(serviceType).getWelcomeMessage(welcomeSource, 'ar'),
    JSON.stringify(parseList(body.suggestions_en)),
    JSON.stringify(parseList(body.suggestions_ar)),
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

module.exports = router;
