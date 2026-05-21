'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle } = require('./shared/matcher');

const FEATURE_SYNONYMS = {
  color: ['color', 'colors', 'لون', 'اللون', 'ألوان', 'الوان'],
  material: ['material', 'materials', 'مادة', 'خامة', 'المادة', 'الخامة', 'صنع من'],
  dimensions: ['dimensions', 'dimension', 'size', 'sizes', 'أبعاد', 'ابعاد', 'الحجم', 'حجم', 'مقاس', 'مقاسات'],
  weight: ['weight', 'الوزن', 'وزن'],
  shipping: ['shipping', 'delivery', 'شحن', 'الشحن', 'التوصيل', 'توصيل'],
  country: ['country', 'origin', 'بلد', 'البلد', 'دولة', 'الدولة', 'منشأ', 'المنشأ'],
};

const FEATURE_LABELS = {
  en: {
    color: 'Color',
    material: 'Material',
    dimensions: 'Dimensions',
    weight: 'Weight',
    shipping: 'Shipping',
    country: 'Country of Origin',
  },
  ar: {
    color: 'اللون',
    material: 'الخامة / المادة',
    dimensions: 'الأبعاد / المقاس',
    weight: 'الوزن',
    shipping: 'الشحن',
    country: 'بلد المنشأ',
  }
};

const PATTERNS = {
  en: {
    greeting_hello: [/^(hi|hello|hey|hiya|howdy)\b/i, /^good (morning|afternoon|evening)\b/i],
    greeting_how_are_you: [/^(how are u|how are u doing|are u okay|how are you|how are you doing|are you okay)\b/i],
    greeting_yasta: [/^(yasta)\b/i],
    thanks: [/\b(thanks|thank you|thx|ty|appreciate)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i, /\bhow does this work\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i, /\bworking hours\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bwhere are you\b/i, /\bdirections\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the store\b/i, /\bwhat do you provide\b/i],
    catalog_general: [/\bcatalog\b/i, /\bproducts\b/i, /\bwhat do you have\b/i, /\bshow me\b/i],
    ecommerce_search_hot: [/\bhot\b/i, /\bbest selling\b/i, /\bpopular\b/i, /\btop\b/i, /\btrending\b/i],
    ecommerce_category_info: [/\bcategory\b/i, /\bmore about\b/i, /\bdetails on\b/i],
    ecommerce_product_advantages: [/\badvantages\b/i, /\bbenefits\b/i, /\bwhy choose\b/i, /\bfeatures\b/i],
    ecommerce_check_availability: [/\bdo you have\b/i, /\bavailability\b/i, /\bavailable\b/i, /\bis there\b/i],
    ecommerce_country_info: [/\bmarketplace in\b/i, /\babout country\b/i, /\bcountry\b/i],
    ecommerce_country_products: [/\bproducts in\b/i, /\bfrom country\b/i, /\bmarketplace in\b/i, /\bin the country\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
  },
  ar: {
    greeting_hello: [/^(مرحبا|مرحبتين|اهلا|أهلا|اهلين|أهلين|هلا|هالو|هلو|هاي|ألو|الو|حياك|حياكم|يا هلا|هلا والله|يا هلا والله|السلام عليكم|وعليكم السلام)/, /^(صباح الخير|مساء الخير|صباح النور|مساء النور)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|شلونكم|شخباركم|اخبارك|ازيك|إزيك|ايش اخبارك|كيف حالك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي|يصاحبي|يا صاحبي)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون|يعطيك العافية)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك|بتعمل ايه|تساعدني)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل|تليفون|تلفون|كلمكم|اكلمكم)/],
    working_hours: [/(ساعات|مواعيد|عمل|الدوام|شغالين|تفتح|تقفل|تفتحون|تغلقون|امتى|امتا|الساعة كام|الساعه كام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة|مكان|فروعكم|فرعكم)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المتجر|عن المعرض|مين انت)/],
    catalog_general: [/(كتالوج|المنتجات|ايش عندكم|شو عندكم|عندكم ايه|عندك ايه|الكتالوج|وش عندكم)/],
    ecommerce_search_hot: [/(الاكثر مبيعا|الأكثر مبيعا|تريند|ترند|ساخن|مشهور|مطلوب|اكتر مبيعا|البيست سيلر|الاكثر طلبا|الاكثر مبيعاً)/],
    ecommerce_category_info: [/(عن القسم|القسم|قسم|صنف|تصنيف|تفاصيل القسم)/],
    ecommerce_product_advantages: [/(مميزات|مزايا|فوائد|ليه اشتري|مواصفات)/],
    ecommerce_check_availability: [/(متاح|موجود|هل عندكم|هل يوجد|عندكم|عندكو|عندك|متوفر|في|فيه)/],
    ecommerce_country_info: [/(سوق|اسواق|في بلد|في دوله|في دولة|السوق)/],
    ecommerce_country_products: [/(منتجات من|من بلد|من دولة|منتجات في|في السعودية|في مصر|في الإمارات|السعودية|مصر|الإمارات)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|بقديش|كم السعر|الثمن|حسابه|حسابها|كم حقها|حقها كم)/],
  }
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

function getDisplayCountry(item, lang) {
  const meta = item.metadata || {};
  return lang === 'ar' ? meta.country_ar || meta.country || meta.country_en : meta.country_en || meta.country || meta.country_ar;
}

function getDisplayDescription(item, lang) {
  return lang === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
}

function getDynamicFeaturesText(item) {
  const meta = item.metadata || {};
  const ignores = ['thumbnail', 'hot_selling', 'country', 'country_ar', 'country_en'];
  const features = [];
  for (const [k, v] of Object.entries(meta)) {
    if (!ignores.includes(k) && typeof v === 'string') {
      features.push(`${k}: ${v}`);
    }
  }
  return features;
}

function getCountryNames(items) {
  const countriesEn = new Set();
  const countriesAr = new Set();
  items.forEach(item => {
    const meta = item.metadata || {};
    if (meta.country_en) countriesEn.add(meta.country_en.toLowerCase());
    if (meta.country) countriesEn.add(meta.country.toLowerCase());
    if (meta.country_ar) countriesAr.add(meta.country_ar);
  });
  return { en: Array.from(countriesEn), ar: Array.from(countriesAr) };
}

function detectCountry(text, lang, items) {
  const { en, ar } = getCountryNames(items);
  const searchList = lang === 'ar' ? ar : en;
  const normalized = text.toLowerCase();
  for (const country of searchList) {
    if (normalized.includes(country.toLowerCase())) {
      return country;
    }
  }
  const altList = lang === 'ar' ? en : ar;
  for (const country of altList) {
    if (normalized.includes(country.toLowerCase())) {
      return country;
    }
  }
  return null;
}

function resolveMetadataValue(meta, canonicalKey, lang) {
  if (meta[canonicalKey] !== undefined) return meta[canonicalKey];
  const keyEn = `${canonicalKey}_en`;
  const keyAr = `${canonicalKey}_ar`;
  if (lang === 'ar') {
    if (meta[keyAr] !== undefined) return meta[keyAr];
    if (meta[keyEn] !== undefined) return meta[keyEn];
  } else {
    if (meta[keyEn] !== undefined) return meta[keyEn];
    if (meta[keyAr] !== undefined) return meta[keyAr];
  }
  return null;
}

function detectFeatureInquiry(text, lang, item) {
  if (!item || !item.metadata) return null;
  const normalizedText = text.toLowerCase();
  
  let meta = item.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }

  for (const [canonicalKey, synonyms] of Object.entries(FEATURE_SYNONYMS)) {
    for (const syn of synonyms) {
      if (normalizedText.includes(syn.toLowerCase())) {
        const val = resolveMetadataValue(meta, canonicalKey, lang);
        if (val) {
          return {
            intent: 'ecommerce_inquire_feature',
            item,
            featureKey: canonicalKey,
            featureLabel: canonicalKey,
            featureValue: val,
          };
        }
      }
    }
  }

  for (const [key, value] of Object.entries(meta)) {
    if (normalizedText.includes(key.toLowerCase())) {
      return {
        intent: 'ecommerce_inquire_feature',
        item,
        featureKey: key,
        featureLabel: key,
        featureValue: resolveMetadataValue(meta, key, lang),
      };
    }
  }

  return null;
}

function findEcommerceItems(text, lang, businessId, context = {}) {
  const items = getBusinessItems(businessId);
  const scoredMatchesAll = findScoredItems({
    text,
    lang,
    items,
    context,
    getItemVariants: (item) => [item.title_en, item.title_ar],
    getCategoryVariants: (item) => [item.category_en, item.category_ar],
    getExtraVariants: (item) => {
      let meta = item.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      const extras = [
        item.description_en,
        item.description_ar,
        meta.country,
        meta.country_ar,
        meta.country_en
      ];
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === 'string') extras.push(v);
      }
      return extras.filter(Boolean);
    },
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
  const { items, scoredMatches, matchedItems, categoryMatches } = findEcommerceItems(text, lang, business.id, context);
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchesAny(normalizedText, patterns.greeting_hello)) return { intent: 'greeting_hello' };
  if (matchesAny(normalizedText, patterns.greeting_how_are_you)) return { intent: 'greeting_how_are_you' };
  if (matchesAny(normalizedText, patterns.greeting_yasta)) return { intent: 'greeting_yasta' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours' };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };

  // Contextual or explicit dynamic feature inquiry check
  const itemInContext = foundItem || (context.last_item ? items.find(i => i.id === context.last_item) : null);
  if (itemInContext) {
    const featureInquiry = detectFeatureInquiry(normalizedText, lang, itemInContext);
    if (featureInquiry) return featureInquiry;
  }

  // Country checking
  const countryForProducts = detectCountry(normalizedText, lang, items);
  if (countryForProducts) {
    const filterCountry = (i) => {
      let meta = i.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      const cEn = String(meta.country_en || '').toLowerCase();
      const cAr = String(meta.country_ar || '');
      const c = String(meta.country || '').toLowerCase();
      const target = countryForProducts.toLowerCase();
      return cEn === target || cAr === countryForProducts || c === target;
    };

    if (matchesAny(normalizedText, patterns.ecommerce_search_hot)) {
      const hotItems = items.filter(i => {
        let meta = i.metadata || {};
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch { meta = {}; }
        }
        return String(meta.hot_selling) === 'true';
      });
      const filtered = hotItems.filter(filterCountry);
      return { intent: 'ecommerce_search_hot', items: filtered, country: countryForProducts };
    }

    if (matchesAny(normalizedText, patterns.ecommerce_country_products) || tokensCount(normalizedText) <= 3) {
      const filtered = items.filter(filterCountry);
      return { intent: 'ecommerce_country_products', items: filtered, country: countryForProducts };
    }
  }

  if (matchesAny(normalizedText, patterns.ecommerce_search_hot)) {
    const hotItems = items.filter(i => {
      let meta = i.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      return String(meta.hot_selling) === 'true';
    });
    if (categoryMatches.length === 1) {
      return { intent: 'ecommerce_search_hot', items: hotItems.filter(i => getDisplayCategory(i, lang) === categoryMatches[0].display) };
    }
    return { intent: 'ecommerce_search_hot', items: hotItems };
  }

  const asksPriceBase = matchesAny(normalizedText, patterns.item_price);

  if (foundItem) {
    const isAdvantage = matchesAny(normalizedText, patterns.ecommerce_product_advantages);
    if (isAdvantage) return { intent: 'ecommerce_product_advantages', item: foundItem };

    if (matchedItems.length === 1 || (matchedItems.length > 1 && topScore >= secondScore + 3)) {
      if (asksPriceBase) return { intent: 'item_price', item: foundItem };
      return { intent: 'item_found', item: foundItem };
    }
  }

  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };

  if (categoryMatches.length === 1) {
    const categoryMatch = categoryMatches[0];
    if (matchesAny(normalizedText, patterns.ecommerce_category_info)) {
      return { intent: 'ecommerce_category_info', category: categoryMatch.display, items: categoryMatch.items };
    }
    if (categoryMatch.items.length === 1) {
      if (asksPriceBase) return { intent: 'item_price', item: categoryMatch.items[0] };
      return { intent: 'item_found', item: categoryMatch.items[0] };
    }
    return {
      intent: 'category_items',
      category: categoryMatch.display,
      items: categoryMatch.items,
    };
  }

  if (matchedItems.length > 1) {
    return { intent: 'item_disambiguation', items: matchedItems };
  }

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) {
    return { intent: 'item_not_found' };
  }

  return { intent: 'unknown' };
}

function tokensCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
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

  const getItemThumbnail = (item) => {
    let meta = item.metadata || {};
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    return meta.thumbnail || null;
  };

  switch (intentResult.intent) {
    case 'greeting_hello':
      payload.text = locale === 'ar'
        ? `أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك اليوم؟`
        : `Hello from ${business.name}. How can I help you today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_how_are_you':
      payload.text = locale === 'ar'
        ? `أنا بخير، شكراً لسؤالك! أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك اليوم؟`
        : `I'm doing great, thanks for asking! Welcome to ${business.name}. How can I help you today?`;
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
        ? 'أقدر أساعدك في الكتالوج، المنتجات الأكثر مبيعاً، وتفاصيل المنتجات ومزاياها.'
        : 'I can help with the catalog, best selling products, and product features.';
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'catalog_general':
      payload.text = locale === 'ar' ? 'هذا هو الكتالوج.' : 'Here is our catalog.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح الكتالوج' : 'Open catalog',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;

    case 'ecommerce_inquire_feature': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const label = FEATURE_LABELS[locale][intentResult.featureKey] || intentResult.featureLabel;
      payload.text = locale === 'ar'
        ? `${label} لـ **${title}** هو: ${intentResult.featureValue}`
        : `The ${label} of **${title}** is: ${intentResult.featureValue}`;
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'المميزات'] : [`Order ${title}`, 'Advantages'];
      payload.context_update.last_item = item.id;
      break;
    }

    case 'ecommerce_country_products':
      if (intentResult.items && intentResult.items.length > 0) {
        payload.messages = [];
        payload.messages.push({
          text: locale === 'ar' 
            ? `إليك المنتجات المتوفرة في ${intentResult.country}:` 
            : `Here are the products available in ${intentResult.country}:`,
          thumbnail: null,
        });
        intentResult.items.slice(0, 6).forEach(item => {
          const title = getDisplayTitle(item, locale);
          const desc = getDisplayDescription(item, locale);
          const priceText = item.price !== null && item.price !== undefined ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}` : '';
          payload.messages.push({
            text: `**${title}**\n${desc}${priceText}`,
            thumbnail: getItemThumbnail(item),
          });
        });
        payload.text = payload.messages.map(m => m.text).join('\n\n');
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar'
          ? `عذراً، لم نجد منتجات متوفرة في ${intentResult.country} حالياً.`
          : `Sorry, we couldn't find any products in ${intentResult.country} at the moment.`;
      }
      break;

    case 'ecommerce_search_hot':
      if (intentResult.items && intentResult.items.length > 0) {
        payload.messages = [];
        const headline = intentResult.country 
          ? (locale === 'ar' ? `إليك المنتجات الأكثر طلباً في ${intentResult.country}:` : `Here are the hot selling products in ${intentResult.country}:`)
          : (locale === 'ar' ? 'إليك المنتجات الأكثر طلباً ومبيعاً لدينا:' : 'Here are our hot selling products:');
        payload.messages.push({ text: headline, thumbnail: null });
        intentResult.items.slice(0, 6).forEach(item => {
          const title = getDisplayTitle(item, locale);
          const desc = getDisplayDescription(item, locale);
          const priceText = item.price !== null && item.price !== undefined ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}` : '';
          payload.messages.push({
            text: `**${title}**\n${desc}${priceText}`,
            thumbnail: getItemThumbnail(item),
          });
        });
        payload.text = payload.messages.map(m => m.text).join('\n\n');
        payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? 'لم نجد منتجات محددة كأكثر مبيعاً حالياً.' : 'No hot selling products specified at the moment.';
      }
      break;

    case 'ecommerce_category_info':
      payload.text = locale === 'ar' 
        ? `قسم ${intentResult.category} يحتوي على العديد من المنتجات الرائعة. هل تبحث عن شيء محدد؟`
        : `The ${intentResult.category} category has many great products. Are you looking for anything specific?`;
      if (intentResult.items && intentResult.items.length > 0) {
         payload.text += '\n\n' + intentResult.items.slice(0, 4).map(i => `- ${getDisplayTitle(i, locale)}`).join('\n');
         payload.suggestions = intentResult.items.slice(0, 3).map(item => getDisplayTitle(item, locale));
      }
      break;
    case 'ecommerce_product_advantages': {
      const item = intentResult.item;
      const desc = getDisplayDescription(item, locale);
      const features = getDynamicFeaturesText(item);
      let lines = [];
      if (desc) lines.push(desc);
      if (features.length) {
        lines.push(locale === 'ar' ? 'المواصفات:' : 'Features:');
        lines.push(...features.map(f => `- ${f}`));
      }
      payload.text = lines.length > 0 ? lines.join('\n') : (locale === 'ar' ? 'لا تتوفر تفاصيل إضافية لهذا المنتج.' : 'No additional details available for this product.');
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.suggestions = [locale === 'ar' ? `اطلب ${getDisplayTitle(item, locale)}` : `Order ${getDisplayTitle(item, locale)}`];
      payload.context_update.last_item = item.id;
      break;
    }
    case 'item_found': {
      const item = intentResult.item;
      const title = getDisplayTitle(item, locale);
      const lines = [title];
      
      const category = getDisplayCategory(item, locale);
      const country = getDisplayCountry(item, locale);
      
      if (category) lines.push(locale === 'ar' ? `القسم: ${category}` : `Category: ${category}`);
      if (country) lines.push(locale === 'ar' ? `البلد: ${country}` : `Country: ${country}`);
      
      const description = getDisplayDescription(item, locale);
      if (description) {
        lines.push(`\n${description}`);
      }

      if (item.price !== null && item.price !== undefined) {
        lines.push('\n' + (locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`));
      }
      
      const features = getDynamicFeaturesText(item);
      if (features.length > 0) {
        lines.push('\n' + features.join('\n'));
      }

      payload.text = lines.join('\n');
      const thumb = getItemThumbnail(item);
      if (thumb) {
        payload.thumbnail = thumb;
      }

      payload.suggestions = locale === 'ar' ? [`اطلب ${title}`, 'المميزات'] : [`Order ${title}`, 'Advantages'];
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = category || null;
      break;
    }
    case 'item_price': {
      const item = intentResult.item;
      payload.text = item.price !== null && item.price !== undefined
        ? (locale === 'ar'
          ? `${getDisplayTitle(item, locale)} سعره ${item.price} ${item.currency}.`
          : `${getDisplayTitle(item, locale)} costs ${item.price} ${item.currency}.`)
        : (locale === 'ar'
          ? `سعر ${getDisplayTitle(item, locale)} غير محدد حالياً. تواصل معنا للتفاصيل.`
          : `The price for ${getDisplayTitle(item, locale)} is not listed yet. Please contact us for details.`);
      const thumb = getItemThumbnail(item);
      if (thumb) payload.thumbnail = thumb;
      payload.context_update.last_item = item.id;
      payload.context_update.last_category = getDisplayCategory(item, locale) || null;
      break;
    }
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا المنتج في الكتالوج. يمكنك فتح الكتالوج الكامل من الزر بالأسفل.' + (business.phone ? ` أو التواصل معنا مباشرة عبر ${business.phone}.` : '')
        : 'I could not find that product in the catalog. You can open the full catalog below.' + (business.phone ? ` Or contact us directly at ${business.phone}.` : '');
      payload.suggestions = suggestions.slice(0, 3);
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض الكتالوج' : 'View catalog',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'category_items':
      if (intentResult.items && intentResult.items.length > 0) {
        payload.messages = [];
        payload.messages.push({
          text: locale === 'ar' ? `إليك المنتجات في قسم ${intentResult.category}:` : `Here are the products in ${intentResult.category}:`,
          thumbnail: null,
        });
        intentResult.items.slice(0, 6).forEach(item => {
          const title = getDisplayTitle(item, locale);
          const desc = getDisplayDescription(item, locale);
          const priceText = item.price !== null && item.price !== undefined ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}` : '';
          payload.messages.push({
            text: `**${title}**\n${desc}${priceText}`,
            thumbnail: getItemThumbnail(item),
          });
        });
        payload.text = payload.messages.map(m => m.text).join('\n\n');
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? `لا توجد منتجات في قسم ${intentResult.category} حالياً.` : `No products found in ${intentResult.category} category.`;
      }
      payload.context_update.last_category = intentResult.category;
      break;
    case 'item_disambiguation':
      if (intentResult.items && intentResult.items.length > 0) {
        payload.messages = [];
        payload.messages.push({
          text: locale === 'ar' ? 'وجدت أكثر من منتج مطابق. أي واحد تقصد؟' : 'I found more than one matching product. Which one did you mean?',
          thumbnail: null,
        });
        intentResult.items.slice(0, 6).forEach(item => {
          const title = getDisplayTitle(item, locale);
          const desc = getDisplayDescription(item, locale);
          const priceText = item.price !== null && item.price !== undefined ? `\n${locale === 'ar' ? 'السعر' : 'Price'}: ${item.price} ${item.currency}` : '';
          payload.messages.push({
            text: `**${title}**\n${desc}${priceText}`,
            thumbnail: getItemThumbnail(item),
          });
        });
        payload.text = payload.messages.map(m => m.text).join('\n\n');
        payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      } else {
        payload.text = locale === 'ar' ? 'وجدت مطابقات متعددة ولكن لم نتمكن من عرض التفاصيل.' : 'Multiple matches found but details could not be loaded.';
      }
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
        ? (business.address_ar ? `عنواننا:\n${business.address_ar}` : 'العنوان غير مضاف حالياً.')
        : (business.address_en ? `Our address:\n${business.address_en}` : 'Our address is not listed yet.');
      break;
    case 'unknown':
    default:
      payload.text = locale === 'ar'
        ? `لا أملك إجابة دقيقة على هذا السؤال حالياً. يمكنك تصفح الكتالوج أو الاستفسار عن منتج محدد.`
        : `I do not have an exact answer for that yet. You can browse the catalog or ask about a specific product.`;
      payload.suggestions = suggestions.slice(0, 3);
      break;
  }

  return payload;
}

function mapSheetRecords(records) {
  return records
    .filter((record) => record.title || record.title_en || record.title_er || record.title_ar || record.name || record.name_en)
    .map((record) => {
      const standardKeys = [
        'title', 'title_en', 'title_ar', 'title_er', 'name', 'name_en', 'name_ar',
        'category', 'category_en', 'category_ar', 'category_er',
        'description', 'description_en', 'description_ar', 'description_er',
        'price', 'currency', 'available', 'Metadata', 'metadata', 'METADATA'
      ];

      const rawMetadata = record.metadata || record.Metadata || record.METADATA || '';
      let metadataObj = {};
      if (rawMetadata) {
        try {
          metadataObj = typeof rawMetadata === 'object'
            ? rawMetadata
            : JSON.parse(rawMetadata);
        } catch (e) {
          console.error('[ecommerce mapSheetRecords] Failed to parse metadata json:', e.message);
        }
      }

      const lowerStandard = standardKeys.map(k => k.toLowerCase());
      for (const [k, v] of Object.entries(record)) {
        if (!lowerStandard.includes(k.toLowerCase()) && typeof v !== 'undefined') {
          metadataObj[k] = v;
        }
      }

      if (record.thumbnail || record.thumbnail_url || record.image) {
        metadataObj.thumbnail = record.thumbnail || record.thumbnail_url || record.image;
      }
      if (record.hot_selling !== undefined) {
        metadataObj.hot_selling = ['1', 'true', 'yes', true].includes(record.hot_selling);
      }
      if (record.country_en || record.country) {
        metadataObj.country_en = record.country_en || record.country;
      }
      if (record.country_ar) {
        metadataObj.country_ar = record.country_ar;
      }

      return {
        title_en: record.title_en || record.title || record.name_en || record.name || '',
        title_ar: record.title_ar || record.title_er || record.name_ar || '',
        category_en: record.category_en || record.category || '',
        category_ar: record.category_ar || record.category_er || '',
        description_en: record.description_en || record.description || '',
        description_ar: record.description_ar || record.description_er || '',
        price: record.price ? Number(record.price) : null,
        currency: record.currency || 'EGP',
        metadata: JSON.stringify(metadataObj),
        available: ['0', 'false', 'no'].includes(String(record.available || '').toLowerCase()) ? 0 : 1,
      };
    });
}

module.exports = {
  serviceType: 'ecommerce',
  defaultSheetName: 'Products',
  defaultBusinessName: 'New E-Commerce Store',
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في متجر ${business.name_ar || business.name}!`)
      : (business.welcome_en || `Welcome to ${business.name} store!`);
  },
  mapSheetRecords,
};
