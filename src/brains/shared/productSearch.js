'use strict';

// Structured catalog search backend (architecture spec §2.4).
//
// The LLM / regex intent layer never searches the catalog directly — it
// resolves a STRUCTURED query (country, category, subject keywords, product
// code) and this module executes it deterministically:
//
//   • Product codes ("SA-BC1004") resolve ONLY by exact metadata.code match —
//     never by fuzzy text scoring, which used to surface a completely
//     different product for a code lookup.
//   • Country and category are HARD filters applied before any keyword
//     scoring, so a "hair products in Iraq" query can never return a
//     skin-care item from Saudi Arabia.
//   • Subject keywords (whatever meaningful words remain after stripping
//     question fillers, country names, and the already-consumed category
//     words) are scored INSIDE the filtered pool only.

const { normalize, tokenize } = require('../../engine/detector');
const { fuzzyTokenScore, isCountryToken } = require('./matcher');

// ---------------------------------------------------------------------------
// Product-code lane
// ---------------------------------------------------------------------------

// Catalog codes look like "SA-BC1004": 2-letter country prefix + 2-letter
// category + 3-6 digits. Customers type them with any case and with -, _, .,
// space, or nothing at all between the parts. Canonical form for comparison is
// uppercase alphanumerics only ("SABC1004") — the DB itself has entries with
// stray leading spaces (" SA-BC1308"), which canonicalization also absorbs.
const CODE_SEPARATED_RE = /([A-Za-z]{2})\s*[-_./\\]\s*([A-Za-z]{2})\s*[-_ ]?\s*(\d{3,6})/;
const CODE_COMPACT_RE = /(?:^|[^A-Za-z0-9])([A-Za-z]{4})(\d{3,6})(?:[^A-Za-z0-9]|$)/;

function canonicalCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Pretty display form for a canonical code: re-insert the standard hyphen
// after the country prefix ("QTBC1001" -> "QT-BC1001").
function displayCode(canonical) {
  return String(canonical || '').replace(/^([A-Z]{2})(?=[A-Z0-9])/, '$1-');
}

// Extract a product code from free text. Returns the canonical form or null.
function extractProductCode(text) {
  const raw = String(text || '');
  let m = raw.match(CODE_SEPARATED_RE);
  if (m) return canonicalCode(m[1] + m[2] + m[3]);
  m = raw.match(CODE_COMPACT_RE);
  if (m) return canonicalCode(m[1] + m[2]);
  return null;
}

// True when the message is essentially JUST a product code (possibly with
// punctuation). Used to keep the reply in the session's established language —
// a bare Latin code carries no language signal of its own, and detectLanguage
// would wrongly read it as English inside an Arabic conversation.
function isBareProductCode(text) {
  const raw = String(text || '').trim();
  if (!extractProductCode(raw)) return false;
  const leftovers = raw
    .replace(CODE_SEPARATED_RE, ' ')
    .replace(CODE_COMPACT_RE, ' ')
    .replace(/[^A-Za-z؀-ۿ]/g, '');
  return leftovers.length < 3;
}

function itemCode(item) {
  const meta = item && item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  return canonicalCode(meta.code);
}

// Exact-code lookup. This is the ONLY way a code query may resolve — a code
// that matches nothing returns null (the caller says "code not in our
// database"), never a fuzzy substitute product.
function findByCode(items, canonical) {
  if (!canonical) return null;
  return (items || []).find((item) => itemCode(item) === canonical) || null;
}

// ---------------------------------------------------------------------------
// Subject-keyword extraction
// ---------------------------------------------------------------------------

// Words that carry no PRODUCT meaning in a search query: question words,
// availability words, desire/request fillers, prepositions, and generic
// "product(s)" nouns. Arabic entries are in NORMALIZED form (hamza collapsed,
// ة -> ه, ى -> ي) because they're tested against normalize()d tokens.
const SUBJECT_STOPWORDS = new Set([
  // Question / interrogative
  'هل', 'ما', 'ماذا', 'ماهي', 'ايه', 'اي', 'ايش', 'وش', 'شو', 'مين', 'كام', 'كم',
  'هي', 'هو', 'هذا', 'هذه', 'ذلك', 'تلك', 'انهي',
  // Availability / existence
  'متوفر', 'متوفره', 'متوفرين', 'متاح', 'متاحه', 'موجود', 'موجوده', 'موجودين',
  'يوجد', 'توجد', 'فيه', 'فيها', 'زال', 'مازال',
  // Desire / request fillers
  'عايز', 'عاوز', 'عايزه', 'عاوزه', 'عايزين', 'محتاج', 'محتاجه', 'بدي', 'ابغي',
  'ابي', 'اريد', 'نفسي', 'ودي', 'ممكن', 'لو', 'سمحت', 'فضلك', 'هات', 'هاتلي',
  'جيبلي', 'وريني', 'ورني', 'اعرض', 'اعرضلي', 'طلعلي', 'قولي', 'قلي', 'ارسل', 'ابعت',
  // Knowing / seeing / browsing verbs — they describe the ACT of asking
  'اعرف', 'نعرف', 'تعرف', 'عرفني', 'اشوف', 'نشوف', 'شوف', 'شوفلي', 'اتفرج',
  'تصفح', 'اتصفح', 'استعرض', 'اطلع', 'طلع', 'يعرض', 'تعرض', 'تعرضلي', 'اعرفها',
  // Prepositions / connectors / possession
  'في', 'من', 'عن', 'علي', 'مع', 'الي', 'عند', 'عندكم', 'عندك', 'عندكو',
  'لديكم', 'لدينا', 'لدي', 'ليكم', 'لكم', 'بكم', 'انتم', 'انتو', 'يا', 'و',
  'بس', 'فقط', 'كمان', 'برضه', 'حاليا', 'الان', 'دلوقتي', 'طب', 'طيب', 'يعني',
  'كل', 'جميع', 'كامل', 'كافه', 'باقي', 'بقيه', 'اهم', 'افضل',
  // Generic product nouns — they name the REQUEST, not the subject
  'منتج', 'منتجات', 'منتجاتكم', 'منتجاتكو', 'منتجاتك', 'بضاعه', 'بضائع', 'سلع',
  'سلعه', 'صنف', 'اصناف', 'حاجه', 'حاجات', 'اشياء', 'شي', 'شيء', 'انواع', 'نوع',
  // English
  'do', 'does', 'you', 'your', 'have', 'has', 'any', 'is', 'are', 'there',
  'the', 'a', 'an', 'of', 'for', 'me', 'my', 'i', 'we', 'in', 'at', 'from',
  'to', 'with', 'and', 'or', 'what', 'which', 'where', 'that', 'this', 'it',
  'available', 'availability', 'stock', 'still', 'want', 'need', 'looking',
  'find', 'show', 'give', 'get', 'send', 'please', 'pls', 'can', 'could',
  'product', 'products', 'item', 'items', 'things', 'stuff', 'goods', 'some',
  'sell', 'selling', 'offer', 'carry', 'got', 'know', 'see', 'view', 'browse',
  'list', 'all', 'everything', 'else', 'other', 'whats', 'about', 'tell',
]);

// Attached Arabic prefixes (definite article, prepositions, conjunctions) that
// hide the stem: "للشعر" = ل+ال+شعر. We never DESTRUCTIVELY strip — the caller
// matches on every variant, so a word that genuinely starts with these letters
// ("ليمون") still matches via its original form.
function tokenVariants(token) {
  const variants = new Set([token]);
  const prefixes = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ب', 'ل', 'ف', 'ك'];
  for (const p of prefixes) {
    if (token.startsWith(p) && token.length - p.length >= 3) {
      variants.add(token.slice(p.length));
    }
  }
  // Second pass: "وللشعر" -> strip "و" then "لل".
  for (const v of [...variants]) {
    for (const p of ['لل', 'ال']) {
      if (v.startsWith(p) && v.length - p.length >= 3) variants.add(v.slice(p.length));
    }
  }
  return [...variants];
}

function isStopToken(token) {
  if (SUBJECT_STOPWORDS.has(token)) return true;
  // Only the article variants count as the same stopword ("المتاحه" -> "متاحه");
  // preposition-letter variants would wrongly kill real words ("بيبي" -> "يبي").
  for (const p of ['ال', 'وال', 'بال']) {
    if (token.startsWith(p) && token.length - p.length >= 2 && SUBJECT_STOPWORDS.has(token.slice(p.length))) {
      return true;
    }
  }
  return false;
}

// Tokens (normalized) of a category's own names — used to EXCLUDE the words a
// resolved category already consumed from the remaining subject.
function categoryTokenSet(category, lang) {
  const out = new Set();
  if (!category) return out;
  const names = [category.display, category.key].filter(Boolean);
  if (Array.isArray(category.items) && category.items[0]) {
    names.push(category.items[0].category_en, category.items[0].category_ar);
  }
  for (const name of names) {
    for (const t of tokenize(normalize(String(name || ''), lang))) {
      for (const v of tokenVariants(t)) out.add(v);
    }
  }
  return out;
}

function tokenConsumedByCategory(token, catTokens) {
  if (!catTokens.size) return false;
  for (const v of tokenVariants(token)) {
    if (catTokens.has(v)) return true;
    // Substring tolerance for singular/plural pairs ("عطر" ⊂ "عطور").
    for (const c of catTokens) {
      if (c.length >= 3 && v.length >= 3 && (c.includes(v) || v.includes(c))) return true;
    }
  }
  return false;
}

// Extract the SUBJECT of a product query: the meaningful words left after
// removing question fillers, country names, numbers, and the words already
// consumed by a resolved category. Returns:
//   { tokens: [[variant...], ...],   // for matching
//     label: 'عطر نسائي' }           // for echoing back (includes category words)
function extractSubjectQuery(text, lang, { category } = {}) {
  const catTokens = categoryTokenSet(category, lang);

  // Walk the RAW words and normalize each one individually: matching happens
  // on the normalized form, but the label echoed back to the customer keeps
  // their ORIGINAL spelling ("نسائي", not the normalized "نسايي").
  const rawWords = String(text || '').split(/[\s،,؟?!.:;()\[\]"']+/).filter(Boolean);

  const labelParts = [];
  const searchTokens = [];
  for (const rawWord of rawWords) {
    const token = tokenize(normalize(rawWord, lang)).join('');
    if (!token || /^\d+$/.test(token)) continue;
    if (isStopToken(token)) continue;
    if (isCountryToken(token)) continue;
    // Label reads back to the customer — swap an attached preposition+article
    // ("للشعر" = ل+الشعر) for the plain definite form ("الشعر").
    labelParts.push(rawWord.startsWith('لل') && rawWord.length >= 5 ? `ال${rawWord.slice(2)}` : rawWord);
    if (tokenConsumedByCategory(token, catTokens)) continue;
    if (token.length < 2) continue;
    searchTokens.push(tokenVariants(token));
  }
  return { tokens: searchTokens, label: labelParts.join(' ') };
}

// ---------------------------------------------------------------------------
// Pool-scoped keyword search
// ---------------------------------------------------------------------------

// Score the subject tokens INSIDE an already country/category-filtered pool.
// Title/category hits rank above description hits; multi-token subjects must
// land at least 2 tokens (so one generic shared word never matches), while a
// single-token subject accepts any title/category/description hit.
function searchWithinPool({ tokens, lang, pool }) {
  if (!Array.isArray(tokens) || !tokens.length || !Array.isArray(pool) || !pool.length) return [];
  const minHits = tokens.length >= 2 ? 2 : 1;

  const scored = [];
  for (const item of pool) {
    const title = normalize(`${item.title_en || ''} ${item.title_ar || ''}`, lang);
    const cat = normalize(`${item.category_en || ''} ${item.category_ar || ''}`, lang);
    const desc = normalize(`${item.description_en || ''} ${item.description_ar || ''}`, lang);
    const titleTokens = tokenize(title).filter((t) => t.length > 2);

    let hits = 0;
    let titleHits = 0;
    for (const variants of tokens) {
      const inTitle = variants.some((v) =>
        title.includes(v) || titleTokens.some((tt) => fuzzyTokenScore(v, tt) > 0));
      const inOther = inTitle || variants.some((v) => cat.includes(v) || desc.includes(v));
      if (inTitle) titleHits += 1;
      if (inOther) hits += 1;
    }
    if (hits >= minHits) {
      scored.push({ item, score: titleHits * 10 + hits });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

module.exports = {
  extractProductCode,
  isBareProductCode,
  canonicalCode,
  displayCode,
  findByCode,
  extractSubjectQuery,
  searchWithinPool,
};
