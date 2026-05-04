'use strict';

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const PATTERNS = {
  en: {
    greeting: [/^(hi|hello|hey|hiya|howdy)\b/i, /^good (morning|afternoon|evening)\b/i],
    thanks: [/\b(thanks|thank you|thx|ty|appreciate)\b/i],
    help: [/\bhelp\b/i, /\bwhat can you do\b/i, /\bhow does this work\b/i],
    menu_general: [/\bmenu\b/i, /\bwhat do you have\b/i, /\bwhat do you offer\b/i, /\bshow me.*menu\b/i],
    item_price: [/\bprice\b/i, /\bcost\b/i, /\bhow much\b/i],
    item_sizes: [/\bsize\b/i, /\bsizes\b/i, /\bsmall\b/i, /\bmedium\b/i, /\blarge\b/i],
    contact: [/\bcontact\b/i, /\bphone\b/i, /\bwhatsapp\b/i, /\bcall\b/i, /\bemail\b/i],
    working_hours: [/\bhours\b/i, /\bopen\b/i, /\bclose\b/i, /\bworking hours\b/i],
    location: [/\blocation\b/i, /\baddress\b/i, /\bwhere are you\b/i, /\bdirections\b/i],
    brand_info: [/\bwho are you\b/i, /\babout you\b/i, /\babout the cafe\b/i, /\bwhat do you provide\b/i],
    reservation: [/\breservation\b/i, /\bbook\b/i, /\bbooking\b/i, /\btable\b/i],
  },
  ar: {
    greeting: [/^(مرحبا|اهلا|أهلا|هلا|السلام عليكم)/, /^(صباح الخير|مساء الخير)/],
    thanks: [/(شكرا|شكراً|تسلم|يسلمو|ممنون)/],
    help: [/(مساعدة|ساعدني|كيف يشتغل|كيف يعمل|ماذا يمكنك)/],
    menu_general: [/(منيو|منيـو|قائمه|قائمة|ايش عندكم|شو عندكم|ماذا تقدمون|وجبات|مشروبات)/],
    item_price: [/(سعر|اسعار|أسعار|بكام|بقديش|كم السعر|الثمن)/],
    item_sizes: [/(حجم|احجام|أحجام|صغير|وسط|كبير|الاحجام|الأحجام)/],
    contact: [/(تواصل|اتصال|رقم|واتساب|هاتف|موبايل|ايميل|إيميل)/],
    working_hours: [/(ساعات العمل|اوقات العمل|أوقات العمل|متى تفتحون|متى تغلقون|الدوام)/],
    location: [/(العنوان|الموقع|وين|فين|أين|اتجاهات|خريطة)/],
    brand_info: [/(من انتم|مين انتم|نبذه عنكم|نبذة عنكم|من انتو|ماذا تقدمون|عن المطعم|عن الكافيه)/],
    reservation: [/(حجز|احجز|أحجز|طاوله|طاولة|ريزرفيشن)/],
  },
};

function itemName(item, lang) {
  return lang === 'ar' ? item.name_ar || item.name_en : item.name_en || item.name_ar;
}

function itemDescription(item, lang) {
  return lang === 'ar' ? item.description_ar || item.description_en : item.description_en || item.description_ar;
}

function sizesList(item) {
  return Array.isArray(item.sizes) ? item.sizes.filter(Boolean) : [];
}

const RESPONSES = {
  welcome: {
    en: (cafe) => cafe.welcome_en || `Welcome to ${cafe.name}!`,
    ar: (cafe) => cafe.welcome_ar || `أهلاً بك في ${cafe.name_ar || cafe.name}!`,
  },
  collect_name: {
    en: () => 'What is your name?',
    ar: () => 'ما اسمك؟',
  },
  ask_name_again: {
    en: () => 'What is your name?',
    ar: () => 'ما اسمك؟',
  },
  collect_phone: {
    en: () => 'What is your phone number?',
    ar: () => 'ما رقم هاتفك؟',
  },
  invalid_phone: {
    en: () => 'Please enter a valid phone number.',
    ar: () => 'من فضلك اكتب رقم هاتف صحيح.',
  },
  active_ready: {
    en: (name) => `Perfect, ${name}. How can I help you today?`,
    ar: (name) => `ممتاز يا ${name}. كيف أقدر أساعدك اليوم؟`,
  },
  greeting: {
    en: (cafe) => `Hello from ${cafe.name}. How can I help you?`,
    ar: (cafe) => `أهلاً بك في ${cafe.name_ar || cafe.name}. كيف أساعدك؟`,
  },
  thanks: {
    en: () => 'You are welcome. If you need anything else, just ask.',
    ar: () => 'على الرحب والسعة. إذا احتجت أي شيء آخر فقط اسأل.',
  },
  help: {
    en: () => 'I can help with the menu, item prices, sizes, working hours, location, contact details, and general cafe info.',
    ar: () => 'أقدر أساعدك في القائمة، أسعار الأصناف، الأحجام، مواعيد العمل، الموقع، معلومات التواصل، ومعلومات عامة عن الكافيه.',
  },
  menu_general: {
    en: () => 'Here is the menu.',
    ar: () => 'هذه هي القائمة.',
  },
  item_found: {
    en: (item) => {
      const parts = [itemName(item, 'en')];
      const description = itemDescription(item, 'en');
      const sizes = sizesList(item);
      if (description) parts.push(description);
      if (item.price !== null && item.price !== undefined) parts.push(`Price: ${item.price} ${item.currency}`);
      if (sizes.length) parts.push(`Sizes: ${sizes.join(', ')}`);
      if (item.category_en) parts.push(`Category: ${item.category_en}`);
      return parts.join('\n');
    },
    ar: (item) => {
      const parts = [itemName(item, 'ar')];
      const description = itemDescription(item, 'ar');
      const sizes = sizesList(item);
      if (description) parts.push(description);
      if (item.price !== null && item.price !== undefined) parts.push(`السعر: ${item.price} ${item.currency}`);
      if (sizes.length) parts.push(`الأحجام: ${sizes.join('، ')}`);
      if (item.category_ar || item.category_en) parts.push(`الفئة: ${item.category_ar || item.category_en}`);
      return parts.join('\n');
    },
  },
  item_sizes_context: {
    en: (item) => sizesList(item).length
      ? `${itemName(item, 'en')} is available in: ${sizesList(item).join(', ')}.`
      : `${itemName(item, 'en')} is available in one standard size.`,
    ar: (item) => sizesList(item).length
      ? `${itemName(item, 'ar')} متوفر بالأحجام التالية: ${sizesList(item).join('، ')}.`
      : `${itemName(item, 'ar')} متوفر بحجم واحد فقط.`,
  },
  item_price_context: {
    en: (item) => item.price !== null && item.price !== undefined
      ? `${itemName(item, 'en')} costs ${item.price} ${item.currency}.`
      : `The price for ${itemName(item, 'en')} is not listed yet. Please contact us for details.`,
    ar: (item) => item.price !== null && item.price !== undefined
      ? `${itemName(item, 'ar')} سعره ${item.price} ${item.currency}.`
      : `سعر ${itemName(item, 'ar')} غير مضاف حالياً. تواصل معنا للتفاصيل.`,
  },
  item_not_found: {
    en: () => 'I could not find that item in the menu. You can open the full menu below.',
    ar: () => 'لم أجد هذا الصنف في القائمة. يمكنك فتح القائمة الكاملة من الزر بالأسفل.',
  },
  category_items: {
    en: (category, items) => {
      const lines = [`Here are the items in ${category}:`];
      items.slice(0, 8).forEach((item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        lines.push(`- ${item.name_en}${price}`);
      });
      return lines.join('\n');
    },
    ar: (category, items) => {
      const lines = [`هذه الأصناف الموجودة في ${category}:`];
      items.slice(0, 8).forEach((item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        lines.push(`- ${item.name_ar || item.name_en}${price}`);
      });
      return lines.join('\n');
    },
  },
  item_disambiguation: {
    en: (items) => {
      const lines = ['I found more than one matching item. Which one do you mean?'];
      items.slice(0, 6).forEach((item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        lines.push(`- ${item.name_en}${price}`);
      });
      return lines.join('\n');
    },
    ar: (items) => {
      const lines = ['وجدت أكثر من صنف مطابق. أي واحد تقصد؟'];
      items.slice(0, 6).forEach((item) => {
        const price = item.price !== null && item.price !== undefined ? ` - ${item.price} ${item.currency}` : '';
        lines.push(`- ${item.name_ar || item.name_en}${price}`);
      });
      return lines.join('\n');
    },
  },
  need_item_context: {
    en: () => 'Which item do you mean?',
    ar: () => 'تقصد أي صنف؟',
  },
  brand_info: {
    en: (cafe) => cafe.about_en || `We are ${cafe.name}. Contact us if you want to know more.`,
    ar: (cafe) => cafe.about_ar || `نحن ${cafe.name_ar || cafe.name}. تواصل معنا إذا أردت معرفة المزيد.`,
  },
  contact: {
    en: (cafe) => {
      const lines = ['You can contact us through:'];
      if (cafe.phone) lines.push(`Phone / WhatsApp: ${cafe.phone}`);
      if (cafe.email) lines.push(`Email: ${cafe.email}`);
      return lines.join('\n');
    },
    ar: (cafe) => {
      const lines = ['يمكنك التواصل معنا عبر:'];
      if (cafe.phone) lines.push(`الهاتف / واتساب: ${cafe.phone}`);
      if (cafe.email) lines.push(`الإيميل: ${cafe.email}`);
      return lines.join('\n');
    },
  },
  working_hours: {
    en: (cafe) => cafe.working_hours_en
      ? `Our working hours:\n${cafe.working_hours_en}`
      : 'Working hours are not listed yet. Please contact us to confirm.',
    ar: (cafe) => cafe.working_hours_ar
      ? `مواعيد العمل:\n${cafe.working_hours_ar}`
      : 'مواعيد العمل غير مضافة حالياً. تواصل معنا للتأكيد.',
  },
  location: {
    en: (cafe) => cafe.address_en
      ? `Our address:\n${cafe.address_en}`
      : 'Our address is not listed yet. Please contact us for directions.',
    ar: (cafe) => cafe.address_ar
      ? `عنواننا:\n${cafe.address_ar}`
      : 'العنوان غير مضاف حالياً. تواصل معنا للحصول على الاتجاهات.',
  },
  reservation: {
    en: (cafe) => `For reservations, please contact us directly at ${cafe.phone || 'our phone number'}.`,
    ar: (cafe) => `للحجز تواصل معنا مباشرة على ${cafe.phone || 'رقم الهاتف'}.`,
  },
  unknown: {
    en: (cafe) => `I do not have an exact answer for that yet. Please contact us at ${cafe.phone || 'our contact number'}, and I can still help with the menu, prices, hours, or location.`,
    ar: (cafe) => `لا أملك إجابة دقيقة على هذا السؤال حالياً. تواصل معنا على ${cafe.phone || 'رقم التواصل'}، وما زلت أقدر أساعدك في القائمة أو الأسعار أو المواعيد أو الموقع.`,
  },
  error: {
    en: (cafe) => `Something went wrong. Please contact us at ${cafe?.phone || 'our contact number'}.`,
    ar: (cafe) => `حصل خطأ تقني. تواصل معنا على ${cafe?.phone || 'رقم التواصل'}.`,
  },
};

module.exports = { PATTERNS, RESPONSES, pick };
