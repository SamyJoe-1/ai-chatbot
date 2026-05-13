'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { detectLanguage, normalizeArabicDigits } = require('../../engine/detector');
const { validatePhone } = require('../../engine/phoneValidator');
const { recoverUserQuery } = require('../../engine/queryRecovery');
const { isSessionExpired, resetSessionState } = require('../../engine/sessionLifecycle');
const { COMMON_RESPONSES } = require('../../brains/shared/commonResponses');
const { getBrain } = require('../../brains');
const { recoverFranco } = require('../../engine/franco');

const router = express.Router();

const getSession = db.prepare('SELECT * FROM sessions WHERE session_key = ? AND business_id = ?');
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

function parseSuggestions(business, lang) {
  try {
    const parsed = JSON.parse(business[`suggestions_${lang}`] || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 4) : [];
  } catch {
    return [];
  }
}

function normalizeSuggestions(value) {
  return Array.isArray(value) ? value.slice(0, 4).filter(Boolean) : [];
}

function shouldRetryWithRecovery(intent) {
  return intent === 'unknown' || intent === 'item_not_found';
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
  }

  return true;
}

router.post('/', tokenValidator, (req, res) => {
  const business = req.business;
  const brain = getBrain(business.service_type);

  try {
    const { session_key: sessionKey, message } = req.body || {};
    if (!sessionKey || !String(message || '').trim()) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const session = getSession.get(sessionKey, business.id);
    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
    }

    const text = String(message).trim();
    const lang = detectLanguage(text);

    if (isSessionExpired(session.last_active)) {
      const freshMessages = resetSessionState(db, session.id, lang, business);
      return res.json({
        reset: true,
        history: freshMessages,
        response: { text: COMMON_RESPONSES.collect_name[lang](), type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: 'collect_name',
      });
    }

    const context = parseContext(session.context);
    insertMessage.run(session.id, 'user', text, null);

    if (Number(session.automated) === 0) {
      db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(session.id);
      return res.json({
        automated: false,
        response: null,
        language: lang,
        phase: session.phase,
        suggestions: [],
      });
    }

    if (session.phase === 'collect_name') {
      if (!looksLikeName(text)) {
        const reply = COMMON_RESPONSES.invalid_name[lang]();
        insertMessage.run(session.id, 'bot', reply, 'collect_name_retry');
        return res.json({
          automated: true,
          response: { text: reply, type: 'text', buttons: [], suggestions: [] },
          language: lang,
          phase: session.phase,
        });
      }

      const name = text.slice(0, 60);
      const reply = COMMON_RESPONSES.collect_phone[lang]();
      updateSession.run('collect_phone', lang, name, session.guest_phone, JSON.stringify(context), session.id);
      insertMessage.run(session.id, 'bot', reply, 'collect_phone');

      return res.json({
        automated: true,
        response: { text: reply, type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: 'collect_phone',
      });
    }

    if (session.phase === 'collect_phone') {
      const phoneResult = validatePhone(text);
      if (!phoneResult.valid) {
        const reply = COMMON_RESPONSES.invalid_phone[lang]();
        insertMessage.run(session.id, 'bot', reply, 'invalid_phone');
        return res.json({
          automated: true,
          response: { text: reply, type: 'text', buttons: [], suggestions: [] },
          language: lang,
          phase: 'collect_phone',
        });
      }

      const reply = COMMON_RESPONSES.active_ready[lang](session.guest_name || (lang === 'ar' ? 'صديقي' : 'there'));
      const nextContext = {
        ...context,
        last_suggestions: parseSuggestions(business, lang),
      };
      updateSession.run('active', lang, session.guest_name, phoneResult.normalized, JSON.stringify(nextContext), session.id);
      insertMessage.run(session.id, 'bot', reply, 'active_ready');

      return res.json({
        automated: true,
        response: { text: reply, type: 'text', buttons: [], suggestions: parseSuggestions(business, lang) },
        language: lang,
        phase: 'active',
      });
    }

    let resolvedText = text;
    let intentResult = brain.detectIntent({ text: resolvedText, lang, business, context });

    if (shouldRetryWithRecovery(intentResult.intent)) {
      const { getBusinessItems } = require('../../brains/shared/catalogStore');
      const items = getBusinessItems(business.id);

      // 1. Try explicit Arabic-to-English literal translation first
      const { translateArabicToEnglish } = require('../../engine/translation');
      let translationMatched = false;
      if (lang === 'ar') {
        const translatedDictText = translateArabicToEnglish(text);
        if (translatedDictText !== text) {
          const dictIntent = brain.detectIntent({ text: translatedDictText, lang: 'en', business, context });
          if (!shouldRetryWithRecovery(dictIntent.intent)) {
            resolvedText = translatedDictText;
            intentResult = dictIntent;
            translationMatched = true;
          }
        }
      }

      // 2. Try algorithmic Franco-Arabic phonetic recovery first
      if (!translationMatched && shouldRetryWithRecovery(intentResult.intent)) {
        const translatedText = recoverFranco(text, items);
        if (translatedText && translatedText !== text) {
          const francoIntent = brain.detectIntent({ text: translatedText, lang: 'en', business, context });
          if (!shouldRetryWithRecovery(francoIntent.intent)) {
            resolvedText = translatedText;
            intentResult = francoIntent;
          }
        }
      }

      // 3. If mapping didn't solve it, try the standard query recovery
      if (shouldRetryWithRecovery(intentResult.intent)) {
        const recoveredText = recoverUserQuery(text, lang, business.id);
        if (recoveredText && recoveredText.trim() && recoveredText.trim() !== text) {
          const recoveredIntent = brain.detectIntent({ text: recoveredText, lang, business, context });
          if (!shouldRetryWithRecovery(recoveredIntent.intent)) {
            resolvedText = recoveredText;
            intentResult = recoveredIntent;
          }
        }
      }
    }

    const payload = brain.buildResponse(intentResult, lang, business);
    const nextContext = {
      ...context,
      ...payload.context_update,
      last_suggestions: normalizeSuggestions(payload.suggestions),
    };
    if (resolvedText !== text) {
      nextContext.last_recovered_query = resolvedText;
    }

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
      automated: true,
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
        text: COMMON_RESPONSES.error[lang](business),
        type: 'text',
        buttons: [],
        suggestions: [],
      },
    });
  }
});

module.exports = router;
