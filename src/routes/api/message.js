'use strict';

const express = require('express');

const db = require('../../db/db');
const { tokenValidator } = require('../../middleware/tokenValidator');
const { detectLanguage, normalizeArabicDigits } = require('../../engine/detector');
const { validatePhone } = require('../../engine/phoneValidator');
const { recoverUserQuery } = require('../../engine/queryRecovery');
const { isSessionExpired, resetSessionState } = require('../../engine/sessionLifecycle');
const {
  isOrderingEnabled,
  isInternalOrderCommand,
  looksLikeOrderIntent,
  getExistingPhoneStatus,
  startOrderFlow,
  handleOrderMessage,
  matchItemsForOrder,
  resolveOrderUiState,
} = require('../../engine/orderFlow');
const { COMMON_RESPONSES } = require('../../brains/shared/commonResponses');
const { getBrain } = require('../../brains');
const { recoverFranco } = require('../../engine/franco');
const {
  assessAiRoutingNeed,
  callAiClassifier,
  callAiAnswer,
  recordAiCall,
  isAiEnabledForBusiness,
  parseAiPipeline,
} = require('../../engine/aiRouting');
const {
  buildNotFoundPayload,
  prefixAiFallbackPayload,
  resolveAiPipeline,
} = require('../../engine/aiPipelines');
const { canUseAi, recordAiUse } = require('../../engine/aiRateLimiter');
const { matchFaq } = require('../../engine/faqMatcher');

const router = express.Router();

const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH || 1000);

const getSession = db.prepare('SELECT * FROM sessions WHERE session_key = ? AND business_id = ?');
const updateSession = db.prepare(`
  UPDATE sessions
  SET phase = ?, language = ?, guest_name = ?, guest_phone = ?, context = ?, last_active = datetime('now')
  WHERE id = ?
`);
const insertMessageStmt = db.prepare('INSERT INTO messages (session_id, role, content, intent, thumbnail, ai_score) VALUES (?, ?, ?, ?, ?, ?)');
const insertMessage = {
  run(sessionId, role, content, intent, thumbnail = null, aiScore = null) {
    return insertMessageStmt.run(sessionId, role, content, intent, thumbnail, aiScore);
  }
};

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

function emptyUiState() {
  return {
    input_locked: false,
    choice_buttons: [],
    address_preview: '',
    order_draft: null,
  };
}

function mergeRecentItemIds(context, ids) {
  const nextIds = Array.isArray(context.recent_item_ids) ? context.recent_item_ids.slice() : [];
  ids.forEach((id) => {
    if (!Number.isFinite(id)) return;
    const existingIndex = nextIds.indexOf(id);
    if (existingIndex >= 0) {
      nextIds.splice(existingIndex, 1);
    }
    nextIds.push(id);
  });
  return nextIds.slice(-10);
}

function collectTrackedItemIds(intentResult) {
  if (!intentResult || typeof intentResult !== 'object') return [];
  if (intentResult.item?.id) return [intentResult.item.id];
  if (Array.isArray(intentResult.items)) {
    return intentResult.items.map((item) => item?.id).filter(Number.isFinite).slice(0, 10);
  }
  return [];
}

function shouldRetryWithRecovery(intent) {
  return intent === 'unknown' || intent === 'item_not_found';
}

function hasUsablePayload(payload) {
  return Boolean(payload && payload.text && !['unknown', 'item_not_found', 'need_item_context', 'ai_not_found'].includes(payload.intent));
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

router.post('/', tokenValidator, async (req, res) => {
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
    const dashboardActive = req.body.order_dashboard_active !== false;
    let lang = detectLanguage(text);
    if (session.phase === 'collect_phone' && session.language) {
      lang = session.language === 'ar' ? 'ar' : 'en';
    }

    // Per-IP + per-device identifiers for AI rate limiting.
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();
    const deviceId = String(req.body?.device_id || sessionKey || '').trim();

    // Message length guard (skip internal order commands, which carry JSON carts).
    if (!isInternalOrderCommand(text) && text.length > MAX_MESSAGE_LENGTH) {
      const tooLong = lang === 'ar'
        ? `الرسالة طويلة جدًا. من فضلك اختصرها إلى ${MAX_MESSAGE_LENGTH} حرف أو أقل.`
        : `That message is a bit too long. Please keep it under ${MAX_MESSAGE_LENGTH} characters.`;
      return res.json({
        automated: true,
        response: { text: tooLong, type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: session.phase,
      });
    }

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
    const aiAssessment = assessAiRoutingNeed({ text, lang, business });
    const internalOrderCommand = isInternalOrderCommand(text);
    if (!internalOrderCommand) {
      insertMessage.run(session.id, 'user', text, null, null, aiAssessment.score);
    }

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

    let aiUnavailable = false;
    async function tryAiPipeline(reason) {
      if (aiUnavailable || !isAiEnabledForBusiness(business)) return { handled: false };

      const gate = canUseAi({ businessId: business.id, ip: clientIp, deviceId });
      if (!gate.allowed) {
        console.warn('[ai-routing] rate limited, answering from rules', { reason, limit: gate.reason });
        return { handled: false, rateLimited: true };
      }
      recordAiUse({ businessId: business.id, ip: clientIp, deviceId });

      const aiResult = await callAiClassifier({ text, business, session });
      if (!aiResult.ok) {
        aiUnavailable = true;
        console.warn('[ai-routing] classifier failed', { reason, error: aiResult.error, elapsed_ms: aiResult.elapsed_ms });
        return { handled: false };
      }
      recordAiCall({ businessId: business.id, sessionId: session.id, message: text, mode: 'classify', result: aiResult });

      const pipeline = parseAiPipeline(aiResult.raw);
      if (!pipeline.valid) {
        return { handled: false, invalid: true, raw: aiResult.raw };
      }
      if (pipeline.code === 6) {
        return { handled: false, forceOrder: true, raw: aiResult.raw };
      }

      if (pipeline.code === 10) {
        const faqHit = matchFaq({ text, lang, business });
        if (!faqHit) return { handled: false, raw: aiResult.raw };
        const faqSuggestions = parseSuggestions(business, lang);
        return {
          handled: true,
          intent: 'faq',
          payload: {
            text: faqHit.answer,
            type: 'text',
            buttons: [],
            suggestions: faqSuggestions,
            context_update: {},
          },
          raw: aiResult.raw,
        };
      }

      // Greetings stay templated; everything content-related (search, category,
      // filter, exclude, details, not-found) goes to answer mode so the AI reads
      // the menu and replies with what the customer actually asked for — handling
      // typos, meaning, and include-vs-exclude that the keyword pipeline gets wrong.
      if (pipeline.code !== 1) {
        // Narrow the menu we send to answer mode whenever the classifier gave us
        // an item/category term — huge token saving. Skip exclude([5])/not-found([9])
        // where the term isn't a thing to keep. Falls back to lean catalog if the
        // hint matches nothing.
        const f = pipeline.fields || {};
        let categoryHint = '';
        if (pipeline.code === 4) categoryHint = f.category || f.item || '';
        else if (pipeline.code === 2 || pipeline.code === 3 || pipeline.code === 7) categoryHint = pipeline.item || '';
        else if (pipeline.code === 8) categoryHint = pipeline.itemForDetail || '';
        const answer = await callAiAnswer({ text, business, session, lang, categoryHint });
        if (answer.ok) {
          recordAiCall({ businessId: business.id, sessionId: session.id, message: text, mode: 'answer', result: answer });
        }
        if (answer.ok && answer.text) {
          return {
            handled: true,
            intent: 'ai_answer',
            payload: { text: answer.text, type: 'text', buttons: [], suggestions: [], context_update: {} },
            raw: aiResult.raw,
          };
        }
        console.warn('[ai-routing] answer mode failed, falling back to keyword pipeline', { error: answer.error });
      }

      const resolved = resolveAiPipeline({ pipeline, brain, business, lang, context });
      if (!resolved || !resolved.payload) {
        return { handled: false, invalid: true, raw: aiResult.raw };
      }

      return {
        handled: true,
        intent: resolved.intent,
        payload: resolved.payload,
        raw: aiResult.raw,
      };
    }

    function sendPayloadResult({ payload, intent, nextContext, phase = session.phase }) {
      updateSession.run(
        phase,
        lang,
        session.guest_name,
        session.guest_phone,
        JSON.stringify(nextContext),
        session.id
      );

      if (Array.isArray(payload.messages) && payload.messages.length > 0) {
        payload.messages.forEach((msg) => {
          insertMessage.run(session.id, 'bot', msg.text, intent, msg.thumbnail || null);
        });
      } else {
        insertMessage.run(session.id, 'bot', payload.text, intent, payload.thumbnail || null);
      }

      const orderState = resolveOrderUiState({ business, session: { ...session, phase }, context: nextContext, lang });
      const orderSuggestions = orderState.suggestions || [];
      let finalUiState = orderState.ui_state;
      if (!dashboardActive) {
        finalUiState = {
          input_locked: false,
          choice_buttons: [],
          address_preview: '',
          order_draft: orderState.ui_state?.order_draft || null,
        };
      }

      return res.json({
        automated: true,
        response: {
          text: payload.text,
          type: payload.type,
          buttons: payload.buttons,
          suggestions: payload.suggestions,
          ui_state: finalUiState,
          order_suggestions: orderSuggestions,
          thumbnail: payload.thumbnail,
          messages: payload.messages || null,
        },
        language: lang,
        phase,
        intent,
        order_suggestions: orderSuggestions,
      });
    }

    function startOrderResponse(seedItems) {
      const orderStartResult = startOrderFlow({
        business,
        session,
        context,
        lang,
        seedItems,
      });

      updateSession.run(
        orderStartResult.phase,
        lang,
        session.guest_name,
        session.guest_phone,
        JSON.stringify(orderStartResult.context),
        session.id
      );

      if (orderStartResult.response.text) {
        insertMessage.run(session.id, 'bot', orderStartResult.response.text, orderStartResult.intent);
      }

      const lastSuggestions = orderStartResult.context.last_suggestions;
      const chitchatSuggestions = Array.isArray(lastSuggestions) && lastSuggestions.length
        ? lastSuggestions
        : parseSuggestions(business, lang);

      const orderSuggestions = orderStartResult.response.suggestions || [];
      const finalResponse = {
        ...orderStartResult.response,
        suggestions: chitchatSuggestions,
        order_suggestions: orderSuggestions,
      };

      return res.json({
        automated: true,
        response: finalResponse,
        language: lang,
        phase: orderStartResult.phase,
        intent: orderStartResult.intent,
        order_suggestions: orderSuggestions,
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

    let forceOrderFromAi = false;
    let aiInvalidClassification = false;
    if (session.phase === 'active' && aiAssessment.route === 'ai') {
      const aiPipeline = await tryAiPipeline('threshold');
      if (aiPipeline.forceOrder) {
        forceOrderFromAi = true;
      } else if (aiPipeline.invalid) {
        aiInvalidClassification = true;
      } else if (aiPipeline.handled) {
        const nextContext = {
          ...context,
          ...aiPipeline.payload.context_update,
          last_suggestions: normalizeSuggestions(aiPipeline.payload.suggestions),
        };
        return sendPayloadResult({
          payload: aiPipeline.payload,
          intent: aiPipeline.intent,
          nextContext,
        });
      }
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

      const displayName = session.guest_name || (lang === 'ar' ? 'صديقي' : 'there');
      const isReturningGuest = getExistingPhoneStatus(business.id, phoneResult.normalized, session.id);
      const reply = isReturningGuest
        ? COMMON_RESPONSES.active_ready_again[lang](displayName)
        : COMMON_RESPONSES.active_ready[lang](displayName);
      const nextContext = {
        ...context,
        last_suggestions: parseSuggestions(business, lang),
      };
      updateSession.run('active', lang, session.guest_name, phoneResult.normalized, JSON.stringify(nextContext), session.id);
      insertMessage.run(session.id, 'bot', reply, 'active_ready');

      return res.json({
        automated: true,
        response: {
          text: reply,
          type: 'text',
          buttons: [],
          suggestions: parseSuggestions(business, lang),
          ui_state: emptyUiState(),
        },
        language: lang,
        phase: 'active',
      });
    }

    const isOrderCmd = isInternalOrderCommand(text);
    if (isOrderingEnabled(business) && String(session.phase || '').startsWith('order_') && (dashboardActive || isOrderCmd)) {
      const orderFlowResult = handleOrderMessage({ text, business, session, context, lang });
      if (orderFlowResult) {
        updateSession.run(
          orderFlowResult.phase,
          lang,
          session.guest_name,
          session.guest_phone,
          JSON.stringify(orderFlowResult.context),
          session.id
        );

        if (!orderFlowResult.skipBotMessage && orderFlowResult.response.text) {
          insertMessage.run(session.id, 'bot', orderFlowResult.response.text, orderFlowResult.intent);
        }

        const lastSuggestions = orderFlowResult.context.last_suggestions;
        const chitchatSuggestions = Array.isArray(lastSuggestions) && lastSuggestions.length
          ? lastSuggestions
          : parseSuggestions(business, lang);

        const orderSuggestions = orderFlowResult.response.suggestions || [];

        const finalResponse = {
          ...orderFlowResult.response,
          suggestions: chitchatSuggestions,
          order_suggestions: orderSuggestions,
        };

        return res.json({
          automated: true,
          response: finalResponse,
          language: lang,
          phase: orderFlowResult.phase,
          intent: orderFlowResult.intent,
          order_suggestions: orderSuggestions,
        });
      }
    }

    const isOrderIntent = forceOrderFromAi || looksLikeOrderIntent(text, lang) || (lang === 'ar' && looksLikeOrderIntent(require('../../engine/translation').translateArabicToEnglish(text), 'en'));
    if (isOrderingEnabled(business) && (session.phase === 'active' || String(session.phase || '').startsWith('order_')) && (isOrderIntent || isInternalOrderCommand(text))) {
      const orderSeedItems = matchItemsForOrder({
        text,
        lang,
        businessId: business.id,
        context,
      });
      return startOrderResponse(orderSeedItems);
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

    if (aiInvalidClassification) {
      const fallbackPayload = brain.buildResponse(intentResult, lang, business);
      const fallbackIsUsable = hasUsablePayload({ ...fallbackPayload, intent: intentResult.intent });
      const payload = fallbackIsUsable
        ? prefixAiFallbackPayload(fallbackPayload, lang)
        : buildNotFoundPayload(lang === 'ar' ? 'ar' : 'en', business);
      const nextContext = {
        ...context,
        ...payload.context_update,
        last_suggestions: normalizeSuggestions(payload.suggestions),
      };
      return sendPayloadResult({
        payload,
        intent: fallbackIsUsable ? intentResult.intent : 'ai_not_found',
        nextContext,
      });
    }

    if (aiAssessment.score > 0 && shouldRetryWithRecovery(intentResult.intent)) {
      const aiPipeline = await tryAiPipeline('rules_fallback');
      if (aiPipeline.forceOrder && isOrderingEnabled(business)) {
        const orderSeedItems = matchItemsForOrder({
          text,
          lang,
          businessId: business.id,
          context,
        });
        return startOrderResponse(orderSeedItems);
      }
      if (aiPipeline.handled) {
        const nextContext = {
          ...context,
          ...aiPipeline.payload.context_update,
          last_suggestions: normalizeSuggestions(aiPipeline.payload.suggestions),
        };
        return sendPayloadResult({
          payload: aiPipeline.payload,
          intent: aiPipeline.intent,
          nextContext,
        });
      }
      if (aiPipeline.invalid) {
        const fallbackPayload = brain.buildResponse(intentResult, lang, business);
        const payload = hasUsablePayload({ ...fallbackPayload, intent: intentResult.intent })
          ? prefixAiFallbackPayload(fallbackPayload, lang)
          : buildNotFoundPayload(lang === 'ar' ? 'ar' : 'en', business);
        const nextContext = {
          ...context,
          ...payload.context_update,
          last_suggestions: normalizeSuggestions(payload.suggestions),
        };
        return sendPayloadResult({
          payload,
          intent: hasUsablePayload({ ...fallbackPayload, intent: intentResult.intent }) ? intentResult.intent : 'ai_not_found',
          nextContext,
        });
      }
    }

    const trackedItemIds = mergeRecentItemIds(
      context,
      collectTrackedItemIds(intentResult)
    );
    const payload = brain.buildResponse(intentResult, lang, business);
    const nextContext = {
      ...context,
      ...payload.context_update,
      last_suggestions: normalizeSuggestions(payload.suggestions),
      recent_item_ids: trackedItemIds,
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
    if (Array.isArray(payload.messages) && payload.messages.length > 0) {
      payload.messages.forEach((msg) => {
        insertMessage.run(session.id, 'bot', msg.text, intentResult.intent, msg.thumbnail || null);
      });
    } else {
      insertMessage.run(session.id, 'bot', payload.text, intentResult.intent, payload.thumbnail || null);
    }

    const orderState = resolveOrderUiState({ business, session, context: nextContext, lang });
    const orderSuggestions = orderState.suggestions || [];
    
    let finalUiState = orderState.ui_state;
    if (!dashboardActive) {
      finalUiState = {
        ui_state: {
          input_locked: false,
          choice_buttons: [],
          address_preview: '',
          order_draft: orderState.ui_state?.order_draft || null,
        },
        suggestions: [],
      }.ui_state;
    }

    return res.json({
      automated: true,
      response: {
        text: payload.text,
        type: payload.type,
        buttons: payload.buttons,
        suggestions: payload.suggestions,
        ui_state: finalUiState,
        order_suggestions: orderSuggestions,
        thumbnail: payload.thumbnail,
        messages: payload.messages || null,
      },
      language: lang,
      phase: session.phase,
      intent: intentResult.intent,
      order_suggestions: orderSuggestions,
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
