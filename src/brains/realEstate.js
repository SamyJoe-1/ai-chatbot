'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById } = require('./shared/matcher');

const PATTERNS = {
  en: {
    greeting_hello: [/^(hi|hello|hey)\b/i, /^good (morning|afternoon|evening)\b/i],
    greeting_how_are_you: [/^(how are u|how are u doing|are u okay|how are you|how are you doing|are you okay)\b/i],
    greeting_yasta: [/^(yasta)\b/i],
    thanks: [/\b(thanks|thank you|thx)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i],
    catalog_general: [
      /\bprojects?\b/i,
      /\bproperties?\b/i,
      /\blistings?\b/i,
      /\bunits?\b/i,
      /\bshow me.*(projects|properties|listings|units)\b/i,
      /\bwhat projects\b/i,
      /\ball projects\b/i,
    ],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    item_location: [/\blocation\b/i, /\bwhere is\b/i, /\baddress\b/i, /\bdistrict\b/i],
    item_specs: [/\bbed(room)?s?\b/i, /\bbath(room)?s?\b/i, /\barea\b/i, /\bsquare\b/i, /\bmeter\b/i, /\bsize\b/i],
    item_finance: [/\bpayment\b/i, /\binstallment\b/i, /\bdown payment\b/i, /\bdeposit\b/i, /\broi\b/i, /\brental\b/i, /\brent\b/i, /\binvest(ment)?\b/i],
    appointment: [/\bvisit\b/i, /\bviewing\b/i, /\bappointment\b/i, /\bbook\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\bagency\b/i, /\bdeveloper\b/i],
  },
  ar: {
    greeting_hello: [/^(مرحبا|اهلا|أهلا|هلا|السلام عليكم)/, /^(صباح الخير|مساء الخير)/],
    greeting_how_are_you: [/^(ايه اخبارك|عامل ايه|عامل اية|انت كويس|كيفك|شلونك|اخبارك|ازيك|إزيك)/],
    greeting_yasta: [/^(يسطا|يا اسطى|ياسطى|ي زميلي|يا زميلي|يصاحبي|يا صاحبي)/],
    thanks: [/(شكرا|شكرًا|تسلم|يعطيك العافية)/],
    help: [/(مساعدة|ساعدني|ماذا يمكنك|بتعمل ايه|تساعدني)/],
    catalog_general: [/(مشروعات|مشروع|عقارات|عقار|وحدات|شقق|فلل|عروض|قائمة|عندكم ايه|عندكو ايه|مشاريع)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|كم السعر|الثمن)/],
    item_location: [/(الموقع|العنوان|فين|وين|المنطقة|الحي|مكان|فروعكم|فرعكم)/],
    item_specs: [/(غرف|غرفة|حمام|حمامات|مساحة|متر|امتار|الأمتار|القياس|تشطيب)/],
    item_finance: [/(السداد|تقسيط|المقدم|دفعة|عائد|استثمار|إيجار|إيجاري|الإيجار|قسط)/],
    appointment: [/(معاينة|زيارة|موعد|احجز|أحجز|شوف)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل|تليفون|تلفون|كلمكم|اكلمكم)/],
    brand_info: [/(من انتم|مين انتم|عن الشركة|عن المكتب|عن المطور|مين انت)/],
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

function joinUnique(values) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

function getLocation(item) {
  return joinUnique([
    item.metadata?.district,
    item.metadata?.compound,
    item.metadata?.location,
  ]).join(', ');
}

function getSpecs(item) {
  return {
    bedrooms: item.metadata?.bedrooms,
    bathrooms: item.metadata?.bathrooms,
    area: item.metadata?.area_sqm || item.metadata?.area,
    listingType: item.metadata?.listing_type || item.metadata?.purpose,
    assetType: item.metadata?.asset_type || item.metadata?.unit_type || '',
    offerType: item.metadata?.offer_type || item.metadata?.sale_type || '',
    projectName: item.metadata?.project_name || '',
    finishing: item.metadata?.finishing || '',
    delivery: item.metadata?.delivery_status || item.metadata?.delivery_date || item.metadata?.handover || '',
    paymentPlan: item.metadata?.payment_plan || '',
    downPayment: item.metadata?.down_payment || '',
    installmentYears: item.metadata?.installment_years || '',
    roi: item.metadata?.roi || item.metadata?.expected_roi || '',
    rentFrequency: item.metadata?.rent_frequency || '',
  };
}

function getExtraVariants(item) {
  return [
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
    item.metadata?.asset_type,
    item.metadata?.unit_type,
    item.metadata?.offer_type,
    item.metadata?.sale_type,
    item.metadata?.project_name,
    item.metadata?.finishing,
    item.metadata?.delivery_status,
    item.metadata?.delivery_date,
    item.metadata?.handover,
    item.metadata?.payment_plan,
    item.metadata?.down_payment,
    item.metadata?.installment_years,
    item.metadata?.roi,
    item.metadata?.expected_roi,
    item.metadata?.rent_frequency,
  ];
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
    getExtraVariants,
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

  if (matchesAny(normalizedText, patterns.greeting_hello)) return { intent: 'greeting_hello' };
  if (matchesAny(normalizedText, patterns.greeting_how_are_you)) return { intent: 'greeting_how_are_you' };
  if (matchesAny(normalizedText, patterns.greeting_yasta)) return { intent: 'greeting_yasta' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };
  if (matchesAny(normalizedText, patterns.appointment)) return { intent: 'appointment', item: foundItem || lastItem || null };
  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };



  const asksPrice = matchesAny(normalizedText, patterns.item_price);
  const asksLocation = matchesAny(normalizedText, patterns.item_location);
  const asksSpecs = matchesAny(normalizedText, patterns.item_specs);
  const asksFinance = matchesAny(normalizedText, patterns.item_finance);

  if (matchedItems.length === 1 && foundItem) {
    if (asksPrice) return { intent: 'item_price', item: foundItem };
    if (asksSpecs) return { intent: 'item_specs', item: foundItem };
    if (asksFinance) return { intent: 'item_finance', item: foundItem };
    if (asksLocation) return { intent: 'item_location', item: foundItem };
    return { intent: 'item_found', item: foundItem };
  }

  if (matchedItems.length > 1) {
    if (topScore >= secondScore + 3) {
      if (asksPrice) return { intent: 'item_price', item: foundItem };
      if (asksSpecs) return { intent: 'item_specs', item: foundItem };
      if (asksFinance) return { intent: 'item_finance', item: foundItem };
      if (asksLocation) return { intent: 'item_location', item: foundItem };
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
  if (asksSpecs && lastItem) return { intent: 'item_specs', item: lastItem };
  if (asksFinance && lastItem) return { intent: 'item_finance', item: lastItem };
  if (asksLocation && lastItem) return { intent: 'item_location', item: lastItem };
  if (asksPrice || asksLocation || asksSpecs || asksFinance) return { intent: 'need_item_context' };



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
  if (specs.assetType) lines.push(locale === 'ar' ? `نوع الوحدة: ${specs.assetType}` : `Asset: ${specs.assetType}`);
  if (specs.offerType) lines.push(locale === 'ar' ? `طريقة الطرح: ${specs.offerType}` : `Offer: ${specs.offerType}`);
  if (specs.projectName) lines.push(locale === 'ar' ? `المشروع: ${specs.projectName}` : `Project: ${specs.projectName}`);
  if (specs.bedrooms !== undefined && specs.bedrooms !== '') lines.push(locale === 'ar' ? `غرف النوم: ${specs.bedrooms}` : `Bedrooms: ${specs.bedrooms}`);
  if (specs.bathrooms !== undefined && specs.bathrooms !== '') lines.push(locale === 'ar' ? `الحمامات: ${specs.bathrooms}` : `Bathrooms: ${specs.bathrooms}`);
  if (specs.area !== undefined && specs.area !== '') lines.push(locale === 'ar' ? `المساحة: ${specs.area} م²` : `Area: ${specs.area} sqm`);
  if (specs.finishing) lines.push(locale === 'ar' ? `التشطيب: ${specs.finishing}` : `Finishing: ${specs.finishing}`);
  if (specs.delivery) lines.push(locale === 'ar' ? `التسليم: ${specs.delivery}` : `Delivery: ${specs.delivery}`);

  return lines.join('\n');
}

function buildFinanceSummary(item, lang) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const specs = getSpecs(item);
  const parts = [];

  if (item.price !== null && item.price !== undefined) parts.push(locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`);
  if (specs.downPayment) parts.push(locale === 'ar' ? `المقدم: ${specs.downPayment}` : `Down payment: ${specs.downPayment}`);
  if (specs.installmentYears) parts.push(locale === 'ar' ? `فترة التقسيط: ${specs.installmentYears}` : `Installments: ${specs.installmentYears}`);
  if (specs.paymentPlan) parts.push(locale === 'ar' ? `نظام السداد: ${specs.paymentPlan}` : `Payment plan: ${specs.paymentPlan}`);
  if (specs.roi) parts.push(locale === 'ar' ? `العائد المتوقع: ${specs.roi}` : `Expected ROI: ${specs.roi}`);
  if (specs.rentFrequency) parts.push(locale === 'ar' ? `نظام الإيجار: ${specs.rentFrequency}` : `Rental term: ${specs.rentFrequency}`);

  if (!parts.length) {
    return locale === 'ar'
      ? 'لا توجد تفاصيل مالية مسجلة لهذا العنصر حاليًا.'
      : 'There are no payment or investment details listed for this item yet.';
  }

  return `${getDisplayTitle(item, locale)}\n${parts.join('\n')}`;
}

function hasPrice(item) {
  return item.price !== null && item.price !== undefined;
}

function hasLocation(item) {
  return Boolean(getLocation(item));
}

function hasSpecs(item) {
  const specs = getSpecs(item);
  return Boolean(
    specs.assetType
    || specs.offerType
    || specs.bedrooms !== undefined && specs.bedrooms !== ''
    || specs.bathrooms !== undefined && specs.bathrooms !== ''
    || specs.area !== undefined && specs.area !== ''
    || specs.finishing
    || specs.delivery
  );
}

function hasFinance(item) {
  const specs = getSpecs(item);
  return Boolean(
    hasPrice(item)
    || specs.downPayment
    || specs.installmentYears
    || specs.paymentPlan
    || specs.roi
    || specs.rentFrequency
  );
}

function buildItemSuggestions(item, locale) {
  const suggestions = [];

  if (hasPrice(item)) {
    suggestions.push(locale === 'ar' ? 'السعر' : 'Price');
  }

  if (hasLocation(item)) {
    suggestions.push(locale === 'ar' ? 'الموقع' : 'Location');
  }

  if (hasSpecs(item)) {
    suggestions.push(locale === 'ar' ? 'المواصفات' : 'Specs');
  }

  if (hasFinance(item)) {
    suggestions.push(locale === 'ar' ? 'السداد' : 'Payment');
  }

  return suggestions.slice(0, 4);
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
        ? `أهلًا بك في ${business.name_ar || business.name}. كيف أساعدك في المشروعات أو الوحدات اليوم؟`
        : `Hello from ${business.name}. How can I help you with projects or units today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_how_are_you':
      payload.text = locale === 'ar'
        ? `أنا بخير، شكراً لسؤالك! أهلًا بك في ${business.name_ar || business.name}. كيف أساعدك في المشروعات أو الوحدات اليوم؟`
        : `I'm doing great, thanks for asking! Welcome to ${business.name}. How can I help you with projects or units today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_yasta':
      payload.text = locale === 'ar'
        ? `حبيبي يسطا! منور ${business.name_ar || business.name}. أقدر أساعدك إزاي في المشروعات أو الوحدات؟`
        : `Hey there! Welcome to ${business.name}. How can I help you with projects or units today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = locale === 'ar' ? 'على الرحب والسعة. إذا احتجت أي مشروع أو وحدة أخرى فقط اسأل.' : 'You are welcome. If you need another project or unit, just ask.';
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = locale === 'ar'
        ? 'أقدر أساعدك في المشروعات والوحدات والأسعار والموقع والمواصفات وتفاصيل السداد وبيانات التواصل.'
        : 'I can help with projects, units, pricing, location, specs, payment details, and contact information.';
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'catalog_general': {
      const items = getBusinessItems(business.id);
      payload.text = [
        locale === 'ar' ? 'هذه بعض المشروعات المتاحة:' : 'Here are the available projects:',
        ...items.slice(0, 8).map((item) => `- ${getDisplayTitle(item, locale)}`),
      ].join('\n');
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح المشروعات' : 'Open projects',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      payload.suggestions = items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    }
    case 'item_found':
      payload.text = buildPropertySummary(intentResult.item, locale);
      payload.suggestions = buildItemSuggestions(intentResult.item, locale);
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = getDisplayCategory(intentResult.item, locale) || null;
      break;
    case 'item_price':
      payload.text = intentResult.item.price !== null && intentResult.item.price !== undefined
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} سعره ${intentResult.item.price} ${intentResult.item.currency}.`
          : `${getDisplayTitle(intentResult.item, locale)} is listed for ${intentResult.item.price} ${intentResult.item.currency}.`)
        : (locale === 'ar'
          ? `سعر ${getDisplayTitle(intentResult.item, locale)} غير مضاف حاليًا.`
          : `The price for ${getDisplayTitle(intentResult.item, locale)} is not listed yet.`);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'item_location':
      payload.text = getLocation(intentResult.item)
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} موجود في ${getLocation(intentResult.item)}.`
          : `${getDisplayTitle(intentResult.item, locale)} is located in ${getLocation(intentResult.item)}.`)
        : (locale === 'ar'
          ? `موقع ${getDisplayTitle(intentResult.item, locale)} غير مضاف حاليًا.`
          : `The location for ${getDisplayTitle(intentResult.item, locale)} is not listed yet.`);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'item_specs': {
      const specs = getSpecs(intentResult.item);
      const parts = [];
      if (specs.assetType) parts.push(locale === 'ar' ? `نوع الوحدة: ${specs.assetType}` : `Asset: ${specs.assetType}`);
      if (specs.offerType) parts.push(locale === 'ar' ? `طريقة الطرح: ${specs.offerType}` : `Offer: ${specs.offerType}`);
      if (specs.bedrooms !== undefined && specs.bedrooms !== '') parts.push(locale === 'ar' ? `غرف النوم: ${specs.bedrooms}` : `Bedrooms: ${specs.bedrooms}`);
      if (specs.bathrooms !== undefined && specs.bathrooms !== '') parts.push(locale === 'ar' ? `الحمامات: ${specs.bathrooms}` : `Bathrooms: ${specs.bathrooms}`);
      if (specs.area !== undefined && specs.area !== '') parts.push(locale === 'ar' ? `المساحة: ${specs.area} م²` : `Area: ${specs.area} sqm`);
      if (specs.finishing) parts.push(locale === 'ar' ? `التشطيب: ${specs.finishing}` : `Finishing: ${specs.finishing}`);
      if (specs.delivery) parts.push(locale === 'ar' ? `التسليم: ${specs.delivery}` : `Delivery: ${specs.delivery}`);
      payload.text = parts.length
        ? `${getDisplayTitle(intentResult.item, locale)}\n${parts.join('\n')}`
        : (locale === 'ar' ? 'لا توجد مواصفات إضافية مسجلة لهذا العنصر حاليًا.' : 'There are no extra specs listed for this item yet.');
      payload.context_update.last_item = intentResult.item.id;
      break;
    }
    case 'item_finance':
      payload.text = buildFinanceSummary(intentResult.item, locale);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'category_items':
      payload.text = [
        locale === 'ar' ? `هذه العناصر ضمن ${intentResult.category}:` : `Here are the listings in ${intentResult.category}:`,
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
        locale === 'ar' ? 'وجدت أكثر من عنصر مطابق. أي واحد تقصد؟' : 'I found more than one matching listing. Which one do you mean?',
        ...intentResult.items.slice(0, 6).map((item) => `- ${getDisplayTitle(item, locale)}`),
      ].join('\n');
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    case 'need_item_context':
      payload.text = locale === 'ar' ? 'تقصد أي مشروع أو وحدة؟' : 'Which project or unit do you mean?';
      break;
    case 'item_not_found':
      payload.text = locale === 'ar'
        ? 'لم أجد هذا العنصر ضمن البيانات الحالية.'
        : 'I could not find that item in the current catalog.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض كل المشروعات' : 'View all projects',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'appointment':
      payload.text = locale === 'ar'
        ? `لحجز معاينة تواصل معنا مباشرة على ${business.phone || 'رقم الهاتف'}.`
        : `For a viewing, please contact us directly at ${business.phone || 'our phone number'}.`;
      break;
    case 'brand_info':
      payload.text = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا لمعرفة المزيد عن المشروعات والوحدات.`)
        : (business.about_en || `We are ${business.name}. Contact us to learn more about our projects and units.`);
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
        ? `لا أملك إجابة دقيقة على هذا السؤال حاليًا. تواصل معنا على ${business.phone || 'رقم التواصل'}، وما زلت أقدر أساعدك في الأسعار أو المواقع أو المواصفات أو السداد.`
        : `I do not have an exact answer for that yet. Please contact us at ${business.phone || 'our contact number'}, and I can still help with pricing, location, specs, or payment details.`;
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
        asset_type: record.asset_type || record.unit_type || '',
        unit_type: record.unit_type || '',
        offer_type: record.offer_type || record.sale_type || '',
        sale_type: record.sale_type || '',
        project_name: record.project_name || '',
        finishing: record.finishing || '',
        delivery_status: record.delivery_status || '',
        delivery_date: record.delivery_date || record.handover || '',
        handover: record.handover || '',
        payment_plan: record.payment_plan || '',
        down_payment: record.down_payment || '',
        installment_years: record.installment_years || '',
        roi: record.roi || record.expected_roi || '',
        expected_roi: record.expected_roi || '',
        rent_frequency: record.rent_frequency || '',
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
      ? (business.welcome_ar || `أهلًا بك في ${business.name_ar || business.name}! كيف أساعدك في المشروعات أو الوحدات؟`)
      : (business.welcome_en || `Welcome to ${business.name}! How can I help you with projects or units?`);
  },
  mapSheetRecords,
};
