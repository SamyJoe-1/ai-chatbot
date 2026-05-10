'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById } = require('./shared/matcher');

const PATTERNS = {
  en: {
    greeting: [/^(hi|hello|hey)\b/i],
    thanks: [/\b(thanks|thank you|thx)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i],
    catalog_general: [/\bproperties?\b/i, /\blistings?\b/i, /\bunits?\b/i, /\bshow me.*(properties|listings|units)\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    item_location: [/\blocation\b/i, /\bwhere is\b/i, /\barea\b/i],
    item_specs: [/\bbed(room)?s?\b/i, /\bbath(room)?s?\b/i, /\barea\b/i, /\bsquare\b/i, /\bmeter\b/i],
    appointment: [/\bvisit\b/i, /\bviewing\b/i, /\bappointment\b/i, /\bbook\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\bagency\b/i, /\bdeveloper\b/i],
  },
  ar: {
    greeting: [/^(مرحبا|اهلا|أهلا|هلا)/],
    thanks: [/(شكرا|شكراً|تسلم)/],
    help: [/(مساعدة|ساعدني|ماذا يمكنك)/],
    catalog_general: [/(عقارات|عقار|وحدات|شقق|فلل|عروض|قائمة العقارات)/],
    item_price: [/(سعر|بكام|كم السعر|الثمن)/],
    item_location: [/(الموقع|العنوان|فين|وين|المنطقة)/],
    item_specs: [/(غرف|غرفة|حمام|حمامات|مساحة|متر|امتار)/],
    appointment: [/(معاينة|زيارة|موعد|احجز|أحجز)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|ايميل|إيميل)/],
    brand_info: [/(من انتم|مين انتم|عن الشركة|عن المكتب|عن المطور)/],
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

function getLocation(item) {
  return item.metadata?.location || item.metadata?.district || item.metadata?.compound || '';
}

function getSpecs(item) {
  return {
    bedrooms: item.metadata?.bedrooms,
    bathrooms: item.metadata?.bathrooms,
    area: item.metadata?.area_sqm || item.metadata?.area,
    listingType: item.metadata?.listing_type || item.metadata?.purpose,
  };
}

function findProperties(text, lang, businessId, context = {}) {
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
      item.metadata?.location,
      item.metadata?.district,
      item.metadata?.compound,
      item.metadata?.listing_type,
      item.metadata?.purpose,
      item.metadata?.bedrooms,
      item.metadata?.bathrooms,
      item.metadata?.area_sqm,
      item.metadata?.area,
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
  const { items, matchedItems, scoredMatches, categoryMatches } = findProperties(text, lang, business.id, context);
  const lastItem = context.last_item ? items.find((item) => item.id === context.last_item) : null;
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchesAny(normalizedText, patterns.greeting)) return { intent: 'greeting' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };
  if (matchesAny(normalizedText, patterns.appointment)) return { intent: 'appointment', item: foundItem || lastItem || null };

  const asksPrice = matchesAny(normalizedText, patterns.item_price);
  const asksLocation = matchesAny(normalizedText, patterns.item_location);
  const asksSpecs = matchesAny(normalizedText, patterns.item_specs);

  if (matchedItems.length === 1 && foundItem) {
    if (asksPrice) return { intent: 'item_price', item: foundItem };
    if (asksLocation) return { intent: 'item_location', item: foundItem };
    if (asksSpecs) return { intent: 'item_specs', item: foundItem };
    return { intent: 'item_found', item: foundItem };
  }

  if (matchedItems.length > 1) {
    if (topScore >= secondScore + 3) {
      if (asksPrice) return { intent: 'item_price', item: foundItem };
      if (asksLocation) return { intent: 'item_location', item: foundItem };
      if (asksSpecs) return { intent: 'item_specs', item: foundItem };
      return { intent: 'item_found', item: foundItem };
    }
    return { intent: 'item_disambiguation', items: matchedItems };
  }

  if (categoryMatches.length === 1) {
    return {
      intent: 'category_items',
      category: categoryMatches[0].display,
      items: categoryMatches[0].items,
    };
  }

  if (asksPrice && lastItem) return { intent: 'item_price', item: lastItem };
  if (asksLocation && lastItem) return { intent: 'item_location', item: lastItem };
  if (asksSpecs && lastItem) return { intent: 'item_specs', item: lastItem };
  if (asksPrice || asksLocation || asksSpecs) return { intent: 'need_item_context' };

  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) return { intent: 'item_not_found' };
  return { intent: 'unknown' };
}

function buildPropertySummary(item, lang) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const specs = getSpecs(item);
  const lines = [getDisplayTitle(item, locale)];
  const description = locale === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
  if (description) lines.push(description);
  if (item.price !== null && item.price !== undefined) lines.push(locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`);
  if (getLocation(item)) lines.push(locale === 'ar' ? `الموقع: ${getLocation(item)}` : `Location: ${getLocation(item)}`);
  if (specs.listingType) lines.push(locale === 'ar' ? `النوع: ${specs.listingType}` : `Type: ${specs.listingType}`);
  if (specs.bedrooms !== undefined && specs.bedrooms !== '') lines.push(locale === 'ar' ? `غرف النوم: ${specs.bedrooms}` : `Bedrooms: ${specs.bedrooms}`);
  if (specs.bathrooms !== undefined && specs.bathrooms !== '') lines.push(locale === 'ar' ? `الحمامات: ${specs.bathrooms}` : `Bathrooms: ${specs.bathrooms}`);
  if (specs.area !== undefined && specs.area !== '') lines.push(locale === 'ar' ? `المساحة: ${specs.area} م²` : `Area: ${specs.area} sqm`);
  return lines.join('\n');
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
    case 'greeting':
      payload.text = locale === 'ar'
        ? `أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك في العقارات اليوم؟`
        : `Hello from ${business.name}. How can I help you with properties today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = locale === 'ar' ? 'على الرحب والسعة. إذا احتجت عقاراً آخر فقط اسأل.' : 'You are welcome. If you need another property, just ask.';
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = locale === 'ar'
        ? 'أقدر أساعدك في العقارات المتاحة، الأسعار، الموقع، المواصفات الأساسية، ومعلومات التواصل.'
        : 'I can help with available properties, pricing, location, key specs, and contact details.';
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'catalog_general':
      payload.text = locale === 'ar' ? 'هذه بعض العقارات المتاحة.' : 'Here are the available properties.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح العروض' : 'Open listings',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'item_found':
      payload.text = buildPropertySummary(intentResult.item, locale);
      payload.suggestions = locale === 'ar' ? ['السعر', 'الموقع', 'المواصفات'] : ['Price', 'Location', 'Specs'];
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = getDisplayCategory(intentResult.item, locale) || null;
      break;
    case 'item_price':
      payload.text = intentResult.item.price !== null && intentResult.item.price !== undefined
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} سعره ${intentResult.item.price} ${intentResult.item.currency}.`
          : `${getDisplayTitle(intentResult.item, locale)} is listed for ${intentResult.item.price} ${intentResult.item.currency}.`)
        : (locale === 'ar'
          ? `سعر ${getDisplayTitle(intentResult.item, locale)} غير مضاف حالياً.`
          : `The price for ${getDisplayTitle(intentResult.item, locale)} is not listed yet.`);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'item_location':
      payload.text = getLocation(intentResult.item)
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} موجود في ${getLocation(intentResult.item)}.`
          : `${getDisplayTitle(intentResult.item, locale)} is located in ${getLocation(intentResult.item)}.`)
        : (locale === 'ar'
          ? `موقع ${getDisplayTitle(intentResult.item, locale)} غير مضاف حالياً.`
          : `The location for ${getDisplayTitle(intentResult.item, locale)} is not listed yet.`);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'item_specs': {
      const specs = getSpecs(intentResult.item);
      const parts = [];
      if (specs.bedrooms !== undefined && specs.bedrooms !== '') parts.push(locale === 'ar' ? `غرف النوم: ${specs.bedrooms}` : `Bedrooms: ${specs.bedrooms}`);
      if (specs.bathrooms !== undefined && specs.bathrooms !== '') parts.push(locale === 'ar' ? `الحمامات: ${specs.bathrooms}` : `Bathrooms: ${specs.bathrooms}`);
      if (specs.area !== undefined && specs.area !== '') parts.push(locale === 'ar' ? `المساحة: ${specs.area} م²` : `Area: ${specs.area} sqm`);
      payload.text = parts.length
        ? `${getDisplayTitle(intentResult.item, locale)}\n${parts.join('\n')}`
        : (locale === 'ar' ? 'لا توجد مواصفات إضافية مسجلة لهذا العقار حالياً.' : 'There are no extra specs listed for this property yet.');
      payload.context_update.last_item = intentResult.item.id;
      break;
    }
    case 'category_items':
      payload.text = [
        locale === 'ar' ? `هذه العقارات ضمن ${intentResult.category}:` : `Here are the listings in ${intentResult.category}:`,
        ...intentResult.items.slice(0, 8).map((item) => {
          const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
          return `- ${getDisplayTitle(item, locale)}${price}`;
        }),
      ].join('\n');
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      payload.context_update.last_category = intentResult.category;
      break;
    case 'item_disambiguation':
      payload.text = [
        locale === 'ar' ? 'وجدت أكثر من عقار مطابق. أي واحد تقصد؟' : 'I found more than one matching listing. Which one do you mean?',
        ...intentResult.items.slice(0, 6).map((item) => `- ${getDisplayTitle(item, locale)}`),
      ].join('\n');
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    case 'need_item_context':
      payload.text = locale === 'ar' ? 'تقصد أي عقار؟' : 'Which property do you mean?';
      break;
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا العقار ضمن العروض الحالية.'
        : 'I could not find that property in the current listings.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض كل العقارات' : 'View all listings',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'appointment':
      payload.text = locale === 'ar'
        ? `لحجز معاينة تواصل معنا مباشرة على ${business.phone || 'رقم الهاتف'}.`
        : `For a property viewing, please contact us directly at ${business.phone || 'our phone number'}.`;
      break;
    case 'brand_info':
      payload.text = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا لمعرفة المزيد عن العروض.`)
        : (business.about_en || `We are ${business.name}. Contact us to learn more about our listings.`);
      break;
    case 'contact':
      payload.text = [
        locale === 'ar' ? 'يمكنك التواصل معنا عبر:' : 'You can contact us through:',
        business.phone ? (locale === 'ar' ? `الهاتف / واتساب: ${business.phone}` : `Phone / WhatsApp: ${business.phone}`) : null,
        business.email ? (locale === 'ar' ? `الإيميل: ${business.email}` : `Email: ${business.email}`) : null,
      ].filter(Boolean).join('\n');
      break;
    case 'unknown':
    default:
      payload.text = locale === 'ar'
        ? `لا أملك إجابة دقيقة على هذا السؤال حالياً. تواصل معنا على ${business.phone || 'رقم التواصل'}، وما زلت أقدر أساعدك في الأسعار أو المواقع أو المواصفات.`
        : `I do not have an exact answer for that yet. Please contact us at ${business.phone || 'our contact number'}, and I can still help with pricing, location, or specs.`;
      payload.suggestions = suggestions.slice(0, 3);
      break;
  }

  return payload;
}

function mapSheetRecords(records) {
  return records
    .filter((record) => record.title_en || record.title || record.name_en || record.name)
    .map((record) => ({
      title_en: record.title_en || record.title || record.name_en || record.name || '',
      title_ar: record.title_ar || record.name_ar || '',
      category_en: record.category_en || record.category || record.property_type || '',
      category_ar: record.category_ar || '',
      description_en: record.description_en || record.description || '',
      description_ar: record.description_ar || '',
      price: record.price ? Number(record.price) : null,
      currency: record.currency || 'EGP',
      metadata: JSON.stringify({
        location: record.location || record.area_name || '',
        district: record.district || '',
        compound: record.compound || '',
        bedrooms: record.bedrooms || '',
        bathrooms: record.bathrooms || '',
        area_sqm: record.area_sqm || record.area || '',
        listing_type: record.listing_type || record.purpose || '',
      }),
      available: ['0', 'false', 'no'].includes(String(record.available || '').toLowerCase()) ? 0 : 1,
    }));
}

module.exports = {
  serviceType: 'real_estate',
  defaultSheetName: 'Properties',
  defaultBusinessName: 'New Real Estate Business',
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في ${business.name_ar || business.name}! كيف أساعدك في العقارات؟`)
      : (business.welcome_en || `Welcome to ${business.name}! How can I help you with properties?`);
  },
  mapSheetRecords,
};
