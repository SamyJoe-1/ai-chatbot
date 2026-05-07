'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { detectLanguage, normalizeArabicDigits } = require('../../engine/detector');
const { detectIntent } = require('../../engine/intent');
const { buildResponse } = require('../../engine/responder');
const { validatePhone } = require('../../engine/phoneValidator');
const { RESPONSES } = require('../../engine/patterns');
const { isSessionExpired, resetSessionState } = require('../../engine/sessionLifecycle');

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
  const clean = normalizeArabicDigits(String(text || '').trim()).replace(/\s+/g, ' ');
  if (!clean || /\d/.test(clean)) return false;

  const latinOrArabicName = /^(?=.{2,40}$)[A-Za-z\u0600-\u06FF]+(?:[ '\-][A-Za-z\u0600-\u06FF]+){0,3}$/u;
  if (!latinOrArabicName.test(clean)) return false;

  const parts = clean.split(/[ '\-]+/).filter(Boolean);
  const letterCount = (clean.match(/[A-Za-z\u0600-\u06FF]/gu) || []).length;
  if (letterCount < 2 || parts.some((part) => part.length < 2 || part.length > 20)) return false;

  const latinJoined = parts.join('').toLowerCase();
  if (/^[a-z]+$/i.test(latinJoined)) {
    if (!/[aeiou]/.test(latinJoined)) return false;
    if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(latinJoined)) return false;
    if (/(.+)\1{2,}/i.test(latinJoined)) return false;
    for (let size = 2; size <= 4; size += 1) {
      if (latinJoined.length >= size * 3) {
        const chunk = latinJoined.slice(0, size);
        if (chunk.repeat(Math.floor(latinJoined.length / size)).startsWith(latinJoined.slice(0, size * 3))) {
          const repeatedPrefix = chunk.repeat(Math.ceil(latinJoined.length / size)).slice(0, latinJoined.length);
          if (repeatedPrefix === latinJoined) return false;
        }
      }
    }
  }

  return true;
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

    if (isSessionExpired(session.last_active)) {
      const freshMessages = resetSessionState(db, session.id, lang, cafe);
      return res.json({
        reset: true,
        history: freshMessages,
        response: { text: RESPONSES.collect_name[lang](), type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: 'collect_name',
      });
    }

    const context = parseContext(session.context);

    insertMessage.run(session.id, 'user', text, null);

    if (session.phase === 'collect_name') {
      if (!looksLikeName(text)) {
        const reply = RESPONSES.invalid_name[lang]();
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
