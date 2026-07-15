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
     prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_usd, from_cache,
     full_input, full_output)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Log one AI call (classify/answer) for the AI Usage dashboard. Non-fatal.
// We keep the full message, the exact rendered prompt (full_input) and the
// model's full output (full_output) so a call can be opened and diagnosed.
function recordAiCall({ businessId, sessionId, message, mode, result }) {
  try {
    const u = (result && result.usage) || {};
    const prompt = Number(u.prompt_tokens || 0);
    const completion = Number(u.completion_tokens || 0);
    const total = Number(u.total_tokens || prompt + completion);
    const cached = Number(
      (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
      (result && result.cached_tokens) || 0,
    );
    const model = (result && result.model) || null;
    insertAiCall.run(
      businessId,
      sessionId || null,
      message != null ? String(message) : null,
      mode,
      model,
      Number((result && result.elapsed_ms) || 0),
      prompt,
      completion,
      total,
      cached,
      estimateCost(model, prompt, completion),
      result && result.from_cache ? 1 : 0,
      (result && result.final_prompt) || null,
      (result && result.raw_response) || null,
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
  greeting_compound: 1,  // greeting glued to a real request
  category_and_item: 2,  // both a category AND an item named together
  composition: 3,        // "does X contain Y" / "meat in pizza" ingredient query
  item_question: 2,      // "does/is/can ... <item> ...?" that isn't "do you have X"
  followup_context: 4,   // "what's the ingredient?" / "is it spicy?" — refers to a prior item
  modifier_cap: 3,
  long_message: 2,       // > LONG_WORDS words
  medium_message: 1,     // > MEDIUM_WORDS words
  unknown_high: 2,
  unknown_mid: 1,
  help_intent: 4,        // "can i ask" / "i need help" — explicit, forces AI
  bare_question: 3,      // a real question no pipeline/catalog could classify
  consequence: 4,        // "what happens if i eat X" / "is it safe" — forces AI
  multi_item: 2,         // two+ distinct items named together — rules do only one
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

// Explicit meta / help intent: the user is asking to ask, or asking for help.
// There is no keyword pipeline for "can i ask a question" / "i need help" — it's
// a conversational turn only the AI can carry — so any hit forces AI on its own.
const HELP_INTENT_TERMS = [
  // --- english ---
  'can i ask', 'could i ask', 'may i ask', 'can i ask you', 'let me ask',
  'i want to ask', 'i wanna ask', 'i would like to ask', 'i have a question',
  'i have question', 'i got a question', 'got a question', 'quick question',
  'a question', 'ask you something', 'ask a question', 'ask question',
  'i need help', 'need help', 'help me', 'can you help', 'could you help',
  'i need assistance', 'assist me', 'i was wondering', 'wondering if',
  'do you know', 'question for you',
  // --- arabic ---
  'ممكن اسأل', 'ممكن أسأل', 'ممكن اسال', 'عايز اسأل', 'عاوز اسأل',
  'عندي سؤال', 'عندى سؤال', 'عايز اسال', 'محتاج مساعده', 'محتاج مساعدة',
  'ممكن مساعده', 'ممكن مساعدة', 'ساعدني', 'ساعدنى', 'اسألك', 'عايز اسألك',
  // --- franco / arabizi ---
  'momken as2al', 'momken as2alak', 'momken asal', '3ayez as2al', '3awez as2al',
  '3andi so2al', '3andy so2al', 'sa3edni', 'momken mosa3da', 'me7tag mosa3da',
];

// Broad interrogative shape used by the bare-question signal: a wh-opener
// anywhere, or (with QUESTION_AUX_RE / "?") a yes/no question.
const WH_QUESTION_RE = /\b(what|whats|where|when|who|whom|whose|why|how)\b/i;

// Tolerant help/meta intent — survives filler the literal HELP_INTENT_TERMS
// miss ("i need SOME help HERE", "can you please help me out"). Catches
// need/want/require ... help, help ... (here|me|out), and can/could you help.
const HELP_INTENT_RE = /\b(?:need|want|require|looking\s+for)\b[\w\s]{0,15}\bhelp\b|\bhelp\b[\w\s]{0,10}\b(?:here|me|out|please|pls|asap)\b|\b(?:can|could|would|will)\s+(?:you|u|ya|someone|anyone)\s+(?:please\s+)?help\b/i;

// Consequence / hypothetical / dietary-advice questions ("what happens if i eat
// X", "is it safe", "will it make me sick", "should i drink this"). Rules can
// NEVER answer these and a fuzzy item lookup is actively harmful (an "egg"
// health question must not return a smoothie). Forces AI regardless of catalog.
// Runs on the normalized text, so gonna->going to / wanna->want to already done.
const CONSEQUENCE_RE = new RegExp([
  'what\\s+(?:is\\s+going\\s+to\\s+|will\\s+|would\\s+|is\\s+|does\\s+|do\\s+)?happens?',
  'happens?\\s+(?:if|when|after)',
  '\\bif\\s+i\\s+(?:eat|ate|drink|drank|have|had|take|took|try|tried|mix|order|get|use)\\b',
  'is\\s+it\\s+(?:safe|healthy|ok|okay|fine|bad|good\\s+for|harmful|dangerous)',
  'will\\s+it\\s+(?:make|cause|hurt|affect|harm|help|give)',
  'side\\s+effects?',
  'should\\s+i\\s+(?:eat|drink|have|take|try|avoid|get|mix|order)',
  'can\\s+i\\s+(?:eat|drink|have|take|mix)\\b',
  'make\\s+me\\s+(?:sick|fat|ill|sleepy|full)',
  'good\\s+for\\s+(?:me|my|you|health|diet)',
  'bad\\s+for\\s+(?:me|my|you|health|teeth|stomach)',
].join('|'), 'i');
const CONSEQUENCE_AR_RE = /(هيحصل|هايحصل|يحصل ايه|حيصير|لو اكلت|لو شربت|لو اكل|لو شرب|ينفع اكل|ينفع اشرب|مضر|اضرار|اعراض جانبيه|امن|آمن|صحي|كويس لصحتي|وحش لصحتي)/;

// Interrogative openers (yes/no questions). When asked ABOUT a catalog item
// ("does the pizza have cheese", "is the latte sweet") these usually need AI to
// reason — the keyword pipeline can only match/list, not judge contents/quality.
const QUESTION_AUX_RE = /^(?:do|does|did|is|are|was|were|can|could|would|will|should|may|might|has|have)\b/i;
const QUESTION_AR_RE = /(?:^|\s)هل\s/; // Arabic yes/no particle "hal"
// Plain existence / availability — "do you have X", "is there X", "available".
// The keyword pipeline answers these fine, so they must NOT trigger the AI
// question boost even though they start with an interrogative.
const EXISTENCE_RE = /\b(?:do|does|did|are|is)\s+(?:you|u|ya|yall|we|they|guys)\b|\b(?:is|are)\s+there\b|\b(?:available|in\s+stock)\b|\bdo\s+you\s+(?:have|sell|offer|serve|carry|got|make)\b/i;

// Context-dependent follow-ups: a property/inquiry that names NO item of its own
// ("what's the ingredient?", "is it spicy?", "and the price?"). Only resolvable
// against the previous turn, so the gate routes them to AI when history exists.
const FOLLOWUP_PROP_RE = /\b(ingredient|ingredients|contain|contains|recipe|made|topping|toppings|price|cost|calorie|calories|size|spicy|vegan|vegetarian|halal|gluten|detail|details)\b/i;
const ANAPHOR_RE = /\b(this|that|it|its|them|these|those|same)\b/i;
const ANAPHOR_AR_RE = /(ده|دى|دي|دا|هذا|هذه|نفس|فيها|فيه|مكونات|سعر)/;
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
const ITEM_HAS_RE = /\b(?:do|does|did|is|are|was|were|can|could|will|would|has|have)\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+|a\s+|an\s+|your\s+|their\s+|its\s+)?(?!you\b|u\b|we\b|they\b|i\b|ya\b|guys\b)([a-z\u0600-\u06ff]{2,})\s+(?:(?:mainly|really|actually|usually|normally|typically|generally|even|only|just|also|always|still|truly|honestly)\s+)?(?:have|has|had|got|hold|holds|contain|contains|containing|include|includes|come|comes)\b/i;
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
const HELP_INTENT_M = compile(HELP_INTENT_TERMS);

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

function assessAiRoutingNeed({ text, lang, business, hasContext = false }) {
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

  // TWO+ distinct items named, split by a list separator (, | / &) or "and"
  // ("Creamy Pesto Chicken | Tomato Soup", "the latte and the tomato soup"). The
  // keyword rules can only detail ONE item, so a multi-item ask must reach AI.
  const itemSegments = compactText
    .split(/\s*(?:[,|/&]|\band\b)\s*/i)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .filter((seg) => {
      const segTokens = new Set(tokenize(seg));
      return [...sig.itemPhrases].some((p) => p.length > 2 && seg.includes(p))
        || [...segTokens].some((t) => sig.itemTokens.has(t) && !sig.categoryTokens.has(t));
    }).length;
  if (itemSegments >= 2) {
    score += W.multi_item;
    reasons.push('multi_item');
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

  // Tricky interrogatives — "does/do/did/is/are/can ... <item> ...?" — almost
  // always need AI to reason. We DON'T fire for a plain "do you have pizza"
  // existence check (the keyword pipeline handles that), and only when a real
  // catalog item/category is named so it can't fire cross-domain. Length is a
  // secondary tie-breaker: a fuller question is a stronger AI signal than a
  // three-word "is pizza spicy".
  const isQuestion = QUESTION_AUX_RE.test(compactText) || QUESTION_AR_RE.test(String(text || ''));
  const isExistence = EXISTENCE_RE.test(compactText);
  if (isQuestion && !isExistence && !orderIntent && hasCatalogMention) {
    score += W.item_question;
    reasons.push('item_question');
    if (messageTokens.length >= 4) {
      score += 1;
      reasons.push('item_question_detailed');
    }
  }

  // Explicit help / meta intent ("can i ask a question", "i need some help
  // here"). No keyword pipeline covers it; the tolerant regex backs up the
  // literal list so filler words ("some", "please") don't defeat the match.
  if (anyMatch(compactText, HELP_INTENT_M) || HELP_INTENT_RE.test(compactText)) {
    score += W.help_intent;
    reasons.push('help_intent');
  }

  // Consequence / hypothetical / dietary-advice question. Rules can't answer it
  // and a fuzzy item lookup would be misleading, so force AI even when a catalog
  // word happens to appear ("if i eat egg what happens" must NOT return an item).
  if (CONSEQUENCE_RE.test(compactText) || CONSEQUENCE_AR_RE.test(String(text || ''))) {
    score += W.consequence;
    reasons.push('consequence_query');
  }

  // Bare question the rules couldn't classify: a genuine interrogative (wh-word,
  // yes/no aux, or trailing "?") that hit NO pipeline and names NO catalog item.
  // By definition the keyword engine has no answer for it, so escalate to AI.
  // A plain existence check ("do you have X") and order intent are excluded —
  // rules handle those. Tiny questions ("why?") stay under threshold; a fuller
  // question (>=4 words) crosses it, matching the false-negatives we saw.
  const looksLikeQuestion = isQuestion
    || WH_QUESTION_RE.test(compactText)
    || /[?؟]/.test(String(text || ''));
  if (looksLikeQuestion && !isExistence && !orderIntent
      && pipelineHits.length === 0 && !hasCatalogMention) {
    score += W.bare_question;
    reasons.push('bare_question');
    if (messageTokens.length >= 4) {
      score += 1;
      reasons.push('bare_question_detailed');
    }
  }

  // Context-dependent follow-up: an inquiry that names NO item of its own but
  // refers to a prior one ("what's the ingredient?", "is it spicy?"). Routes to
  // AI only when we have recent history to resolve the reference — otherwise it
  // scores 0 and the customer gets nothing useful.
  if (hasContext && !hasCatalogMention && !orderIntent
      && (isQuestion
        || FOLLOWUP_PROP_RE.test(compactText)
        || ANAPHOR_RE.test(compactText)
        || ANAPHOR_AR_RE.test(String(text || '')))) {
    score += W.followup_context;
    reasons.push('followup_context');
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

async function callAiClassifier({ text, business, session, history }) {
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
        history: history || '',
        service_type: business.service_type || 'cafe',
        // Lets the master prompt greet/answer as "{{BRAND_NAME}}'s assistant".
        brand_name: business.name || business.name_ar || '',
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
        source_data: buildCatalogSchema(business),
        // Ask the AI service to echo the rendered prompt + full output so the
        // AI Usage view can show exactly what filled the token budget.
        debug: true,
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
      // Diagnosis fields (present only when the AI service echoes them).
      final_prompt: data.final_prompt || null,
      raw_response: data.raw_response != null ? data.raw_response : (data.response || null),
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

// Second AI step for subjective recommendations ([12]). Unlike the classifier,
// this DOES receive item rows — but only the small candidate set the caller
// already narrowed down (e.g. one category), kept compact to stay cheap. The
// model returns a short reply (the best pick + reason) shown verbatim.
// The language directive handed to the AI answer service. BRAND VOICE: the
// bot always speaks friendly, professional English or Modern Standard Arabic
// (فصحى) — it does NOT clone the customer's dialect. The `dialect` parameter
// is kept in the signature so call sites don't change, but it no longer
// affects the label.
function aiLanguageLabel(lang, dialect) { // eslint-disable-line no-unused-vars
  if (lang !== 'ar') return 'English — friendly and professional';
  return 'Modern Standard Arabic (العربية الفصحى) — friendly and professional; never dialect';
}

async function callAiAnswer({ prompt, business, lang, dialect, history, candidates, mode = 'recommend' }) {
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
        prompt,
        mode,
        history: history || '',
        service_type: business.service_type || 'cafe',
        brand_name: business.name || business.name_ar || '',
        language: aiLanguageLabel(lang, dialect),
        stream: false,
        ...(process.env.AI_MODEL ? { model: process.env.AI_MODEL } : {}),
        temperature: Number(process.env.AI_ANSWER_TEMPERATURE || 0.4),
        max_tokens: Number(process.env.AI_ANSWER_MAX_TOKENS || 220),
        source_data: candidates,
        debug: true,
      }),
      signal: controller.signal,
    });

    const elapsed_ms = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, elapsed_ms, error: `status_${response.status}` };
    }
    const data = await response.json();
    const reply = String(data.response || '').trim();
    return {
      ok: true,
      elapsed_ms,
      raw: reply,
      reply,
      from_cache: Boolean(data.from_cache),
      usage: data.usage || null,
      model: data.model || null,
      final_prompt: data.final_prompt || null,
      raw_response: data.raw_response != null ? data.raw_response : (data.response || null),
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

// Tiny schema for the classifier: category names + sortable field keys only.
// No item rows -> the classify request stays at a few hundred tokens, and the
// menu itself is NEVER sent to the AI. FAQ question TITLES (never answers) ride
// along so the classifier can route a policy/service question to [10] instead
// of improvising an [11] bounce — ~35 short questions, sits in the cached
// prompt prefix, so the marginal cost is near zero.
function buildCatalogSchema(business) {
  const items = getBusinessItems(business.id);
  const categories = [...new Set(items.map((i) => i.category_en || i.category_ar).filter(Boolean))];
  const fields = new Set(['price']);
  items.forEach((i) => Object.keys(i.metadata || {}).forEach((k) => fields.add(k)));
  const { parseFaqList } = require('./faqMatcher');
  // Interleave EN/AR so the cap keeps coverage of BOTH languages' topics (the
  // two lists usually mirror each other, so 24 interleaved ≈ the top 12 topics
  // in both tongues). Kept tight on purpose: exact FAQ asks are already
  // answered locally by the strong-FAQ gate BEFORE any AI call — the classifier
  // only needs enough topics to recognize the fuzzier rephrasings, and the
  // whole classify prompt must stay inside the ~2k-token budget.
  const en = parseFaqList(business.faq_en);
  const ar = parseFaqList(business.faq_ar);
  const interleaved = [];
  for (let i = 0; i < Math.max(en.length, ar.length); i += 1) {
    if (en[i]) interleaved.push(en[i]);
    if (ar[i]) interleaved.push(ar[i]);
  }
  const faqTopics = interleaved
    .map((entry) => String(entry.q || entry.question || '').trim())
    .filter(Boolean)
    .slice(0, 24);
  return { categories, sortable_fields: [...fields], faq_topics: faqTopics };
}

function parseAiPipeline(raw) {
  const line = String(raw || '').trim();
  let match = line.match(/^\[(\d+)\]\s*(.*)$/);
  if (!match) return { valid: false, raw: line };

  const code = Number(match[1]);
  const body = match[2] || '';
  if (code < 1 || code > 12) return { valid: false, raw: line };

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
    // Order intent may now carry the named item ("...: latte") for later
    // resolution; the item is optional so a bare order line still matches.
    6: /^wants to make an order(?::\s*(.+))?$/,
    7: /^wants to know full details about (.+)$/,
    8: /^wants to inquire (.+) about (.+)$/,
    9: /^not found$/,
    10: /^faq lookup$/,
    // [11] is the last-resort direct answer: the classifier writes the reply
    // inline, so capture the whole body as the message to show verbatim.
    11: /^(.+)$/,
    // [12] recommend {criteria}: a subjective single-pick recommendation. The
    // criteria is resolved with a focused AI answer over the candidate items.
    12: /^recommend (.+)$/,
  };

  match = body.match(patterns[code]);
  if (!match) return { valid: false, raw: line };

  return {
    valid: true,
    code,
    item: match[1] || '',
    detail: code === 8 ? match[1] || '' : '',
    itemForDetail: code === 8 ? match[2] || '' : '',
    direct: code === 11 ? (match[1] || '').trim() : '',
    raw: line,
  };
}

module.exports = {
  assessAiRoutingNeed,
  callAiClassifier,
  callAiAnswer,
  recordAiCall,
  isAiEnabledForBusiness,
  parseAiPipeline,
};
