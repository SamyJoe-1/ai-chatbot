'use strict';

const { normalize, tokenize } = require('../../engine/detector');

function overlapScore(messageTokens, itemTokens) {
  if (!itemTokens.length) return 0;
  const matches = itemTokens.filter((token) => messageTokens.includes(token));
  return matches.length / itemTokens.length;
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
      if (messageTokens.length > 1 && messageTokens.every((token) => itemTokens.includes(token))) {
        score += 12;
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
      const ratio = overlapScore(messageTokens, extraTokens);
      if (ratio >= 0.4) {
        score += ratio * 4;
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
    .map((entry) => ({ ...entry, items: uniqueById(entry.items) }))
    .filter((entry) => entry.items.length);
}

module.exports = {
  findMatchingCategories,
  findScoredItems,
  uniqueById,
};
