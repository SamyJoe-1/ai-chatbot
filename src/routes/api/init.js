'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db/db');
const { detectLanguage } = require('../../engine/detector');
const { isSessionExpired, resetSessionState } = require('../../engine/sessionLifecycle');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { RESPONSES } = require('../../engine/patterns');

const router = express.Router();

const getSession = db.prepare('SELECT * FROM sessions WHERE session_key = ? AND cafe_id = ?');
const createSession = db.prepare(`
  INSERT INTO sessions (session_key, cafe_id, language, ip, phase, context)
  VALUES (?, ?, ?, ?, 'collect_name', '{}')
`);
const touchSession = db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?");
const insertMessage = db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)');
const getMessages = db.prepare(`
  SELECT role, content, intent, created_at
  FROM messages
  WHERE session_id = ?
  ORDER BY id ASC
`);

function detectHeaderLanguage(req) {
  const header = String(req.headers['accept-language'] || '').toLowerCase();
  return header.includes('ar') ? 'ar' : 'en';
}

function parseSuggestions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.post('/', tokenValidator, (req, res) => {
  try {
    const { session_key: sessionKey, force_new: forceNew } = req.body || {};
    const cafe = req.cafe;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();

    let session = null;
    let isNew = false;

    if (sessionKey && !forceNew) {
      session = getSession.get(sessionKey, cafe.id);
    }

    if (!session) {
      const newKey = uuidv4();
      const language = detectHeaderLanguage(req);
      createSession.run(newKey, cafe.id, language, ip);
      session = getSession.get(newKey, cafe.id);
      isNew = true;

      insertMessage.run(session.id, 'bot', RESPONSES.welcome[language](cafe), 'welcome');
      insertMessage.run(session.id, 'bot', RESPONSES.collect_name[language](), 'collect_name');
    } else {
      if (isSessionExpired(session.last_active)) {
        const language = session.guest_name ? detectLanguage(session.guest_name) : detectHeaderLanguage(req);
        resetSessionState(db, session.id, language, cafe);
        session = getSession.get(session.session_key, cafe.id);
      } else {
        touchSession.run(session.id);
        session = getSession.get(session.session_key, cafe.id);
      }
    }

    const language = session.language === 'ar' ? 'ar' : 'en';
    const history = getMessages.all(session.id);
    const suggestions = session.phase === 'active' ? parseSuggestions(cafe[`suggestions_${language}`]) : [];

    return res.json({
      session_key: session.session_key,
      is_new: isNew,
      automated: Number(session.automated) !== 0,
      phase: session.phase,
      guest_name: session.guest_name,
      guest_phone: session.guest_phone,
      language,
      cafe: {
        id: cafe.id,
        name: cafe.name,
        name_ar: cafe.name_ar,
        logo_url: cafe.logo_url,
        primary_color: cafe.primary_color,
        secondary_color: cafe.secondary_color,
        phone: cafe.phone,
        suggestions_en: parseSuggestions(cafe.suggestions_en),
        suggestions_ar: parseSuggestions(cafe.suggestions_ar),
      },
      history,
      suggestions: Number(session.automated) !== 0 ? suggestions : [],
    });
  } catch (error) {
    console.error('[init]', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
