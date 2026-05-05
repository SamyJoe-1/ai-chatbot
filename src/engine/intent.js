'use strict';

const db = require('../db/db');
const { PATTERNS } = require('./patterns');
const { normalize, tokenize } = require('./detector');

const menuCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function parseSizes(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getMenuItems(cafeId) {
  const cached = menuCache.get(cafeId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.items;
  }

  const items = db.prepare('SELECT * FROM menu_items WHERE cafe_id = ? AND available = 1').all(cafeId)
    .map((item) => ({ ...item, sizes: parseSizes(item.sizes) }));

  menuCache.set(cafeId, { items, ts: Date.now() });
  return items;
}

function invalidateMenuCache(cafeId) {
  menuCache.delete(Number(cafeId));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function overlapScore(messageTokens, itemTokens) {
  if (!itemTokens.length) return 0;
  const matches = itemTokens.filter((token) => messageTokens.includes(token));
  return matches.length / itemTokens.length;
}

function getItemVariants(item) {
  return [
    normalize(item.name_en || '', 'en'),
    normalize(item.name_ar || '', 'ar'),
  ].filter(Boolean);
}

function getItemCategoryVariants(item) {
  return [
    normalize(item.category_en || '', 'en'),
    normalize(item.category_ar || '', 'ar'),
  ].filter(Boolean);
}

function findScoredItems(text, lang, items, context = {}) {
  const normalizedText = normalize(text, lang);
  const messageTokens = tokenize(normalizedText);
  const boostedCategory = context.last_category ? normalize(String(context.last_category), lang) : '';
  const scored = [];

  for (const item of items) {
    let score = 0;
    const variants = getItemVariants(item);
    const categories = getItemCategoryVariants(item);

    for (const variant of variants) {
      if (!variant) continue;
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
      if (!category) continue;
      if (normalizedText.includes(category)) {
        score += 6;
      }
      const categoryTokens = tokenize(category).filter((token) => token.length > 1);
      const ratio = overlapScore(messageTokens, categoryTokens);
      if (ratio >= 0.5) {
        score += ratio * 4;
      }
      // Only use previous category context to break ties when the new message
      // already matched something real about this item.
      if (boostedCategory && category === boostedCategory && score > 0) {
        score += 5;
      }
    }

    const description = normalize(
      lang === 'ar' ? item.description_ar || item.description_en || '' : item.description_en || item.description_ar || '',
      lang
    );
    if (description) {
      const descTokens = tokenize(description).filter((token) => token.length > 2);
      const ratio = overlapScore(messageTokens, descTokens);
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

function findMatchingItems(text, lang, items, context = {}) {
  return uniqueById(findScoredItems(text, lang, items, context).map((entry) => entry.item));
}

function findMatchingCategories(text, lang, items) {
  const normalizedText = normalize(text, lang);
  const categoryMap = new Map();

  for (const item of items) {
    const variants = getItemCategoryVariants(item);
    for (const variant of variants) {
      if (!variant) continue;
      if (normalizedText.includes(variant) || overlapScore(tokenize(normalizedText), tokenize(variant)) >= 0.5) {
        const key = variant;
        const existing = categoryMap.get(key) || {
          key,
          display: lang === 'ar' ? item.category_ar || item.category_en : item.category_en || item.category_ar,
          items: [],
        };
        existing.items.push(item);
        categoryMap.set(key, existing);
      }
    }
  }

  return Array.from(categoryMap.values()).map((entry) => ({
    ...entry,
    items: uniqueById(entry.items),
  })).filter((entry) => entry.items.length);
}

function detectIntent(text, lang, cafeId, context = {}) {
  const patterns = PATTERNS[lang] || PATTERNS.en;
  const normalizedText = normalize(text, lang);
  const items = getMenuItems(cafeId);
  const lastItem = context.last_item
    ? items.find((item) => item.id === context.last_item)
    : null;
  const categoryMatches = findMatchingCategories(text, lang, items);

  if (matchesAny(normalizedText, patterns.greeting)) return { intent: 'greeting', confidence: 1 };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks', confidence: 1 };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help', confidence: 1 };
  if (matchesAny(normalizedText, patterns.reservation)) return { intent: 'reservation', confidence: 1 };

  const asksPrice = matchesAny(normalizedText, patterns.item_price);
  const asksSizes = matchesAny(normalizedText, patterns.item_sizes);
  const scoredMatches = findScoredItems(text, lang, items, context);
  const matchedItems = uniqueById(scoredMatches.map((entry) => entry.item));
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchedItems.length === 1 && foundItem) {
    if (asksPrice && !asksSizes) return { intent: 'item_price', item: foundItem, confidence: 1 };
    if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: foundItem, confidence: 1 };
    return { intent: 'item_found', item: foundItem, confidence: 1 };
  }

  if (matchedItems.length > 1) {
    if (topScore >= secondScore + 3) {
      if (asksPrice && !asksSizes) return { intent: 'item_price', item: foundItem, confidence: 0.92 };
      if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: foundItem, confidence: 0.92 };
      return { intent: 'item_found', item: foundItem, confidence: 0.92 };
    }
    if (asksPrice || asksSizes) {
      return { intent: 'item_disambiguation', items: matchedItems, confidence: 0.85 };
    }
    return { intent: 'item_disambiguation', items: matchedItems, confidence: 0.85 };
  }

  if (categoryMatches.length === 1) {
    const categoryMatch = categoryMatches[0];
    if (categoryMatch.items.length === 1) {
      if (asksPrice && !asksSizes) return { intent: 'item_price', item: categoryMatch.items[0], confidence: 0.9 };
      if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: categoryMatch.items[0], confidence: 0.9 };
      return { intent: 'item_found', item: categoryMatch.items[0], confidence: 0.9 };
    }
    return {
      intent: 'category_items',
      category: categoryMatch.display,
      items: categoryMatch.items,
      confidence: 0.8,
    };
  }

  if (asksPrice && lastItem) return { intent: 'item_price', item: lastItem, confidence: 0.9 };
  if (asksSizes && lastItem) return { intent: 'item_sizes', item: lastItem, confidence: 0.9 };
  if (asksPrice || asksSizes) return { intent: 'need_item_context', confidence: 0.7 };

  if (matchesAny(normalizedText, patterns.menu_general)) return { intent: 'menu_general', confidence: 1 };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact', confidence: 1 };
  if (matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours', confidence: 1 };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location', confidence: 1 };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info', confidence: 1 };

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) {
    return { intent: 'item_not_found', confidence: 0.45 };
  }

  return { intent: 'unknown', confidence: 0 };
}

module.exports = {
  detectIntent,
  findMatchingItems,
  getMenuItems,
  invalidateMenuCache,
};
