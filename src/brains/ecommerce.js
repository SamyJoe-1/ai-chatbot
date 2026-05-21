'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById, uniqueScoredByTitle } = require('./shared/matcher');

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
    ecommerce_country_products: [/\bproducts in\b/i, /\bfrom country\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
  },
  ar: {
    greeting_hello: [/^(مرحبا|مرحبتين|اهلا|أهلا|اهلين|أهلين|هلا|هالو|هلو|هاي|ألو|الو|حياك|حياكم|يا هلا|هلا والله|السلام عليكم|وعليكم السلام)/, /^(صباح الخير|مساء الخير|صباح النور|مساء النور)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|اخبارك|ازيك|إزيك|ايش اخبارك|كيف حالك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي|يصاحبي|يا صاحبي)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون|يعطيك العافية)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك|بتعمل ايه|تساعدني)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل|تليفون|تلفون|كلمكم|اكلمكم)/],
    working_hours: [/(ساعات|مواعيد|عمل|الدوام|شغالين|تفتح|تقفل|تفتحون|تغلقون|امتى|امتا|الساعة كام|الساعه كام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة|مكان|فروعكم|فرعكم)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المتجر|عن المعرض|مين انت)/],
    catalog_general: [/(كتالوج|المنتجات|ايش عندكم|شو عندكم|عندكم ايه|عندكو ايه|عندك ايه|الكتالوج)/],
    ecommerce_search_hot: [/(الاكثر مبيعا|الأكثر مبيعا|تريند|ترند|ساخن|مشهور|مطلوب|اكتر مبيعا)/],
    ecommerce_category_info: [/(عن القسم|القسم|قسم|صنف|تصنيف|تفاصيل القسم)/],
    ecommerce_product_advantages: [/(مميزات|مزايا|فوائد|ليه اشتري|مواصفات)/],
    ecommerce_check_availability: [/(متاح|موجود|هل عندكم|هل يوجد|عندكم|متوفر)/],
    ecommerce_country_info: [/(سوق|اسواق|في بلد|في دوله|في دولة|السوق)/],
    ecommerce_country_products: [/(منتجات من|من بلد|من دولة|منتجات في)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|بقديش|كم السعر|الثمن|حسابه|حسابها)/],
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
      const meta = item.metadata || {};
      const extras = [
        item.description_en,
        item.description_ar,
        meta.country,
        meta.country_ar,
        meta.country_en
      ];
      // Add dynamic feature values for fuzzy matching
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
  
  if (matchesAny(normalizedText, patterns.ecommerce_search_hot)) {
    const hotItems = items.filter(i => String(i.metadata?.hot_selling) === 'true');
    // If category or country matched in context of hot selling
    if (categoryMatches.length === 1) {
      return { intent: 'ecommerce_search_hot', items: hotItems.filter(i => getDisplayCategory(i, lang) === categoryMatches[0].display) };
    }
    return { intent: 'ecommerce_search_hot', items: hotItems };
  }

  const asksPriceBase = matchesAny(normalizedText, patterns.item_price);
  
  // Specific dynamic feature queries checking
  if (foundItem) {
    const isAdvantage = matchesAny(normalizedText, patterns.ecommerce_product_advantages);
    if (isAdvantage) return { intent: 'ecommerce_product_advantages', item: foundItem };
    
    // Default to found item
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
    case 'ecommerce_search_hot':
      if (intentResult.items && intentResult.items.length > 0) {
        payload.text = [
          locale === 'ar' ? 'إليك المنتجات الأكثر مبيعاً:' : 'Here are our hot selling products:',
          ...intentResult.items.slice(0, 6).map(item => `- ${getDisplayTitle(item, locale)}`)
        ].join('\n');
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
      if (item.metadata?.thumbnail) payload.thumbnail = item.metadata.thumbnail;
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
      if (item.metadata?.thumbnail) {
        payload.thumbnail = item.metadata.thumbnail;
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
      if (item.metadata?.thumbnail) payload.thumbnail = item.metadata.thumbnail;
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
      payload.text = [
        locale === 'ar' ? `هذه المنتجات الموجودة في ${intentResult.category}:` : `Here are the products in ${intentResult.category}:`,
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
        locale === 'ar' ? 'وجدت أكثر من منتج مطابق. أي واحد تقصد؟' : 'I found more than one matching product. Which would you like?',
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
    .filter((record) => record.title || record.title_en || record.name || record.name_en)
    .map((record) => {
      // standard fields
      const standardKeys = [
        'title', 'title_en', 'title_ar', 'name', 'name_en', 'name_ar',
        'category', 'category_en', 'category_ar',
        'description', 'description_en', 'description_ar',
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

      // map any unknown keys from record into metadataObj for dynamic features
      for (const [k, v] of Object.entries(record)) {
        if (!standardKeys.includes(k) && typeof v !== 'undefined') {
          metadataObj[k] = v;
        }
      }

      return {
        title_en: record.title_en || record.title || record.name_en || record.name || '',
        title_ar: record.title_ar || record.name_ar || '',
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
