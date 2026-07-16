'use strict';

/**
 * Golden tests for the 14 client-feedback scenarios (E-Global Trading, biz 3).
 * Drives the REAL ecommerce brain (detectIntent + buildResponse) against the
 * live SQLite catalog — no AI calls, everything here must resolve locally.
 *
 * Run: node scripts/test-client-feedback.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const db = require('../src/db/db');
const brain = require('../src/brains/ecommerce');

const BUSINESS_ID = 3;
const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(BUSINESS_ID);
if (!business) {
  console.error('Business 3 (E-Global Trading) not found — aborting.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function run(name, { text, lang = 'ar', context = {} }, checks) {
  const intentResult = brain.detectIntent({ text, lang, business, context });
  const payload = brain.buildResponse(intentResult, lang, business);
  const errors = [];
  try {
    checks({ intentResult, payload, text });
  } catch (e) {
    errors.push(e.message);
  }
  if (errors.length) {
    failed += 1;
    failures.push({ name, errors, intent: intentResult.intent, text: String(payload.text || '').slice(0, 300) });
    console.log(`✗ ${name}`);
    errors.forEach((e) => console.log(`    - ${e}`));
    console.log(`    intent=${intentResult.intent}`);
    console.log(`    reply: ${String(payload.text || '').replace(/\n/g, ' | ').slice(0, 260)}`);
  } else {
    passed += 1;
    console.log(`✓ ${name}  [${intentResult.intent}]`);
  }
  return { intentResult, payload };
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------

// #1 — company intro must lead with products + sourcing services
run('1. تعريف بالشركة ومجال العمل', { text: 'ممكن تعرفني بشركتكم ومجال عملكم؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'brand_info', `expected brand_info, got ${intentResult.intent}`);
  expect(/توريد|Sourcing/i.test(payload.text), 'reply must mention sourcing/supply services');
  expect(/منتجات/.test(payload.text), 'reply must mention products');
});

// #2 — bare "products in KSA" must ask for the category first (with chips)
run('2. المنتجات المتاحة في السعودية → يسأل عن الفئة', { text: 'ما هي المنتجات المتاحة لديكم في السعودية؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_country_categories', `expected ecommerce_country_categories, got ${intentResult.intent}`);
  expect(/الفئة|القسم|الأقسام/.test(payload.text), 'reply must ask which category');
  expect(payload.suggestions.length >= 3, 'must offer category chips');
});

// #2b — after the ask, tapping a category shows that country's items
run('2b. متابعة: اختيار قسم بعد سؤال الفئة', {
  text: 'الجمال والعناية',
  context: { last_country: ['السعودية'] },
}, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  expect(intentResult.items.length > 0, 'must return items');
  const wrongCountry = intentResult.items.filter((i) => (i.metadata || {}).country_en !== 'Saudi Arabia');
  expect(wrongCountry.length === 0, `all items must be Saudi (got ${wrongCountry.length} others)`);
});

// #4 — "هل متوفر عطور؟" must show perfumes, never a stale context item
run('4. هل متوفر عطور؟ (مع منتج قديم في السياق)', {
  text: 'هل متوفر عطور؟',
  context: { last_item: 6278 }, // the baby organizer that hijacked this before
}, ({ intentResult }) => {
  expect(intentResult.intent !== 'ecommerce_status_yesno', 'must NOT yes/no about the stale context item');
  const items = intentResult.items || [];
  expect(items.length > 0, `must list perfume items, got intent=${intentResult.intent}`);
  expect(items.every((i) => /Perfumes/i.test(i.category_en || '')), 'all items must be perfumes');
});

// #5 — categories scoped to the named country
run('5. أقسام المنتجات في السعودية', { text: 'ما هي أقسام المنتجات لديكم في السعودية؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'list_categories', `expected list_categories, got ${intentResult.intent}`);
  expect(intentResult.country, 'country must be resolved');
  expect(intentResult.categories.length > 0, 'must list categories');
  // KSA doesn't stock Home appliances / Equipment — those must not appear.
  expect(!intentResult.categories.some((c) => /أجهزة منزلية|معدات/.test(c)), 'must only list KSA categories');
  expect(/السعودية/.test(payload.text), 'heading must name the country');
});

// #6 — hair products in Iraq must return HAIR items from IRAQ
run('6. منتجات للشعر في العراق', { text: 'منتجات للشعر في العراق' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.length > 0, 'must return hair items');
  expect(items.every((i) => (i.metadata || {}).country_en === 'Iraq'), 'all items must be from Iraq');
  // Hair items match by title OR description (the Res Q shampoo's title has no
  // literal "شعر" but it IS a hair product — description-level match is right).
  expect(items.every((i) => /شعر|hair|شامبو|shampoo/i.test(`${i.title_ar} ${i.title_en} ${i.description_ar} ${i.description_en}`)),
    'all items must be hair-related');
});

// #7 — country+category list must open with the availability confirmation
run('7. منتجات الشعر في السعودية → يبدأ بـ نعم متوفر', { text: 'منتجات الشعر في السعودية' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  expect(/^نعم/.test(payload.text.trim()), 'reply must open with نعم (availability confirmation)');
  const items = intentResult.items || [];
  expect(items.every((i) => (i.metadata || {}).country_en === 'Saudi Arabia'), 'all items must be Saudi');
});

// #8 — price-threshold question must NOT claim products match a price
run('8. منتجات بأقل من 50 ريال', { text: 'هل متوفر لديكم منتجات بأقل من 50 ريال؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_price_filter', `expected ecommerce_price_filter, got ${intentResult.intent}`);
  expect(!/سيروم|متوفر ✅/.test(payload.text), 'must not name/claim a matching product');
  expect(/سعر|أسعار/.test(payload.text), 'must explain pricing is quote-based');
});

// #9 — "منتجاتكم في ليبيا" shows Libya's products directly (single category)
run('9. ما هي منتجاتكم في ليبيا؟', { text: 'ما هي منتجاتكم في ليبيا؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.length > 0, 'must list Libya products directly');
  expect(items.every((i) => (i.metadata || {}).country_en === 'Libya'), 'all items must be from Libya');
});

// #10 — women's perfume in Kuwait: never show another country's perfume
run('10. هل متاح عطر نسائي في الكويت؟', { text: 'هل متاح عطر نسائي في الكويت؟' }, ({ intentResult, payload }) => {
  const ok = intentResult.intent === 'ecommerce_country_products' || intentResult.intent === 'ecommerce_country_miss';
  expect(ok, `expected country_products/country_miss, got ${intentResult.intent}`);
  const items = intentResult.items || intentResult.alternatives || [];
  const wrong = items.filter((i) => (i.metadata || {}).country_en !== 'Kuwait');
  expect(wrong.length === 0, `every shown item must be from Kuwait (got ${wrong.map((i) => (i.metadata || {}).country_en).join(',')})`);
  if (intentResult.intent === 'ecommerce_country_miss') {
    expect(/غير متوفر/.test(payload.text), 'miss must say not available');
  }
});

// #11 — home appliances in Qatar: honest miss + Qatar alternatives
run('11. هل متاح أجهزة منزلية في قطر؟', { text: 'هل متاح أجهزة منزلية في قطر؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_country_miss', `expected ecommerce_country_miss, got ${intentResult.intent}`);
  expect(/غير متوفر/.test(payload.text), 'must say not available in Qatar');
  const alts = intentResult.alternatives || [];
  expect(alts.every((i) => (i.metadata || {}).country_en === 'Qatar'), 'alternatives must be from Qatar');
  expect((intentResult.elsewhereCountries || []).length > 0, 'should name countries that DO stock the category');
});

// #12 is the same behavior as #11 (honest miss + same-country alternatives).

// #13 — code lookup must resolve by EXACT code only
run('13. SA-BC1004 هل هذا المنتج ما زال متوفر؟', { text: 'SA-BC1004 هل هذا المنتج ما زال متوفر لديكم؟' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_code_lookup', `expected ecommerce_code_lookup, got ${intentResult.intent}`);
  const code = ((intentResult.item || {}).metadata || {}).code || '';
  expect(code.replace(/\s/g, '') === 'SA-BC1004', `resolved item's code must be SA-BC1004, got "${code}"`);
  expect(/نعم/.test(payload.text), 'must confirm availability');
});

// #14 — bare existing code answers in Arabic session language with the right product
run('14a. QT-BC1001 (كود موجود، رسالة كود فقط)', { text: 'QT-BC1001', lang: 'ar' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_code_lookup', `expected ecommerce_code_lookup, got ${intentResult.intent}`);
  const code = ((intentResult.item || {}).metadata || {}).code || '';
  expect(code.replace(/\s/g, '') === 'QT-BC1001', `resolved code must be QT-BC1001, got "${code}"`);
  expect(/[؀-ۿ]/.test(payload.text), 'reply must be in Arabic');
});

// #14b — unknown code says "code not in database", not "product unavailable"
run('14b. كود غير موجود XX-ZZ9999', { text: 'XX-ZZ9999', lang: 'ar' }, ({ intentResult, payload }) => {
  expect(intentResult.intent === 'ecommerce_code_not_found', `expected ecommerce_code_not_found, got ${intentResult.intent}`);
  expect(/غير موجود/.test(payload.text) && /قاعدة بيانات/.test(payload.text), 'must say the CODE is not in the database');
  expect(!/غير متوفر حالياً/.test(payload.text), 'must NOT claim the product is unavailable');
});

// --- Regression guards (previously-fixed behaviors that must not break) ----

run('R1. أفضل منتج في السعودية (hot stays local + single)', { text: 'افضل منتج في السعودية' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_search_hot', `expected ecommerce_search_hot, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.length <= 1, 'superlative singular caps to 1');
  if (items.length) {
    expect((items[0].metadata || {}).country_en === 'Saudi Arabia', 'pick must be Saudi');
  }
});

run('R2. شغالين في دول ايه؟ (service area intact)', { text: 'انتم شغالين في دول ايه؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'service_area', `expected service_area, got ${intentResult.intent}`);
});

run('R3. هل تشتغلوا في المغرب؟ (unserved country honest)', { text: 'هل تشتغلوا في المغرب؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'service_area', `expected service_area, got ${intentResult.intent}`);
  expect(intentResult.isServed === false, 'Morocco is not served');
});

run('R4. ساعات العمل ايه (hours not hijacked by watches)', { text: 'ساعات العمل ايه عندكم؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'working_hours', `expected working_hours, got ${intentResult.intent}`);
});

run('R5. كام حبه متوفره منه؟ (stock qty policy intact)', {
  text: 'كام حبه متوفره منه؟', context: { last_item: 6278 },
}, ({ intentResult }) => {
  expect(intentResult.intent === 'stock_quantity', `expected stock_quantity, got ${intentResult.intent}`);
});

run('R6. اقل كمية اقدر اطلبها؟ (MOQ intact)', { text: 'اقل كمية اقدر اطلبها؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'moq', `expected moq, got ${intentResult.intent}`);
});

run('R7. عندكم ساعات في الامارات؟ (watches category via alias + country)', { text: 'عندكم ساعات في الامارات؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.length > 0, 'UAE stocks watches');
  expect(items.every((i) => /Watches/i.test(i.category_en || '')), 'all must be watches');
  expect(items.every((i) => (i.metadata || {}).country_en === 'United Arab Emirates'), 'all must be UAE');
});

run('R8. منتجات البشرة في العراق (skin products, not hair)', { text: 'منتجات للبشرة في العراق' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_country_products', `expected ecommerce_country_products, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.length > 0, 'Iraq has beauty items');
  expect(items.every((i) => (i.metadata || {}).country_en === 'Iraq'), 'all must be Iraq');
});

run('R9. الأكثر مبيعا في الكويت (hot + country)', { text: 'ايه الاكثر مبيعا عندكم في الكويت؟' }, ({ intentResult }) => {
  expect(intentResult.intent === 'ecommerce_search_hot', `expected ecommerce_search_hot, got ${intentResult.intent}`);
  const items = intentResult.items || [];
  expect(items.every((i) => (i.metadata || {}).country_en === 'Kuwait'), 'all hot picks must be Kuwait');
});

run('R10. مرحبا (greeting intact)', { text: 'مرحبا' }, ({ intentResult }) => {
  expect(intentResult.intent === 'greeting_hello', `expected greeting_hello, got ${intentResult.intent}`);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
