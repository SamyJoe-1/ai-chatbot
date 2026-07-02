'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { getBrandProfile, conceptMatchItems } = require('./shared/brandProfile');
const { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle } = require('./shared/matcher');
const { getItemThumbnail, buildThumbnailMessages } = require('./shared/thumbnailMessages');

// Filler words in a price/size question. Anything left over means the user
// named a specific (unknown) item -> "not found", not "which item do you mean?".
const PRICE_CONTEXT_FILLER = new Set([
  'how', 'much', 'many', 'what', 'whats', 'is', 'are', 'the', 'a', 'an', 'of',
  'for', 'it', 'this', 'that', 'your', 'do', 'you', 'have', 'price', 'cost',
  'prices', 'costs', 'priced', 'and', 'to', 'me', 'i', 'we', 'about', 'in',
]);

const PATTERNS = {
  en: {
    greeting_hello: [/^(hi|hello|hey|hiya|howdy)\b/i, /^good (morning|afternoon|evening)\b/i],
    greeting_how_are_you: [/^(how are u|how are u doing|are u okay|how are you|how are you doing|are you okay)\b/i],
    greeting_yasta: [/^(yasta)\b/i],
    thanks: [/\b(thanks|thank you|thx|ty|appreciate)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i, /\bhow does this work\b/i],
    catalog_general: [
      /\bmenu\b/i,
      /\bwhat do (you|u|ya)\b.*(have|got|offer|serve|sell)\b/i,
      /\bwhat (do|did|does) (you|u|ya) (have|got|offer|serve|sell)\b/i,
      /\bwhat do you offer\b/i,
      /\bshow me.*menu\b/i,
      /\bwhat (type|types|kind|kinds) of (food|dish|dishes|item|items|meal|meals)\b/i,
      /\bwhat food\b/i,
      /\bwhat.*you (serve|sell|offer|have|got)\b/i,
    ],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    item_sizes: [
      /\bsize\b/i, /\bsizes\b/i, /\bsmall\b/i, /\bmedium\b/i, /\blarge\b/i,
      /\bdiameter\b/i, /\binch(es)?\b/i, /\bweight\b/i, /\bgram(s)?\b/i,
      /\bserves\b/i, /\bdimension(s)?\b/i, /\bwidth\b/i, /\bmeasur(e|ement)\b/i
    ],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i, /\bworking hours\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bwhere are you\b/i, /\bdirections\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the cafe\b/i, /\bwhat do you provide\b/i],
    reservation: [/\breservation\b/i, /\bbook\b/i, /\bbooking\b/i, /\btable\b/i],
    // Explicit references back to a previously discussed item. Used ONLY as a
    // recall signal (paired with a stored last_item) — never matches generic
    // chatter or gibberish, so it can't hijack the normal not-found flow.
    recall: [
      /\bremind me\b/i, /\bwhat (was|were|is) (that|it|the|this)\b/i,
      /\bwhat did we\b/i, /\b(talking|talkin|chatting|discussing) about\b/i,
      /\bwe (were|are) (talking|discussing|checking)\b/i,
      /\bthat (dish|plate|plat|item|one|meal|food|thing)\b/i,
      /\bthe (last|previous) (one|item|dish|meal|thing)\b/i,
      /\bwhat (was|is) it (again|called)\b/i,
    ],
  },
  ar: {
    greeting_hello: [/^(مرحبا|مرحبتين|اهلا|أهلا|اهلين|أهلين|هلا|هالو|هلو|هاي|ألو|الو|حياك|حياكم|يا هلا|هلا والله|السلام عليكم|وعليكم السلام)/, /^(صباح الخير|مساء الخير|صباح النور|مساء النور)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|اخبارك|ازيك|إزيك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي|يصاحبي|يا صاحبي)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون|يعطيك العافية)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك|بتعمل ايه|تساعدني)/],
    catalog_general: [/(منيو|منيـو|قائمه|قائمة|ايش عندكم|شو عندكم|ماذا تقدمون|وجبات|مشروبات|عندكم ايه|عندكو ايه|عندك ايه)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|بقديش|كم السعر|الثمن|حسابه|حسابها)/],
    item_sizes: [/(حجم|احجام|أحجام|صغير|وسط|كبير|الاحجام|الأحجام|مقاس|مقاسات|قطر|بوصة|بوصه|انش|إنش|سم|سنتيمتر|وزن|جرام|تكفي|تكفى)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل|تليفون|تلفون|كلمكم|اكلمكم)/],
    working_hours: [/(ساعات|مواعيد|عمل|الدوام|شغالين|تفتح|تقفل|تفتحون|تغلقون|امتى|امتا|الساعة كام|الساعه كام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة|مكان|فروعكم|فرعكم)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المطعم|عن الكافيه|مين انت)/],
    reservation: [/(حجز|احجز|أحجز|طاوله|طاولة|ريزرفيشن|حجوزات)/],
    recall: [
      /(فكرني|ذكرني|افكرني|افتكر)/,
      /(كنا بنتكلم|كنا نتكلم|كنا نحكي|كنا بنحكي|اللي كنا)/,
      /(الصنف اللي|الطبق اللي|الاكله اللي|الأكله اللي|الحاجه اللي)/,
      /(اخر صنف|آخر صنف|الصنف السابق|الصنف اللي فات|الطلب اللي فات)/,
      /(ايه اللي كنا|إيه اللي كنا|كان اسمه ايه|اسمه ايه تاني|اسمها ايه تاني)/,
    ],
  },
};

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function getDisplayTitle(item, lang) {
  return lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar;
}

function getDisplayCategory(item, lang) {
  return lang === 'ar' ? item.category_ar || item.category_en : item.category_en || item.category_ar;
}

const SIZE_KEYWORDS = {
  small: {
    en: /\b(small|sm|s|single|personal|individual|baby|smallest)\b/i,
    ar: /(صغير|صغيره|سيرف|فرد|فرد واحد|لشخص|لشخص واحد|سمول|بيبي|الاصغر|الأصغر|اصغر حجم|أصغر حجم|منفرد|منفرده)/i
  },
  medium: {
    en: /\b(medium|med|m|mid|middle|regular|reg|double|serves 2|for 2)\b/i,
    ar: /(وسط|الوسط|المتوسط|ميديام|ميديوم|شخصين|فردين|لشخصين|لفردين|الحجم الوسط|المقاس الوسط)/i
  },
  large: {
    en: /\b(large|lg|l|big|jumbo|giant|family|family size|largest|xl|xxl)\b/i,
    ar: /(كبير|كبيره|الكبير|العائلي|عائلي|عائله|عائلة|لارج|الاضخم|الأضخم|اكبر حجم|أكبر حجم|جامبو|عملاق)/i
  }
};

function detectTargetSize(text, lang) {
  const normalized = text.toLowerCase();
  for (const [sizeKey, patterns] of Object.entries(SIZE_KEYWORDS)) {
    const pattern = lang === 'ar' ? patterns.ar : patterns.en;
    if (pattern.test(normalized)) {
      return sizeKey;
    }
  }
  return null;
}

function getSizes(item) {
  return Array.isArray(item.metadata?.sizes) ? item.metadata.sizes.filter(Boolean) : [];
}

function findCafeItems(text, lang, businessId, context = {}) {
  const items = getBusinessItems(businessId);
  const scoredMatchesAll = findScoredItems({
    text,
    lang,
    items,
    context,
    getItemVariants: (item) => [item.title_en, item.title_ar],
    getCategoryVariants: (item) => [item.category_en, item.category_ar],
    getExtraVariants: (item) => [
      item.description_en,
      item.description_ar,
      ...(getSizes(item)),
    ],
  });

  const scoredMatches = uniqueScoredByTitle(scoredMatchesAll, lang);

  return {
    items,
    scoredMatches,
    matchedItems: scoredMatches.map((entry) => entry.item),
    categoryMatches: findMatchingCategories({
      text,
      lang,
      items,
      getCategoryVariants: (item) => [item.category_en, item.category_ar],
      getCategoryDisplay: getDisplayCategory,
    }),
  };
}

function detectIntent({ text, lang, business, context = {} }) {
  const result = runDetectIntent({ text, lang, business, context });
  if (result) {
    result.queryText = text;
  }
  return result;
}

function runDetectIntent({ text, lang, business, context = {} }) {
  const patterns = PATTERNS[lang] || PATTERNS.en;
  const normalizedText = normalize(text, lang);
  const { items, scoredMatches, matchedItems, categoryMatches } = findCafeItems(text, lang, business.id, context);
  const lastItem = context.last_item ? items.find((item) => item.id === context.last_item) : null;
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchesAny(normalizedText, patterns.greeting_hello)) return { intent: 'greeting_hello' };
  if (matchesAny(normalizedText, patterns.greeting_how_are_you)) return { intent: 'greeting_how_are_you' };
  if (matchesAny(normalizedText, patterns.greeting_yasta)) return { intent: 'greeting_yasta' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };
  if (matchesAny(normalizedText, patterns.reservation)) return { intent: 'reservation' };
  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours' };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };



  const asksPriceBase = matchesAny(normalizedText, patterns.item_price);
  const asksSizesBase = matchesAny(normalizedText, patterns.item_sizes);

  let asksPrice = asksPriceBase;
  let asksSizes = asksSizesBase;

  if (foundItem) {
    const itemTitle = (lang === 'ar' ? foundItem.title_ar || foundItem.title_en : foundItem.title_en || foundItem.title_ar) || '';
    const itemTokens = tokenize(normalize(itemTitle, lang));
    const queryTokens = tokenize(normalizedText);
    const extraTokens = queryTokens.filter((token) => !itemTokens.includes(token));
    const extraText = extraTokens.join(' ');

    asksPrice = matchesAny(extraText, patterns.item_price);
    asksSizes = matchesAny(extraText, patterns.item_sizes);
  }

  if ((asksPrice || asksSizes) && lastItem && topScore < 12) {
    if (asksPrice && !asksSizes) return { intent: 'item_price', item: lastItem };
    if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: lastItem };
    return { intent: 'item_sizes', item: lastItem };
  }

  if (matchedItems.length === 1 && foundItem) {
    if (asksPrice && !asksSizes) return { intent: 'item_price', item: foundItem };
    if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: foundItem };
    return { intent: 'item_found', item: foundItem };
  }

  if (matchedItems.length > 1) {
    if (topScore >= secondScore + 3) {
      if (asksPrice && !asksSizes) return { intent: 'item_price', item: foundItem };
      if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: foundItem };
      return { intent: 'item_found', item: foundItem };
    }
    return { intent: 'item_disambiguation', items: matchedItems };
  }

  if (categoryMatches.length === 1) {
    const categoryMatch = categoryMatches[0];
    if (categoryMatch.items.length === 1) {
      if (asksPrice && !asksSizes) return { intent: 'item_price', item: categoryMatch.items[0] };
      if (asksSizes && !asksPrice) return { intent: 'item_sizes', item: categoryMatch.items[0] };
      return { intent: 'item_found', item: categoryMatch.items[0] };
    }
    return {
      intent: 'category_items',
      category: categoryMatch.display,
      items: categoryMatch.items,
    };
  }

  // Context recall: an explicit "remind me / what was that dish" with a prior
  // item in context and nothing new named. Reached only after item/category
  // matching failed, and gated on the recall phrasing — so plain gibberish
  // after a matched item still falls through to the normal not-found reply.
  if (lastItem && matchesAny(normalizedText, patterns.recall)) {
    return { intent: 'item_recall', item: lastItem };
  }

  if (asksPrice && lastItem) return { intent: 'item_price', item: lastItem };
  if (asksSizes && lastItem) return { intent: 'item_sizes', item: lastItem };
  if (asksPrice || asksSizes) {
    // If the user actually named something (residual content tokens) that we
    // couldn't match, say "not found" — don't dead-end with "which item?" and
    // no options. Only a bare "how much?" deserves the clarification prompt.
    const residual = tokenize(normalizedText).filter((token) => token.length > 1 && !PRICE_CONTEXT_FILLER.has(token));
    return { intent: residual.length ? 'item_not_found' : 'need_item_context' };
  }

  // Concept fallback (zero AI): nothing matched a literal item/category, but the
  // brand profile may map a concept the customer used ("something from the sea",
  // "anything spicy") onto real catalog items. Resolved entirely from the stored
  // profile — no classifier call — so this deflects a would-be AI query.
  const conceptItems = conceptMatchItems({
    text: normalizedText,
    lang,
    items,
    profile: getBrandProfile(business.id),
  });
  if (conceptItems.length === 1) {
    return { intent: 'item_found', item: conceptItems[0] };
  }
  if (conceptItems.length > 1) {
    return { intent: 'concept_items', items: conceptItems };
  }

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) {
    return { intent: 'item_not_found' };
  }

  return { intent: 'unknown' };
}

function buildResponse(intentResult, lang, business) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const parseSuggestions = () => {
    try {
      const parsed = JSON.parse(business[`suggestions_${locale}`] || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const suggestions = parseSuggestions();
  const payload = {
    text: '',
    type: 'text',
    buttons: [],
    suggestions: [],
    context_update: {},
  };

  switch (intentResult.intent) {
    case 'greeting_hello':
      payload.text = locale === 'ar'
        ? `أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك؟`
        : `Hello from ${business.name}. How can I help you?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_how_are_you':
      payload.text = locale === 'ar'
        ? `أنا بخير، شكراً لسؤالك! أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك؟`
        : `I'm doing great, thanks for asking! Welcome to ${business.name}. How can I help you?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_yasta':
      payload.text = locale === 'ar'
        ? `حبيبي يسطا! منور ${business.name_ar || business.name}. أقدر أساعدك إزاي؟`
        : `Hey there! Welcome to ${business.name}. How can I help you?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = locale === 'ar'
        ? 'على الرحب والسعة. إذا احتجت أي شيء آخر فقط اسأل.'
        : 'You are welcome. If you need anything else, just ask.';
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = locale === 'ar'
        ? 'أقدر أساعدك في القائمة، أسعار الأصناف، الأحجام، مواعيد العمل، الموقع، معلومات التواصل، ومعلومات عامة عن الكافيه.'
        : 'I can help with the menu, item prices, sizes, working hours, location, contact details, and general cafe info.';
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'catalog_general':
      payload.text = locale === 'ar' ? 'هذه هي القائمة.' : 'Here is the menu.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح القائمة' : 'Open menu',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'item_recall':
    case 'item_found': {
      const item = intentResult.item;
      const sizes = getSizes(item);
      const title = getDisplayTitle(item, locale);
      const lines = [];
      // Recall replies lead with a short reminder, then show the same item card.
      if (intentResult.intent === 'item_recall') {
        lines.push(locale === 'ar' ? `كنا نتحدث عن ${title}:` : `We were talking about ${title}:`);
      }
      lines.push(title);
      const description = locale === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
      if (description) {
        const titleClean = tokenize(normalize(title, locale)).join(' ');
        const descClean = tokenize(normalize(description, locale)).join(' ');
        if (descClean !== titleClean) {
          lines.push(description);
        }
      }
      if (item.price !== null && item.price !== undefined) lines.push(locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`);
      if (sizes.length) lines.push(locale === 'ar' ? `الأحجام: ${sizes.join('، ')}` : `Sizes: ${sizes.join(', ')}`);
      const category = getDisplayCategory(item, locale);
      if (category) lines.push(locale === 'ar' ? `الفئة: ${category}` : `Category: ${category}`);
      payload.text = lines.join('\n');
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? ['السعر', 'الأحجام', 'فتح القائمة'] : ['Price', 'Sizes', 'Open menu'];
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = category || null;
      break;
    }
    case 'item_sizes': {
      const item = intentResult.item;
      const queryText = intentResult.queryText || '';
      const targetSizeKey = detectTargetSize(queryText, locale);
      const itemTitle = getDisplayTitle(item, locale);
      const details = item.metadata?.size_details;

      if (targetSizeKey && details && details[targetSizeKey]) {
        const spec = details[targetSizeKey];
        const sizeName = locale === 'ar' ? spec.name_ar || spec.name_en : spec.name_en || spec.name_ar;
        const diameter = locale === 'ar' ? spec.diameter_ar || spec.diameter_en : spec.diameter_en || spec.diameter_ar;
        const weight = locale === 'ar' ? spec.weight_ar || spec.weight_en : spec.weight_en || spec.weight_ar;
        const serves = locale === 'ar' ? spec.serves_ar || spec.serves_en : spec.serves_en || spec.serves_ar;

        let responseText = locale === 'ar'
          ? `تفاصيل الحجم ال${sizeName} لـ ${itemTitle}:\n`
          : `Details for ${sizeName} ${itemTitle}:\n`;

        if (diameter) responseText += locale === 'ar' ? `- المقاس / القطر: ${diameter}\n` : `- Diameter: ${diameter}\n`;
        if (weight) responseText += locale === 'ar' ? `- الوزن: ${weight}\n` : `- Weight: ${weight}\n`;
        if (serves) responseText += locale === 'ar' ? `- السعة: ${serves}\n` : `- Serving: ${serves}\n`;
        if (spec.price) responseText += locale === 'ar' ? `- السعر: ${spec.price} ${item.currency || 'EGP'}` : `- Price: ${spec.price} ${item.currency || 'EGP'}`;

        payload.text = responseText.trim();
        payload.suggestions = locale === 'ar'
          ? [`اطلب ${itemTitle} ${sizeName}`, 'عرض باقي الأحجام']
          : [`Order ${sizeName} ${itemTitle}`, 'Show other sizes'];
      } else {
        const sizes = getSizes(item);
        payload.text = sizes.length
          ? (locale === 'ar'
            ? `${itemTitle} متوفر بالأحجام التالية: ${sizes.join('، ')}.`
            : `${itemTitle} is available in: ${sizes.join(', ')}.`)
          : (locale === 'ar'
            ? `${itemTitle} متوفر بحجم واحد فقط.`
            : `${itemTitle} is available in one standard size.`);
        // Only offer a per-size "details" chip when we actually have detail data
        // to show for that size AND it routes back here: the size word must be
        // recognizable (detectTargetSize) and present in size_details. Otherwise
        // the chip dead-ends on a not-found reply. The "size"/"حجم" keyword in the
        // chip text is what re-triggers the item_sizes intent against last_item.
        const detailable = details
          ? sizes.filter((s) => {
            const key = detectTargetSize(String(s), locale);
            return key && details[key];
          })
          : [];
        if (detailable.length) {
          payload.suggestions = detailable.map(s => locale === 'ar' ? `تفاصيل حجم ${s}` : `Details of ${s} size`);
        } else {
          // No further data to detail — offer real next actions instead of a
          // chip that would dead-end.
          payload.suggestions = locale === 'ar'
            ? [`اطلب ${itemTitle}`, 'السعر', 'فتح القائمة']
            : [`Order ${itemTitle}`, 'Price', 'Open menu'];
        }
      }
      const thumbSizes = getItemThumbnail(item);
      if (thumbSizes) payload.thumbnail = thumbSizes;
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = getDisplayCategory(item, locale) || null;
      break;
    }
    case 'item_price': {
      const item = intentResult.item;
      payload.text = item.price !== null && item.price !== undefined
        ? (locale === 'ar'
          ? `${getDisplayTitle(item, locale)} سعره ${item.price} ${item.currency}.`
          : `${getDisplayTitle(item, locale)} costs ${item.price} ${item.currency}.`)
        : (locale === 'ar'
          ? `سعر ${getDisplayTitle(item, locale)} غير مضاف حالياً. تواصل معنا للتفاصيل.`
          : `The price for ${getDisplayTitle(item, locale)} is not listed yet. Please contact us for details.`);
      const thumbPrice = getItemThumbnail(item);
      if (thumbPrice) payload.thumbnail = thumbPrice;
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = getDisplayCategory(item, locale) || null;
      break;
    }
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا الصنف في القائمة. يمكنك فتح القائمة الكاملة من الزر بالأسفل.' + (business.phone ? ` أو التواصل معنا مباشرة للطلب عبر ${business.phone}.` : '')
        : 'I could not find that item in the menu. You can open the full menu below.' + (business.phone ? ` Or contact us directly to order at ${business.phone}.` : '');
      payload.suggestions = suggestions.slice(0, 3);
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض القائمة' : 'View menu',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'need_item_context':
      payload.text = locale === 'ar' ? 'تقصد أي صنف؟' : 'Which item do you mean?';
      break;
    case 'category_items': {
      const catItems = intentResult.items.slice(0, 8);
      const catHeading = locale === 'ar' ? `هذه الأصناف الموجودة في ${intentResult.category}:` : `Here are the items in ${intentResult.category}:`;
      const catItemLine = (item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        return `- ${getDisplayTitle(item, locale)}${price}`;
      };
      const catThumbMsgs = buildThumbnailMessages(catItems, catHeading, catItemLine);
      if (catThumbMsgs) {
        payload.messages = catThumbMsgs;
        payload.text = catThumbMsgs.map((m) => m.text).filter(Boolean).join('\n');
      } else {
        payload.text = [catHeading, ...catItems.map(catItemLine)].join('\n');
      }
      payload.context_update.last_category = intentResult.category;
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    }
    case 'concept_items': {
      // Items surfaced via the brand-profile concept map ("from the sea" ->
      // seafood dishes). Same card layout as a category listing, but a heading
      // that doesn't claim a literal category the customer never named.
      const conceptItems = intentResult.items.slice(0, 8);
      const conceptHeading = locale === 'ar' ? 'دي أقرب الأصناف اللي ممكن تناسبك:' : 'Here are the closest items that might fit:';
      const conceptItemLine = (item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        return `- ${getDisplayTitle(item, locale)}${price}`;
      };
      const conceptThumbMsgs = buildThumbnailMessages(conceptItems, conceptHeading, conceptItemLine);
      if (conceptThumbMsgs) {
        payload.messages = conceptThumbMsgs;
        payload.text = conceptThumbMsgs.map((m) => m.text).filter(Boolean).join('\n');
      } else {
        payload.text = [conceptHeading, ...conceptItems.map(conceptItemLine)].join('\n');
      }
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    }
    case 'item_disambiguation': {
      const disambItems = intentResult.items.slice(0, 6);
      const disambHeading = locale === 'ar' ? 'وجدت أكثر من صنف مطابق. أي واحد تقصد؟' : 'I found more than one matching item. Which would you like?';
      const disambItemLine = (item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        return `- ${getDisplayTitle(item, locale)}${price}`;
      };
      const disambThumbMsgs = buildThumbnailMessages(disambItems, disambHeading, disambItemLine);
      if (disambThumbMsgs) {
        payload.messages = disambThumbMsgs;
        payload.text = disambThumbMsgs.map((m) => m.text).filter(Boolean).join('\n');
      } else {
        payload.text = [disambHeading, ...disambItems.map(disambItemLine)].join('\n');
      }
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    }
    case 'brand_info':
      payload.text = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا إذا أردت معرفة المزيد.`)
        : (business.about_en || `We are ${business.name}. Contact us if you want to know more.`);
      break;
    case 'contact':
      payload.text = [
        locale === 'ar' ? 'يمكنك التواصل معنا عبر:' : 'You can contact us through:',
        business.phone ? (locale === 'ar' ? `الهاتف / واتساب: ${business.phone}` : `Phone / WhatsApp: ${business.phone}`) : null,
        business.email ? (locale === 'ar' ? `الإيميل: ${business.email}` : `Email: ${business.email}`) : null,
      ].filter(Boolean).join('\n');
      break;
    case 'working_hours':
      payload.text = locale === 'ar'
        ? (business.working_hours_ar ? `مواعيد العمل:\n${business.working_hours_ar}` : 'مواعيد العمل غير مضافة حالياً. تواصل معنا للتأكيد.')
        : (business.working_hours_en ? `Our working hours:\n${business.working_hours_en}` : 'Working hours are not listed yet. Please contact us to confirm.');
      break;
    case 'location':
      payload.text = locale === 'ar'
        ? (business.address_ar ? `عنواننا:\n${business.address_ar}` : 'العنوان غير مضاف حالياً. تواصل معنا للحصول على الاتجاهات.')
        : (business.address_en ? `Our address:\n${business.address_en}` : 'Our address is not listed yet. Please contact us for directions.');
      break;
    case 'reservation':
      payload.text = locale === 'ar'
        ? `للحجز تواصل معنا مباشرة على ${business.phone || 'رقم الهاتف'}.`
        : `For reservations, please contact us directly at ${business.phone || 'our phone number'}.`;
      break;
    case 'unknown':
    default:
      payload.text = locale === 'ar'
        ? `سؤال جميل! عشان أضمنلك إجابة دقيقة، تواصل مع فريقنا على ${business.phone || 'رقم التواصل'} — وفي نفس الوقت اسألني عن القائمة أو الأسعار أو المواعيد أو الموقع وهجاوبك فوراً.`
        : `Good question! To make sure you get an accurate answer, reach our team at ${business.phone || 'our contact number'} — and meanwhile, ask me about the menu, prices, hours, or location and I'll answer right away.`;
      payload.suggestions = suggestions.slice(0, 3);
      break;
  }

  return payload;
}

function mapSheetRecords(records) {
  return records
    .filter((record) => record.name_en || record.name || record.title_en || record.title)
    .map((record) => {
      const rawSizes = record.sizes || record.size_options || '';
      const sizes = String(rawSizes)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const rawMetadata = record.metadata || record.Metadata || record.METADATA || '';
      let metadataObj = {};
      if (rawMetadata) {
        try {
          metadataObj = typeof rawMetadata === 'object'
            ? rawMetadata
            : JSON.parse(rawMetadata);
        } catch (e) {
          console.error('[mapSheetRecords] Failed to parse metadata json:', e.message);
        }
      }

      if (!metadataObj.sizes || !metadataObj.sizes.length) {
        metadataObj.sizes = sizes;
      }

      const thumbUrl = record.thumbnail || record.thumbnail_url || record.image || record.image_url || record.photo || record.photo_url;
      if (thumbUrl) {
        metadataObj.thumbnail = thumbUrl;
      }

      return {
        title_en: record.name_en || record.name || record.title_en || record.title || '',
        title_ar: record.name_ar || record.title_ar || '',
        category_en: record.category_en || record.category || '',
        category_ar: record.category_ar || '',
        description_en: record.description_en || record.description || '',
        description_ar: record.description_ar || '',
        price: record.price ? Number(record.price) : null,
        currency: record.currency || 'EGP',
        metadata: JSON.stringify(metadataObj),
        available: ['0', 'false', 'no'].includes(String(record.available || '').toLowerCase()) ? 0 : 1,
      };
    });
}

module.exports = {
  serviceType: 'cafe',
  defaultSheetName: 'Menu',
  defaultBusinessName: 'New Cafe',
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في ${business.name_ar || business.name}!`)
      : (business.welcome_en || `Welcome to ${business.name}!`);
  },
  mapSheetRecords,
};
