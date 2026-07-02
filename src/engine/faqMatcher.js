'use strict';

// Per-brand FAQ matcher. Each business stores two independent FAQ lists
// (faq_en / faq_ar), picked by the language the customer is talking in.
// Matching is intentionally "weak": loose keyword overlap, NOT exact phrasing.
// To avoid false hits (e.g. a lone word like "table"), an answer is only
// returned when at least FAQ_MIN_OVERLAP distinct question keywords appear in
// the customer message.

const { normalize, tokenize } = require('./detector');

// Min distinct matched keywords before an FAQ answer fires. 2 is the sweet
// spot: lone words ("table", "wifi") never match, but real short questions
// ("is the meat halal") do. Bump to 3 for stricter precision.
const FAQ_MIN_OVERLAP = Number(process.env.FAQ_MIN_KEYWORD_OVERLAP || 2);

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'is', 'are',
  'am', 'be', 'do', 'does', 'did', 'to', 'for', 'of', 'in', 'on', 'at', 'and',
  'or', 'but', 'with', 'about', 'what', 'whats', 'which', 'how', 'can', 'could',
  'would', 'should', 'will', 'this', 'that', 'there', 'here', 'have', 'has',
  'had', 'much', 'many', 'please', 'pls', 'it', 'its', 'from', 'us', 'so',
  'if', 'any', 'get', 'got', 'tell', 'know', 'give', 'want', 'need',
  // Conversational filler — never carries FAQ meaning on its own
  'lets', 'let', 'ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'no', 'now',
  'just', 'go', 'well', 'hmm', 'hm',
  // Arabic (light)
  'في', 'من', 'على', 'و', 'هل', 'ما', 'هي', 'هو', 'ان', 'انا', 'عن', 'مع',
  'الى', 'ايه', 'ايش', 'ليه', 'فيه', 'عندكم', 'عندك',
]);

function parseFaqList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Light stem so plurals/derivations unify: cars->car, deliveries->delivery.
function stem(token) {
  return token
    .replace(/ies$/, 'y')
    .replace(/(ches|shes|xes|ses)$/, (m) => m.slice(0, -2))
    .replace(/s$/, '')
    .replace(/ing$/, '');
}

// Two keywords match if equal, share a stem, or share a 4-char prefix
// (handles reserve/reservation, book/booking) — deliberately loose.
function keywordsMatch(a, b) {
  if (a === b) return true;
  if (stem(a) === stem(b)) return true;
  return a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4);
}

function keywordSet(text, lang) {
  const stripped = String(text || '').replace(/[’'`]/g, '');
  const tokens = tokenize(normalize(stripped, lang));
  const set = new Set();
  for (const token of tokens) {
    if (token.length > 1 && !STOPWORDS.has(token)) set.add(token);
  }
  return set;
}

// Generic words too vague to answer an FAQ on their own. A lone "table" or
// "menu" must NOT match (handled by the menu/rules pipeline), but a lone
// distinctive word like "wifi"/"parking"/"halal" can.
const GENERIC_WORDS = new Set([
  'table', 'menu', 'food', 'foods', 'order', 'orders', 'price', 'prices',
  'cost', 'costs', 'hour', 'hours', 'open', 'close', 'place', 'item', 'items',
  'drink', 'drinks', 'meal', 'meals', 'cafe', 'restaurant', 'here', 'today',
  'time', 'want', 'need', 'give', 'thing', 'something', 'anything', 'stuff',
  'available', 'info',
  // Conversation verbs that appear inside FAQ questions but say nothing about
  // WHICH question ("so lets start" must not hit "...does the wholesale price
  // start"; "help me find my product" must not hit a product FAQ).
  'start', 'starts', 'starting', 'begin', 'begins', 'help', 'find',
  'product', 'products', 'question', 'questions', 'store', 'shop', 'buy',
]);

function isDistinctive(word) {
  return word.length >= 4 && !GENERIC_WORDS.has(word);
}

// Returns { question, answer, overlap } for the best matching FAQ, or null.
function matchFaq({ text, lang, business }) {
  const list = parseFaqList(lang === 'ar' ? business.faq_ar : business.faq_en)
    .map((entry) => ({
      q: String(entry.q || entry.question || '').trim(),
      a: String(entry.a || entry.answer || '').trim(),
    }))
    .filter((entry) => entry.q && entry.a);

  if (!list.length) return null;

  const messageKeywords = keywordSet(text, lang);
  if (messageKeywords.size === 0) return null;

  const messageWords = [...messageKeywords];
  // A short focused question ("do you have wifi") may match on ONE distinctive
  // keyword; otherwise require the full FAQ_MIN_OVERLAP count.
  const shortFocused = messageWords.length <= 2;

  let best = null;
  for (const entry of list) {
    const questionKeywords = keywordSet(entry.q, lang);
    let overlap = 0;
    let distinctiveHit = false;
    for (const qword of questionKeywords) {
      const matched = messageWords.find((m) => keywordsMatch(qword, m));
      if (matched) {
        overlap += 1;
        if (isDistinctive(matched)) distinctiveHit = true;
      }
    }
    const accept = overlap >= FAQ_MIN_OVERLAP
      || (overlap >= 1 && shortFocused && distinctiveHit);
    if (accept && (!best || overlap > best.overlap)) {
      best = { question: entry.q, answer: entry.a, overlap };
    }
  }
  return best;
}

module.exports = { matchFaq, parseFaqList, FAQ_MIN_OVERLAP };
