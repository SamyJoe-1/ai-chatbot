'use strict';

const { normalize, tokenize } = require('../../engine/detector');

function overlapScore(messageTokens, targetTokens) {
  if (!targetTokens.length) return 0;
  const matches = targetTokens.filter((token) => messageTokens.includes(token));
  return matches.length / targetTokens.length;
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function toNormalizedList(values, lang) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => normalize(String(value || ''), lang))
    .filter(Boolean);
}

function findScoredItems({ text, lang, items, context = {}, getItemVariants, getCategoryVariants, getExtraVariants }) {
  const normalizedText = normalize(text, lang);
  const messageTokens = tokenize(normalizedText);
  const boostedCategory = context.last_category ? normalize(String(context.last_category), lang) : '';
  const scored = [];

  for (const item of items) {
    let score = 0;
    const variants = toNormalizedList(getItemVariants(item), lang);
    const categories = toNormalizedList(getCategoryVariants(item), lang);
    const extras = toNormalizedList(getExtraVariants ? getExtraVariants(item) : [], lang);

    for (const variant of variants) {
      if (normalizedText.includes(variant)) {
        score += 12 + variant.length;
      }

      // Tokens of length 2 ("SA", "US", "AI"...) are near-universally common
      // abbreviations/words that coincidentally appear inside unrelated titles
      // or product codes ("CeraVe SA Smoothing Cleanser", code "SA-BC1308") —
      // scoring on them turns a country abbreviation in casual text into a
      // false product match. Require 3+ chars, same bar the extras loop below
      // already uses for metadata/code fields.
      const itemTokens = tokenize(variant).filter((token) => token.length > 2);

      const matches = messageTokens.filter((token) => itemTokens.includes(token));
      if (matches.length > 0) {
        if (matches.length === messageTokens.length) {
          score += 12; // All user words match item words
        } else {
          score += matches.length * 3; // Partial match
        }
      }

      const ratio = overlapScore(messageTokens, itemTokens);
      if (ratio >= 0.5) {
        score += ratio * 10;
      }
    }

    for (const category of categories) {
      if (normalizedText.includes(category)) {
        score += 6;
      }

      const categoryTokens = tokenize(category).filter((token) => token.length > 1);
      const ratio = overlapScore(messageTokens, categoryTokens);
      if (ratio >= 0.5) {
        score += ratio * 4;
      }

      if (boostedCategory && category === boostedCategory && score > 0) {
        score += 5;
      }
    }

    for (const extra of extras) {
      const extraTokens = tokenize(extra).filter((token) => token.length > 2);
      const matches = messageTokens.filter((token) => extraTokens.includes(token));
      if (matches.length > 0) {
        const ratio = matches.length / Math.max(extraTokens.length, 1);
        if (ratio >= 0.4) {
          score += ratio * 4;
        }
      }
    }

    if (score > 0) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((entry) => entry.score >= 4);
}

function findMatchingCategories({ text, lang, items, getCategoryVariants, getCategoryDisplay }) {
  const normalizedText = normalize(text, lang);
  const tokens = tokenize(normalizedText);
  const categoryMap = new Map();

  for (const item of items) {
    const variants = toNormalizedList(getCategoryVariants(item), lang);
    for (const variant of variants) {
      if (!variant) continue;

      if (normalizedText.includes(variant) || overlapScore(tokens, tokenize(variant)) >= 0.5) {
        const existing = categoryMap.get(variant) || {
          key: variant,
          display: getCategoryDisplay(item, lang),
          items: [],
        };
        existing.items.push(item);
        categoryMap.set(variant, existing);
      }
    }
  }

  return Array.from(categoryMap.values())
    .map((entry) => ({ ...entry, items: uniqueByTitle(uniqueById(entry.items), lang) }))
    .filter((entry) => entry.items.length);
}

function uniqueByTitle(items, lang) {
  const seen = new Set();
  return items.filter((item) => {
    const title = item.title_en || item.title_ar || item.name_en || item.name_ar || '';
    const key = normalize(title, lang);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[t.length];
}

// Word-level typo gate: only treat two words as a fuzzy match when the edit
// distance is small relative to length AND the first letter agrees (typos rarely
// change the first letter). This is what keeps the search box from filling with
// noise — "capucino" -> "cappuccino" passes, unrelated words don't.
function fuzzyTokenScore(qToken, vToken) {
  if (qToken.length < 4 || vToken.length < 4) return 0;
  if (qToken[0] !== vToken[0]) return 0;
  const dist = levenshtein(qToken, vToken);
  const maxDist = qToken.length <= 5 ? 1 : qToken.length <= 8 ? 2 : 3;
  if (dist === 0 || dist > maxDist) return 0;
  return (1 - dist / Math.max(qToken.length, vToken.length)) * 60;
}

// Score one normalized title variant against the query. Higher tiers are worth
// strictly more, so an exact/prefix/substring hit can never be outranked by a
// fuzzy one — accuracy is structural, not threshold-tuned.
function scoreVariant(nq, qTokens, variant) {
  if (!variant) return 0;
  if (variant === nq) return 1000;            // exact title
  if (variant.startsWith(nq)) return 600;     // title starts with what was typed
  if (variant.includes(nq)) return 400;       // title contains the query
  if (nq.includes(variant)) return 350;       // query contains the title ("a cappuccino please")

  const vTokens = tokenize(variant).filter(Boolean);
  if (!qTokens.length || !vTokens.length) return 0;

  let total = 0;
  let matchedQ = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const v of vTokens) {
      let s = 0;
      if (q === v) s = 100;                                   // whole word matches
      else if (q.length >= 2 && v.startsWith(q)) s = 70;      // typing a word's prefix ("capp")
      else if (v.length >= 3 && q.startsWith(v)) s = 40;      // user word extends a catalog word
      else s = fuzzyTokenScore(q, v);                         // bounded typo tolerance
      if (s > best) best = s;
    }
    if (best > 0) { total += best; matchedQ += 1; }
  }
  if (!matchedQ) return 0;
  // For multi-word queries, require at least half the words to land so we don't
  // surface an item that only shares one common word ("ice" in "ice cream").
  if (qTokens.length > 1 && matchedQ / qTokens.length < 0.5) return 0;
  return total;
}

// Tiered search for the order-container search box. Returns catalog items ranked
// exact > prefix > substring > token > bounded typo-fuzzy. Safe to keep loose:
// the caller only ever adds an item the user explicitly clicks (by exact title),
// so a stray fuzzy suggestion can never become a wrong order line.
function searchCatalogItems({ text, lang, items, limit = 10 }) {
  const nq = normalize(text, lang);
  if (!nq || !Array.isArray(items) || !items.length) return [];
  const qTokens = tokenize(nq).filter(Boolean);

  const scored = [];
  for (const item of items) {
    const variants = [item.title_en, item.title_ar]
      .map((v) => normalize(v || '', lang))
      .filter(Boolean);

    let score = 0;
    for (const variant of variants) {
      const s = scoreVariant(nq, qTokens, variant);
      if (s > score) score = s;
    }

    if (score > 0) {
      // Small nudge for a category hit — only ever a tie-breaker, never enough
      // to lift a category-only item above a real title match.
      const cats = [item.category_en, item.category_ar]
        .map((c) => normalize(c || '', lang))
        .filter(Boolean);
      if (cats.some((c) => nq.includes(c))) score += 5;
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie: prefer the shorter title (closer to what was typed).
    const la = String(a.item.title_en || a.item.title_ar || '').length;
    const lb = String(b.item.title_en || b.item.title_ar || '').length;
    return la - lb;
  });

  return uniqueByTitle(uniqueById(scored.map((e) => e.item)), lang).slice(0, limit);
}

function uniqueScoredByTitle(scoredEntries, lang) {
  const seen = new Set();
  return scoredEntries.filter((entry) => {
    const title = entry.item.title_en || entry.item.title_ar || entry.item.name_en || entry.item.name_ar || '';
    const key = normalize(title, lang);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Keyed by lowercased name so matching stays case-insensitive, but the VALUE
// keeps the catalog's original casing ("Saudi Arabia") so any caller that
// displays the detected country back to the customer doesn't show it in
// all-lowercase.
function getCountryNames(items) {
  const countriesEn = new Map();
  const countriesAr = new Map();
  items.forEach(item => {
    const meta = item.metadata || {};
    if (meta.country_en) countriesEn.set(meta.country_en.toLowerCase(), meta.country_en);
    if (meta.country) countriesEn.set(meta.country.toLowerCase(), meta.country);
    if (meta.country_ar) countriesAr.set(meta.country_ar, meta.country_ar);
  });
  return { en: Array.from(countriesEn.values()), ar: Array.from(countriesAr.values()) };
}

// Built-in synonym groups so one catalog country is recognized from ANY of its
// common spellings across BOTH languages, colloquial forms, and ISO codes —
// "الإمارات" / "امارات" / "UAE" / "UA" / "emirates" all resolve to the same
// place. Each inner array is one country's full set of aliases (mixed ar/en/
// codes); order inside doesn't matter. Matched after normalization, so bare
// alef/hamza/ta-marbuta differences ("امارات" vs "إمارات") already collapse —
// these aliases add the cross-language + short-code + colloquial coverage that
// normalization alone can't. Keep additions here; it's the single maintenance
// point.
const COUNTRY_ALIAS_GROUPS = [
  ['united arab emirates', 'uae', 'ua', 'emirates', 'الامارات', 'امارات', 'الامارات العربيه المتحده'],
  ['saudi arabia', 'saudi', 'ksa', 'sa', 'السعوديه', 'سعوديه', 'المملكه العربيه السعوديه'],
  ['qatar', 'qa', 'قطر'],
  ['kuwait', 'kw', 'الكويت', 'كويت'],
  ['bahrain', 'bh', 'البحرين', 'بحرين'],
  ['oman', 'om', 'عمان', 'سلطنه عمان'],
  ['egypt', 'eg', 'مصر'],
  ['jordan', 'jo', 'الاردن', 'اردن'],
  ['lebanon', 'lb', 'لبنان'],
  ['iraq', 'iq', 'العراق', 'عراق'],
  ['syria', 'sy', 'سوريا'],
  ['yemen', 'ye', 'اليمن', 'يمن'],
  ['palestine', 'ps', 'فلسطين'],
  ['libya', 'ly', 'ليبيا'],
  ['sudan', 'sd', 'السودان', 'سودان'],
  ['tunisia', 'tn', 'تونس'],
  ['algeria', 'dz', 'الجزائر', 'جزائر'],
  ['morocco', 'ma', 'المغرب', 'مغرب'],
  ['turkey', 'turkiye', 'tr', 'تركيا'],
  ['iran', 'ir', 'ايران'],
  ['united states', 'united states of america', 'usa', 'us', 'america', 'امريكا', 'الولايات المتحده'],
  ['united kingdom', 'uk', 'britain', 'england', 'بريطانيا', 'انجلترا', 'المملكه المتحده'],
  ['china', 'cn', 'الصين', 'صين'],
  ['india', 'in', 'الهند', 'هند'],
  ['japan', 'jp', 'اليابان', 'يابان'],
  ['south korea', 'korea', 'kr', 'كوريا', 'كوريا الجنوبيه'],
  ['germany', 'de', 'المانيا', 'ألمانيا'],
  ['france', 'fr', 'فرنسا'],
  ['italy', 'it', 'ايطاليا'],
  ['spain', 'es', 'اسبانيا', 'إسبانيا'],
  ['russia', 'ru', 'روسيا'],
];

// Normalize an alias/name to a language-agnostic comparison key: Arabic runs
// through the shared Arabic normalizer (collapses alef/hamza/ta-marbuta/ya +
// strips diacritics), Latin is lowercased, and a leading Arabic definite
// article "ال" is stripped so "الامارات" and "امارات" compare equal.
function countryKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isArabic = /[؀-ۿ]/.test(raw);
  let key = normalize(raw, isArabic ? 'ar' : 'en');
  if (isArabic && key.startsWith('ال') && key.length > 4) key = key.slice(2);
  return key.trim();
}

// Precomputed lookup from a normalized alias key -> its whole alias group, so a
// catalog country can pull in every equivalent spelling in O(1).
const ALIAS_KEY_TO_GROUP = (() => {
  const map = new Map();
  for (const group of COUNTRY_ALIAS_GROUPS) {
    const keys = group.map(countryKey).filter(Boolean);
    for (const key of keys) map.set(key, keys);
  }
  return map;
})();

// A one-letter-off Arabic country name ("لبيا" for "ليبيا" — a dropped ي) must
// still resolve: country correctness is safety-critical (a missed/misdetected
// country either dumps the wrong items or wrongly claims/denies coverage), and
// customers mistype on mobile keyboards constantly. Mirrors the exact
// Levenshtein tolerance already proven for item-name typo recovery in
// queryRecovery.js: distance scales with word length, and the first letter
// must still match (kills unrelated-word false positives almost entirely
// while still catching a dropped/swapped middle letter).
function fuzzyArabicTokenMatch(key, normalizedArabic) {
  if (key.length < 4 || key.includes(' ')) return false;
  const threshold = key.length <= 5 ? 1 : key.length <= 8 ? 2 : 3;
  return tokenize(normalizedArabic).some((token) => {
    if (token.length < 4 || token[0] !== key[0]) return false;
    if (Math.abs(token.length - key.length) > threshold) return false;
    return levenshtein(token, key) <= threshold;
  });
}

// Match one comparison key against the message. Rules by kind:
//  • Arabic keys  -> substring on the Arabic-normalized text, with a small
//    Levenshtein-tolerant fallback for a single typo'd letter.
//  • Latin 2-char codes ("ua","sa","uk","us","in") -> ONLY when written as a
//    standalone UPPERCASE token in the RAW text. Two-letter codes collide with
//    ordinary words ("in", "us") and product lines ("CeraVe SA"), so a bare
//    lowercase hit is far more likely noise than a country — requiring the
//    uppercase form (how people actually type a country code) kills that.
//  • Latin 3-char codes ("uae","ksa","usa") -> standalone word, any case; these
//    don't collide with common words.
//  • Longer Latin keys -> substring, so "from the emirates" still resolves.
function keyMatchesText(key, rawText, normalizedLatin, normalizedArabic) {
  if (!key) return false;
  const isArabic = /[؀-ۿ]/.test(key);
  if (isArabic) {
    if (!normalizedArabic) return false;
    if (normalizedArabic.includes(key)) return true;
    return fuzzyArabicTokenMatch(key, normalizedArabic);
  }
  if (!normalizedLatin) return false;

  if (key.length <= 2) {
    return new RegExp(`(?:^|[^A-Za-z0-9])${key.toUpperCase()}(?:[^A-Za-z0-9]|$)`).test(rawText);
  }
  if (key.length === 3) {
    return new RegExp(`(?:^|[^a-z0-9])${key}(?:[^a-z0-9]|$)`, 'i').test(normalizedLatin);
  }
  return normalizedLatin.includes(key);
}

// A single distinguishing word from a multi-word country name ("Saudi" out of
// "Saudi Arabia", "Emirates" out of "United Arab Emirates") — short/common
// words are dropped so a generic word never stands in for the whole country.
function countryTokenHints(country) {
  return String(country || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 5);
}

// Every recognized comparison key for one catalog country: its own normalized
// name (+ "ال"-stripped form) plus every alias in its group if it belongs to a
// known one.
function countryForms(country) {
  const forms = new Set();
  const key = countryKey(country);
  if (key) forms.add(key);
  const group = ALIAS_KEY_TO_GROUP.get(key);
  if (group) group.forEach((k) => forms.add(k));
  return forms;
}

// Detects a country NAMED IN THE CATALOG ITSELF (not a hardcoded list) so any
// country the business sources from is recognized without a maintained list —
// now matched across normalized spellings, cross-language aliases, and codes.
function detectCountry(text, lang, items) {
  const { en, ar } = getCountryNames(items);
  // Search order still prefers the active language's names first, but every
  // form is normalized so language of the STORED name no longer matters.
  const allCountries = lang === 'ar' ? [...ar, ...en] : [...en, ...ar];
  const rawText = String(text || '');
  const normalizedLatin = normalize(rawText, 'en');
  const normalizedArabic = normalize(rawText, 'ar');

  // Tier 1 — full name or any alias/code. Most precise; wins first.
  for (const country of allCountries) {
    for (const key of countryForms(country)) {
      if (keyMatchesText(key, rawText, normalizedLatin, normalizedArabic)) return country;
    }
  }

  // Tier 2 — a distinguishing single WORD of the name ("Saudi" -> "Saudi
  // Arabia") so informal phrasing still resolves.
  for (const country of allCountries) {
    for (const hint of countryTokenHints(country)) {
      if (keyMatchesText(countryKey(hint), rawText, normalizedLatin, normalizedArabic)) return country;
    }
  }
  return null;
}

// Stable identity for a country across languages/spellings: if it belongs to a
// known alias group, that group's first key; otherwise its own normalized key.
// Lets us treat "Saudi Arabia" and "السعودية" as the same real country.
function countryCanonicalId(country) {
  const key = countryKey(country);
  const group = ALIAS_KEY_TO_GROUP.get(key);
  return group ? group[0] : key;
}

// Regional umbrella terms -> the set of member-country canonical ids. When a
// customer names a REGION ("دول الخليج", "Gulf", "GCC") instead of one country,
// we expand it to every member the catalog actually stocks. Members are written
// as any alias (resolved to canonical ids at load) so this list stays readable.
const REGION_GROUPS = [
  {
    aliases: ['gulf', 'gcc', 'khaleej', 'الخليج', 'دول الخليج', 'الخليج العربي', 'مجلس التعاون', 'الخليجيه'],
    members: ['united arab emirates', 'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman'],
  },
  {
    aliases: ['levant', 'الشام', 'بلاد الشام', 'المشرق العربي'],
    members: ['syria', 'lebanon', 'jordan', 'palestine', 'iraq'],
  },
  {
    aliases: ['north africa', 'maghreb', 'المغرب العربي', 'شمال افريقيا', 'شمال أفريقيا'],
    members: ['egypt', 'libya', 'tunisia', 'algeria', 'morocco', 'sudan'],
  },
  {
    aliases: ['europe', 'european', 'اوروبا', 'أوروبا', 'الاتحاد الاوروبي'],
    members: ['germany', 'france', 'italy', 'spain', 'united kingdom', 'russia'],
  },
].map((region) => ({
  aliasKeys: region.aliases.map(countryKey).filter(Boolean),
  memberIds: new Set(region.members.map(countryCanonicalId)),
}));

// If the message names a region, return that region's member-id Set; else null.
function detectRegionMemberIds(rawText, normalizedLatin, normalizedArabic) {
  for (const region of REGION_GROUPS) {
    for (const key of region.aliasKeys) {
      if (keyMatchesText(key, rawText, normalizedLatin, normalizedArabic)) return region.memberIds;
    }
  }
  return null;
}

// Plural detection: a region term expands to EVERY catalog country in that
// group; otherwise falls back to the single best country. Returns an array of
// the catalog's own country strings (deduped, active-language name preferred),
// suitable for filtering with countryMatchesItem and for display.
function detectCountries(text, lang, items) {
  const rawText = String(text || '');
  const normalizedLatin = normalize(rawText, 'en');
  const normalizedArabic = normalize(rawText, 'ar');

  const { en, ar } = getCountryNames(items);
  const allCountries = lang === 'ar' ? [...ar, ...en] : [...en, ...ar];

  const memberIds = detectRegionMemberIds(rawText, normalizedLatin, normalizedArabic);
  if (memberIds) {
    const seen = new Set();
    const matched = [];
    for (const country of allCountries) {
      const id = countryCanonicalId(country);
      if (!memberIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      matched.push(country);
    }
    if (matched.length) return matched;
  }

  const single = detectCountry(text, lang, items);
  return single ? [single] : [];
}

// English/Arabic display names per alias group, for echoing a recognized
// country back in the customer's language.
const GROUP_DISPLAY = new Map();
for (const group of COUNTRY_ALIAS_GROUPS) {
  const id = countryCanonicalId(group[0]);
  const en = group.find((a) => /^[a-z .]+$/i.test(a)) || group[0];
  const ar = group.find((a) => /[؀-ۿ]/.test(a)) || '';
  GROUP_DISPLAY.set(id, { en, ar });
}

// Recognizes ANY well-known country named in the text — independent of the
// catalog — so a "do you serve <country>?" question can be answered yes/no even
// when the country is one we DON'T stock (e.g. "المغرب"). Returns { id, en, ar }
// or null. Use countryCanonicalId on catalog countries to test membership.
function detectAnyKnownCountry(text, lang) {
  const rawText = String(text || '');
  const normalizedLatin = normalize(rawText, 'en');
  const normalizedArabic = normalize(rawText, 'ar');
  for (const group of COUNTRY_ALIAS_GROUPS) {
    for (const alias of group) {
      if (keyMatchesText(countryKey(alias), rawText, normalizedLatin, normalizedArabic)) {
        const id = countryCanonicalId(group[0]);
        const disp = GROUP_DISPLAY.get(id) || { en: group[0], ar: '' };
        return { id, en: disp.en, ar: disp.ar };
      }
    }
  }
  return null;
}

function countryMatchesItem(item, targetCountry) {
  let meta = item.metadata || {};
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  const cEn = String(meta.country_en || '').toLowerCase();
  const cAr = String(meta.country_ar || '');
  const c = String(meta.country || '').toLowerCase();
  const target = String(targetCountry || '').toLowerCase();
  return cEn === target || cAr === targetCountry || c === target;
}

module.exports = {
  findMatchingCategories,
  findScoredItems,
  searchCatalogItems,
  fuzzyTokenScore,
  uniqueById,
  uniqueByTitle,
  uniqueScoredByTitle,
  detectCountry,
  detectCountries,
  detectAnyKnownCountry,
  countryCanonicalId,
  countryMatchesItem,
};
