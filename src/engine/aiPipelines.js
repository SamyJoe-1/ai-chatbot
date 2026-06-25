'use strict';

const { getBusinessItems } = require('../brains/shared/catalogStore');
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
    const matches = findItemsByText(items, pipeline.item, locale);
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
    const matches = findItemsByText(items, pipeline.item, locale);
    if (matches[0]) {
      return { intent: 'item_found', payload: brain.buildResponse({ intent: 'item_found', item: matches[0] }, locale, business) };
    }
    return { intent: 'ai_not_found', payload: buildNotFoundPayload(locale, business) };
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
};
