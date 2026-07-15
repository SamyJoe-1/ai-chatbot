'use strict';

// Golden tests for FAQ precedence: an owner-authored FAQ must never be stolen
// by an AI bounce, and the strong-FAQ pre-gate must never hijack product /
// order / browse queries. Run: node scripts/test-faq-precedence.js
// Requires the dev DB (business 3 = E-Global Trading with the Sourcing FAQs).

const db = require('../src/db/db');
const { matchFaq, matchFaqStrong } = require('../src/engine/faqMatcher');
const { isFillerAiReply } = require('../src/routes/api/message');
const { looksLikeOrderIntent } = require('../src/engine/orderFlow');
const { getBrain } = require('../src/brains');

const business = db.prepare('SELECT * FROM businesses WHERE id = 3').get();
if (!business) {
  console.error('SKIP: business 3 (E-Global Trading) not found in this DB');
  process.exit(0);
}

let fails = 0;
function check(ok, label) {
  if (!ok) fails += 1;
  console.log(ok ? 'PASS' : 'FAIL', '|', label);
}

// --- strong FAQ gate: these answer locally BEFORE any AI spend ---
const mustBeStrong = [
  ['كيف تتم عملية الـ Sourcing؟', 'ar'],
  ['كيف بتتم عملية ال Sourcing', 'ar'],
  ['كم تكلفة خدمة الـ Sourcing؟', 'ar'],
  ['كيف أرسل طلب Sourcing؟', 'ar'],
];
for (const [text, lang] of mustBeStrong) {
  check(Boolean(matchFaqStrong({ text, lang, business })), `strong: ${text}`);
}

// --- precision: product / browse / order queries must NOT hit the gate ---
const mustNotBeStrong = [
  ['do you have a baby organizer', 'en'],
  ['so lets start', 'en'],
  ['قلي احدث 4 منتجات في السعودية', 'ar'],
  ['i want to order the lamp', 'en'],
  ['اعرض المنتجات', 'ar'],
];
for (const [text, lang] of mustNotBeStrong) {
  check(!matchFaqStrong({ text, lang, business }), `not strong: ${text}`);
}

// --- cross-language fallback: an ask in one language finds the other list ---
check(Boolean(matchFaq({ text: 'how does the sourcing process work', lang: 'en', business })),
  'cross-list: EN ask finds a sourcing FAQ');

// --- filler guard: bounces die, real answers pass ---
const fillerCases = [
  ['أنا هنا لمساعدتك! بس قولي أي منتج حاب تبحث عنه أو تحتاج مساعدة فيه.', 'كيف بتتم عملية ال Sourcing', 'ar', true],
  ['أنا هنا لمساعدتك! كيف أقدر أساعدك في عملية الـ Sourcing؟', 'كيف تتم عملية الـ Sourcing؟', 'ar', true],
  ['يسعدني خدمتك! ما هو المنتج الذي تبحث عنه؟', 'كيف تتم عملية الشحن', 'ar', true],
  ['I am here to help! What do you need?', 'i need some help here', 'en', true],
  ['Your name is Samy.', 'what is my name', 'en', false],
  ['Of course — just tell me which product(s) you would like and I will take the whole order right here in chat.', 'how can i order a specific product', 'en', false],
  ['ايه أكيد، أقدر أكلمك باللهجة اللي تريحك! وش تبي تعرف؟', 'بتعرف تتكلم لهجة خليجي', 'ar', false],
  ['نعم نوفر الشحن لجميع دول الخليج خلال 5-7 أيام عمل.', 'هل عندكم شحن للسعودية', 'ar', false],
];
for (const [reply, msg, lang, want] of fillerCases) {
  check(isFillerAiReply(reply, msg, lang) === want, `filler=${want}: ${reply.slice(0, 50)}`);
}

// --- intent precedence: qty-limit / best-product / capability-category ---
const brain = getBrain('ecommerce');
function intentOf(text) {
  const lang = /[؀-ۿ]/.test(text) ? 'ar' : 'en';
  const r = brain.detectIntent({ text, lang, business, context: {} });
  return r ? r.intent : null;
}
// A quantity-limit QUESTION is policy, never an order command.
check(!looksLikeOrderIntent('ايه اقصي كميه ممكن اطلبها ؟', 'ar'), 'qty-limit question is not order intent');
check(looksLikeOrderIntent('عايز اطلب ميدالية لابوبو', 'ar'), 'real order phrase still is order intent');
check(intentOf('ايه اقصي كميه ممكن اطلبها ؟') === 'moq', 'max-qty question -> moq');
check(intentOf('whats the maximum quantity i can order') === 'moq', 'EN max-qty question -> moq');
// "best product" always resolves from the hot_selling flag, locally.
check(intentOf('ايه افضل منتح موحود ف السعوديه') === 'ecommerce_search_hot', 'best product (typos) + country -> hot flag');
check(intentOf('ايه احسن منتج عندكم') === 'ecommerce_search_hot', 'best product singular -> hot flag');
check(intentOf('whats the best product you have') === 'ecommerce_search_hot', 'EN best product -> hot flag');
// Capability ask with a recognizable category shows that category's products.
check(intentOf('هل يمكنكم توفير متجات تجميل') === 'ecommerce_capability_category', 'capability + تجميل -> category products');
check(intentOf('can you provide cosmetics products') === 'ecommerce_capability_category', 'EN capability + cosmetics -> category products');
// A "recommend" verb with CONCRETE criteria is a filter query, not discovery.
check(intentOf('طيب رشحلى الافضل مبيعا ف السعوديه والامارات والعراقر') === 'ecommerce_search_hot', 'رشحلي + hot + countries -> hot filter, not discovery');
check(intentOf('مش عارف اختار') === 'guided_discovery', 'genuine confusion still -> guided discovery');
// Multi-country enumeration filters by ALL named countries (typos tolerated).
{
  const { detectCountries } = require('../src/brains/shared/matcher');
  const { getBusinessItems } = require('../src/brains/shared/catalogStore');
  const list = detectCountries('الافضل مبيعا في السعوديه والامارات والعراقر', 'ar', getBusinessItems(3));
  check(list.length === 3, `multi-country enumeration detects all 3 (got ${list.length}: ${list.join('،')})`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
