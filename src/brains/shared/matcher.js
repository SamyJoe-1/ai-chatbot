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

      const itemTokens = tokenize(variant).filter((token) => token.length > 1);
      
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

module.exports = {
  findMatchingCategories,
  findScoredItems,
  searchCatalogItems,
  fuzzyTokenScore,
  uniqueById,
  uniqueByTitle,
  uniqueScoredByTitle,
};
