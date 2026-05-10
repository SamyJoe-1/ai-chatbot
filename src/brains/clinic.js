'use strict';

const { tokenize, normalize } = require('../engine/detector');
const { getBusinessItems } = require('./shared/catalogStore');
const { findMatchingCategories, findScoredItems, uniqueById } = require('./shared/matcher');

const PATTERNS = {
  en: {
    greeting: [/^(hi|hello|hey)\b/i],
    thanks: [/\b(thanks|thank you|thx)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i],
    catalog_general: [/\bservices?\b/i, /\bdoctors?\b/i, /\bclinics?\b/i, /\bshow me.*(services|doctors)\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    doctor_info: [/\bdoctor\b/i, /\bdr\b/i],
    specialization: [/\bspecial(ty|ization)\b/i, /\bdentist\b/i, /\bdermatolog/i],
    appointment: [/\bappointment\b/i, /\bbook\b/i, /\breserve\b/i, /\bvisit\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bbranch\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the clinic\b/i],
  },
  ar: {
    greeting: [/^(مرحبا|اهلا|أهلا|هلا)/],
    thanks: [/(شكرا|شكراً|تسلم)/],
    help: [/(مساعدة|ساعدني|ماذا يمكنك)/],
    catalog_general: [/(خدمات|دكاترة|دكتور|عيادة|الأطباء)/],
    item_price: [/(سعر|بكام|كم السعر|الثمن)/],
    doctor_info: [/(دكتور|طبيب|دكتورة)/],
    specialization: [/(تخصص|تخصصه|أسنان|جلدية|باطنة|عظام)/],
    appointment: [/(موعد|حجز|احجز|أحجز|زيارة)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|ايميل|إيميل)/],
    location: [/(الموقع|العنوان|الفرع|فين|وين)/],
    working_hours: [/(ساعات العمل|اوقات العمل|أوقات العمل|الدوام)/],
    brand_info: [/(من انتم|مين انتم|عن العيادة|عن المركز)/],
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

function getDoctor(item) {
  return item.metadata?.doctor || item.metadata?.provider || '';
}

function getSpecialization(item) {
  return item.metadata?.specialization || item.metadata?.department || '';
}

function getBranch(item) {
  return item.metadata?.branch || item.metadata?.location || '';
}

function findServices(text, lang, businessId, context = {}) {
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
      item.metadata?.doctor,
      item.metadata?.provider,
      item.metadata?.specialization,
      item.metadata?.department,
      item.metadata?.branch,
      item.metadata?.location,
      item.metadata?.duration_minutes,
      item.metadata?.booking,
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
  const { items, matchedItems, scoredMatches, categoryMatches } = findServices(text, lang, business.id, context);
  const lastItem = context.last_item ? items.find((item) => item.id === context.last_item) : null;
  const foundItem = matchedItems[0] || null;
  const topScore = scoredMatches[0]?.score || 0;
  const secondScore = scoredMatches[1]?.score || 0;

  if (matchesAny(normalizedText, patterns.greeting)) return { intent: 'greeting' };
  if (matchesAny(normalizedText, patterns.thanks)) return { intent: 'thanks' };
  if (matchesAny(normalizedText, patterns.help)) return { intent: 'help' };
  if (matchesAny(normalizedText, patterns.appointment)) return { intent: 'appointment', item: foundItem || lastItem || null };

  const asksPrice = matchesAny(normalizedText, patterns.item_price);
  const asksDoctor = matchesAny(normalizedText, patterns.doctor_info);
  const asksSpecialization = matchesAny(normalizedText, patterns.specialization);

  if (matchedItems.length === 1 && foundItem) {
    if (asksPrice) return { intent: 'item_price', item: foundItem };
    if (asksDoctor) return { intent: 'doctor_info', item: foundItem };
    if (asksSpecialization) return { intent: 'specialization', item: foundItem };
    return { intent: 'item_found', item: foundItem };
  }

  if (matchedItems.length > 1) {
    if (topScore >= secondScore + 3) {
      if (asksPrice) return { intent: 'item_price', item: foundItem };
      if (asksDoctor) return { intent: 'doctor_info', item: foundItem };
      if (asksSpecialization) return { intent: 'specialization', item: foundItem };
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
  if (asksDoctor && lastItem) return { intent: 'doctor_info', item: lastItem };
  if (asksSpecialization && lastItem) return { intent: 'specialization', item: lastItem };
  if (asksPrice || asksDoctor || asksSpecialization) return { intent: 'need_item_context' };

  if (matchesAny(normalizedText, patterns.catalog_general)) return { intent: 'catalog_general' };
  if (matchesAny(normalizedText, patterns.contact)) return { intent: 'contact' };
  if (matchesAny(normalizedText, patterns.location)) return { intent: 'location' };
  if (matchesAny(normalizedText, patterns.working_hours)) return { intent: 'working_hours' };
  if (matchesAny(normalizedText, patterns.brand_info)) return { intent: 'brand_info' };

  const tokens = tokenize(normalizedText);
  if (tokens.length && tokens.length <= 3) return { intent: 'item_not_found' };
  return { intent: 'unknown' };
}

function buildServiceSummary(item, lang) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const lines = [getDisplayTitle(item, locale)];
  const description = locale === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
  if (description) lines.push(description);
  if (item.price !== null && item.price !== undefined) lines.push(locale === 'ar' ? `السعر: ${item.price} ${item.currency}` : `Price: ${item.price} ${item.currency}`);
  if (getDoctor(item)) lines.push(locale === 'ar' ? `الطبيب: ${getDoctor(item)}` : `Doctor: ${getDoctor(item)}`);
  if (getSpecialization(item)) lines.push(locale === 'ar' ? `التخصص: ${getSpecialization(item)}` : `Specialization: ${getSpecialization(item)}`);
  if (getBranch(item)) lines.push(locale === 'ar' ? `الفرع: ${getBranch(item)}` : `Branch: ${getBranch(item)}`);
  if (item.metadata?.duration_minutes) lines.push(locale === 'ar' ? `المدة: ${item.metadata.duration_minutes} دقيقة` : `Duration: ${item.metadata.duration_minutes} minutes`);
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
        ? `أهلاً بك في ${business.name_ar || business.name}. كيف أساعدك في الخدمات الطبية اليوم؟`
        : `Hello from ${business.name}. How can I help you with medical services today?`;
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = locale === 'ar' ? 'على الرحب والسعة. إذا احتجت خدمة أخرى فقط اسأل.' : 'You are welcome. If you need another service, just ask.';
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = locale === 'ar'
        ? 'أقدر أساعدك في الخدمات، الأطباء، الأسعار، المواعيد، ومعلومات التواصل.'
        : 'I can help with services, doctors, pricing, appointments, and contact details.';
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'catalog_general':
      payload.text = locale === 'ar' ? 'هذه هي الخدمات المتاحة.' : 'Here are the available services.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح الخدمات' : 'Open services',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'item_found':
      payload.text = buildServiceSummary(intentResult.item, locale);
      payload.suggestions = locale === 'ar' ? ['السعر', 'الطبيب', 'التخصص'] : ['Price', 'Doctor', 'Specialization'];
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = getDisplayCategory(intentResult.item, locale) || null;
      break;
    case 'item_price':
      payload.text = intentResult.item.price !== null && intentResult.item.price !== undefined
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} سعره ${intentResult.item.price} ${intentResult.item.currency}.`
          : `${getDisplayTitle(intentResult.item, locale)} costs ${intentResult.item.price} ${intentResult.item.currency}.`)
        : (locale === 'ar'
          ? `سعر ${getDisplayTitle(intentResult.item, locale)} غير مضاف حالياً.`
          : `The price for ${getDisplayTitle(intentResult.item, locale)} is not listed yet.`);
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'doctor_info':
      payload.text = getDoctor(intentResult.item)
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} يقدمه ${getDoctor(intentResult.item)}.`
          : `${getDisplayTitle(intentResult.item, locale)} is handled by ${getDoctor(intentResult.item)}.`)
        : (locale === 'ar'
          ? 'بيانات الطبيب غير مضافة حالياً لهذه الخدمة.'
          : 'Doctor information is not listed for this service yet.');
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'specialization':
      payload.text = getSpecialization(intentResult.item)
        ? (locale === 'ar'
          ? `${getDisplayTitle(intentResult.item, locale)} ضمن تخصص ${getSpecialization(intentResult.item)}.`
          : `${getDisplayTitle(intentResult.item, locale)} belongs to ${getSpecialization(intentResult.item)}.`)
        : (locale === 'ar'
          ? 'التخصص غير مضاف حالياً لهذه الخدمة.'
          : 'The specialization is not listed for this service yet.');
      payload.context_update.last_item = intentResult.item.id;
      break;
    case 'category_items':
      payload.text = [
        locale === 'ar' ? `هذه الخدمات ضمن ${intentResult.category}:` : `Here are the services in ${intentResult.category}:`,
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
        locale === 'ar' ? 'وجدت أكثر من خدمة مطابقة. أي واحدة تقصد؟' : 'I found more than one matching service. Which one do you mean?',
        ...intentResult.items.slice(0, 6).map((item) => `- ${getDisplayTitle(item, locale)}`),
      ].join('\n');
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => getDisplayTitle(item, locale));
      break;
    case 'need_item_context':
      payload.text = locale === 'ar' ? 'تقصد أي خدمة؟' : 'Which service do you mean?';
      break;
    case 'item_not_found':
      payload.text = locale === 'ar' ? 'لم أجد هذه الخدمة ضمن الخدمات الحالية.' : 'I could not find that service in the current catalog.';
      if (business.catalog_link) {
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض كل الخدمات' : 'View all services',
          url: business.catalog_link,
          target: '_blank',
        });
      }
      break;
    case 'appointment':
      payload.text = locale === 'ar'
        ? `لحجز موعد تواصل معنا مباشرة على ${business.phone || 'رقم الهاتف'}.`
        : `For appointments, please contact us directly at ${business.phone || 'our phone number'}.`;
      break;
    case 'brand_info':
      payload.text = locale === 'ar'
        ? (business.about_ar || `نحن ${business.name_ar || business.name}. تواصل معنا لمعرفة المزيد عن خدماتنا.`)
        : (business.about_en || `We are ${business.name}. Contact us to learn more about our services.`);
      break;
    case 'contact':
      payload.text = [
        locale === 'ar' ? 'يمكنك التواصل معنا عبر:' : 'You can contact us through:',
        business.phone ? (locale === 'ar' ? `الهاتف / واتساب: ${business.phone}` : `Phone / WhatsApp: ${business.phone}`) : null,
        business.email ? (locale === 'ar' ? `الإيميل: ${business.email}` : `Email: ${business.email}`) : null,
      ].filter(Boolean).join('\n');
      break;
    case 'location':
      payload.text = locale === 'ar'
        ? (business.address_ar ? `عنواننا:\n${business.address_ar}` : 'العنوان غير مضاف حالياً.')
        : (business.address_en ? `Our address:\n${business.address_en}` : 'Our address is not listed yet.');
      break;
    case 'working_hours':
      payload.text = locale === 'ar'
        ? (business.working_hours_ar ? `مواعيد العمل:\n${business.working_hours_ar}` : 'مواعيد العمل غير مضافة حالياً.')
        : (business.working_hours_en ? `Our working hours:\n${business.working_hours_en}` : 'Working hours are not listed yet.');
      break;
    case 'unknown':
    default:
      payload.text = locale === 'ar'
        ? `لا أملك إجابة دقيقة على هذا السؤال حالياً. تواصل معنا على ${business.phone || 'رقم التواصل'}، وما زلت أقدر أساعدك في الخدمات أو الأسعار أو المواعيد.`
        : `I do not have an exact answer for that yet. Please contact us at ${business.phone || 'our contact number'}, and I can still help with services, pricing, or appointments.`;
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
      category_en: record.category_en || record.category || record.department || '',
      category_ar: record.category_ar || '',
      description_en: record.description_en || record.description || '',
      description_ar: record.description_ar || '',
      price: record.price ? Number(record.price) : null,
      currency: record.currency || 'EGP',
      metadata: JSON.stringify({
        doctor: record.doctor || record.provider || '',
        specialization: record.specialization || record.department || '',
        branch: record.branch || record.location || '',
        duration_minutes: record.duration_minutes || record.duration || '',
        booking: record.booking || record.booking_notes || '',
      }),
      available: ['0', 'false', 'no'].includes(String(record.available || '').toLowerCase()) ? 0 : 1,
    }));
}

module.exports = {
  serviceType: 'clinic',
  defaultSheetName: 'Services',
  defaultBusinessName: 'New Clinic',
  detectIntent,
  buildResponse,
  getWelcomeMessage(business, lang) {
    return lang === 'ar'
      ? (business.welcome_ar || `أهلاً بك في ${business.name_ar || business.name}! كيف أساعدك في خدمات العيادة؟`)
      : (business.welcome_en || `Welcome to ${business.name}! How can I help you with clinic services?`);
  },
  mapSheetRecords,
};
