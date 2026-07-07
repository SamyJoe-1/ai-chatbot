'use strict';

const { getBusinessItems } = require('../brains/shared/catalogStore');
const { getBrandProfile, conceptMatchItems } = require('../brains/shared/brandProfile');
const { normalize, tokenize } = require('./detector');
const { fuzzyTokenScore, detectCountry, detectCountries, countryMatchesItem } = require('../brains/shared/matcher');
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

// Strip the Arabic definite article "ال" from the front of a token so
// "الامبراطوره" matches a title's "امبراطوره". Substring matching already
// handles the reverse direction (a bare token is a substring of a title that
// carries the article). Only strip when enough stem remains to stay meaningful.
function stripArabicArticle(token) {
  return (token.length > 4 && token.startsWith('ال')) ? token.slice(2) : token;
}

function findItemsByText(items, value, lang) {
  const needle = normalize(value, lang);
  if (!needle) return [];
  const needleTokens = tokenize(needle)
    .filter((token) => token.length > 1)
    .map(stripArabicArticle);

  // Primary: match against the title / category only. These are the strongest
  // signals — if anything matches here we never look at descriptions.
  // For a MULTI-WORD query, a single shared token must NOT qualify: "عطر
  // البراطور" would otherwise return every perfume on the generic word "عطر"
  // while the distinguishing word "البراطور" matches nothing. Require the full
  // phrase OR at least two token hits so the query's specificity is respected.
  // A single-token query keeps the loose any-token behavior (e.g. a bare
  // category word like "العطور" should still list the whole category).
  // A needle token "hits" a haystack when it is a substring OR is a small typo
  // away from one of the haystack's own tokens (fuzzyTokenScore: same first
  // letter + bounded edit distance). The fuzzy arm is what lets "امبروطوره"
  // (typo) find a title's "امبراطوره". Gated by the ≥2-hit rule below so a typo
  // on a generic word alone can never widen into a category dump.
  const tokenHits = (hay, hayTokens, token) => {
    if (hay.includes(token)) return true;
    return hayTokens.some((vt) => fuzzyTokenScore(token, vt) > 0);
  };

  const minTokenHits = needleTokens.length >= 2 ? 2 : 1;
  const titleCategoryMatches = items.filter((item) => {
    const title = normalize(`${item.title_en || ''} ${item.title_ar || ''}`, lang);
    const category = normalize(`${item.category_en || ''} ${item.category_ar || ''}`, lang);
    if (title.includes(needle) || category.includes(needle)) return true;
    const titleTokens = tokenize(title).filter(Boolean);
    const categoryTokens = tokenize(category).filter(Boolean);
    const hits = needleTokens.filter((token) =>
      tokenHits(title, titleTokens, token) || tokenHits(category, categoryTokens, token)).length;
    return hits >= minTokenHits;
  });
  if (titleCategoryMatches.length) return titleCategoryMatches;

  // Fallback: only when nothing matched by title/category, engage the
  // description + metadata so we still surface relevant items by context. Apply
  // the same multi-word precision rule — a single generic token shared by a
  // whole category's descriptions must not return all of them.
  return items.filter((item) => {
    const haystack = itemSearchText(item, lang);
    if (haystack.includes(needle)) return true;
    const hits = needleTokens.filter((token) => haystack.includes(token)).length;
    return hits >= minTokenHits;
  });
}

// "send me one product", "just one", "منتج واحد بس" — the customer wants a
// SINGLE result, not the AI-routed pipelines' default list. Mirrors the
// ecommerce brain's local single_item_request patterns so the AI-classified
// path (codes [2]/[3]/[4]/[5], resolved locally against the catalog) respects
// the same "just one" signal instead of always dumping up to 8 matches.
const SINGLE_ITEM_RE = [
  /\bone\b[\w\s]{0,15}\bproducts?\b/i,
  /\bproducts?\b[\w\s]{0,15}\bone\b/i,
  /\bjust one\b/i,
  /\bonly one\b/i,
  /\bsingle (item|product)\b/i,
  /\bgive me one\b/i,
  /\bshow (me )?(just )?one\b/i,
  /\bat\s*least\s*one\b/i,
  /(واحد بس|واحد فقط|منتج واحد|قطعة واحدة|عايز واحد|عاوز واحد|عايزة واحد|ولو واحد|على الاقل واحد|على الأقل واحد)/,
];

function wantsOnlyOne(text) {
  const value = String(text || '');
  return SINGLE_ITEM_RE.some((re) => re.test(value));
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
      ? `مش لاقي نتيجة مطابقة للطلب ده تحديداً — ممكن توصفلي المنتج بشكل تاني أو تقولي اسمه؟ وتقدر دايماً تسألني عن القائمة أو الأسعار أو تتواصل معنا على ${business.phone || 'رقم التواصل'}.`
      : `I could not spot an exact match for that one — could you describe it differently or give me the name? You can always ask me about the catalog and prices, or reach us at ${business.phone || 'our contact number'}.`,
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
// The classifier's own prompt instructs it to separate multi-item slots with
// COMMAS ONLY. Splitting on |, /, &, + as well used to fragment a single
// item's own title when the title itself contained one of those characters
// ("Soap&Shampoo", "USB & PD") into two bogus "item" names — one of which
// would then false-match some unrelated product.
function splitItemSlot(slot) {
  return String(slot || '')
    .split(/\s*,\s*|\s*،\s*/) // comma, Arabic comma
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

// [8]'s schema is ONE item / ONE detail, but the classifier sometimes fills
// the item slot with a comma-separated list anyway ("are those available in
// SA, or which country?" about several items just shown) — collapsing that to
// whichever ONE item findItemsByText happens to return first silently answers
// about the wrong product. Build one concise line per item instead.
// "availability" as a detail slot has no matching field — the real data lives
// in the boolean `available` column plus the item's country (what a Gulf
// sourcing customer actually means by "is it available / which country").
// resolveDetail's generic key lookup can't bridge that name gap, so special-
// case it the same way price/size already are in the single-item branch below.
function isAvailabilityDetail(detail) {
  return /(availab|in\s*stock|stock)/i.test(String(detail || ''));
}

function formatAvailabilityLine(item, lang) {
  const isAvailable = Number(item.available) === 1 || item.available === true;
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const country = lang === 'ar' ? (meta.country_ar || meta.country_en) : (meta.country_en || meta.country);
  const status = lang === 'ar' ? (isAvailable ? 'متوفر' : 'غير متوفر') : (isAvailable ? 'Available' : 'Not available');
  return country ? `${status} (${country})` : status;
}

function buildMultiDetailFieldPayload({ items, detail, lang, business }) {
  const lines = items.map((item) => {
    if (isAvailabilityDetail(detail)) {
      return `- ${displayTitle(item, lang)}: ${formatAvailabilityLine(item, lang)}`;
    }
    const resolved = resolveDetail(item, detail, lang);
    const value = resolved
      ? stringifySearch(resolved.value)
      : (lang === 'ar' ? 'غير محدد' : 'not specified');
    return `- ${displayTitle(item, lang)}: ${value}`;
  });
  const heading = lang === 'ar' ? 'إليك التفاصيل المطلوبة لكل عنصر:' : 'Here is that detail for each item:';
  const last = items[items.length - 1];
  return {
    intent: 'ai_multi_specific_detail',
    payload: {
      text: [heading, ...lines].join('\n'),
      type: 'text',
      buttons: [],
      suggestions: items.slice(0, 4).map((item) => displayTitle(item, lang)),
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

// Shared "we don't have that from country X" honest reply — used whenever a
// country filter wipes out every candidate, so the bot never silently
// substitutes an item from the wrong country as if it satisfied the request.
function buildCountryMissPayload({ activeCountry, activeCountries, lang, business }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  // Detection may resolve to several countries at once (a region like "Gulf").
  // Show the full list so the honest "not available" reply names exactly what
  // was searched, not just one of them.
  const list = Array.isArray(activeCountries) && activeCountries.length ? activeCountries : [activeCountry];
  const label = list.filter(Boolean).join(locale === 'ar' ? '، ' : ', ');
  const text = locale === 'ar'
    ? `لم نجد هذا متوفراً من ${label} حالياً، لكن يمكننا توفيره من شبكتنا — تواصل معنا على ${business.phone || 'رقم التواصل'}.`
    : `We don't currently have that available from ${label}, but we can source it from our network — contact us at ${business.phone || 'our contact number'}.`;
  return { intent: 'ecommerce_country_products', payload: { text, type: 'text', buttons: [], suggestions: [], context_update: {} } };
}

function resolveAiPipeline({ pipeline, brain, business, lang, context, text }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const items = getBusinessItems(business.id);
  const capToOne = wantsOnlyOne(text);
  // The AI's pipeline slots ([2]/[3]/[5] especially) have NO country field, so
  // "electronics in Saudi Arabia" can classify as a plain item/category search
  // and silently drop the country the customer actually asked for. Detect it
  // locally from the raw message and narrow the AI's candidate set with it —
  // independent of which pipeline code the classifier picked.
  // May resolve to several countries when a REGION is named ("Gulf" -> every
  // Gulf country the catalog stocks). activeCountry keeps the first for any
  // single-value use; activeCountries drives filtering + the miss message.
  const activeCountries = detectCountries(text, locale, items);
  const activeCountry = activeCountries[0] || null;
  // When a country is named but filtering it wipes out every candidate, DO NOT
  // silently fall back to showing an item from a different country as if it
  // satisfied the request — that is exactly the "silent substitution" that
  // caused real confusion. Flag the miss so the caller can say so honestly.
  let countryMiss = false;
  const narrowByCountry = (matches) => {
    if (!activeCountries.length) return matches;
    const filtered = matches.filter((item) => activeCountries.some((c) => countryMatchesItem(item, c)));
    if (!filtered.length && matches.length) countryMiss = true;
    return filtered;
  };
  const countryMissPayload = () => buildCountryMissPayload({ activeCountry, activeCountries, lang, business });

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
    matches = narrowByCountry(matches);
    if (countryMiss) return countryMissPayload();
    if (matches.length && (matches.length === 1 || capToOne)) {
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
    // A category lookup must filter on the CATEGORY field, not fuzzy-search
    // titles — findItemsByText's typo tolerance is tuned for product names and
    // can conflate a category word with an unrelated title that merely shares
    // a prefix ("Electronics" fuzzy-matching "Electric Facial Massager").
    // Fall back to the fuzzy title search only if no real category matched,
    // in case the classifier's slot isn't an exact category name.
    const categoryNeedle = normalize(pipeline.item, locale);
    let matches = items.filter((item) =>
      normalize(`${item.category_en || ''} ${item.category_ar || ''}`, locale).includes(categoryNeedle));
    if (!matches.length) matches = findItemsByText(items, pipeline.item, locale);
    matches = narrowByCountry(matches);
    if (countryMiss) return countryMissPayload();
    if (capToOne && matches.length) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: matches[0] }, locale, business) };
    }
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
    matches = narrowByCountry(matches);
    if (countryMiss) return countryMissPayload();
    if (capToOne && matches.length) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: matches[0] }, locale, business) };
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
    const matches = narrowByCountry(items.filter((item) => !excludes.some((term) => itemSearchText(item, locale).includes(term))));
    if (countryMiss) return countryMissPayload();
    if (capToOne && matches.length) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: matches[0] }, locale, business) };
    }
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
    const detailParts = splitItemSlot(pipeline.itemForDetail);
    if (detailParts.length > 1) {
      const resolvedItems = [];
      const seen = new Set();
      for (const part of detailParts) {
        let best = bestItemForName(items, part, locale);
        if (!best) {
          const m = conceptMatchItems({ text: part, lang: locale, items, profile: getBrandProfile(business.id) });
          best = m[0] || null;
        }
        if (best && !seen.has(best.id)) {
          seen.add(best.id);
          resolvedItems.push(best);
        }
      }
      if (resolvedItems.length > 1) {
        return buildMultiDetailFieldPayload({ items: resolvedItems, detail: pipeline.detail, lang: locale, business });
      }
      // Only one name actually resolved — fall through to the normal
      // single-item path below using the original slot text.
    }
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
function recommendationPool({ criteria, business, lang, context, text }) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const items = getBusinessItems(business.id);
  const crit = normalize(criteria || '', locale);

  // Check each language's category name SEPARATELY against the criteria — the
  // previous version concatenated "electronics إلكترونيات" into one string and
  // tested if THAT (bilingual) blob was a substring of the (single-language)
  // criteria sentence, which can never be true. That silently broke category
  // narrowing entirely, always falling through to the whole catalog below.
  let pool = items.filter((item) => {
    const catEn = normalize(item.category_en || '', locale);
    const catAr = normalize(item.category_ar || '', locale);
    return (catEn && crit.includes(catEn)) || (catAr && crit.includes(catAr));
  });

  if (!pool.length && context && context.last_category) {
    const lastCat = normalize(context.last_category, locale);
    pool = items.filter((item) => normalize(`${item.category_en || ''} ${item.category_ar || ''}`, locale).includes(lastCat));
  }
  if (!pool.length) pool = findItemsByText(items, criteria, locale);
  if (!pool.length) pool = conceptMatchItems({ text: criteria, lang: locale, items, profile: getBrandProfile(business.id) });
  if (!pool.length) pool = items.slice();

  // A country named in the request/criteria ("recommend electronics for Saudi
  // Arabia") must actually narrow the candidates — otherwise the recommend
  // call has no way to know it should only pick from that country, and can
  // (and did) suggest an item from somewhere else entirely.
  const activeCountries = detectCountries(text || criteria, locale, items);
  const activeCountry = activeCountries[0] || null;
  let countryMiss = false;
  if (activeCountries.length) {
    const filtered = pool.filter((item) => activeCountries.some((c) => countryMatchesItem(item, c)));
    if (filtered.length) {
      pool = filtered;
    } else {
      countryMiss = true;
    }
  }

  return { pool: pool.slice(0, 12), countryMiss, activeCountry, activeCountries };
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
    // Country travels WITH the candidate so the recommend call can reference
    // or (when the customer named one) honor it — it used to be dropped
    // entirely, so the model had no way to know a candidate's country.
    if (meta.country_en || meta.country) out.country = meta.country_en || meta.country;
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) out[key] = value;
    }
    return out;
  });
}

function buildRecommendationCandidates({ criteria, business, lang, context, text }) {
  const { pool, countryMiss, activeCountry, activeCountries } = recommendationPool({ criteria, business, lang, context, text });
  // "suggest ONE product" — the recommend prompt can still pad its reply with
  // a second "if you're interested" suggestion when it has more than one
  // candidate to work with. Physically cap the candidate set to 1 so there is
  // nothing else in scope for it to mention.
  const cappedPool = wantsOnlyOne(text) ? pool.slice(0, 1) : pool;
  return { candidates: compactCandidates(cappedPool, lang), countryMiss, activeCountry, activeCountries };
}

// Strip a leading list marker ("1. ", "- ", "• ", "* ") from a recommendation
// line. The `*` bullet case uses a negative lookahead so it never eats one
// asterisk off a leading "**Bold Title**" — that left a stray unmatched `*`
// in the output ("*Bold Title**") that rendered as literal asterisks instead
// of bold text.
function stripListPrefix(line) {
  return String(line || '').replace(/^\s*(?:\d+[.)]\s*|[-•]\s*|\*(?!\*)\s*)/, '').trim();
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
  buildCountryMissPayload,
};
