'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { detectLanguage, normalizeArabicDigits } = require('../../engine/detector');
const { detectIntent } = require('../../engine/intent');
const { buildResponse } = require('../../engine/responder');
const { validatePhone } = require('../../engine/phoneValidator');
const { RESPONSES } = require('../../engine/patterns');

const router = express.Router();

const getSession = db.prepare('SELECT * FROM sessions WHERE session_key = ? AND cafe_id = ?');
const updateSession = db.prepare(`
  UPDATE sessions
  SET phase = ?, language = ?, guest_name = ?, guest_phone = ?, context = ?, last_active = datetime('now')
  WHERE id = ?
`);
const insertMessage = db.prepare('INSERT INTO messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)');

function parseContext(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function parseSuggestions(cafe, lang) {
  try {
    const parsed = JSON.parse(cafe[`suggestions_${lang}`] || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 4) : [];
  } catch {
    return [];
  }
}

function looksLikeName(text) {
  const clean = normalizeArabicDigits(String(text || '').trim());
  if (!clean) return false;
  if (clean.replace(/\D/g, '').length >= 7) return false;
  return clean.length >= 2;
}

router.post('/', tokenValidator, (req, res) => {
  const cafe = req.cafe;

  try {
    const { session_key: sessionKey, message } = req.body || {};
    if (!sessionKey || !String(message || '').trim()) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const session = getSession.get(sessionKey, cafe.id);
    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
    }

    const text = String(message).trim();
    const lang = detectLanguage(text);
    const context = parseContext(session.context);

    insertMessage.run(session.id, 'user', text, null);

    if (session.phase === 'collect_name') {
      if (!looksLikeName(text)) {
        const reply = RESPONSES.ask_name_again[lang]();
        insertMessage.run(session.id, 'bot', reply, 'collect_name_retry');
        return res.json({
          response: { text: reply, type: 'text', buttons: [], suggestions: [] },
          language: lang,
          phase: session.phase,
        });
      }

      const name = text.slice(0, 60);
      const reply = RESPONSES.collect_phone[lang](name);
      updateSession.run('collect_phone', lang, name, session.guest_phone, JSON.stringify(context), session.id);
      insertMessage.run(session.id, 'bot', reply, 'collect_phone');

      return res.json({
        response: { text: reply, type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: 'collect_phone',
      });
    }

    if (session.phase === 'collect_phone') {
      const phoneResult = validatePhone(text);
      if (!phoneResult.valid) {
        const reply = RESPONSES.invalid_phone[lang]();
        insertMessage.run(session.id, 'bot', reply, 'invalid_phone');
        return res.json({
          response: { text: reply, type: 'text', buttons: [], suggestions: [] },
          language: lang,
          phase: 'collect_phone',
        });
      }

      const reply = RESPONSES.active_ready[lang](session.guest_name || (lang === 'ar' ? 'صديقي' : 'there'));
      updateSession.run('active', lang, session.guest_name, phoneResult.normalized, JSON.stringify(context), session.id);
      insertMessage.run(session.id, 'bot', reply, 'active_ready');

      return res.json({
        response: { text: reply, type: 'text', buttons: [], suggestions: parseSuggestions(cafe, lang) },
        language: lang,
        phase: 'active',
      });
    }

    const intentResult = detectIntent(text, lang, cafe.id, context);
    const payload = buildResponse(intentResult, lang, cafe);
    const nextContext = { ...context, ...payload.context_update };

    updateSession.run(
      session.phase,
      lang,
      session.guest_name,
      session.guest_phone,
      JSON.stringify(nextContext),
      session.id
    );
    insertMessage.run(session.id, 'bot', payload.text, intentResult.intent);

    return res.json({
      response: {
        text: payload.text,
        type: payload.type,
        buttons: payload.buttons,
        suggestions: payload.suggestions,
      },
      language: lang,
      phase: session.phase,
      intent: intentResult.intent,
    });
  } catch (error) {
    console.error('[message]', error);
    const lang = detectLanguage(req.body?.message || '');
    return res.status(500).json({
      response: {
        text: RESPONSES.error[lang](cafe),
        type: 'text',
        buttons: [],
        suggestions: [],
      },
    });
  }
});

module.exports = router;
