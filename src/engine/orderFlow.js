'use strict';

const { v4: uuidv4 } = require('uuid');

const db = require('../db/db');
const { normalize } = require('./detector');
const { getBusinessItems } = require('../brains/shared/catalogStore');
const { findScoredItems, uniqueById } = require('../brains/shared/matcher');

const ORDER_COMMAND_PREFIX = '__order__:';
const ACTIVE_ORDER_STATUSES = ['draft', 'awaiting_address', 'awaiting_details', 'address_confirmation', 'pending'];

const getFrancoFlag = db.prepare('SELECT franco_enabled FROM businesses WHERE id = ?');
// Franco/Arabizi recovery is on unless the business row explicitly disables it
// (column defaults to 1, so a missing row/flag is treated as enabled).
function isFrancoEnabled(businessId) {
  const row = getFrancoFlag.get(businessId);
  return !row || Number(row.franco_enabled) !== 0;
}

const getOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
const getLatestActiveOrderByPhone = db.prepare(`
  SELECT *
  FROM orders
  WHERE business_id = ?
    AND guest_phone = ?
    AND status IN ('draft', 'awaiting_address', 'awaiting_details', 'address_confirmation', 'pending')
  ORDER BY updated_at DESC, created_at DESC
  LIMIT 1
`);
const createOrder = db.prepare(`
  INSERT INTO orders (id, business_id, session_id, guest_name, guest_phone, status)
  VALUES (?, ?, ?, ?, ?, 'draft')
`);
const attachOrderToSession = db.prepare(`
  UPDATE orders
  SET session_id = ?, guest_name = ?, guest_phone = ?, updated_at = datetime('now')
  WHERE id = ?
`);
const updateOrderStatus = db.prepare(`
  UPDATE orders
  SET status = ?, updated_at = datetime('now')
  WHERE id = ?
`);
const updateOrderAddressAndStatus = db.prepare(`
  UPDATE orders
  SET address = ?, status = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);
// E-commerce checkout: save the captured contact + country + note and confirm.
const updateOrderDetailsAndConfirm = db.prepare(`
  UPDATE orders
  SET guest_name = ?, guest_phone = ?, email = ?, country = ?, note = ?,
      status = 'pending', confirmed_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);
const cancelOrder = db.prepare(`
  UPDATE orders
  SET status = 'cancelled', updated_at = datetime('now')
  WHERE id = ?
`);
const listOrderItems = db.prepare(`
  SELECT id, order_id, service_item_id, title_en, title_ar, quantity, unit_price, currency
  FROM order_items
  WHERE order_id = ?
  ORDER BY id DESC
`);
const getOrderItemByServiceItem = db.prepare(`
  SELECT *
  FROM order_items
  WHERE order_id = ? AND service_item_id = ?
  LIMIT 1
`);
const insertOrderItem = db.prepare(`
  INSERT INTO order_items (order_id, service_item_id, title_en, title_ar, quantity, unit_price, currency)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateOrderItemQuantity = db.prepare(`
  UPDATE order_items
  SET quantity = ?, updated_at = datetime('now')
  WHERE id = ?
`);
const deleteOrderItemById = db.prepare('DELETE FROM order_items WHERE id = ?');
const hasPreviousPhoneActivity = db.prepare(`
  SELECT 1
  FROM sessions
  WHERE business_id = ?
    AND guest_phone = ?
    AND id != ?
  LIMIT 1
`);

const YES_PATTERNS = {
  en: [
    /^(yes|yeah|yep|sure|ok|okay|confirm|confirmed|confirm order|confirm address|go ahead|sounds good|do it)$/i,
    /^confirm (order|address)$/i,
    // Affirmative chips WE offer in the order-confirm prompt ("Yes, start the
    // order") plus their bare-verb form, so tapping our own button confirms.
    /^yes[,!.\s]+(start|place|open|make|do)\b/i,
    /^(start|place|open) the order$/i,
  ],
  ar: [
    /^(نعم|ايوه|أيوه|اه|آه|أكيد|اكيد|تمام|موافق|ماشي|اوكي|أوكي|تم|تأكيد الطلب|تأكيد العنوان)$/i,
    /^تأكيد (الطلب|العنوان)$/i,
    // Same for the Arabic chip "نعم، ابدأ الطلب" (yes, start the order) and the
    // bare "ابدأ/ابدا الطلب/الاوردر" a user types to confirm.
    /^نعم[،,]?\s*(ابدأ|ابدا|إبدأ|ابدأي|ابدئي)\s*(الطلب|الاوردر|الأوردر)$/,
    /^(ابدأ|ابدا|إبدأ|ابدأي|ابدئي)\s*(الطلب|الاوردر|الأوردر)$/,
  ],
};

const CANCEL_PATTERNS = {
  en: [/^(cancel|stop|exit|leave it|never mind|cancel order)$/i, /^cancel order$/i],
  ar: [/^(الغاء|إلغاء|وقف|خلاص|خليه|سيبها|الغي|إلغي|إلغاء الطلب|الغاء الطلب)$/i, /^(إلغاء|الغاء) الطلب$/i],
};

const ADD_MORE_PATTERNS = {
  en: [/^(add|add item|add another|add another item|add more|add more items)$/i, /^add another item$/i],
  ar: [/^(اضف|أضف|اضافة عنصر|إضافة عنصر|اضافة طلب|إضافة طلب|اضف عنصر|أضف عنصر|اضف عنصر اخر|أضف عنصر آخر|اضافة عنصر اخر|إضافة عنصر آخر)$/i, /^(إضافة|اضافة) عنصر آخر$/i],
};

const ORDER_INTENT_PATTERNS = {
  en: [/\b(order|place order|make order|i want to order|i wanna order|can i order|delivery order|take my order|checkout)\b/i],
  ar: [/(اطلب|أطلب|عايز اطلب|عاوز اطلب|عايز أطلب|عاوز أطلب|حابب اطلب|بدي اطلب|بدي طلب|عايز عمل طلب|عاوز عمل طلب|طلب دليفري|توصيل|ابغى اطلب|ابغي اطلب|اوردر|أوردر|الاوردر|الأوردر)/],
};

function isOrderingEnabled(business) {
  return ['cafe', 'ecommerce'].includes(String(business?.service_type || ''));
}

function looksLikeOrderIntent(text, lang) {
  const patterns = ORDER_INTENT_PATTERNS[lang] || ORDER_INTENT_PATTERNS.en;
  return patterns.some((pattern) => pattern.test(String(text || '').trim()));
}

function buildCommand(action, itemId) {
  return `${ORDER_COMMAND_PREFIX}${action}${itemId ? `:${itemId}` : ''}`;
}

function emptyUiState() {
  return {
    input_locked: false,
    choice_buttons: [],
    address_preview: '',
    order_draft: null,
  };
}

function parseOrderCommand(text) {
  const value = String(text || '').trim();
  if (!value.startsWith(ORDER_COMMAND_PREFIX)) return null;

  const rest = value.slice(ORDER_COMMAND_PREFIX.length);
  const colon1 = rest.indexOf(':');
  if (colon1 === -1) {
    return { action: rest, itemId: null, payload: null };
  }
  const action = rest.slice(0, colon1);
  const remainder = rest.slice(colon1 + 1);
  
  if (action === 'sync_cart' || action === 'add_item' || action === 'submit_details') {
    return { action, itemId: null, payload: remainder };
  }

  const colon2 = remainder.indexOf(':');
  const rawItemId = colon2 === -1 ? remainder : remainder.slice(0, colon2);
  const itemId = Number(rawItemId);
  return {
    action,
    itemId: Number.isFinite(itemId) ? itemId : null,
    payload: colon2 === -1 ? null : remainder.slice(colon2 + 1),
  };
}

function isInternalOrderCommand(text) {
  return Boolean(parseOrderCommand(text));
}

function isYesText(text, lang) {
  const patterns = YES_PATTERNS[lang] || YES_PATTERNS.en;
  return patterns.some((pattern) => pattern.test(String(text || '').trim()));
}

function isCancelText(text, lang) {
  const patterns = CANCEL_PATTERNS[lang] || CANCEL_PATTERNS.en;
  return patterns.some((pattern) => pattern.test(String(text || '').trim()));
}

function isAddMoreText(text, lang) {
  const patterns = ADD_MORE_PATTERNS[lang] || ADD_MORE_PATTERNS.en;
  return patterns.some((pattern) => pattern.test(String(text || '').trim()));
}

function getDisplayItemTitle(item, lang) {
  return lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar;
}

function getOrderSummaryLines(items, lang) {
  return items.map((item, index) => `${index + 1}. ${getDisplayItemTitle(item, lang)} x${item.quantity}`);
}

function getOrderSummaryText(items, lang) {
  if (!items.length) {
    return lang === 'ar' ? 'لا توجد عناصر في الطلب حتى الآن.' : 'No items in the order yet.';
  }
  return getOrderSummaryLines(items, lang).join('\n');
}

function createOrderId() {
  return Math.floor(100000000000 + Math.random() * 900000000000).toString();
}

function touchOrder(orderId) {
  db.prepare("UPDATE orders SET updated_at = datetime('now') WHERE id = ?").run(orderId);
}

function getOrderItems(orderId) {
  return listOrderItems.all(orderId);
}

function normalizeOrderContext(context) {
  const orderFlow = context?.order_flow && typeof context.order_flow === 'object' ? context.order_flow : {};
  return {
    ...context,
    order_flow: orderFlow,
  };
}

function buildChoiceButtons(lang, stage, hasItems, business) {
  if (stage === 'review') {
    const buttons = [
      {
        label: lang === 'ar' ? 'إلغاء الطلب' : 'Cancel',
        value: buildCommand('cancel'),
        style: 'danger',
      },
      {
        label: lang === 'ar' ? 'إضافة عنصر آخر' : 'Add another item',
        value: buildCommand('add_more'),
        style: 'secondary',
      },
    ];
    if (hasItems) {
      buttons.push({
        label: lang === 'ar' ? 'تأكيد الطلب' : 'Confirm order',
        value: buildCommand('confirm'),
        style: 'primary',
      });
    }
    return buttons;
  }

  if (stage === 'add_item') {
    return [
      {
        label: lang === 'ar' ? 'إلغاء الطلب' : 'Cancel',
        value: buildCommand('cancel'),
        style: 'danger',
      },
    ];
  }

  if (stage === 'address') {
    const buttons = [
      {
        label: lang === 'ar' ? 'إلغاء الطلب' : 'Cancel',
        value: buildCommand('cancel'),
        style: 'danger',
      },
    ];
    if (business && String(business.service_type || '') === 'ecommerce') {
      buttons.push({
        label: lang === 'ar' ? 'تخطي العنوان' : 'Skip Address',
        value: buildCommand('skip_address'),
        style: 'secondary',
      });
    }
    return buttons;
  }

  if (stage === 'address_confirmation') {
    return [
      {
        label: lang === 'ar' ? 'إلغاء الطلب' : 'Cancel',
        value: buildCommand('cancel'),
        style: 'danger',
      },
      {
        label: lang === 'ar' ? 'تعديل العنوان' : 'Rewrite address',
        value: buildCommand('rewrite_address'),
        style: 'secondary',
      },
      {
        label: lang === 'ar' ? 'تأكيد العنوان' : 'Confirm address',
        value: buildCommand('confirm_address'),
        style: 'primary',
      },
    ];
  }

  return [];
}

function buildUiState({ lang, stage, order, items, addressPreview, business }) {
  return {
    input_locked: stage !== 'address',
    choice_buttons: buildChoiceButtons(lang, stage, items.length > 0, business),
    address_preview: addressPreview || '',
    order_draft: order ? {
      order_id: order.id,
      status: order.status,
      address: order.address || '',
      // Prefilled contact/details for the e-commerce checkout wizard. Name/phone
      // come from the chat start (stored on the order at creation); editable.
      guest_name: order.guest_name || '',
      guest_phone: order.guest_phone || '',
      email: order.email || '',
      country: order.country || '',
      note: order.note || '',
      empty_label: lang === 'ar' ? 'الطلب فارغ حالياً' : 'This order is empty right now',
      items: items.map((item) => ({
        order_item_id: item.id,
        title: getDisplayItemTitle(item, lang),
        quantity: item.quantity,
        inc_value: buildCommand('inc', item.id),
        dec_value: buildCommand('dec', item.id),
        remove_value: buildCommand('remove', item.id),
      })),
    } : null,
  };
}

function getFallbackSuggestions(businessId, lang) {
  return getBusinessItems(businessId)
    .slice(0, 10)
    .map((item) => getDisplayItemTitle(item, lang))
    .filter(Boolean);
}

function getRecentItemSuggestions(context, businessId, lang) {
  const recentIds = Array.isArray(context?.recent_item_ids) ? context.recent_item_ids : [];
  const items = getBusinessItems(businessId);
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const recent = recentIds
    .slice(-10)
    .reverse()
    .map((id) => itemMap.get(id))
    .filter(Boolean)
    .map((item) => getDisplayItemTitle(item, lang));

  return uniqueById(recent.map((title, index) => ({ id: title || index, title })))
    .map((entry) => entry.title)
    .filter(Boolean)
    .slice(0, 10);
}

function getOrderItemSuggestions(context, businessId, lang) {
  const recent = getRecentItemSuggestions(context, businessId, lang);
  const fallback = getFallbackSuggestions(businessId, lang);
  const combined = [...recent, ...fallback];
  return [...new Set(combined)].slice(0, 10);
}

function setOrderContext(context, patch) {
  return {
    ...context,
    order_flow: {
      ...(context.order_flow || {}),
      ...patch,
    },
  };
}

function clearOrderContext(context) {
  const nextContext = { ...context };
  delete nextContext.order_flow;
  return nextContext;
}

function mergeRecentItemsIntoContext(context, items) {
  const recent = Array.isArray(context.recent_item_ids) ? context.recent_item_ids.slice() : [];
  items.forEach((item) => {
    if (!Number.isFinite(item?.id)) return;
    const existingIndex = recent.indexOf(item.id);
    if (existingIndex >= 0) {
      recent.splice(existingIndex, 1);
    }
    recent.push(item.id);
  });
  return {
    ...context,
    recent_item_ids: recent.slice(-10),
  };
}

function getMatchesForText(text, lang, items, context) {
  const normalizedText = normalize(text, lang);
  const seenTitles = new Set();
  const uniqueByTitle = (entries) => entries.filter((item) => {
    const key = normalize(item.title_en || item.title_ar || '', lang);
    if (!key || seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  const exactMatches = uniqueByTitle(items.filter((item) => {
    const variants = [item.title_en, item.title_ar]
      .map((value) => normalize(value || '', lang))
      .filter(Boolean);
    return variants.some((variant) => normalizedText.includes(variant));
  }));

  if (exactMatches.length) {
    return exactMatches.slice(0, 6);
  }

  const scored = findScoredItems({
    text,
    lang,
    items,
    context,
    getItemVariants: (item) => [item.title_en, item.title_ar],
    getCategoryVariants: (item) => [item.category_en, item.category_ar],
    getExtraVariants: (item) => [item.description_en, item.description_ar],
  });

  const strongMatches = uniqueByTitle(uniqueById(scored
    .filter((entry) => {
      const titles = [entry.item.title_en, entry.item.title_ar]
        .map((value) => normalize(value || '', lang))
        .filter(Boolean);
      return entry.score >= 10 || titles.some((title) => normalizedText.includes(title));
    })
    .map((entry) => entry.item)));

  if (strongMatches.length) {
    return strongMatches.slice(0, 6);
  }

  return uniqueByTitle(uniqueById(scored.slice(0, 3).map((entry) => entry.item)));
}

function matchItemsForOrder({ text, lang, businessId, context = {} }) {
  const items = getBusinessItems(businessId);
  if (!items.length) return [];

  const containsArabic = /[\u0600-\u06FF]/.test(text || '');
  const activeLang = containsArabic ? 'ar' : (lang || 'en');

  // Try matching original text first
  let matches = getMatchesForText(text, activeLang, items, context);
  if (matches.length) {
    return matches;
  }

  // 1. Try explicit Arabic-to-English literal translation
  if (activeLang === 'ar') {
    const { translateArabicToEnglish } = require('./translation');
    const translatedDictText = translateArabicToEnglish(text);
    if (translatedDictText !== text) {
      matches = getMatchesForText(translatedDictText, 'en', items, context);
      if (matches.length) return matches;
    }
  }

  // 2. Try algorithmic Franco-Arabic phonetic recovery
  // Only run if the text actually contains Franco (Latin) letters/digits AND
  // the business hasn't disabled Franco recovery.
  if (/[a-zA-Z0-9]/.test(text) && isFrancoEnabled(businessId)) {
    const { recoverFranco } = require('./franco');
    const francoText = recoverFranco(text, items);
    if (francoText && francoText !== text) {
      matches = getMatchesForText(francoText, 'en', items, context);
      if (matches.length) return matches;
    }
  }

  // 3. Try standard query recovery (Levenshtein)
  const { recoverUserQuery } = require('./queryRecovery');
  const recoveredText = recoverUserQuery(text, activeLang, businessId);
  if (recoveredText && recoveredText !== text) {
    matches = getMatchesForText(recoveredText, activeLang, items, context);
    if (matches.length) return matches;
  }

  return [];
}

function addItemsToOrder(orderId, itemsToAdd) {
  itemsToAdd.forEach((item) => {
    const existing = getOrderItemByServiceItem.get(orderId, item.id);
    if (existing) {
      updateOrderItemQuantity.run(Number(existing.quantity || 0) + 1, existing.id);
    } else {
      insertOrderItem.run(
        orderId,
        item.id,
        item.title_en || item.title_ar || 'Item',
        item.title_ar || item.title_en || '',
        1,
        item.price ?? null,
        item.currency || 'EGP'
      );
    }
  });
  touchOrder(orderId);
}

function applyOrderItemCommand(orderId, command) {
  const items = getOrderItems(orderId);
  const target = items.find((item) => item.id === command.itemId);
  if (!target) {
    return getOrderItems(orderId);
  }

  if (command.action === 'inc') {
    updateOrderItemQuantity.run(Number(target.quantity || 0) + 1, target.id);
  } else if (command.action === 'dec') {
    const nextQuantity = Number(target.quantity || 0) - 1;
    if (nextQuantity <= 0) {
      deleteOrderItemById.run(target.id);
    } else {
      updateOrderItemQuantity.run(nextQuantity, target.id);
    }
  } else if (command.action === 'remove') {
    deleteOrderItemById.run(target.id);
  }

  touchOrder(orderId);
  return getOrderItems(orderId);
}

function buildReviewMessage({ lang, order, items, existingOrder }) {
  const intro = existingOrder
    ? (lang === 'ar'
      ? `لديك طلب مفتوح بالفعل برقم ${order.id}، لذلك سنكمل عليه ونعدله معاً.`
      : `You already have an open order with us, so we will update order ${order.id} instead of creating a new one.`)
    : (lang === 'ar'
      ? `تم إنشاء طلبك برقم ${order.id}.`
      : `Your order has been created with ID ${order.id}.`);

  return [
    intro,
    '',
    lang === 'ar' ? 'العناصر الحالية:' : 'Current items:',
    getOrderSummaryText(items, lang),
    '',
    lang === 'ar'
      ? 'يمكنك تعديل الكميات من الأزرار، أو إضافة عنصر آخر، أو تأكيد الطلب.'
      : 'You can adjust quantities with the buttons, add another item, or confirm the order.',
  ].join('\n');
}

function buildAddItemMessage({ lang, order, hasItems }) {
  if (hasItems) {
    return lang === 'ar'
      ? `حاضر. اكتب اسم العنصر الذي تريد إضافته إلى الطلب ${order.id}، أو اختر من الاقتراحات الجاهزة.`
      : `Sure. Send the next item you want to add to order ${order.id}, or pick one of the ready suggestions.`;
  }

  return lang === 'ar'
    ? `تم فتح طلب جديد برقم ${order.id}. اكتب العنصر الذي تريد طلبه، أو اختر من العناصر التي تحدثنا عنها قبل قليل.`
    : `I opened a new order for you with ID ${order.id}. Send the item you want to order, or pick from the items we talked about a moment ago.`;
}

function buildAddressPrompt({ lang, order }) {
  return lang === 'ar'
    ? `تمام. أرسل عنوان التوصيل الكامل لطلب ${order.id}.`
    : `Perfect. Please send the full delivery address for order ${order.id}.`;
}

function buildAddressConfirmationMessage({ lang, address }) {
  return [
    lang === 'ar' ? 'هذا هو العنوان الذي استلمته:' : 'This is the address I received:',
    address,
    '',
    lang === 'ar' ? 'إذا كان صحيحاً اختر تأكيد العنوان أو اختر إلغاء الطلب.' : 'If it is correct, choose Confirm address or Cancel.',
  ].join('\n');
}

// Prompt shown when an e-commerce order moves to the details wizard.
function buildDetailsPrompt({ lang }) {
  return lang === 'ar'
    ? 'تمام! بقي خطوة أخيرة — أكِّد بياناتك (الاسم والهاتف) وحدِّد الدولة لإتمام الطلب.'
    : 'Great! One last step — confirm your details (name & phone) and select your country to place the order.';
}

// E-commerce order confirmation: shows country + note instead of a delivery address.
function buildEcomOrderCompleteMessage({ lang, order, items }) {
  return [
    lang === 'ar'
      ? `شكراً جداً. تم تأكيد طلبك بنجاح برقم ${order.id}.`
      : `Thank you very much. Your order ${order.id} has been confirmed successfully.`,
    '',
    `${lang === 'ar' ? 'الاسم:' : 'Name:'} ${order.guest_name || '-'}`,
    `${lang === 'ar' ? 'الهاتف:' : 'Phone:'} ${order.guest_phone || '-'}`,
    order.email ? `${lang === 'ar' ? 'الإيميل:' : 'Email:'} ${order.email}` : null,
    `${lang === 'ar' ? 'الدولة:' : 'Country:'} ${order.country || '-'}`,
    order.note ? `${lang === 'ar' ? 'ملاحظة:' : 'Note:'} ${order.note}` : null,
    '',
    lang === 'ar' ? 'تفاصيل الطلب:' : 'Order details:',
    getOrderSummaryText(items, lang),
    '',
    lang === 'ar'
      ? 'سنتواصل معك قريباً لتأكيد التفاصيل والتسعير.'
      : 'We will contact you shortly to confirm details and pricing.',
  ].filter((line) => line !== null).join('\n');
}

function buildOrderCompleteMessage({ lang, order, items, address }) {
  return [
    lang === 'ar'
      ? `شكراً جداً. تم تأكيد طلبك بنجاح برقم ${order.id}.`
      : `Thank you very much. Your order ${order.id} has been confirmed successfully.`,
    '',
    lang === 'ar' ? 'العنوان:' : 'Address:',
    address,
    '',
    lang === 'ar' ? 'تفاصيل الطلب:' : 'Order details:',
    getOrderSummaryText(items, lang),
    '',
    lang === 'ar'
      ? 'إذا احتجت أي شيء آخر أنا هنا معك.'
      : 'If you need anything else, I am here for you.',
  ].join('\n');
}

function buildOrderCancelledMessage({ lang }) {
  return lang === 'ar'
    ? 'تم إلغاء الطلب والعودة إلى الدردشة العادية. إذا أردت نبدأ طلباً جديداً في أي وقت.'
    : 'The order was cancelled and we are back to the normal chat. If you want, we can start a new order any time.';
}

function buildOrderItemNotFoundMessage({ lang }) {
  return lang === 'ar'
    ? 'لم أتعرف على هذا العنصر بشكل واضح. اكتب اسم الصنف كما في القائمة أو اختر واحداً من الاقتراحات.'
    : 'I could not match that item clearly. Please send the menu item name or choose one of the ready suggestions.';
}

function buildLockedChoiceMessage({ lang }) {
  return lang === 'ar'
    ? 'اختر واحداً من الخيارات الظاهرة حتى أكمل معك الطلب بشكل صحيح.'
    : 'Please choose one of the visible options so I can continue the order correctly.';
}

function buildValidAddressMessage({ lang }) {
  return lang === 'ar'
    ? 'من فضلك أرسل عنواناً أوضح للتوصيل قبل أن أكمل الطلب.'
    : 'Please send a clearer delivery address before I continue the order.';
}

function serializeOrderState({ lang, stage, order, items, context, business }) {
  const suggestions = (stage === 'add_item' || stage === 'review') ? getOrderItemSuggestions(context, order.business_id, lang) : [];
  const addressPreview = stage === 'address_confirmation' ? context?.order_flow?.pending_address || '' : '';
  return {
    suggestions,
    ui_state: buildUiState({ lang, stage, order, items, addressPreview, business }),
  };
}

function getExistingPhoneStatus(businessId, phone, sessionId) {
  return Boolean(hasPreviousPhoneActivity.get(businessId, phone, sessionId));
}

function startOrderFlow({ business, session, context, lang, seedItems = [], seedAll = false }) {
  const nextContext = normalizeOrderContext(context);
  const existingOrder = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);

  // If the customer named an item in the same breath as the order intent
  // ("عايز اطلب ماية"), auto-add it so the order opens with the item already
  // inside and we jump straight to review. A plain text match is ambiguous, so
  // we add only the TOP candidate — but a precise set resolved from a back-
  // reference ("an order with them" -> the 2 items we recommended) is seedAll,
  // and every one of those is intended, so add them all.
  const validSeeds = seedItems.filter((item) => Number.isFinite(item?.id));
  const seedsToAdd = seedAll ? validSeeds : (validSeeds.length ? [validSeeds[0]] : []);
  const hasSeed = seedsToAdd.length > 0;

  if (existingOrder) {
    attachOrderToSession.run(session.id, session.guest_name || existingOrder.guest_name, session.guest_phone, existingOrder.id);
    if (hasSeed) {
      addItemsToOrder(existingOrder.id, seedsToAdd);
    }
    const items = getOrderItems(existingOrder.id);
    const stage = items.length ? 'review' : 'add_item';
    const updatedContext = setOrderContext(
      hasSeed ? mergeRecentItemsIntoContext(nextContext, seedsToAdd) : nextContext,
      {
        order_id: existingOrder.id,
        stage,
        pending_address: '',
      }
    );

    const responseText = items.length
      ? buildReviewMessage({ lang, order: existingOrder, items, existingOrder: true })
      : buildAddItemMessage({ lang, order: existingOrder, hasItems: false });

    return {
      phase: stage === 'review' ? 'order_review' : 'order_add_item',
      context: updatedContext,
      response: {
        text: responseText,
        type: 'text',
        buttons: [],
        ...serializeOrderState({ lang, stage, order: existingOrder, items, context: updatedContext, business }),
      },
      intent: 'order_existing',
    };
  }

  const orderId = createOrderId();
  createOrder.run(orderId, business.id, session.id, session.guest_name || '', session.guest_phone);
  const order = getOrderById.get(orderId);

  // Fresh order with a named item ("عايز اطلب ماية") or a resolved back-reference
  // ("an order with them"): add the seed item(s) and jump straight to review so
  // the customer can adjust quantity, add more, or confirm.
  if (hasSeed) {
    addItemsToOrder(orderId, seedsToAdd);
    const items = getOrderItems(orderId);
    const stage = 'review';
    const updatedContext = setOrderContext(
      mergeRecentItemsIntoContext(nextContext, seedsToAdd),
      { order_id: orderId, stage, pending_address: '' }
    );
    return {
      phase: 'order_review',
      context: updatedContext,
      response: {
        text: buildReviewMessage({ lang, order, items, existingOrder: false }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({ lang, stage, order, items, context: updatedContext, business }),
      },
      intent: 'order_started',
    };
  }

  // No item named — open an empty order and ask what they want.
  const items = getOrderItems(orderId); // always empty for a new order
  const stage = 'add_item';
  const updatedContext = setOrderContext(nextContext, {
    order_id: orderId,
    stage,
    pending_address: '',
  });

  // Build suggestion labels from seedItems so the user can tap them to add
  const seedSuggestions = seedItems
    .map((item) => (lang === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar))
    .filter(Boolean);

  const orderState = serializeOrderState({ lang, stage, order, items, context: updatedContext, business });

  return {
    phase: 'order_add_item',
    context: updatedContext,
    response: {
      text: buildAddItemMessage({ lang, order, hasItems: false }),
      type: 'text',
      buttons: [],
      ...orderState,
      // Override suggestions with the seed item names so user can tap them
      suggestions: seedSuggestions.length ? seedSuggestions : (orderState.suggestions || []),
    },
    intent: 'order_started',
  };
}

function resolveOrderUiState({ business, session, context, lang }) {
  if (!isOrderingEnabled(business)) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  if (Number(session.automated) === 0) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  let orderId = context?.order_flow?.order_id;
  let order = null;
  if (orderId) {
    order = getOrderById.get(orderId);
  } else if (session.guest_phone) {
    order = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);
  }

  if (!order || !ACTIVE_ORDER_STATUSES.includes(order.status)) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  const items = getOrderItems(order.id);

  if (!String(session.phase || '').startsWith('order_')) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  if (order.status === 'pending') {
    return serializeOrderState({ lang, stage: 'pending', order, items, context, business });
  }

  if (session.phase === 'order_review') {
    return serializeOrderState({ lang, stage: 'review', order, items, context, business });
  }
  if (session.phase === 'order_add_item') {
    return serializeOrderState({ lang, stage: 'add_item', order, items, context, business });
  }
  if (session.phase === 'order_address') {
    return serializeOrderState({ lang, stage: 'address', order, items, context, business });
  }
  if (session.phase === 'order_details') {
    return serializeOrderState({ lang, stage: 'details', order, items, context, business });
  }
  if (session.phase === 'order_address_confirm') {
    return serializeOrderState({ lang, stage: 'address_confirmation', order, items, context, business });
  }

  return {
    ui_state: emptyUiState(),
    suggestions: [],
  };
}

function handleOrderMessage({ text, business, session, context, lang }) {
  const normalizedContext = normalizeOrderContext(context);
  const orderCommand = parseOrderCommand(text);
  let orderId = normalizedContext.order_flow?.order_id;
  let order = orderId ? getOrderById.get(orderId) : null;

  // Global Cancel Handling (Even if order ID is missing from context, try to find it by phone)
  if (isCancelText(text, lang) || (orderCommand && orderCommand.action === 'cancel')) {
    if (!order) {
      order = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);
    }

    if (order) {
      cancelOrder.run(order.id);
      return {
        phase: 'active',
        context: clearOrderContext(normalizedContext),
        response: {
          text: buildOrderCancelledMessage({ lang }),
          type: 'text',
          buttons: [],
          suggestions: [],
          ui_state: emptyUiState(),
        },
        intent: 'order_cancelled',
      };
    }

    // No order found at all to cancel
    return {
      phase: 'active',
      context: clearOrderContext(normalizedContext),
      response: {
        text: lang === 'ar' ? 'لا يوجد طلب مفتوح لإلغائه حالياً.' : 'There is no open order to cancel right now.',
        type: 'text',
        buttons: [],
        suggestions: [],
        ui_state: emptyUiState(),
      },
      intent: 'order_cancel_missing',
    };
  }

  // Global Add More Handling
  if (isAddMoreText(text, lang) || (orderCommand && orderCommand.action === 'add_more')) {
    if (!order) {
      order = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);
    }
    if (order) {
      const items = getOrderItems(order.id);
      const updatedContext = setOrderContext(normalizedContext, { order_id: order.id, stage: 'add_item' });
      return {
        phase: 'order_add_item',
        context: updatedContext,
        response: {
          text: buildAddItemMessage({ lang, order, hasItems: items.length > 0 }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'add_item', order, items, context: updatedContext, business }),
        },
        intent: 'order_add_more',
      };
    }
  }

  // Atomic Add Item: unlock + match + add in a single request, regardless of the
  // current stage (review or add_item). The widget uses this for instant "tap to
  // add" so it doesn't need the two-request add_more -> title handshake. Returns
  // no bot text (skipBotMessage) so adding an item stays silent.
  if (orderCommand && orderCommand.action === 'add_item') {
    if (!order) {
      order = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);
    }
    if (order) {
      const itemTitle = String(orderCommand.payload || '').trim();
      const matchedItems = itemTitle
        ? matchItemsForOrder({ text: itemTitle, lang, businessId: business.id, context: normalizedContext })
        : [];

      if (!matchedItems.length) {
        const currentItems = getOrderItems(order.id);
        const stage = currentItems.length ? 'review' : 'add_item';
        const updatedContext = setOrderContext(normalizedContext, { order_id: order.id, stage });
        return {
          phase: currentItems.length ? 'order_review' : 'order_add_item',
          context: updatedContext,
          response: {
            text: '',
            type: 'text',
            buttons: [],
            ...serializeOrderState({ lang, stage, order: getOrderById.get(order.id), items: currentItems, context: updatedContext, business }),
          },
          intent: 'order_item_not_found',
          skipUserMessage: true,
          skipBotMessage: true,
        };
      }

      if (order.status === 'pending') {
        updateOrderStatus.run('draft', order.id);
      }
      const bestMatch = matchedItems[0];
      addItemsToOrder(order.id, [bestMatch]);

      const nextItems = getOrderItems(order.id);
      const updatedContext = setOrderContext(
        mergeRecentItemsIntoContext(normalizedContext, [bestMatch]),
        { order_id: order.id, stage: 'review' }
      );
      return {
        phase: 'order_review',
        context: updatedContext,
        response: {
          text: '',
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'review', order: getOrderById.get(order.id), items: nextItems, context: updatedContext, business }),
        },
        intent: 'order_item_added',
        skipUserMessage: true,
        skipBotMessage: true,
      };
    }
  }

  // Handle "Rewrite Address"
  if (orderCommand && orderCommand.action === 'rewrite_address') {
    if (order) {
      const items = getOrderItems(order.id);
      const updatedContext = setOrderContext(normalizedContext, {
        stage: 'address',
        pending_address: '',
      });
      updateOrderStatus.run('awaiting_address', order.id);
      return {
        phase: 'order_address',
        context: updatedContext,
        response: {
          text: buildAddressPrompt({ lang, order }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({
            lang,
            stage: 'address',
            order,
            items,
            context: updatedContext,
            business,
          }),
        },
        intent: 'order_address_rewrite',
      };
    }
  }

  if (!order) {
    return {
      phase: 'active',
      context: clearOrderContext(normalizedContext),
      response: {
        text: lang === 'ar'
          ? 'لا يوجد طلب مفتوح الآن، لذلك رجعت بك إلى الدردشة العادية.'
          : 'There is no open order right now, so I moved you back to the normal chat.',
        type: 'text',
        buttons: [],
        suggestions: [],
        ui_state: emptyUiState(),
      },
      intent: 'order_missing',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  let items = getOrderItems(order.id);

  // Handle cart edit commands (inc, dec, remove, sync_cart) globally across all stages
  if (orderCommand && (['inc', 'dec', 'remove'].includes(orderCommand.action) || orderCommand.action === 'sync_cart')) {
    if (order.status === 'pending') {
      updateOrderStatus.run('draft', order.id);
    }

    let nextItems = [];
    if (orderCommand.action === 'sync_cart') {
      try {
        const newCart = JSON.parse(orderCommand.payload || '[]');
        const currentItems = getOrderItems(order.id);

        for (const current of currentItems) {
          const found = newCart.find(i => Number(i.id) === current.id);
          if (!found || found.qty <= 0) {
            deleteOrderItemById.run(current.id);
          } else if (found.qty !== current.quantity) {
            updateOrderItemQuantity.run(found.qty, current.id);
          }
        }
      } catch (e) {}
      nextItems = getOrderItems(order.id);
    } else {
      nextItems = applyOrderItemCommand(order.id, orderCommand);
    }

    if (!nextItems.length) {
      const updatedContext = setOrderContext(normalizedContext, { stage: 'add_item' });
      return {
        phase: 'order_add_item',
        context: updatedContext,
        response: {
          text: buildAddItemMessage({ lang, order: getOrderById.get(order.id), hasItems: false }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({
            lang,
            stage: 'add_item',
            order: getOrderById.get(order.id),
            items: nextItems,
            context: updatedContext,
            business,
          }),
        },
        intent: 'order_empty_after_edit',
        skipUserMessage: true,
        skipBotMessage: false,
      };
    }

    const currentStage = session.phase === 'order_add_item' ? 'add_item' : 'review';
    const nextPhase = session.phase === 'order_add_item' ? 'order_add_item' : 'order_review';

    const updatedContext = setOrderContext(normalizedContext, { stage: currentStage });
    return {
      phase: nextPhase,
      context: updatedContext,
      response: {
        text: '',
        type: 'text',
        buttons: [],
        ...serializeOrderState({
          lang,
          stage: currentStage,
          order: getOrderById.get(order.id),
          items: nextItems,
          context: updatedContext,
          business,
        }),
      },
      intent: 'order_item_updated',
      skipUserMessage: true,
      skipBotMessage: true,
    };
  }

  // E-commerce checkout submit: the wizard sends all collected fields at once.
  if (orderCommand && orderCommand.action === 'submit_details' && order) {
    let details = {};
    try { details = JSON.parse(orderCommand.payload || '{}'); } catch {}
    const country = String(details.country || '').trim().slice(0, 80);
    const name = String(details.name || order.guest_name || '').trim().slice(0, 60);
    const phone = String(details.phone || order.guest_phone || '').trim().slice(0, 30);
    const email = String(details.email || '').trim().slice(0, 120);
    const note = String(details.note || '').trim().slice(0, 500);
    const detailItems = getOrderItems(order.id);

    // Country is the one required field; bounce back to the wizard without it.
    if (!country) {
      const updatedContext = setOrderContext(normalizedContext, { stage: 'details' });
      return {
        phase: 'order_details',
        context: updatedContext,
        response: {
          text: lang === 'ar' ? 'من فضلك حدّد الدولة لإتمام الطلب.' : 'Please select your country to place the order.',
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'details', order, items: detailItems, context: updatedContext, business }),
        },
        intent: 'order_details_invalid',
        skipUserMessage: true,
        skipBotMessage: false,
      };
    }

    updateOrderDetailsAndConfirm.run(name, phone, email, country, note, order.id);
    const refreshedOrder = getOrderById.get(order.id);

    return {
      phase: 'active',
      context: clearOrderContext(normalizedContext),
      response: {
        text: buildEcomOrderCompleteMessage({ lang, order: refreshedOrder, items: detailItems }),
        type: 'text',
        buttons: [],
        suggestions: [],
        ui_state: emptyUiState(),
      },
      intent: 'order_confirmed',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  if (session.phase === 'order_review') {
    if (isYesText(text, lang) || (orderCommand && orderCommand.action === 'confirm')) {
      // E-commerce skips the delivery-address flow entirely: it confirms contact
      // info and collects a required country + optional note via a wizard.
      if (String(business.service_type || '') === 'ecommerce') {
        const updatedContext = setOrderContext(normalizedContext, { stage: 'details' });
        updateOrderStatus.run('awaiting_details', order.id);
        return {
          phase: 'order_details',
          context: updatedContext,
          response: {
            text: buildDetailsPrompt({ lang }),
            type: 'text',
            buttons: [],
            ...serializeOrderState({
              lang,
              stage: 'details',
              order: getOrderById.get(order.id),
              items,
              context: updatedContext,
              business,
            }),
          },
          intent: 'order_details_requested',
          skipUserMessage: false,
          skipBotMessage: false,
        };
      }

      const updatedContext = setOrderContext(normalizedContext, {
        stage: 'address',
        pending_address: '',
      });
      updateOrderStatus.run('awaiting_address', order.id);
      return {
        phase: 'order_address',
        context: updatedContext,
        response: {
          text: buildAddressPrompt({ lang, order }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({
            lang,
            stage: 'address',
            order: getOrderById.get(order.id),
            items,
            context: updatedContext,
            business,
          }),
        },
        intent: 'order_address_requested',
        skipUserMessage: false,
        skipBotMessage: false,
      };
    }

    return {
      phase: 'order_review',
      context: normalizedContext,
      response: {
        text: buildLockedChoiceMessage({ lang }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({ lang, stage: 'review', order: getOrderById.get(order.id), items, context: normalizedContext, business }),
      },
      intent: 'order_review_locked',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  if (session.phase === 'order_add_item') {
    const matchedItems = matchItemsForOrder({
      text,
      lang,
      businessId: business.id,
      context: normalizedContext,
    });

    if (!matchedItems.length) {
      return {
        phase: 'order_add_item',
        context: normalizedContext,
        response: {
          text: buildOrderItemNotFoundMessage({ lang }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'add_item', order, items, context: normalizedContext, business }),
        },
        intent: 'order_item_not_found',
        skipUserMessage: false,
        skipBotMessage: false,
      };
    }

    // Auto-add the first (top) match
    const bestMatch = matchedItems[0];
    if (order.status === 'pending') {
      updateOrderStatus.run('draft', order.id);
    }
    addItemsToOrder(order.id, [bestMatch]);

    const nextItems = getOrderItems(order.id);
    const updatedContext = setOrderContext(mergeRecentItemsIntoContext(normalizedContext, [bestMatch]), { stage: 'review' });
    return {
      phase: 'order_review',
      context: updatedContext,
      response: {
        text: buildReviewMessage({ lang, order: getOrderById.get(order.id), items: nextItems, existingOrder: false }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({ lang, stage: 'review', order: getOrderById.get(order.id), items: nextItems, context: updatedContext, business }),
      },
      intent: 'order_items_added',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  // E-commerce details wizard is in the panel (input is locked); any stray text
  // just re-shows the wizard. The real submit comes via submit_details above.
  if (session.phase === 'order_details') {
    const detailItems = getOrderItems(order.id);
    return {
      phase: 'order_details',
      context: normalizedContext,
      response: {
        text: buildDetailsPrompt({ lang }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({ lang, stage: 'details', order, items: detailItems, context: normalizedContext, business }),
      },
      intent: 'order_details',
      skipUserMessage: false,
      skipBotMessage: true,
    };
  }

  if (session.phase === 'order_address') {
    if (orderCommand && orderCommand.action === 'skip_address') {
      const address = lang === 'ar' ? 'تخطي / لم يحدد' : 'Skipped / Not specified';
      updateOrderAddressAndStatus.run(address, 'pending', order.id);
      const refreshedOrder = getOrderById.get(order.id);
      const refreshedItems = getOrderItems(order.id);

      return {
        phase: 'active',
        context: clearOrderContext(normalizedContext),
        response: {
          text: buildOrderCompleteMessage({ lang, order: refreshedOrder, items: refreshedItems, address }),
          type: 'text',
          buttons: [],
          suggestions: [],
          ui_state: emptyUiState(),
        },
        intent: 'order_confirmed',
        skipUserMessage: false,
        skipBotMessage: false,
      };
    }

    const address = String(text || '').trim();
    if (address.length < 6) {
      return {
        phase: 'order_address',
        context: normalizedContext,
        response: {
          text: buildValidAddressMessage({ lang }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'address', order, items, context: normalizedContext, business }),
        },
        intent: 'order_invalid_address',
        skipUserMessage: false,
        skipBotMessage: false,
      };
    }

    const updatedContext = setOrderContext(normalizedContext, {
      stage: 'address_confirmation',
      pending_address: address.slice(0, 240),
    });
    updateOrderStatus.run('address_confirmation', order.id);

    return {
      phase: 'order_address_confirm',
      context: updatedContext,
      response: {
        text: buildAddressConfirmationMessage({ lang, address: updatedContext.order_flow.pending_address }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({
          lang,
          stage: 'address_confirmation',
          order: getOrderById.get(order.id),
          items,
          context: updatedContext,
          business,
        }),
      },
      intent: 'order_address_confirmation',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  if (session.phase === 'order_address_confirm') {
    if (isYesText(text, lang) || (orderCommand && orderCommand.action === 'confirm_address')) {
      const address = normalizedContext.order_flow?.pending_address || order.address || '';
      updateOrderAddressAndStatus.run(address, 'pending', order.id);
      const refreshedOrder = getOrderById.get(order.id);
      const refreshedItems = getOrderItems(order.id);

      return {
        phase: 'active',
        context: clearOrderContext(normalizedContext),
        response: {
          text: buildOrderCompleteMessage({ lang, order: refreshedOrder, items: refreshedItems, address }),
          type: 'text',
          buttons: [],
          suggestions: [],
          ui_state: emptyUiState(),
        },
        intent: 'order_confirmed',
        skipUserMessage: false,
        skipBotMessage: false,
      };
    }

    return {
      phase: 'order_address_confirm',
      context: normalizedContext,
      response: {
        text: buildLockedChoiceMessage({ lang }),
        type: 'text',
        buttons: [],
        ...serializeOrderState({
          lang,
          stage: 'address_confirmation',
          order: getOrderById.get(order.id),
          items,
          context: normalizedContext,
          business,
        }),
      },
      intent: 'order_address_locked',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  return null;
}

module.exports = {
  isOrderingEnabled,
  isInternalOrderCommand,
  looksLikeOrderIntent,
  isYesText,
  isCancelText,
  getExistingPhoneStatus,
  startOrderFlow,
  handleOrderMessage,
  resolveOrderUiState,
  matchItemsForOrder,
};
