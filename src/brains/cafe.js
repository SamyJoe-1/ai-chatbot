'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById } = require('./shared/matcher');

const PATTERNS = {
  en: {
    greeting_hello: [/^(hi|hello|hey|hiya|howdy)\b/i, /^good (morning|afternoon|evening)\b/i],
    greeting_how_are_you: [/^(how are u|how are u doing|are u okay|how are you|how are you doing|are you okay)\b/i],
    greeting_yasta: [/^(yasta)\b/i],
    thanks: [/\b(thanks|thank you|thx|ty|appreciate)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i, /\bhow does this work\b/i],
    catalog_general: [/\bmenu\b/i, /\bwhat do you have\b/i, /\bwhat do you offer\b/i, /\bshow me.*menu\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    item_sizes: [/\bsize\b/i, /\bsizes\b/i, /\bsmall\b/i, /\bmedium\b/i, /\blarge\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i, /\bworking hours\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bwhere are you\b/i, /\bdirections\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the cafe\b/i, /\bwhat do you provide\b/i],
    reservation: [/\breservation\b/i, /\bbook\b/i, /\bbooking\b/i, /\btable\b/i],
  },
  ar: {
    greeting_hello: [/^(مرحبا|اهلا|أهلا|هلا|السلام عليكم)/, /^(صباح الخير|مساء الخير)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|اخبارك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك)/],
    catalog_general: [/(منيو|منيـو|قائمه|قائمة|ايش عندكم|شو عندكم|ماذا تقدمون|وجبات|مشروبات)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|بقديش|كم السعر|الثمن)/],
    item_sizes: [/(حجم|احجام|أحجام|صغير|وسط|كبير|الاحجام|الأحجام)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل)/],
    working_hours: [/(ساعات العمل|اوقات العمل|أوقات العمل|متى تفتحون|متى تغلقون|الدوام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المطعم|عن الكافيه)/],
    reservation: [/(حجز|احجز|أحجز|طاوله|طاولة|ريزرفيشن)/],
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

function getSizes(item) {
  return Array.isArray(item.metadata?.sizes) ? item.metadata.sizes.filter(Boolean) : [];
}

function findCafeItems(text, lang, businessId, context = {}) {
  const items = getBusinessItems(businessId);
  const scoredMatches = findScoredItems({
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

  return {
    items,
    scoredMatches,
    matchedItems: uniqueById(scoredMatches.map((entry) => entry.item)),
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

  const asksPrice = matchesAny(normalizedText, patterns.item_price);
  const asksSizes = matchesAny(normalizedText, patterns.item_sizes);

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

  if (asksPrice && lastItem) return { intent: 'item_price', item: lastItem };
  if (asksSizes && lastItem) return { intent: 'item_sizes', item: lastItem };
  if (asksPrice || asksSizes) return { intent: 'need_item_context' };

  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours' };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };

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
    case 'item_found': {
      const item = intentResult.item;
      const sizes = getSizes(item);
      const lines = [getDisplayTitle(item, locale)];
      const description = locale === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
      if (description) lines.push(description);
      if (item.price !== null && item.price !== undefined) lines.push(locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`);
      if (sizes.length) lines.push(locale === 'ar' ? `الأحجام: ${sizes.join('، ')}` : `Sizes: ${sizes.join(', ')}`);
      const category = getDisplayCategory(item, locale);
      if (category) lines.push(locale === 'ar' ? `الفئة: ${category}` : `Category: ${category}`);
      payload.text = lines.join('\n');
      payload.suggestions = locale === 'ar' ? ['السعر', 'الأحجام', 'فتح القائمة'] : ['Price', 'Sizes', 'Open menu'];
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = category || null;
      break;
    }
    case 'item_sizes': {
      const item = intentResult.item;
      const sizes = getSizes(item);
      payload.text = sizes.length
        ? (locale === 'ar'
          ? `${getDisplayTitle(item, locale)} متوفر بالأحجام التالية: ${sizes.join('، ')}.`
          : `${getDisplayTitle(item, locale)} is available in: ${sizes.join(', ')}.`)
        : (locale === 'ar'
          ? `${getDisplayTitle(item, locale)} متوفر بحجم واحد فقط.`
          : `${getDisplayTitle(item, locale)} is available in one standard size.`);
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
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = getDisplayCategory(item, locale) || null;
      break;
    }
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا الصنف في القائمة. يمكنك فتح القائمة الكاملة من الزر بالأسفل.'
        : 'I could not find that item in the menu. You can open the full menu below.';
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
    case 'category_items':
      payload.text = [
        locale === 'ar' ? `هذه الأصناف الموجودة في ${intentResult.category}:` : `Here are the items in ${intentResult.category}:`,
        ...intentResult.items.slice(0, 8).map((item) => {
          const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
          return `- ${getDisplayTitle(item, locale)}${price}`;
        }),
      ].join('\n');
      payload.context_update.last_category = intentResult.category;
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    case 'item_disambiguation':
      payload.text = [
        locale === 'ar' ? 'وجدت أكثر من صنف مطابق. أي واحد تقصد؟' : 'I found more than one matching item. Which would you like?',
        ...intentResult.items.slice(0, 6).map((item) => {
          const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
          return `- ${getDisplayTitle(item, locale)}${price}`;
        }),
      ].join('\n');
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
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
        ? `لا أملك إجابة دقيقة على هذا السؤال حالياً. تواصل معنا على ${business.phone || 'رقم التواصل'}، وما زلت أقدر أساعدك في القائمة أو الأسعار أو المواعيد أو الموقع.`
        : `I do not have an exact answer for that yet. Please contact us at ${business.phone || 'our contact number'}, and I can still help with the menu, prices, hours, or location.`;
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

      return {
        title_en: record.name_en || record.name || record.title_en || record.title || '',
        title_ar: record.name_ar || record.title_ar || '',
        category_en: record.category_en || record.category || '',
        category_ar: record.category_ar || '',
        description_en: record.description_en || record.description || '',
        description_ar: record.description_ar || '',
        price: record.price ? Number(record.price) : null,
        currency: record.currency || 'EGP',
        metadata: JSON.stringify({ sizes }),
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
