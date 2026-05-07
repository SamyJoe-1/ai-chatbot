'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const db = require('../../db/db');
const { authMiddleware, adminOnly } = require('../../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const allCafes = db.prepare('SELECT * FROM cafes ORDER BY created_at DESC');
const getCafe = db.prepare('SELECT * FROM cafes WHERE id = ?');
const createCafe = db.prepare(`
  INSERT INTO cafes (
    token, name, name_ar, primary_color, secondary_color, logo_url,
    about_en, about_ar, phone, email, address_en, address_ar,
    working_hours_en, working_hours_ar, menu_link, drive_folder_id, sheet_id,
    welcome_en, welcome_ar, suggestions_en, suggestions_ar, active
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateCafe = db.prepare(`
  UPDATE cafes SET
    name = ?, name_ar = ?, primary_color = ?, secondary_color = ?, logo_url = ?,
    about_en = ?, about_ar = ?, phone = ?, email = ?, address_en = ?, address_ar = ?,
    working_hours_en = ?, working_hours_ar = ?, menu_link = ?, drive_folder_id = ?, sheet_id = ?,
    welcome_en = ?, welcome_ar = ?, suggestions_en = ?, suggestions_ar = ?, active = ?
  WHERE id = ?
`);
const deleteCafe = db.prepare('DELETE FROM cafes WHERE id = ?');

const listUsers = db.prepare('SELECT id, username, role, cafe_id, created_at FROM admins ORDER BY created_at DESC');
const createUser = db.prepare('INSERT INTO admins (username, password, role, cafe_id) VALUES (?, ?, ?, ?)');
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

function serializeCafe(cafe) {
  return {
    ...cafe,
    suggestions_en: parseList(cafe.suggestions_en),
    suggestions_ar: parseList(cafe.suggestions_ar),
  };
}

function ensureAccess(admin, cafeId) {
  return admin.role === 'admin' || Number(admin.cafe_id) === Number(cafeId);
}

router.get('/', (req, res) => {
  if (req.admin.role === 'admin') {
    return res.json(allCafes.all().map(serializeCafe));
  }

  if (!req.admin.cafe_id) {
    return res.json([]);
  }

  const cafe = getCafe.get(req.admin.cafe_id);
  return res.json(cafe ? [serializeCafe(cafe)] : []);
});

router.get('/users/all', adminOnly, (_req, res) => {
  return res.json(listUsers.all());
});

router.post('/users', adminOnly, async (req, res) => {
  const { username, password, cafe_id: cafeId } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = createUser.run(username, hash, 'user', cafeId || null);
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
  const cafeId = Number(req.params.id);
  if (!ensureAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const sessions = db.prepare(`
    SELECT s.*, COUNT(m.id) AS message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.cafe_id = ?
    GROUP BY s.id
    ORDER BY s.last_active DESC
    LIMIT 200
  `).all(cafeId);

  return res.json(sessions);
});

router.get('/:id/sessions/:sessionId/messages', (req, res) => {
  const cafeId = Number(req.params.id);
  if (!ensureAccess(req.admin, cafeId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND cafe_id = ?').get(req.params.sessionId, cafeId);
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
      phase: session.phase,
      last_active: session.last_active,
    },
    messages,
  });
});

router.get('/:id', (req, res) => {
  const cafe = getCafe.get(req.params.id);
  if (!cafe) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!ensureAccess(req.admin, cafe.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  return res.json(serializeCafe(cafe));
});

router.post('/', adminOnly, (req, res) => {
  const body = req.body || {};
  const token = uuidv4().replace(/-/g, '');

  const result = createCafe.run(
    token,
    body.name || 'New Cafe',
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
    body.menu_link || '',
    body.drive_folder_id || '',
    body.sheet_id || '',
    body.welcome_en || 'Welcome! How can I help you today?',
    body.welcome_ar || 'أهلاً! كيف يمكنني مساعدتك اليوم؟',
    JSON.stringify(parseList(body.suggestions_en)),
    JSON.stringify(parseList(body.suggestions_ar)),
    body.active === 0 ? 0 : 1
  );

  return res.status(201).json({ id: result.lastInsertRowid, token });
});

router.put('/:id', (req, res) => {
  const cafe = getCafe.get(req.params.id);
  if (!cafe) {
    return res.status(404).json({ error: 'not_found' });
  }

  if (!ensureAccess(req.admin, cafe.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  updateCafe.run(
    body.name ?? cafe.name,
    body.name_ar ?? cafe.name_ar,
    body.primary_color ?? cafe.primary_color,
    body.secondary_color ?? cafe.secondary_color,
    body.logo_url ?? cafe.logo_url,
    body.about_en ?? cafe.about_en,
    body.about_ar ?? cafe.about_ar,
    body.phone ?? cafe.phone,
    body.email ?? cafe.email,
    body.address_en ?? cafe.address_en,
    body.address_ar ?? cafe.address_ar,
    body.working_hours_en ?? cafe.working_hours_en,
    body.working_hours_ar ?? cafe.working_hours_ar,
    body.menu_link ?? cafe.menu_link,
    body.drive_folder_id ?? cafe.drive_folder_id,
    body.sheet_id ?? cafe.sheet_id,
    body.welcome_en ?? cafe.welcome_en,
    body.welcome_ar ?? cafe.welcome_ar,
    JSON.stringify(body.suggestions_en !== undefined ? parseList(body.suggestions_en) : parseList(cafe.suggestions_en)),
    JSON.stringify(body.suggestions_ar !== undefined ? parseList(body.suggestions_ar) : parseList(cafe.suggestions_ar)),
    body.active !== undefined ? Number(body.active) : cafe.active,
    cafe.id
  );

  return res.json({ success: true });
});

router.delete('/:id', adminOnly, (req, res) => {
  deleteCafe.run(req.params.id);
  return res.json({ success: true });
});

/* ── Toggle cafe active/inactive ───────────────────── */
router.patch('/:id/toggle', (req, res) => {
  const cafe = getCafe.get(req.params.id);
  if (!cafe) return res.status(404).json({ error: 'not_found' });
  if (!ensureAccess(req.admin, cafe.id)) return res.status(403).json({ error: 'forbidden' });
  const newActive = cafe.active ? 0 : 1;
  db.prepare('UPDATE cafes SET active = ? WHERE id = ?').run(newActive, cafe.id);
  return res.json({ success: true, active: newActive });
});

/* ── Regenerate cafe token ─────────────────────────── */
router.post('/:id/regenerate-token', adminOnly, (req, res) => {
  const cafe = getCafe.get(req.params.id);
  if (!cafe) return res.status(404).json({ error: 'not_found' });
  const newToken = uuidv4().replace(/-/g, '');
  db.prepare('UPDATE cafes SET token = ? WHERE id = ?').run(newToken, cafe.id);
  return res.json({ success: true, token: newToken });
});

/* ── Delete a single session ───────────────────────── */
router.delete('/:id/sessions/:sessionId', (req, res) => {
  const cafeId = Number(req.params.id);
  if (!ensureAccess(req.admin, cafeId)) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM messages WHERE session_id = (SELECT id FROM sessions WHERE id = ? AND cafe_id = ?)').run(req.params.sessionId, cafeId);
  db.prepare('DELETE FROM sessions WHERE id = ? AND cafe_id = ?').run(req.params.sessionId, cafeId);
  return res.json({ success: true });
});

/* ── Clear all sessions for a cafe ─────────────────── */
router.delete('/:id/sessions', (req, res) => {
  const cafeId = Number(req.params.id);
  if (!ensureAccess(req.admin, cafeId)) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE cafe_id = ?)').run(cafeId);
  db.prepare('DELETE FROM sessions WHERE cafe_id = ?').run(cafeId);
  return res.json({ success: true });
});

/* ── Send manual admin message into a session ──────── */
router.post('/:id/sessions/:sessionId/messages', (req, res) => {
  const cafeId = Number(req.params.id);
  if (!ensureAccess(req.admin, cafeId)) return res.status(403).json({ error: 'forbidden' });
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND cafe_id = ?').get(req.params.sessionId, cafeId);
  if (!session) return res.status(404).json({ error: 'not_found' });
  const { content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'empty_message' });
  db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)').run(session.id, 'bot', String(content).trim(), 'admin_manual');
  db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(session.id);
  return res.json({ success: true });
});

module.exports = router;
