'use strict';

const { RESPONSES } = require('./patterns');

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildResponse(intentResult, lang, cafe) {
  const locale = lang === 'ar' ? 'ar' : 'en';
  const suggestions = parseArray(cafe[`suggestions_${locale}`]);
  const payload = {
    text: '',
    type: 'text',
    buttons: [],
    suggestions: [],
    context_update: {},
  };

  switch (intentResult.intent) {
    case 'greeting_hello':
      payload.text = RESPONSES.greeting_hello[locale](cafe);
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_how_are_you':
      payload.text = RESPONSES.greeting_how_are_you[locale](cafe);
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'greeting_yasta':
      payload.text = RESPONSES.greeting_yasta[locale](cafe);
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'thanks':
      payload.text = RESPONSES.thanks[locale]();
      payload.suggestions = suggestions.slice(0, 3);
      break;
    case 'help':
      payload.text = RESPONSES.help[locale]();
      payload.suggestions = suggestions.slice(0, 4);
      break;
    case 'menu_general':
      payload.text = RESPONSES.menu_general[locale]();
      if (cafe.menu_link) {
        payload.type = 'menu_button';
        payload.buttons.push({
          label: locale === 'ar' ? 'فتح القائمة' : 'Open menu',
          url: cafe.menu_link,
          target: '_blank',
        });
      }
      break;
    case 'item_found':
      payload.text = RESPONSES.item_found[locale](intentResult.item);
      payload.suggestions = locale === 'ar'
        ? ['السعر', 'الأحجام', 'فتح القائمة']
        : ['Price', 'Sizes', 'Open menu'];
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = locale === 'ar'
        ? intentResult.item.category_ar || intentResult.item.category_en || null
        : intentResult.item.category_en || intentResult.item.category_ar || null;
      break;
    case 'item_sizes':
      payload.text = RESPONSES.item_sizes_context[locale](intentResult.item);
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = locale === 'ar'
        ? intentResult.item.category_ar || intentResult.item.category_en || null
        : intentResult.item.category_en || intentResult.item.category_ar || null;
      break;
    case 'item_price':
      payload.text = RESPONSES.item_price_context[locale](intentResult.item);
      payload.context_update.last_item = intentResult.item.id;
      payload.context_update.last_category = locale === 'ar'
        ? intentResult.item.category_ar || intentResult.item.category_en || null
        : intentResult.item.category_en || intentResult.item.category_ar || null;
      break;
    case 'item_not_found':
      payload.text = RESPONSES.item_not_found[locale]();
      payload.suggestions = suggestions.slice(0, 3);
      if (cafe.menu_link) {
        payload.type = 'menu_button';
        payload.buttons.push({
          label: locale === 'ar' ? 'عرض القائمة' : 'View menu',
          url: cafe.menu_link,
          target: '_blank',
        });
      }
      break;
    case 'need_item_context':
      payload.text = RESPONSES.need_item_context[locale]();
      break;
    case 'category_items':
      payload.text = RESPONSES.category_items[locale](intentResult.category, intentResult.items);
      payload.context_update.last_category = intentResult.category;
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => locale === 'ar'
        ? item.name_ar || item.name_en
        : item.name_en || item.name_ar);
      break;
    case 'item_disambiguation':
      payload.text = RESPONSES.item_disambiguation[locale](intentResult.items);
      payload.suggestions = intentResult.items.slice(0, 4).map((item) => locale === 'ar'
        ? item.name_ar || item.name_en
        : item.name_en || item.name_ar);
      break;
    case 'brand_info':
      payload.text = RESPONSES.brand_info[locale](cafe);
      break;
    case 'contact':
      payload.text = RESPONSES.contact[locale](cafe);
      break;
    case 'working_hours':
      payload.text = RESPONSES.working_hours[locale](cafe);
      break;
    case 'location':
      payload.text = RESPONSES.location[locale](cafe);
      break;
    case 'reservation':
      payload.text = RESPONSES.reservation[locale](cafe);
      break;
    case 'unknown':
    default:
      payload.text = RESPONSES.unknown[locale](cafe);
      payload.suggestions = suggestions.slice(0, 3);
      break;
  }

  return payload;
}

module.exports = { buildResponse };
