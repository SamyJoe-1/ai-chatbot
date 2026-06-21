'use strict';

const { getBusinessItems } = require('../brains/shared/catalogStore');
const { normalize, tokenize } = require('./detector');
const db = require('../db/db');

// USD per 1M tokens [input, output]. Update if OpenAI pricing changes.
const PRICES = {
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4.1-nano': [0.10, 0.40],
  'gpt-5-nano': [0.05, 0.40],
};
function priceFor(model) {
  if (!model) return [0, 0];
  const key = Object.keys(PRICES).find((k) => String(model).startsWith(k));
  return key ? PRICES[key] : [0, 0];
}
function estimateCost(model, promptTokens, completionTokens) {
  const [pin, pout] = priceFor(model);
  return ((promptTokens || 0) * pin + (completionTokens || 0) * pout) / 1000000;
}

const insertAiCall = db.prepare(`
  INSERT INTO ai_calls
    (business_id, session_id, message, mode, model, duration_ms,
     prompt_tokens, completion_tokens, total_tokens, cost_usd, from_cache)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Log one AI call (classify/answer) for the AI Usage dashboard. Non-fatal.
function recordAiCall({ businessId, sessionId, message, mode, result }) {
  try {
    const u = (result && result.usage) || {};
    const prompt = Number(u.prompt_tokens || 0);
    const completion = Number(u.completion_tokens || 0);
    const total = Number(u.total_tokens || prompt + completion);
    const model = (result && result.model) || null;
    insertAiCall.run(
      businessId,
      sessionId || null,
      String(message || '').slice(0, 500),
      mode,
      model,
      Number((result && result.elapsed_ms) || 0),
      prompt,
      completion,
      total,
      estimateCost(model, prompt, completion),
      result && result.from_cache ? 1 : 0,
    );
  } catch { /* non-fatal */ }
}

const AI_TIMEOUT_MS = Number(process.env.AI_API_TIMEOUT_MS || 10000);
const STATIC_TEXT = new Set([
  'hi', 'hello', 'hey', 'hiya', 'howdy', 'hala', 'salam',
  'good morning', 'good afternoon', 'good evening', 'good night',
  'ok', 'okay', 'sure', 'fine', 'thanks', 'thank you', 'thank you so much', 'thx', 'ty',
  'bye', 'goodbye', 'cya', 'see you',
]);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'you', 'your', 'we', 'our', 'to', 'for',
  'from', 'of', 'in', 'on', 'at', 'is', 'are', 'am', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'and', 'or', 'but', 'please', 'pls',
  'there', 'this', 'that', 'with', 'about', 'what', 'which', 'how', 'have',
]);

const BASE_PIPELINES = {
  welcome: ['hi', 'hello', 'hey', 'good morning', 'good evening', 'thanks', 'thank you', 'bye'],
  menu_query: ['menu', 'catalog', 'price', 'cost', 'how much', 'size', 'sizes', 'do you have', 'show me', 'available'],
  order: ['order', 'want', 'need', 'buy', 'cart', 'checkout', 'deliver', 'delivery', 'reserve', 'book'],
  complaint: ['wrong', 'late', 'cold', 'complaint', 'missing', 'refund', 'problem'],
  info: ['address', 'location', 'hours', 'open', 'close', 'phone', 'contact', 'wifi', 'table'],
  compare: ['recommend', 'compare', 'difference between', 'which is'],
};

const SERVICE_EXTRA_PIPELINES = {
  real_estate: {
    search: ['property', 'unit', 'apartment', 'villa', 'bedroom', 'compound', 'listing', 'find me'],
    pricing: ['installment', 'down payment', 'deposit', 'roi', 'rent', 'payment'],
    availability: ['available', 'viewing', 'visit', 'appointment'],
  },
  ecommerce: {
    product: ['product', 'shipping', 'material', 'color', 'brand', 'stock'],
    purchase: ['buy', 'cart', 'checkout', 'order', 'return'],
  },
  clinic: {
    booking: ['appointment', 'doctor', 'clinic', 'service', 'specialization', 'visit'],
    medical_info: ['duration', 'consultation', 'branch', 'price'],
  },
};

// --- Tunable signal weights. Bump these to make the gate hungrier for AI. ---
const W = {
  dislike: 4,            // negative sentiment alone forces AI
  negation: 4,           // restriction / allergy / exclusion alone forces AI
  recommendation: 3,
  filtration: 3,
  open_question: 2,
  order_intent: 2,
  pipeline_first: 1,
  pipeline_extra_cap: 3,
  catalog_mention: 4,    // names a real menu item/category -> worth an AI answer
  greeting_compound: 1,  // greeting glued to a real request
  category_and_item: 2,  // both a category AND an item named together
  composition: 3,        // "does X contain Y" / "meat in pizza" ingredient query
  modifier_cap: 3,
  long_message: 2,       // > LONG_WORDS words
  medium_message: 1,     // > MEDIUM_WORDS words
  unknown_high: 2,
  unknown_mid: 1,
};
const MEDIUM_WORDS = 25;
const LONG_WORDS = 50;

// Negative SENTIMENT / dislike. apostrophe-free; text is contraction-expanded
// before matching (so "dont like" arrives as "do not like"). Correct spelling +
// common misspellings + Franco (Arabizi) + Arabic. ~60 entries.
const DISLIKE_TERMS = [
  // --- english (correct + misspelled) ---
  'hate', 'hates', 'hated', 'hating', 'hatin', 'i hate', 'hate it', 'h8',
  'dislike', 'dislikes', 'disliked', 'not like', 'not love', 'not a fan',
  'not into', 'cant stand', 'can not stand', 'cannot stand',
  'disgusting', 'disgustin', 'disgust', 'gross', 'grose', 'nasty', 'yuck',
  'yucky', 'eww', 'ugh', 'bleh', 'awful', 'terrible', 'terible', 'horrible',
  'horible', 'horrid', 'worst', 'lousy', 'crap', 'crappy', 'trash', 'garbage',
  'rubbish', 'sucks', 'it sucks', 'sux', 'bland', 'tasteless', 'no taste',
  'not tasty', 'not good', 'no good', 'not nice', 'not great', 'not worth',
  'waste of', 'too expensive', 'overpriced', 'over priced', 'too pricey',
  'rip off', 'ripoff', 'bad', 'so bad', 'very bad', 'too bad', 'really bad',
  'bad taste', 'bad service',
  // --- arabic ---
  '\u0628\u0643\u0631\u0647', '\u0628\u0643\u0631\u0647\u0647', '\u0627\u0643\u0631\u0647', '\u0645\u0643\u0631\u0647\u0634', '\u0645\u0628\u062d\u0628\u0634', '\u0645\u0627 \u0628\u062d\u0628\u0634', '\u0645\u0634 \u0628\u062d\u0628',
  '\u0645\u0634 \u062d\u0644\u0648', '\u0645\u0634 \u062d\u0644\u0648\u0647', '\u0648\u062d\u0634', '\u0648\u062d\u0634\u0647', '\u0632\u0641\u062a', '\u0632\u0628\u0627\u0644\u0647', '\u0633\u064a\u0626', '\u0633\u064a\u0649\u0621', '\u0633\u0626',
  '\u0645\u0642\u0631\u0641', '\u0642\u0631\u0641', '\u0645\u0642\u0631\u0641\u0647', '\u062e\u0627\u064a\u0633', '\u0645\u0634 \u0639\u0627\u062c\u0628\u0646\u064a', '\u0645\u0634 \u0644\u0630\u064a\u0630', '\u0645\u0634 \u0637\u064a\u0628', '\u0645\u0634 \u0643\u0648\u064a\u0633',
  // --- franco / arabizi ---
  'msh 7elw', 'mesh helw', 'msh helw', 'we7esh', 'we7sha', 'wehesh', 'zft',
  'zeft', 'msh 3agbni', 'msh 3ajebni', '2rf', 'mkrhsh', 'bakrah',
];

// Restriction / negation / allergy / exclusion. apostrophe-free; text is
// contraction-expanded so the boundary-safe "not" catches the whole
// doesn't/isn't/won't/can't family. ~70 entries.
const NEGATION_TERMS = [
  // --- core english (correct + misspelled) ---
  'without', 'witout', 'withot', 'withour', 'wthout', 'wihout', 'withoout',
  'no', 'none', 'nope', 'not', 'do not', 'does not', 'did not', 'is not',
  'are not', 'will not', 'can not', 'cannot',
  'except', 'apart from', 'other than', 'aside from',
  'exclude', 'excluding', 'excluded', 'exclud',
  'minus', 'hold the', 'skip', 'skip the', 'leave out', 'leave off',
  'take out', 'take off', 'remove', 'removing', 'omit',
  'free from', 'free of', 'sugar free', 'sugarfree', 'gluten free', 'glutenfree',
  'dairy free', 'dairyfree', 'lactose free', 'nut free', 'caffeine free',
  'fat free', 'decaf',
  // --- allergy / dietary (correct + misspelled) ---
  'allergic', 'allergy', 'allergies', 'alergic', 'alergy', 'alergies',
  'allergec', 'allegic', 'intolerant', 'intolerance', 'lactose', 'gluten',
  'sensitive to',
  // --- exclusion phrases ---
  'cant eat', 'can not eat', 'cannot eat', 'do not eat', 'cant have',
  'can not have', 'cannot have', 'do not have', 'does not have', 'avoid',
  'avoiding', 'does not include', 'not include', 'does not contain',
  'not contain', 'with no', 'anything but', 'something without',
  'no sugar', 'no salt', 'no ice', 'no onion', 'no garlic', 'no milk',
  'no nuts', 'no dairy', 'no meat', 'less sugar', 'less ice', 'low sugar',
  'low fat', 'low salt', 'unsweetened',
  // --- arabic ---
  '\u0628\u062f\u0648\u0646', '\u0628\u062f\u0648\u0646 \u0627\u0636\u0627\u0641\u0647', '\u0628\u062f\u0648\u0646 \u0627\u0636\u0627\u0641\u0629', '\u0645\u0646 \u063a\u064a\u0631', '\u0645\u064a\u0646 \u063a\u064a\u0631', '\u0628\u0644\u0627', '\u0628\u0644\u0627\u0634',
  '\u062e\u0627\u0644\u064a \u0645\u0646', '\u062e\u0627\u0644\u064a\u0647 \u0645\u0646', '\u062e\u0627\u0644\u064a\u0629 \u0645\u0646', '\u0644\u0627 \u064a\u062d\u062a\u0648\u064a', '\u0645\u0627 \u064a\u062d\u062a\u0648\u064a\u0634', '\u0645\u0627 \u0641\u064a\u0647\u0648\u0634',
  '\u0645\u0627 \u0641\u064a\u0634', '\u0645\u0641\u064a\u0634', '\u0646\u0627\u0642\u0635', '\u0634\u064a\u0644', '\u0627\u0644\u063a\u064a', '\u0645\u0634 \u0639\u0627\u064a\u0632', '\u0645\u0634 \u0639\u0627\u0648\u0632', '\u0645\u0645\u0646\u0648\u0639',
  '\u062d\u0633\u0627\u0633\u064a\u0647', '\u062d\u0633\u0627\u0633\u064a\u0629', '\u0639\u0646\u062f\u064a \u062d\u0633\u0627\u0633\u064a\u0647', '\u0639\u0646\u062f\u064a \u062d\u0633\u0627\u0633\u064a\u0629',
  // --- franco / arabizi ---
  'bdoun', 'bidoun', 'bdon', 'badoun', 'mn ghir', 'men gher', 'men ghair',
  'bala', 'balash', 'msh', 'mesh', 'mish', 'mafish', 'ma fish', 'ma feesh',
  'shil', '5ali mn',
];

// Phrases where a negative word is social/filler, not a real restriction.
const NEGATION_EXCEPTIONS = [
  'no problem', 'no worries', 'not bad', 'no thanks', 'no thank you',
  'not sure', 'why not', 'no rush', 'not really', 'no need', 'no doubt',
  'not yet', 'can not wait', 'cannot wait', 'cant wait',
];
const RECOMMENDATION_TERMS = [
  'recommend', 'suggest', 'best', 'better', 'most popular', 'popular',
  'difference between', 'compare', 'comparison', 'which is', 'whats good',
  'what do you think', '\u0627\u0646\u0635\u062d\u0646\u064a', '\u0627\u0641\u0636\u0644', '\u0627\u062d\u0633\u0646',
];
// Filtration / superlatives => almost always an AI [4] filter pipeline.
const FILTRATION_TERMS = [
  'cheapest', 'lowest', 'highest', 'most expensive', 'priciest', 'biggest',
  'smallest', 'largest', 'low to high', 'high to low', 'sort by', 'sorted by',
  'under', 'below', 'less than', 'more than', 'between', 'top rated',
  '\u0627\u0631\u062e\u0635', '\u0627\u063a\u0644\u0649', '\u0627\u0643\u0628\u0631', '\u0627\u0635\u063a\u0631',
];
const MODIFIER_TERMS = ['but', 'and also', 'with extra', 'instead of', 'as well', 'plus', 'add', 'extra', 'w kaman', 'w bdoun', 'zeyada'];
const OPEN_QUESTION_TERMS = ['why', 'how come', 'what would you', 'what should i', 'is it worth', 'suitable for', 'good for', 'tell me about', 'which one'];
const ORDER_INTENT_RE = {
  en: /(^|[^a-z])(order|place order|make order|i want to order|i wanna order|can i order|delivery order|take my order|checkout|add to cart)([^a-z]|$)/i,
  ar: /(\u0627\u0637\u0644\u0628|\u0623\u0637\u0644\u0628|\u0639\u0627\u064a\u0632 \u0627\u0637\u0644\u0628|\u0639\u0627\u0648\u0632 \u0627\u0637\u0644\u0628|\u062d\u0627\u0628\u0628 \u0627\u0637\u0644\u0628|\u0628\u062f\u064a \u0627\u0637\u0644\u0628|\u0623\u0648\u0631\u062f\u0631|\u0627\u0648\u0631\u062f\u0631)/,
};

// Compositional / ingredient / "what's in it" questions about a catalog item.
// Rules can't reason over an item's contents \u2014 only AI can. All these shapes
// require a catalog item nearby (gated by hasCatalogMention at the call site)
// so generic "in/on" usage never fires. do=does=did, has=have=had treated alike.
//
//   1. Containment cue words (strong on their own): inside / within / into /
//      contain / include / ingredient / made of / topped with / ...
//   2. "<item> have/has/got/contain <ingredient>" \u2014 but NOT the vendor shape
//      "do YOU have <item>" (existence). The (?!you|we|they|i) guard splits them.
//   3. "<word> in/on <item>"  ("meat in pizza"), skipping time/place fillers.
const CONTAINMENT_CUES_RE = /\b(inside|within|into|contains?|contained|containing|includes?|included|including|ingredients?|made\s+(?:of|with|from)|topped\s+with|stuffed\s+with|filled\s+with|served\s+with|loaded\s+with|comes?\s+with)\b/i;
const ITEM_HAS_RE = /\b(?:do|does|did|is|are|was|were|can|could|will|would|has|have)\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+|a\s+|an\s+|your\s+|their\s+|its\s+)?(?!you\b|u\b|we\b|they\b|i\b|ya\b|guys\b)([a-z\u0600-\u06ff]{2,})\s+(?:have|has|had|got|hold|holds|contain|contains|containing|include|includes|come|comes)\b/i;
const PREP_BETWEEN_RE = /\b[a-z\u0600-\u06ff]{2,}\s+(?:in|on)\s+(?:the\s+|a\s+|an\s+|my\s+|your\s+)?(?!morning|afternoon|evening|night|advance|stock|future|area|branch|store|shop|town|city|street|menu)[a-z\u0600-\u06ff]{2,}\b/i;

function looksLikeCompositionQuery(text) {
  return CONTAINMENT_CUES_RE.test(text) || ITEM_HAS_RE.test(text) || PREP_BETWEEN_RE.test(text);
}

// Chat-speak / abbreviation expansion so "do u have" reads as "do you have",
// "wanna order" as "want to order", etc. Same spirit as dont -> don't.
const ABBREVIATIONS = {
  u: 'you', ur: 'your', r: 'are', n: 'and', pls: 'please', plz: 'please',
  thx: 'thanks', thnx: 'thanks', wanna: 'want to', gonna: 'going to',
  gimme: 'give me', lemme: 'let me', wat: 'what', wats: 'whats', y: 'why',
};

// Negative contractions (apostrophes already stripped) -> "<aux> not" so the
// single boundary-safe "not" rule catches the ENTIRE family: doesn't, isn't,
// won't, can't, haven't... plus common misspellings (dnt, dosent, cnt).
const NEGATIVE_CONTRACTIONS = {
  dont: 'do not', dnt: 'do not',
  doesnt: 'does not', dosent: 'does not', desnt: 'does not', doesent: 'does not',
  didnt: 'did not',
  isnt: 'is not', arent: 'are not', aint: 'is not',
  wasnt: 'was not', werent: 'were not',
  wont: 'will not', willnt: 'will not',
  cant: 'can not', cannot: 'can not', cnt: 'can not', cantt: 'can not', caint: 'can not',
  couldnt: 'could not', wouldnt: 'would not', shouldnt: 'should not',
  havent: 'have not', hasnt: 'has not', hadnt: 'had not',
  neednt: 'need not', mustnt: 'must not', shant: 'shall not',
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a matcher that respects word boundaries for single words (so "not"
// never matches inside "another") and uses substring for multi-word phrases.
function buildMatcher(term) {
  const value = String(term || '').trim();
  if (!value) return () => false;
  if (/\s/.test(value)) {
    return (text) => text.includes(value);
  }
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(value)}([^\\p{L}\\p{N}]|$)`, 'u');
  return (text) => re.test(text);
}

function compile(terms) {
  return terms.map(buildMatcher);
}

function anyMatch(text, matchers) {
  return matchers.some((m) => m(text));
}

function countMatch(text, matchers) {
  return matchers.reduce((count, m) => count + (m(text) ? 1 : 0), 0);
}

const DISLIKE_M = compile(DISLIKE_TERMS);
const NEGATION_M = compile(NEGATION_TERMS);
const NEGATION_EXCEPTION_M = compile(NEGATION_EXCEPTIONS);
const RECOMMENDATION_M = compile(RECOMMENDATION_TERMS);
const FILTRATION_M = compile(FILTRATION_TERMS);
const MODIFIER_M = compile(MODIFIER_TERMS);
const OPEN_QUESTION_M = compile(OPEN_QUESTION_TERMS);

// Strip apostrophes so "don't" === "dont", expand negative contractions
// ("doesnt" -> "does not") and chat-speak, then normalize.
function scoringNormalize(text, lang) {
  const normalized = normalize(String(text || '').replace(/[\u2019'`]/g, ''), lang);
  return normalized.replace(/\b[a-z]+\b/g, (word) => NEGATIVE_CONTRACTIONS[word] || ABBREVIATIONS[word] || word);
}

function thresholdFor(serviceType) {
  if (serviceType === 'real_estate') return 3;
  if (serviceType === 'clinic') return 2;
  return 4;
}

function getKnownPipelines(serviceType) {
  return {
    ...BASE_PIPELINES,
    ...(SERVICE_EXTRA_PIPELINES[serviceType] || {}),
  };
}

const pipelineMatcherCache = new Map();
function getPipelineMatchers(serviceType) {
  if (pipelineMatcherCache.has(serviceType)) return pipelineMatcherCache.get(serviceType);
  const compiled = Object.entries(getKnownPipelines(serviceType))
    .map(([name, terms]) => [name, compile(terms)]);
  pipelineMatcherCache.set(serviceType, compiled);
  return compiled;
}

// Detect whether the message mentions a real catalog item and/or category.
// Cached per business; rebuilt when the catalog size changes.
const catalogSignatureCache = new Map();
function getCatalogSignature(businessId) {
  const items = getBusinessItems(businessId) || [];
  const cached = catalogSignatureCache.get(businessId);
  if (cached && cached.count === items.length) return cached.sig;

  const itemPhrases = new Set();
  const categoryPhrases = new Set();
  const itemTokens = new Set();
  const categoryTokens = new Set();

  items.forEach((item) => {
    [[item.title_en, 'en'], [item.title_ar, 'ar']].forEach(([value, l]) => {
      const phrase = scoringNormalize(value, l);
      if (!phrase) return;
      itemPhrases.add(phrase);
      tokenize(phrase).forEach((token) => { if (token.length > 2) itemTokens.add(token); });
    });
    [[item.category_en, 'en'], [item.category_ar, 'ar']].forEach(([value, l]) => {
      const phrase = scoringNormalize(value, l);
      if (!phrase) return;
      categoryPhrases.add(phrase);
      tokenize(phrase).forEach((token) => { if (token.length > 2) categoryTokens.add(token); });
    });
  });

  const sig = { itemPhrases, categoryPhrases, itemTokens, categoryTokens };
  catalogSignatureCache.set(businessId, { count: items.length, sig });
  return sig;
}

function collectKnownTokens({ serviceType, businessId, lang }) {
  const known = new Set();
  const add = (value) => tokenize(scoringNormalize(String(value || ''), lang)).forEach((token) => known.add(token));
  Object.values(getKnownPipelines(serviceType)).flat().forEach(add);
  [
    ...NEGATION_TERMS, ...DISLIKE_TERMS, ...RECOMMENDATION_TERMS,
    ...FILTRATION_TERMS, ...MODIFIER_TERMS, ...OPEN_QUESTION_TERMS,
    'large', 'medium', 'small', 'hot', 'cold', 'spicy', 'sweet',
  ].forEach(add);

  getBusinessItems(businessId).forEach((item) => {
    Object.entries(item).forEach(([key, value]) => {
      if (key === 'metadata') return;
      add(key);
      add(value);
    });
    Object.entries(item.metadata || {}).forEach(([key, value]) => {
      add(key);
      if (Array.isArray(value)) value.forEach(add);
      else if (value && typeof value === 'object') Object.values(value).forEach(add);
      else add(value);
    });
  });
  return known;
}

function assessAiRoutingNeed({ text, lang, business }) {
  const serviceType = String(business.service_type || 'cafe');
  const compactText = scoringNormalize(text, lang).trim();
  const messageTokens = tokenize(compactText);
  const reasons = [];
  let score = 0;

  if (STATIC_TEXT.has(compactText)) {
    return { score: 0, threshold: thresholdFor(serviceType), route: 'static', reasons: ['static_text'] };
  }

  const isException = anyMatch(compactText, NEGATION_EXCEPTION_M);

  if (!isException && anyMatch(compactText, DISLIKE_M)) {
    score += W.dislike;
    reasons.push('dislike_sentiment');
  }
  if (!isException && anyMatch(compactText, NEGATION_M)) {
    score += W.negation;
    reasons.push('negation_or_restriction');
  }

  // Catalog awareness: count an item/category mention as its own pipeline so
  // compound messages ("hi i want to order a pizza") escalate correctly.
  const sig = getCatalogSignature(business.id);
  const tokenSet = new Set(messageTokens);
  const hasCategory = [...sig.categoryPhrases].some((p) => p.length > 2 && compactText.includes(p))
    || [...tokenSet].some((t) => sig.categoryTokens.has(t));
  // A *specific* item = a full item title, or an item word that is NOT just the
  // category word (e.g. "almond"/"shrimp", not the shared word "pizza").
  const hasItemSpecific = [...sig.itemPhrases].some((p) => p.length > 2 && compactText.includes(p))
    || [...tokenSet].some((t) => sig.itemTokens.has(t) && !sig.categoryTokens.has(t));
  const hasCatalogMention = hasCategory || hasItemSpecific;

  const pipelineHits = getPipelineMatchers(serviceType)
    .filter(([, matchers]) => anyMatch(compactText, matchers))
    .map(([name]) => name);
  if (hasCatalogMention) pipelineHits.push('item_inquiry');

  // Naming a real menu item/category is a strong signal on its own — route it
  // to the AI so paraphrases ("pizza with something from the sea", Arabic
  // "بيتزا فيها جمبري") get a real answer instead of a keyword guess.
  if (hasCatalogMention) {
    score += W.catalog_mention;
    reasons.push('catalog_mention');
  }

  if (pipelineHits.length > 0) {
    score += W.pipeline_first;
    const extra = Math.min(pipelineHits.length - 1, W.pipeline_extra_cap);
    if (extra > 0) score += extra;
    reasons.push(`pipelines:${pipelineHits.join(',')}`);
  }
  if (pipelineHits.includes('welcome') && pipelineHits.length > 1) {
    score += W.greeting_compound;
    reasons.push('greeting_compound');
  }
  // Both a category AND a distinct item named together => filter-ish, needs AI.
  if (hasCategory && hasItemSpecific) {
    score += W.category_and_item;
    reasons.push('category_and_item');
  }

  // Ingredient / composition question about a catalog item ("meat in pizza",
  // "does the pizza have cheese inside") — rules can't reason over contents.
  if (hasCatalogMention && looksLikeCompositionQuery(compactText)) {
    score += W.composition;
    reasons.push('composition_query');
  }

  const orderIntent = ORDER_INTENT_RE.en.test(compactText) || ORDER_INTENT_RE.ar.test(String(text || ''));
  if (orderIntent) {
    score += W.order_intent;
    reasons.push('order_intent');
  }

  if (anyMatch(compactText, RECOMMENDATION_M)) {
    score += W.recommendation;
    reasons.push('recommendation_or_comparison');
  }
  if (anyMatch(compactText, FILTRATION_M)) {
    score += W.filtration;
    reasons.push('filtration_or_superlative');
  }

  const modifierCount = Math.min(countMatch(compactText, MODIFIER_M), W.modifier_cap);
  if (modifierCount) {
    score += modifierCount;
    reasons.push(`modifiers:${modifierCount}`);
  }

  if (anyMatch(compactText, OPEN_QUESTION_M)) {
    score += W.open_question;
    reasons.push('open_question');
  }

  if (serviceType === 'real_estate') {
    if (/\b(installment|down payment|deposit|payment|roi)\b/i.test(compactText)) score += 1;
    if (/\b(near|close to|beside|around)\b/i.test(compactText)) score += 1;
    if (/\b(at least|minimum|not less than|under|below|not more than)\b/i.test(compactText)) score += 2;
    if (/\b(by|before|within)\b/i.test(compactText)) score += 1;
  }

  const wordCount = messageTokens.length;
  if (wordCount > LONG_WORDS) {
    score += W.long_message;
    reasons.push('long_message');
  } else if (wordCount > MEDIUM_WORDS) {
    score += W.medium_message;
    reasons.push('medium_message');
  }

  const knownTokens = collectKnownTokens({ serviceType, businessId: business.id, lang });
  const meaningfulTokens = messageTokens.filter((token) => token.length > 1 && !STOPWORDS.has(token));
  if (meaningfulTokens.length >= 3) {
    const unknownCount = meaningfulTokens.filter((token) => !knownTokens.has(token)).length;
    const unknownRatio = unknownCount / meaningfulTokens.length;
    if (unknownRatio > 0.65) {
      score += W.unknown_high;
      reasons.push('unknown_tokens_high');
    } else if (unknownRatio > 0.4) {
      score += W.unknown_mid;
      reasons.push('unknown_tokens_medium');
    }
  }

  const threshold = thresholdFor(serviceType);
  return {
    score: Math.min(score, 10),
    threshold,
    route: score >= threshold ? 'ai' : 'rules',
    reasons,
  };
}

function getAiApiUrl() {
  const base = process.env.AI_API_URL || process.env.AI_CALLBACK_API_URL || '';
  if (!base.trim()) return '';
  return base.replace(/\/+$/, '') + '/chat';
}

function getAiSecret() {
  return process.env.AI_API_SECRET || process.env.AI_SECRET_KEY || process.env.SECRET_KEY || '';
}

function isAiEnabledForBusiness(business) {
  return Number(business.ai_enabled) === 1 && Boolean(getAiApiUrl()) && Boolean(getAiSecret());
}

function flattenValue(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
}

function buildAiSourceData(businessId) {
  return getBusinessItems(businessId).map((item) => {
    const source = {
      id: item.id,
      name: item.title_en || item.title_ar,
      name_ar: item.title_ar || '',
      category: item.category_en || item.category_ar || '',
      category_ar: item.category_ar || '',
      description: item.description_en || item.description_ar || '',
      description_ar: item.description_ar || '',
      price: item.price,
      currency: item.currency,
      available: Number(item.available) !== 0,
    };
    Object.entries(item.metadata || {}).forEach(([key, value]) => {
      source[key] = flattenValue(value);
    });
    return source;
  });
}

async function callAiClassifier({ text, business, session }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(getAiApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAiSecret()}`,
      },
      body: JSON.stringify({
        prompt: text,
        service_type: business.service_type || 'cafe',
        customer_name: session.guest_name || '',
        customer_phone: session.guest_phone || '',
        stream: false,
        // Only override the model when explicitly set; otherwise let the AI
        // service pick the default for its active provider (openai/ollama).
        ...(process.env.AI_MODEL ? { model: process.env.AI_MODEL } : {}),
        temperature: Number(process.env.AI_TEMPERATURE || 0.7),
        max_tokens: Number(process.env.AI_MAX_TOKENS || 200),
        // Classifier only needs the queryable shape, not the rows — keeps the
        // request tiny (~hundreds of tokens instead of the whole catalog).
        source_data: buildCatalogSchema(business.id),
      }),
      signal: controller.signal,
    });

    const elapsed_ms = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, elapsed_ms, error: `status_${response.status}` };
    }
    const data = await response.json();
    return {
      ok: true,
      elapsed_ms,
      raw: String(data.response || '').split('\n')[0].trim(),
      from_cache: Boolean(data.from_cache),
      usage: data.usage || null,
      model: data.model || null,
    };
  } catch (error) {
    return {
      ok: false,
      elapsed_ms: Date.now() - startedAt,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Answer mode: send the menu + message and let the AI write the final reply
// (understands typos/meaning, includes vs excludes correctly). Returns the
// full multi-line text, not a classifier code.
// Tiny schema for the classifier: category names + sortable field keys only.
// No item rows -> the classify request stays at a few hundred tokens.
function buildCatalogSchema(businessId) {
  const items = getBusinessItems(businessId);
  const categories = [...new Set(items.map((i) => i.category_en || i.category_ar).filter(Boolean))];
  const fields = new Set(['price']);
  items.forEach((i) => Object.keys(i.metadata || {}).forEach((k) => fields.add(k)));
  return { categories, sortable_fields: [...fields] };
}

// Lean menu for answer mode. Optionally narrowed to a category (from the
// classifier) so we send ~a handful of items instead of all 179. Drops
// size_details/thumbnails and trims descriptions to keep the payload small.
function buildAiAnswerData(businessId, categoryHint) {
  let items = getBusinessItems(businessId);
  if (categoryHint) {
    const needle = String(categoryHint).toLowerCase().trim();
    const narrowed = items.filter((i) =>
      String(i.category_en || '').toLowerCase().includes(needle)
      || String(i.category_ar || '').toLowerCase().includes(needle)
      || String(i.title_en || '').toLowerCase().includes(needle)
      || String(i.title_ar || '').toLowerCase().includes(needle));
    if (narrowed.length) items = narrowed; // only narrow when it actually matched
  }
  return items.map((item) => ({
    name: item.title_en || item.title_ar,
    name_ar: item.title_ar || '',
    category: item.category_en || item.category_ar || '',
    price: item.price,
    currency: item.currency,
    description: String(item.description_en || '').slice(0, 90),
  }));
}

async function callAiAnswer({ text, business, session, lang, categoryHint }) {
  const controller = new AbortController();
  // Answer mode writes a full reply, so it needs more headroom than the
  // single-line classifier; default 20s, tunable via AI_ANSWER_TIMEOUT_MS.
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_ANSWER_TIMEOUT_MS || 20000));
  const startedAt = Date.now();

  try {
    const response = await fetch(getAiApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAiSecret()}`,
      },
      body: JSON.stringify({
        prompt: text,
        mode: 'answer',
        language: lang === 'ar' ? 'Arabic' : 'English',
        service_type: business.service_type || 'cafe',
        customer_name: session.guest_name || '',
        customer_phone: session.guest_phone || '',
        stream: false,
        ...((process.env.AI_ANSWER_MODEL || process.env.AI_MODEL)
          ? { model: process.env.AI_ANSWER_MODEL || process.env.AI_MODEL }
          : {}),
        temperature: Number(process.env.AI_ANSWER_TEMPERATURE || 0.2),
        max_tokens: Number(process.env.AI_ANSWER_MAX_TOKENS || 600),
        source_data: buildAiAnswerData(business.id, categoryHint),
      }),
      signal: controller.signal,
    });

    const elapsed_ms = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, elapsed_ms, error: `status_${response.status}` };
    }
    const data = await response.json();
    return {
      ok: true,
      elapsed_ms,
      text: String(data.response || '').trim(),
      from_cache: Boolean(data.from_cache),
      usage: data.usage || null,
      model: data.model || null,
    };
  } catch (error) {
    return {
      ok: false,
      elapsed_ms: Date.now() - startedAt,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseAiPipeline(raw) {
  const line = String(raw || '').trim();
  let match = line.match(/^\[(\d)\]\s*(.*)$/);
  if (!match) return { valid: false, raw: line };

  const code = Number(match[1]);
  const body = match[2] || '';
  if (code < 1 || code > 10) return { valid: false, raw: line };

  if (code === 4) {
    const fields = {};
    const fieldMatch = body.match(/^item=(.*?) category=(.*?) sort_by=(.*?) order=(.*?) exclude=(.*)$/);
    if (!fieldMatch) return { valid: false, raw: line };
    ['item', 'category', 'sort_by', 'order', 'exclude'].forEach((key, index) => {
      fields[key] = String(fieldMatch[index + 1] || '').trim();
    });
    if (fields.order && !['asc', 'desc'].includes(fields.order)) return { valid: false, raw: line };
    return { valid: true, code, fields, raw: line };
  }

  const patterns = {
    1: /^welcome message$/,
    2: /^searching for (.+) from list of items$/,
    3: /^looking for all items from category (.+)$/,
    5: /^looking for items doesn't include (.+)$/,
    6: /^wants to make an order$/,
    7: /^wants to know full details about (.+)$/,
    8: /^wants to inquire (.+) about (.+)$/,
    9: /^not found$/,
    10: /^faq lookup$/,
  };

  match = body.match(patterns[code]);
  if (!match) return { valid: false, raw: line };

  return {
    valid: true,
    code,
    item: match[1] || '',
    detail: code === 8 ? match[1] || '' : '',
    itemForDetail: code === 8 ? match[2] || '' : '',
    raw: line,
  };
}

module.exports = {
  assessAiRoutingNeed,
  buildAiSourceData,
  callAiClassifier,
  callAiAnswer,
  recordAiCall,
  isAiEnabledForBusiness,
  parseAiPipeline,
};
