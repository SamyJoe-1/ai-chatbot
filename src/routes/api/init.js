'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db/db');
const { detectLanguage } = require('../../engine/detector');
const { isSessionExpired, resetSessionState } = require('../../engine/sessionLifecycle');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { COMMON_RESPONSES } = require('../../brains/shared/commonResponses');
const { getBrain } = require('../../brains');

const router = express.Router();

const getSession = db.prepare('SELECT * FROM sessions WHERE session_key = ? AND business_id = ?');
const createSession = db.prepare(`
  INSERT INTO sessions (session_key, business_id, language, ip, phase, context)
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

function parseContext(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

router.post('/', tokenValidator, (req, res) => {
  try {
    const { session_key: sessionKey, force_new: forceNew } = req.body || {};
    const business = req.business;
    const brain = getBrain(business.service_type);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();

    let session = null;
    let isNew = false;

    if (sessionKey && !forceNew) {
      session = getSession.get(sessionKey, business.id);
    }

    if (!session) {
      const newKey = uuidv4();
      const language = detectHeaderLanguage(req);
      createSession.run(newKey, business.id, language, ip);
      session = getSession.get(newKey, business.id);
      isNew = true;

      insertMessage.run(session.id, 'bot', brain.getWelcomeMessage(business, language), 'welcome');
      insertMessage.run(session.id, 'bot', COMMON_RESPONSES.collect_name[language](), 'collect_name');
    } else if (isSessionExpired(session.last_active)) {
      const language = session.guest_name ? detectLanguage(session.guest_name) : detectHeaderLanguage(req);
      resetSessionState(db, session.id, language, business);
      session = getSession.get(session.session_key, business.id);
    } else {
      touchSession.run(session.id);
      session = getSession.get(session.session_key, business.id);
    }

    const language = session.language === 'ar' ? 'ar' : 'en';
    const history = getMessages.all(session.id);
    const context = parseContext(session.context);
    const suggestions = session.phase === 'active'
      ? (parseSuggestions(context.last_suggestions).length
        ? parseSuggestions(context.last_suggestions)
        : parseSuggestions(business[`suggestions_${language}`]))
      : [];

    const payloadBusiness = {
      id: business.id,
      name: business.name,
      name_ar: business.name_ar,
      service_type: business.service_type,
      logo_url: business.logo_url,
      primary_color: business.primary_color,
      secondary_color: business.secondary_color,
      phone: business.phone,
      catalog_link: business.catalog_link,
      suggestions_en: parseSuggestions(business.suggestions_en),
      suggestions_ar: parseSuggestions(business.suggestions_ar),
    };

    return res.json({
      session_key: session.session_key,
      is_new: isNew,
      automated: Number(session.automated) !== 0,
      phase: session.phase,
      guest_name: session.guest_name,
      guest_phone: session.guest_phone,
      language,
      business: payloadBusiness,
      cafe: payloadBusiness,
      history,
      suggestions: Number(session.automated) !== 0 ? suggestions : [],
    });
  } catch (error) {
    console.error('[init]', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
