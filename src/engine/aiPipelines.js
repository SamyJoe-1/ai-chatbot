'use strict';

const { getBusinessItems } = require('../brains/shared/catalogStore');
const { getBrandProfile, conceptMatchItems } = require('../brains/shared/brandProfile');
const { normalize, tokenize } = require('./detector');
const { getItemThumbnail, buildThumbnailMessages } = require('../brains/shared/thumbnailMessages');

function displayTitle(item, lang) {
  return lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar;
}

function displayCategory(item, lang) {
  return lang === 'ar' ? item.category_ar || item.category_en : item.category_en || item.category_ar;
}

function stringifySearch(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(stringifySearch).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(stringifySearch).join(' ');
  return String(value);
}

function itemSearchText(item, lang) {
  return normalize([
    item.title_en,
    item.title_ar,
    item.category_en,
    item.category_ar,
    item.description_en,
    item.description_ar,
    stringifySearch(item.metadata || {}),
  ].join(' '), lang);
}

function findItemsByText(items, value, lang) {
  const needle = normalize(value, lang);
  if (!needle) return [];
  const needleTokens = tokenize(needle).filter((token) => token.length > 1);

  // Primary: match against the title / category only. These are the strongest
  // signals — if anything matches here we never look at descriptions.
  const titleCategoryMatches = items.filter((item) => {
    const title = normalize(`${item.title_en || ''} ${item.title_ar || ''}`, lang);
    const category = normalize(`${item.category_en || ''} ${item.category_ar || ''}`, lang);
    if (title.includes(needle) || category.includes(needle)) return true;
    return needleTokens.some((token) => title.includes(token) || category.includes(token));
  });
  if (titleCategoryMatches.length) return titleCategoryMatches;

  // Fallback: only when nothing matched by title/category, engage the
  // description + metadata so we still surface relevant items by context.
  return items.filter((item) => {
    const haystack = itemSearchText(item, lang);
    return haystack.includes(needle) || needleTokens.some((token) => haystack.includes(token));
  });
}

function getValueByDynamicKey(item, key) {
  if (!key) return undefined;
  if (Object.prototype.hasOwnProperty.call(item, key)) return item[key];
  if (item.metadata && Object.prototype.hasOwnProperty.call(item.metadata, key)) return item.metadata[key];
  return undefined;
}

function compareValues(a, b, order) {
  const aNum = Number(a);
  const bNum = Number(b);
  let result;
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
    result = aNum - bNum;
  } else {
    result = String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
  }
  return order === 'desc' ? -result : result;
}

function makeListPayload({ items, lang, business, heading, intent }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const suggestions = items.slice(0, 4).map((item) => displayTitle(item, locale));
  const context_update = items[0] ? { last_item: items[0].id, last_category: displayCategory(items[0], locale) || null } : {};

  if (!items.length) {
    return {
      intent,
      payload: { text: buildNotFoundPayload(locale, business).text, type: 'text', buttons: [], suggestions, context_update },
    };
  }

  const sliced = items.slice(0, 8);
  const itemLine = (item) => {
    const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
    return `- ${displayTitle(item, locale)}${price}`;
  };

  const thumbMsgs = buildThumbnailMessages(sliced, heading, itemLine);
  if (thumbMsgs) {
    const text = thumbMsgs.map((m) => m.text).filter(Boolean).join('\n');
    return {
      intent,
      payload: { text, type: 'text', buttons: [], suggestions, messages: thumbMsgs, context_update },
    };
  }

  const text = [heading, ...sliced.map(itemLine)].join('\n');
  return {
    intent,
    payload: { text, type: 'text', buttons: [], suggestions, context_update },
  };
}

function buildNotFoundPayload(lang, business) {
  return {
    text: lang === 'ar'
      ? `لم أجد نتيجة واضحة لهذا الطلب بدون سياق إضافي. يمكنك سؤالي عن القائمة أو الأسعار أو التواصل معنا على ${business.phone || 'رقم التواصل'}.`
      : `I could not find a clear match for that request without more context. You can ask about the catalog, prices, or contact us at ${business.phone || 'our contact number'}.`,
    type: 'text',
    buttons: [],
    suggestions: [],
    context_update: {},
  };
}

// A [7] detail slot may name more than one item ("Creamy Pesto Chicken, Tomato
// Soup" or "latte | espresso"). Split on explicit separators only — NOT the word
// "and", which appears inside real item names ("Fish and Chips") — so each part
// can be resolved to its own item.
function splitItemSlot(slot) {
  return String(slot || '')
    .split(/\s*[,|/&+]\s*|\s*،\s*/) // comma, pipe, slash, &, +, Arabic comma
    .map((part) => part.trim())
    .filter(Boolean);
}

// Pick the SINGLE best item for a named phrase. findItemsByText filters by loose
// token overlap and returns catalog order, so "Creamy Pesto Chicken" would grab
// the first item containing "chicken". Here we rank: a title that contains the
// whole phrase wins, then token coverage, with a small penalty for titles much
// longer than the phrase — so an exact-ish name resolves to the right item.
function bestItemForName(items, name, lang) {
  const needle = normalize(name, lang);
  if (!needle) return null;
  const needleTokens = tokenize(needle).filter((token) => token.length > 1);
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const title = normalize(`${item.title_en || ''} ${item.title_ar || ''}`, lang);
    if (!title) continue;
    let score = 0;
    if (title.includes(needle)) score += 100;
    if (title.length > 2 && needle.includes(title)) score += 80;
    const tokenHits = needleTokens.filter((token) => title.includes(token)).length;
    score += tokenHits * 5;
    if (needleTokens.length) score += (tokenHits / needleTokens.length) * 10;
    if (score > 0) score -= Math.abs(title.length - needle.length) * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore > 0 ? best : null;
}

// Build ONE response that shows a full detail card for EACH item, using the
// brain's normal item_found renderer per item and stitching them into a
// `messages` array (so each keeps its own thumbnail). Tracks all ids as the
// last-recommended set so a follow-up "order them" can seed every one.
function buildMultiDetailPayload({ items, brain, business, lang }) {
  const messages = items.map((item) => {
    const part = brain.buildResponse({ intent: 'item_found', item }, lang, business);
    return { text: part.text, thumbnail: part.thumbnail || null };
  });
  const text = messages.map((m) => m.text).filter(Boolean).join('\n\n');
  const last = items[items.length - 1];
  return {
    intent: 'ai_multi_details',
    payload: {
      text,
      type: 'text',
      buttons: [],
      suggestions: items.slice(0, 4).map((item) => displayTitle(item, lang)),
      messages,
      context_update: {
        last_item: last.id,
        last_category: displayCategory(last, lang) || null,
        last_recommended_ids: items.map((item) => item.id).filter((id) => Number.isFinite(id)),
      },
    },
  };
}

function resolveDetail(item, detail, lang) {
  const key = normalize(detail, 'en').replace(/\s+/g, '_');
  const candidates = [
    detail,
    key,
    key.replace(/s$/, ''),
    normalize(detail, lang),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = getValueByDynamicKey(item, candidate);
    if (value !== undefined && value !== null && value !== '') return { label: candidate, value };
  }

  const normalizedDetail = normalize(detail, lang);
  const metadataEntry = Object.entries(item.metadata || {}).find(([metadataKey]) => {
    return normalize(metadataKey, lang).includes(normalizedDetail)
      || normalizedDetail.includes(normalize(metadataKey, lang));
  });
  if (metadataEntry) return { label: metadataEntry[0], value: metadataEntry[1] };
  return null;
}

function resolveAiPipeline({ pipeline, brain, business, lang, context }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const items = getBusinessItems(business.id);

  if (!pipeline.valid) return null;

  if (pipeline.code === 1) {
    return { intent: 'greeting_hello', payload: brain.buildResponse({ intent: 'greeting_hello' }, locale, business) };
  }

  if (pipeline.code === 2) {
    let matches = findItemsByText(items, pipeline.item, locale);
    // Literal search missed — the classifier may have echoed a concept word
    // ("sea", "spicy"). Fall back to the brand-profile concept map so the
    // search still lands on real items instead of dead-ending on "not found".
    if (!matches.length) {
      matches = conceptMatchItems({ text: pipeline.item, lang: locale, items, profile: getBrandProfile(business.id) });
    }
    if (matches.length === 1) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: matches[0] }, locale, business) };
    }
    return makeListPayload({
      items: matches,
      lang: locale,
      business,
      heading: locale === 'ar' ? 'هذه أقرب النتائج:' : 'Here are the closest matches:',
      intent: matches.length ? 'ai_search_items' : 'ai_not_found',
    });
  }

  if (pipeline.code === 3) {
    const matches = findItemsByText(items, pipeline.item, locale);
    return makeListPayload({
      items: matches,
      lang: locale,
      business,
      heading: locale === 'ar' ? `هذه الأصناف الموجودة في ${pipeline.item}:` : `Here are the items in ${pipeline.item}:`,
      intent: matches.length ? 'category_items' : 'ai_not_found',
    });
  }

  if (pipeline.code === 4) {
    let matches = items.slice();
    if (pipeline.fields.category) {
      const categoryNeedle = normalize(pipeline.fields.category, locale);
      matches = matches.filter((item) => normalize(`${item.category_en || ''} ${item.category_ar || ''}`, locale).includes(categoryNeedle));
    }
    if (pipeline.fields.item) {
      const itemMatches = findItemsByText(matches, pipeline.fields.item, locale);
      matches = itemMatches.length ? itemMatches : matches.filter((item) => itemSearchText(item, locale).includes(normalize(pipeline.fields.item, locale)));
    }
    if (pipeline.fields.exclude) {
      const excludes = pipeline.fields.exclude.split(',').map((value) => normalize(value.trim(), locale)).filter(Boolean);
      matches = matches.filter((item) => !excludes.some((term) => itemSearchText(item, locale).includes(term)));
    }
    if (pipeline.fields.sort_by) {
      matches = matches
        .filter((item) => getValueByDynamicKey(item, pipeline.fields.sort_by) !== undefined)
        .sort((a, b) => compareValues(getValueByDynamicKey(a, pipeline.fields.sort_by), getValueByDynamicKey(b, pipeline.fields.sort_by), pipeline.fields.order || 'asc'));
    }
    return makeListPayload({
      items: matches,
      lang: locale,
      business,
      heading: locale === 'ar' ? 'هذه النتائج المناسبة:' : 'Here are the matching results:',
      intent: matches.length ? 'ai_filtered_items' : 'ai_not_found',
    });
  }

  if (pipeline.code === 5) {
    const excludes = pipeline.item.split(',').map((value) => normalize(value.trim(), locale)).filter(Boolean);
    const matches = items.filter((item) => !excludes.some((term) => itemSearchText(item, locale).includes(term)));
    return makeListPayload({
      items: matches,
      lang: locale,
      business,
      heading: locale === 'ar' ? 'هذه الأصناف التي لا تحتوي على المطلوب استبعاده:' : 'Here are the items without that exclusion:',
      intent: matches.length ? 'ai_exclusion_items' : 'ai_not_found',
    });
  }

  if (pipeline.code === 7) {
    // The slot may name several items — resolve each separately so we show a
    // full card per item instead of collapsing to the first match.
    const parts = splitItemSlot(pipeline.item);
    const resolved = [];
    const seen = new Set();
    for (const part of (parts.length ? parts : [pipeline.item])) {
      let best = bestItemForName(items, part, locale);
      if (!best) {
        const m = conceptMatchItems({ text: part, lang: locale, items, profile: getBrandProfile(business.id) });
        best = m[0] || null;
      }
      if (best && !seen.has(best.id)) {
        seen.add(best.id);
        resolved.push(best);
      }
    }
    if (!resolved.length) {
      return { intent: 'ai_not_found', payload: buildNotFoundPayload(locale, business) };
    }
    if (resolved.length === 1) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: resolved[0] }, locale, business) };
    }
    return buildMultiDetailPayload({ items: resolved, brain, business, lang: locale });
  }

  if (pipeline.code === 8) {
    const matches = findItemsByText(items, pipeline.itemForDetail, locale);
    const item = matches[0];
    if (!item) return { intent: 'ai_not_found', payload: buildNotFoundPayload(locale, business) };
    const normalizedDetail = normalize(pipeline.detail, 'en');
    if (/(price|cost|how much)/i.test(normalizedDetail)) {
      return { intent: 'item_price', payload: brain.buildResponse({ intent: 'item_price', item }, locale, business) };
    }
    if (/(size|sizes|weight|diameter|serves|dimension)/i.test(normalizedDetail)) {
      return { intent: 'item_sizes', payload: brain.buildResponse({ intent: 'item_sizes', item, queryText: pipeline.detail }, locale, business) };
    }
    const detail = resolveDetail(item, pipeline.detail, locale);
    if (detail) {
      const title = displayTitle(item, locale);
      return {
        intent: 'ai_specific_detail',
        payload: {
          text: `${title}\n${detail.label}: ${stringifySearch(detail.value)}`,
          type: 'text',
          buttons: [],
          suggestions: [],
          context_update: { last_item: item.id, last_category: displayCategory(item, locale) || null },
        },
      };
    }
    // We resolved the item but not the specific detail the customer asked about
    // (e.g. an opinion/quality question like "is the egg breakfast good?" — there
    // is no metadata field for that). Don't dead-end on "not found": show the
    // item itself so they still get something useful and can continue.
    return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item }, locale, business) };
  }

  if (pipeline.code === 9) {
    return { intent: 'ai_not_found', payload: buildNotFoundPayload(locale, business) };
  }

  return null;
}

// Narrow the menu down to the small set of items a [12] recommendation should
// be judged over, so the answer call stays cheap. Priority: an explicit
// category in the criteria -> the category just shown (follow-up "which is
// best?") -> a keyword/concept search on the criteria -> the whole menu.
function recommendationPool({ criteria, business, lang, context }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const items = getBusinessItems(business.id);
  const crit = normalize(criteria || '', locale);

  let pool = items.filter((item) => {
    const cat = normalize(`${item.category_en || ''} ${item.category_ar || ''}`, locale);
    return cat && crit.includes(cat);
  });

  if (!pool.length && context && context.last_category) {
    const lastCat = normalize(context.last_category, locale);
    pool = items.filter((item) => normalize(`${item.category_en || ''} ${item.category_ar || ''}`, locale).includes(lastCat));
  }
  if (!pool.length) pool = findItemsByText(items, criteria, locale);
  if (!pool.length) pool = conceptMatchItems({ text: criteria, lang: locale, items, profile: getBrandProfile(business.id) });
  if (!pool.length) pool = items.slice();

  return pool.slice(0, 12);
}

// Compact, token-light shape for the recommend answer call: short keys, a
// truncated description, and any numeric metadata (calories etc.) that helps
// the model reason about diet/protein. Never sends the full row.
function compactCandidates(items, lang) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  return items.map((item) => {
    const out = { n: displayTitle(item, locale), p: item.price, c: item.currency };
    const desc = locale === 'ar' ? (item.description_ar || item.description_en) : (item.description_en || item.description_ar);
    if (desc) out.d = String(desc).slice(0, 90);
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) out[key] = value;
    }
    return out;
  });
}

function buildRecommendationCandidates({ criteria, business, lang, context }) {
  return compactCandidates(recommendationPool({ criteria, business, lang, context }), lang);
}

// Strip a leading list marker ("1. ", "- ", "• ") from a recommendation line.
function stripListPrefix(line) {
  return String(line || '').replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim();
}

// The product name in a recommendation line is the part before the description
// separator ("Baby Organizer — keeps things tidy" / "Latte: smooth and warm").
function itemNameFromLine(line) {
  const stripped = stripListPrefix(line);
  const head = stripped.split(/\s+[—–-]\s+|:\s+/)[0];
  return (head || stripped).trim();
}

// STRICT line->item match: the line must actually contain the product's exact
// title (longest wins), or cover >=80% of a multi-word title's tokens. This is
// deliberately tighter than bestItemForName so an intro line like "great options
// for you" never resolves to a product on loose token overlap. The [12] prompt
// tells the model to copy titles exactly, so containment is the right test.
function strictItemForName(items, name, locale) {
  const n = normalize(name, locale);
  if (!n || n.length < 3) return null;
  const titleOf = (item) => normalize(locale === 'ar' ? (item.title_ar || item.title_en) : (item.title_en || item.title_ar), locale);

  let best = null;
  let bestLen = 0;
  for (const item of items) {
    const t = titleOf(item);
    if (t && t.length >= 4 && n.includes(t) && t.length > bestLen) {
      best = item;
      bestLen = t.length;
    }
  }
  if (best) return best;

  const nTokens = new Set(tokenize(n).filter((x) => x.length > 1));
  if (!nTokens.size) return null;
  let covBest = null;
  let covScore = 0;
  for (const item of items) {
    const tTokens = tokenize(titleOf(item)).filter((x) => x.length > 1);
    if (tTokens.length < 2) continue; // single-word titles can't match on coverage (too loose)
    const hits = tTokens.filter((x) => nTokens.has(x)).length;
    const cov = hits / tTokens.length;
    if (cov >= 0.8 && cov > covScore) {
      covScore = cov;
      covBest = item;
    }
  }
  return covBest;
}

// Turn a free-text [12] recommendation reply into a `messages[]` array: the
// intro line(s) become the first bubble, then EACH line that names a catalog
// item becomes its own bubble carrying that item's thumbnail (mirrors the
// multi-detail layout). Returns null when no line resolves to a real item, so
// the caller keeps the plain single-text reply. Works for every service type.
function buildRecommendationMessages({ replyText, business, lang }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const items = getBusinessItems(business.id);
  if (!items.length) return null;
  const lines = String(replyText || '').split('\n').map((l) => l.trim()).filter(Boolean);

  const intro = [];
  const itemMsgs = [];
  const trailing = [];
  const seen = new Set();
  for (const line of lines) {
    const name = itemNameFromLine(line);
    const item = name ? strictItemForName(items, name, locale) : null;
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      itemMsgs.push({ text: stripListPrefix(line), thumbnail: getItemThumbnail(item) || null });
    } else if (itemMsgs.length === 0) {
      intro.push(line);
    } else {
      trailing.push(line);
    }
  }

  if (!itemMsgs.length) return null;
  const messages = [];
  if (intro.length) messages.push({ text: intro.join('\n'), thumbnail: null });
  messages.push(...itemMsgs);
  if (trailing.length) messages.push({ text: trailing.join('\n'), thumbnail: null });
  return messages;
}

function prefixAiFallbackPayload(payload, lang) {
  const prefix = lang === 'ar'
    ? 'لم أتمكن من فهم تصنيف الذكاء الاصطناعي بدقة، لكن يمكنني مساعدتك بهذا:'
    : 'I could not read the AI classification clearly, but I can still help with this:';
  return {
    ...payload,
    text: `${prefix}\n${payload.text || ''}`.trim(),
  };
}

module.exports = {
  buildNotFoundPayload,
  prefixAiFallbackPayload,
  resolveAiPipeline,
  buildRecommendationCandidates,
  buildRecommendationMessages,
};
