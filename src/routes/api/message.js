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
  isYesText,
  isCancelText,
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
  buildRecommendationCandidates,
  buildRecommendationMessages,
  buildCountryMissPayload,
} = require('../../engine/aiPipelines');
const { canUseAi, recordAiUse } = require('../../engine/aiRateLimiter');
const { matchFaq } = require('../../engine/faqMatcher');
const { getCachedClassification, setCachedClassification } = require('../../brains/shared/catalogStore');

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

// Last few turns so the AI can resolve follow-up references ("what is the
// ingredients" -> the item from the previous result). Call BEFORE inserting the
// current message so it isn't included. 4 rows = ~2 exchanges; content trimmed
// to keep the added tokens small.
const getRecentMessagesStmt = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6');
function buildAiHistory(sessionId) {
  const rows = getRecentMessagesStmt.all(sessionId).reverse();
  return rows
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${String(m.content || '').slice(0, 200)}`)
    .join('\n');
}

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

// Anaphora that points BACK at items named in a previous turn ("order them",
// "add those two", "make an order with both"). When an order message carries no
// item of its own, we seed the cart from what we just recommended/showed instead
// of opening it empty.
const ORDER_ANAPHOR_RE = /\b(them|those|these|both|the ones|the two|the items|the dishes|the meals|all of them|that one|the same)\b/i;
const ORDER_ANAPHOR_AR_RE = /(دول|دي|دى|هم|الاتنين|الإتنين|الاثنين|كلهم|اللي قلت|اللي اقترحت|نفسهم|الحاجتين|الصنفين)/;

function resolveItemsByIds(businessId, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const { getBusinessItems } = require('../../brains/shared/catalogStore');
  const map = new Map(getBusinessItems(businessId).map((it) => [it.id, it]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

// Seed items for a NEW order: items explicitly named in THIS message win (a
// fuzzy text match is ambiguous, so the order flow adds only the top one). If
// none are named but the message refers back to a prior turn ("an order with
// them"), fall back to the items we last recommended ([12]) or last showed —
// that is a PRECISE set, so seedAll tells the order flow to add every one.
function resolveOrderSeedItems({ text, lang, businessId, context }) {
  // 1. Items explicitly named in THIS message win.
  const explicitItems = matchItemsForOrder({ text, lang, businessId, context });
  if (explicitItems.length) return { items: explicitItems, seedAll: false, explicit: true };

  const raw = String(text || '');
  // 2. "order them / those / both" -> the SET we last recommended/showed.
  if (ORDER_ANAPHOR_RE.test(raw) || ORDER_ANAPHOR_AR_RE.test(raw)) {
    const ids = Array.isArray(context.last_recommended_ids) && context.last_recommended_ids.length
      ? context.last_recommended_ids
      : (Array.isArray(context.recent_item_ids) ? context.recent_item_ids.slice(-3) : []);
    // `explicit: false` — the item set is INFERRED from conversation history,
    // not named in this message, so a caller relying on a purely AI-guessed
    // order intent (see isOrderIntent below) must confirm before it acts on it.
    return { items: resolveItemsByIds(businessId, ids), seedAll: true, explicit: false };
  }

  // 3. Bare order intent with NO product named ("make an order", "i want to
  //    order", "i already told you") -> the single product they were just
  //    looking at, else the most recent one. This is what lets "make order"
  //    after viewing a product seed THAT product instead of opening empty.
  if (Number.isFinite(context.last_item)) {
    return { items: resolveItemsByIds(businessId, [context.last_item]), seedAll: true, explicit: false };
  }
  const recent = Array.isArray(context.recent_item_ids) ? context.recent_item_ids : [];
  if (recent.length) {
    return { items: resolveItemsByIds(businessId, [recent[recent.length - 1]]), seedAll: true, explicit: false };
  }
  return { items: [], seedAll: false, explicit: false };
}

function shouldRetryWithRecovery(intent) {
  return intent === 'unknown' || intent === 'item_not_found';
}

// Deterministic meta/FAQ intents where the local rule IS the right answer —
// no reasoning or catalog ambiguity to resolve, so there's nothing an AI call
// could improve on. These get first refusal even on a message that scores
// high enough for AI (a vague "help me choose" question scores high on
// unknown-token ratio same as a real product question). Deliberately NOT
// item_found/category_items/etc — those stay AI-first because the AI is
// there to break catalog ambiguity and reasoning questions rules can't judge.
const ALWAYS_LOCAL_INTENTS = new Set([
  'greeting_hello', 'greeting_how_are_you', 'greeting_yasta', 'thanks',
  'help', 'guided_discovery', 'list_categories', 'contact', 'working_hours',
  'location', 'brand_info', 'order_howto', 'logistics_inquiry', 'logistics_average',
  'service_area', 'business_model', 'stock_quantity', 'faq',
]);

// The classifier's [11] direct-answer sometimes bottoms out on a completely
// open, content-free bounce ("I'm here to help! What do you need?", "Just
// let me know what you're looking for", "just tell me which product(s)
// you'd like to choose") instead of grounding a real reply — even when the
// message already stated what the customer wants (e.g. "I don't know what
// to choose"). Showing that verbatim produces a dead-end loop where the bot
// asks the customer to restate what they already said. Catch that specific
// circular "restate your need" shape — NOT every "I'm here to help" opener,
// since variants that continue with a concrete, non-circular ask ("...just
// tell me which product(s) and I'll take the order") are genuinely useful
// and must still pass through.
const AI_FILLER_RE = [
  /\bwhat do you need\b/i,
  /ما الذي تحتاجه/,
  /ايه اللي محتاجه/,
  /\b(tell|let)\s+me\s+know\s+(what|which)\b[^.!?]*\b(need|want|looking for)\b/i,
  /\bassist you in choosing\b/i,
  /\bwhich product\(?s?\)?\s*you'?d like to choose\b/i,
];
function isFillerAiReply(text) {
  const t = String(text || '').trim();
  return !t || AI_FILLER_RE.some((re) => re.test(t));
}

function hasUsablePayload(payload) {
  return Boolean(payload && payload.text && !['unknown', 'item_not_found', 'need_item_context', 'ai_not_found'].includes(payload.intent));
}

// Compact store profile + category names for the last-resort generic answer
// call. Item rows are deliberately excluded so the call stays a few hundred
// tokens — product lookups were already resolved (or genuinely missed)
// upstream, this call only has to answer meta/general questions in character.
function buildGenericAnswerSource(business) {
  const { getBusinessItems } = require('../../brains/shared/catalogStore');
  const items = getBusinessItems(business.id);
  const categories = [...new Set(items.map((i) => i.category_en || i.category_ar).filter(Boolean))];
  return {
    store: {
      name: business.name || business.name_ar || '',
      about: business.about_en || business.about_ar || '',
      phone: business.phone || '',
      email: business.email || '',
      working_hours: business.working_hours_en || business.working_hours_ar || '',
    },
    categories,
  };
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
    // Internal order commands (button clicks, confirm, country select, cart
    // sync) carry JSON/English payloads, so detectLanguage wrongly reads them as
    // English — which then cascades the whole order flow into English and even
    // overwrites the session language. For these, and for the phone step, trust
    // the language the customer already established in the session instead.
    if ((session.phase === 'collect_phone' || isInternalOrderCommand(text)) && session.language) {
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
        response: { text: COMMON_RESPONSES.ready_to_help[lang](), type: 'text', buttons: [], suggestions: [] },
        language: lang,
        phase: 'active',
      });
    }

    const context = parseContext(session.context);
    const internalOrderCommand = isInternalOrderCommand(text);
    // Capture prior turns before the current message is stored. Built first so
    // the gate can route context-only follow-ups ("what's the ingredient?") to
    // AI — they name no item, so without context they would score 0.
    const aiHistory = buildAiHistory(session.id);
    const aiAssessment = assessAiRoutingNeed({ text, lang, business, hasContext: Boolean(aiHistory) });
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

    // A message "depends on context" only when it points BACK at a prior turn
    // with a pronoun/anaphor ("is it spicy?", "نفس الشيء"). A self-contained
    // question ("do you have wifi") does NOT depend on context even when chat
    // history exists — so it stays cacheable. (This previously keyed off the
    // gate's followup_context flag, which fires for ANY question once history
    // exists and wrongly blocked caching of plain repeated questions.)
    // Casual typing drops the apostrophe ("thats", "whats") — without it the
    // contraction misses \bthat\b/\bwhat\b entirely (no word boundary before
    // the trailing "s"), so a real follow-up ("thats cool but I insist on
    // Saudi Arabia") gets treated as self-contained and sent with NO history,
    // leaving the classifier to guess the category blind.
    const ANAPHOR_RE = /\b(it|its|it's|this|that|that's|thats|these|those|them|they|they're|theyre|same)\b/i;
    const ANAPHOR_AR_RE = /(ده|دى|دي|دا|هذا|هذه|نفس|فيها|فيه)/;
    function isContextReferencing(message) {
      const m = String(message || '');
      return ANAPHOR_RE.test(m) || ANAPHOR_AR_RE.test(m);
    }
    // Cache the classifier verdict for identical, context-free questions only.
    const classifyCacheable = !isContextReferencing(text);
    const classifyKey = `${lang}|${String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
    let aiUnavailable = false;
    // The classifier's [11] reply when it was rejected as a content-free
    // bounce. Held as a LAST-resort reply: if every other pipeline also comes
    // up empty, a warm "I'm here to help" still beats a canned not-found.
    let aiDirectBounceText = '';
    async function tryAiPipeline(reason) {
      if (aiUnavailable || !isAiEnabledForBusiness(business)) return { handled: false };

      // Identical question already classified? Reuse it — no rate-limit hit, no
      // network call, no tokens billed.
      let aiResult;
      const cachedRaw = classifyCacheable ? getCachedClassification(business.id, classifyKey) : null;
      if (cachedRaw) {
        aiResult = { ok: true, raw: cachedRaw, from_cache: true, usage: null, model: null, elapsed_ms: 0 };
      } else {
        const gate = canUseAi({ businessId: business.id, ip: clientIp, deviceId });
        if (!gate.allowed) {
          console.warn('[ai-routing] rate limited, answering from rules', { reason, limit: gate.reason });
          return { handled: false, rateLimited: true };
        }
        recordAiUse({ businessId: business.id, ip: clientIp, deviceId });

        // Only spend tokens on prior turns when the message actually points back
        // at them ("is it spicy?", "based on what I told you"). Self-contained
        // questions send no history — cheaper and still cacheable. When context
        // IS needed we send up to ~3 turns (see getRecentMessagesStmt) so chains
        // like "I'm allergic to X" ... "is this dish ok?" resolve correctly.
        const historyForAi = isContextReferencing(text) ? aiHistory : '';
        aiResult = await callAiClassifier({ text, business, session, history: historyForAi });
        if (!aiResult.ok) {
          aiUnavailable = true;
          console.warn('[ai-routing] classifier failed', { reason, error: aiResult.error, elapsed_ms: aiResult.elapsed_ms });
          return { handled: false };
        }
        // Only cache a classification that actually parses to a valid pipeline
        // code. A one-off malformed AI output (e.g. prose instead of "[N] ...")
        // must NOT poison the cache and force not-found for 30 minutes.
        if (classifyCacheable && parseAiPipeline(aiResult.raw).valid) {
          setCachedClassification(business.id, classifyKey, aiResult.raw);
        }
      }
      recordAiCall({ businessId: business.id, sessionId: session.id, message: text, mode: 'classify', result: aiResult });

      const pipeline = parseAiPipeline(aiResult.raw);
      if (!pipeline.valid) {
        return { handled: false, invalid: true, raw: aiResult.raw };
      }
      if (pipeline.code === 6) {
        return { handled: false, forceOrder: true, raw: aiResult.raw };
      }

      // [12] subjective recommendation ("which is best for diet?"). Local rules
      // can't reason about "best", so narrow the menu to a small candidate set
      // and let a focused AI answer pick one. Only this intent pays the second
      // call, and it sees just the candidates — not the whole menu.
      if (pipeline.code === 12) {
        const { candidates, countryMiss, activeCountry, activeCountries } = buildRecommendationCandidates({ criteria: pipeline.item, business, lang, context, text });
        // A country was named but nothing in the candidate pool is FROM that
        // country — don't let the recommend call improvise a wrong-country
        // pick and present it as satisfying the request.
        if (countryMiss) {
          const miss = buildCountryMissPayload({ activeCountry, activeCountries, lang, business });
          return { handled: true, intent: miss.intent, payload: miss.payload, raw: aiResult.raw };
        }
        if (!candidates.length) return { handled: false, raw: aiResult.raw };
        const answer = await callAiAnswer({
          prompt: text,
          business,
          lang,
          history: isContextReferencing(text) ? aiHistory : '',
          candidates,
        });
        recordAiCall({ businessId: business.id, sessionId: session.id, message: text, mode: 'recommend', result: answer });
        if (!answer.ok || !answer.reply) return { handled: false, raw: aiResult.raw };
        // Track which catalog items the recommendation actually named so a
        // follow-up ("make an order with them") can seed the cart from this
        // turn. The reply is free text but contains the item titles, which
        // matchItemsForOrder resolves back to real rows.
        const recommendedItems = matchItemsForOrder({ text: answer.reply, lang, businessId: business.id, context });
        const recommendedIds = recommendedItems.map((it) => it.id).filter(Number.isFinite);
        // Split the reply so each named catalog item becomes its own bubble with
        // its thumbnail (intro line stays first). Null when nothing resolved -> we
        // keep the plain single-text reply.
        const recMessages = buildRecommendationMessages({ replyText: answer.reply, business, lang });
        return {
          handled: true,
          intent: 'ai_recommend',
          payload: {
            text: answer.reply,
            type: 'text',
            buttons: [],
            suggestions: parseSuggestions(business, lang),
            ...(recMessages ? { messages: recMessages } : {}),
            context_update: recommendedIds.length
              ? {
                recent_item_ids: mergeRecentItemIds(context, recommendedIds),
                last_recommended_ids: recommendedIds,
                // Set last_item when one product was recommended so follow-up
                // questions ("tell me more about this product") resolve it.
                ...(recommendedIds.length === 1 ? { last_item: recommendedIds[0] } : {}),
              }
              : {},
          },
          raw: aiResult.raw,
        };
      }

      if (pipeline.code === 10) {
        const faqHit = resolveFaqWithContext();
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
            context_update: { last_faq: faqHit.question },
          },
          raw: aiResult.raw,
        };
      }

      // [11] direct answer: the classifier already wrote the reply inline as a
      // last resort (an in-scope question none of [1]-[9] could express, e.g.
      // "does this item have butter?"). Show it verbatim — no second AI call.
      if (pipeline.code === 11) {
        const direct = (pipeline.direct || '').trim();
        // Content-free bounce -> let local rules answer instead (e.g. the
        // brain's 'help' intent, which offers real, actionable next steps)
        // rather than parroting the same dead-end question back. Keep the
        // text though — if the rules ALSO dead-end, it's still a real reply.
        if (isFillerAiReply(direct)) {
          aiDirectBounceText = direct;
          return { handled: false, raw: aiResult.raw };
        }
        return {
          handled: true,
          intent: 'ai_answer',
          payload: {
            text: direct,
            type: 'text',
            buttons: [],
            suggestions: parseSuggestions(business, lang),
            context_update: {},
          },
          raw: aiResult.raw,
        };
      }

      // Everything else (search/category/filter/exclude/details/not-found, and
      // greeting) is resolved LOCALLY: the classifier returned a structured
      // query, we run it against our own catalog and format the reply. The menu
      // is NEVER sent to the AI — only the tiny classify call costs tokens.
      const resolved = resolveAiPipeline({ pipeline, brain, business, lang, context, text });
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

    // Last-resort FAQ check. Only fires when every other pipeline has already
    // failed and we are about to tell the customer "not found": we consult the
    // owner-provided FAQ (faq_en / faq_ar) and, if a stored question matches,
    // answer from it. Otherwise the not-found reply stands. Local keyword match,
    // no extra AI call.
    // Resolve an FAQ for the current message. If the message matches nothing on
    // its own but the previous turn answered an FAQ, retry with that topic glued
    // on — so a context-free follow-up ("how fast its speed" after "do you have
    // wifi") still lands on the right FAQ. Returns the FAQ hit or null.
    // A message only inherits the previous FAQ topic when it actually refers
    // BACK to it with a pronoun/anaphor ("how fast is it?", "نفس الشيء") — the
    // same isContextReferencing() test used for cache eligibility. Without a
    // back-reference, an off-topic or gibberish message ("dwqwfww") matched
    // nothing of its own and must stay not-found — it must NOT borrow the prior
    // answer just because the last topic's keywords happen to match.
    function resolveFaqWithContext() {
      const direct = matchFaq({ text, lang, business });
      if (direct) return direct;
      const lastFaq = context && context.last_faq;
      if (lastFaq && isContextReferencing(text)) {
        const followup = matchFaq({ text: `${lastFaq} ${text}`, lang, business });
        if (followup) return followup;
      }
      return null;
    }

    const NOT_FOUND_INTENTS = new Set(['unknown', 'item_not_found', 'need_item_context', 'ai_not_found']);
    function applyFaqFallback({ payload, intent }) {
      if (!NOT_FOUND_INTENTS.has(intent)) return { payload, intent, changed: false };
      const faqHit = resolveFaqWithContext();
      if (!faqHit) return { payload, intent, changed: false };
      return {
        changed: true,
        intent: 'faq',
        faqQuestion: faqHit.question,
        payload: {
          text: faqHit.answer,
          type: 'text',
          buttons: [],
          suggestions: parseSuggestions(business, lang),
          context_update: { last_faq: faqHit.question },
        },
      };
    }

    // ZERO-not-found guarantee. When every pipeline has failed and the reply
    // would be a canned not-found, spend ONE focused AI answer call
    // (mode 'answer' -> rules/<service>_answer.txt on the AI service) so the
    // customer always gets a real reply in their language. Only the compact
    // store profile + category names are sent — never the item rows — so the
    // call stays a few hundred tokens. Context-free replies are cached under
    // a 'generic|' key so a repeated question costs nothing.
    async function resolveGenericAiAnswer() {
      try {
        if (aiUnavailable || !isAiEnabledForBusiness(business)) return null;

        const genericKey = `generic|${classifyKey}`;
        if (classifyCacheable) {
          const cached = getCachedClassification(business.id, genericKey);
          if (cached) return cached;
        }

        const gate = canUseAi({ businessId: business.id, ip: clientIp, deviceId });
        if (!gate.allowed) {
          console.warn('[ai-routing] rate limited, generic answer skipped', { limit: gate.reason });
          return null;
        }
        recordAiUse({ businessId: business.id, ip: clientIp, deviceId });

        const answer = await callAiAnswer({
          prompt: text,
          business,
          lang,
          history: isContextReferencing(text) ? aiHistory : '',
          candidates: buildGenericAnswerSource(business),
          mode: 'answer',
        });
        recordAiCall({ businessId: business.id, sessionId: session.id, message: text, mode: 'answer', result: answer });
        const reply = answer.ok ? String(answer.reply || '').trim() : '';
        if (!reply) return null;
        if (classifyCacheable) setCachedClassification(business.id, genericKey, reply);
        return reply;
      } catch (error) {
        console.warn('[ai-routing] generic answer failed', error.message);
        return null;
      }
    }

    async function sendPayloadResult({ payload, intent, nextContext, phase = session.phase }) {
      const faq = applyFaqFallback({ payload, intent });
      payload = faq.payload;
      intent = faq.intent;
      if (faq.changed) {
        nextContext = {
          ...nextContext,
          last_faq: faq.faqQuestion,
          last_suggestions: normalizeSuggestions(payload.suggestions),
        };
      }

      // Still a not-found after the FAQ pass -> the zero-not-found guarantee:
      // a real AI-written reply, else the classifier's own [11] text, before
      // any canned fallback is allowed out the door.
      if (NOT_FOUND_INTENTS.has(intent)) {
        const genericReply = await resolveGenericAiAnswer();
        const replacement = genericReply || aiDirectBounceText;
        if (replacement) {
          intent = genericReply ? 'ai_generic_answer' : 'ai_answer';
          payload = {
            text: replacement,
            type: 'text',
            buttons: [],
            suggestions: parseSuggestions(business, lang),
            thumbnail: null,
            context_update: {},
          };
          nextContext = {
            ...nextContext,
            last_suggestions: normalizeSuggestions(payload.suggestions),
          };
        }
      }

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

    function startOrderResponse(seedItems, seedAll = false) {
      const orderStartResult = startOrderFlow({
        business,
        session,
        context,
        lang,
        seedItems,
        seedAll,
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

    // The AI classifier is the ONLY signal for order intent (no "order"/"اطلب"
    // wording in the message, no item literally named) and the item(s) it would
    // seed were guessed from conversation history, not this message. That combo
    // has caused real false positives (a complaint like "انا قلت منتج واحد بس"
    // misread as an order request) that silently opened a live order. Ask once
    // instead of acting — "yes" resumes exactly the seed we would have used.
    function startOrderConfirmResponse(orderSeed) {
      const titles = orderSeed.items
        .map((item) => (lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar))
        .filter(Boolean);
      const itemLine = titles.length ? titles.join('، ') : '';
      const text = lang === 'ar'
        ? (itemLine
          ? `يبدو إنك تقصد طلب "${itemLine}". هل أبدأ الطلب فعلاً؟`
          : 'يبدو إنك تقصد بدء طلب جديد. هل أفتح طلباً الآن؟')
        : (itemLine
          ? `Looks like you want to order "${itemLine}". Should I start the order?`
          : 'Looks like you want to start an order. Should I open one now?');
      const suggestions = lang === 'ar' ? ['نعم، ابدأ الطلب', 'لا'] : ['Yes, start the order', 'No'];

      const nextContext = {
        ...context,
        pending_order_confirm: {
          item_ids: orderSeed.items.map((item) => item.id),
          seed_all: orderSeed.seedAll,
        },
        last_suggestions: suggestions,
      };
      updateSession.run(session.phase, lang, session.guest_name, session.guest_phone, JSON.stringify(nextContext), session.id);
      insertMessage.run(session.id, 'bot', text, 'order_confirm_prompt');

      return res.json({
        automated: true,
        response: {
          text,
          type: 'text',
          buttons: [],
          suggestions,
          ui_state: emptyUiState(),
          order_suggestions: [],
          thumbnail: null,
          messages: null,
        },
        language: lang,
        phase: session.phase,
        intent: 'order_confirm_prompt',
        order_suggestions: [],
      });
    }

    // Resume from the confirmation prompt above. "Yes" opens the order with the
    // exact seed we proposed; anything else drops the flag and continues as a
    // normal message so the customer is never trapped answering a yes/no bot.
    if (context.pending_order_confirm && isOrderingEnabled(business)) {
      const pending = context.pending_order_confirm;
      delete context.pending_order_confirm;
      if (isYesText(text, lang)) {
        const seedItems = resolveItemsByIds(business.id, pending.item_ids || []);
        return startOrderResponse(seedItems, Boolean(pending.seed_all));
      }
      // Any other reply (including "no") falls through to normal handling
      // below with the flag already cleared.
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

    // Context recall ("remind me what was that dish") — resolved locally from
    // the stored last_item BEFORE any AI call. Strictly phrase-gated in the
    // brain (intent 'item_recall'), so only an explicit recall short-circuits
    // here; every other message — including gibberish after a matched item —
    // continues down the normal flow untouched.
    if (session.phase === 'active') {
      const recallProbe = brain.detectIntent({ text, lang, business, context });
      if (recallProbe && recallProbe.intent === 'item_recall' && recallProbe.item) {
        const recallPayload = brain.buildResponse(recallProbe, lang, business);
        const nextContext = {
          ...context,
          ...recallPayload.context_update,
          last_suggestions: normalizeSuggestions(recallPayload.suggestions),
          recent_item_ids: mergeRecentItemIds(context, collectTrackedItemIds(recallProbe)),
        };
        return await sendPayloadResult({ payload: recallPayload, intent: 'item_recall', nextContext });
      }
      // Context follow-up ("tell me more about it", "قلي تفاصيل اكتر عنه"): the
      // brain resolved the message against the product already in context. Answer
      // it LOCALLY (in the user's language) BEFORE the AI router can grab it and
      // reply generically/in the wrong language. Gated on fromContext so only a
      // genuine anaphoric follow-up about last_item short-circuits here — a
      // message that names a NEW product flows down normally.
      if (recallProbe && recallProbe.fromContext && recallProbe.item) {
        const followupPayload = brain.buildResponse(recallProbe, lang, business);
        const nextContext = {
          ...context,
          ...followupPayload.context_update,
          last_suggestions: normalizeSuggestions(followupPayload.suggestions),
          recent_item_ids: mergeRecentItemIds(context, collectTrackedItemIds(recallProbe)),
        };
        return await sendPayloadResult({ payload: followupPayload, intent: recallProbe.intent, nextContext });
      }
    }

    // Order handoff (e-commerce). A "how do I order?" question asks WHICH products
    // instead of opening an empty cart; once the customer names products — now or
    // right after we ask — we open the order seeded with exactly those. Runs
    // before the AI/order-intent blocks so the bare how-to question isn't caught
    // by looksLikeOrderIntent ("can i order") and turned into an empty order.
    if (session.phase === 'active' && isOrderingEnabled(business)) {
      if (context.awaiting_order_products) {
        const named = matchItemsForOrder({ text, lang, businessId: business.id, context });
        if (named.length) {
          return startOrderResponse(named, true);
        }
        const seed = resolveOrderSeedItems({ text, lang, businessId: business.id, context });
        if (seed.items.length) {
          return startOrderResponse(seed.items, seed.seedAll);
        }
        // They didn't name a product — drop the flag and answer normally.
        delete context.awaiting_order_products;
      } else {
        const howtoProbe = brain.detectIntent({ text, lang, business, context });
        if (howtoProbe && howtoProbe.intent === 'order_howto') {
          // If they were already looking at / we already recommended a product,
          // skip asking and open the order seeded with it (per spec). Only ask
          // "which products?" when there is genuinely no product in context.
          const seed = resolveOrderSeedItems({ text, lang, businessId: business.id, context });
          if (seed.items.length) {
            return startOrderResponse(seed.items, seed.seedAll);
          }
          const howtoPayload = brain.buildResponse(howtoProbe, lang, business);
          const nextContext = {
            ...context,
            ...howtoPayload.context_update,
            awaiting_order_products: true,
            last_suggestions: normalizeSuggestions(howtoPayload.suggestions),
          };
          return await sendPayloadResult({ payload: howtoPayload, intent: 'order_howto', nextContext });
        }
      }
    }

    let forceOrderFromAi = false;
    let aiInvalidClassification = false;
    // Tracks whether we already spent an AI classification this request, so the
    // rules-fallback below never fires a SECOND (often uncached) classify call
    // for the same message.
    let aiClassifyAttempted = false;
    // While inside an open order, a genuine info question must STILL reach the
    // AI — otherwise the customer is trapped: the order handler only adds items
    // and would swallow "tell me about X and Y". The routing score is the
    // discriminator: a real question/multi-item ask routes to AI, while a bare
    // item name to add scores low and falls through to the order flow below. We
    // keep the current order phase on the reply, so the open order is preserved.
    // Address entry is excluded so a typed address is never hijacked.
    const phaseStr = String(session.phase || '');
    const orderInfoEscape = phaseStr.startsWith('order_')
      && phaseStr !== 'order_address'
      && !isInternalOrderCommand(text);
    // Check local rules BEFORE spending an AI call: if a deterministic intent
    // already has the right answer, showing it beats an AI freeform reply
    // that might bounce with a generic non-answer (and costs money either way).
    const localFirstProbe = brain.detectIntent({ text, lang, business, context });
    const localFirstHasAnswer = Boolean(localFirstProbe && ALWAYS_LOCAL_INTENTS.has(localFirstProbe.intent));
    if ((session.phase === 'active' || orderInfoEscape) && aiAssessment.route === 'ai' && !localFirstHasAnswer) {
      const aiPipeline = await tryAiPipeline('threshold');
      aiClassifyAttempted = true;
      if (aiPipeline.forceOrder) {
        forceOrderFromAi = true;
      } else if (aiPipeline.invalid) {
        aiInvalidClassification = true;
      } else if (aiPipeline.handled && aiPipeline.intent !== 'ai_not_found') {
        const nextContext = {
          ...context,
          ...aiPipeline.payload.context_update,
          last_suggestions: normalizeSuggestions(aiPipeline.payload.suggestions),
        };
        return await sendPayloadResult({
          payload: aiPipeline.payload,
          intent: aiPipeline.intent,
          nextContext,
        });
      }
      // NB: when the AI classifier says "not found" we deliberately DON'T return
      // here. The local rules get a chance first — they can still answer a
      // size/price/recall question from last_item. If the rules also come up
      // empty, the normal not-found reply is produced downstream. (Gibberish is
      // safe: rules only bind to last_item on an explicit price/size/recall
      // phrase, so nonsense still ends up not-found.)
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

    const localOrderIntent = looksLikeOrderIntent(text, lang) || (lang === 'ar' && looksLikeOrderIntent(require('../../engine/translation').translateArabicToEnglish(text), 'en'));
    const isOrderIntent = forceOrderFromAi || localOrderIntent;
    if (isOrderingEnabled(business) && (session.phase === 'active' || String(session.phase || '').startsWith('order_')) && (isOrderIntent || isInternalOrderCommand(text))) {
      const orderSeed = resolveOrderSeedItems({
        text,
        lang,
        businessId: business.id,
        context,
      });
      // The ONLY signal was the AI classifier (no local "order" wording) and the
      // seed item(s) were inferred from history rather than named right here —
      // the riskiest, least-corroborated combination. Confirm before opening a
      // real order instead of acting on a possible misclassification.
      if (forceOrderFromAi && !localOrderIntent && !isInternalOrderCommand(text) && !orderSeed.explicit) {
        if (orderSeed.items.length) return startOrderConfirmResponse(orderSeed);
        // Nothing to seed either — too weak a guess to act on at all; let
        // normal intent detection answer the message below instead.
      } else {
        return startOrderResponse(orderSeed.items, orderSeed.seedAll);
      }
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

      // 2. Try algorithmic Franco-Arabic phonetic recovery first (unless the
      //    business has disabled Franco recovery).
      const francoEnabled = business.franco_enabled === undefined || Number(business.franco_enabled) !== 0;
      if (francoEnabled && !translationMatched && shouldRetryWithRecovery(intentResult.intent)) {
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
      return await sendPayloadResult({
        payload,
        intent: fallbackIsUsable ? intentResult.intent : 'ai_not_found',
        nextContext,
      });
    }

    if (!aiClassifyAttempted && aiAssessment.score > 0 && shouldRetryWithRecovery(intentResult.intent)) {
      const aiPipeline = await tryAiPipeline('rules_fallback');
      if (aiPipeline.forceOrder && isOrderingEnabled(business)) {
        const orderSeed = resolveOrderSeedItems({
          text,
          lang,
          businessId: business.id,
          context,
        });
        // See the identical guard above: the AI classifier is the only order
        // signal here too (local rules already produced 'unknown'/'item_not_found'
        // above this branch), so an inferred, unnamed seed must be confirmed first.
        const localOrderIntentFallback = looksLikeOrderIntent(text, lang)
          || (lang === 'ar' && looksLikeOrderIntent(require('../../engine/translation').translateArabicToEnglish(text), 'en'));
        if (!localOrderIntentFallback && !orderSeed.explicit) {
          if (orderSeed.items.length) return startOrderConfirmResponse(orderSeed);
        } else {
          return startOrderResponse(orderSeed.items, orderSeed.seedAll);
        }
      }
      if (aiPipeline.handled) {
        const nextContext = {
          ...context,
          ...aiPipeline.payload.context_update,
          last_suggestions: normalizeSuggestions(aiPipeline.payload.suggestions),
        };
        return await sendPayloadResult({
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
        return await sendPayloadResult({
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
    const basePayload = brain.buildResponse(intentResult, lang, business);
    const nextContext = {
      ...context,
      ...basePayload.context_update,
      last_suggestions: normalizeSuggestions(basePayload.suggestions),
      recent_item_ids: trackedItemIds,
    };
    if (resolvedText !== text) {
      nextContext.last_recovered_query = resolvedText;
    }
    // sendPayloadResult applies the FAQ fallback and the zero-not-found
    // guarantee (generic AI answer) before anything canned can go out.
    return await sendPayloadResult({ payload: basePayload, intent: intentResult.intent, nextContext });
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
