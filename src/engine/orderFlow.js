'use strict';

const { v4: uuidv4 } = require('uuid');

const db = require('../db/db');
const { normalize } = require('./detector');
const { getBusinessItems } = require('../brains/shared/catalogStore');
const { findScoredItems, uniqueById } = require('../brains/shared/matcher');

const ORDER_COMMAND_PREFIX = '__order__:';
const ACTIVE_ORDER_STATUSES = ['draft', 'awaiting_address', 'address_confirmation', 'pending'];

const getOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
const getLatestActiveOrderByPhone = db.prepare(`
  SELECT *
  FROM orders
  WHERE business_id = ?
    AND guest_phone = ?
    AND status IN ('draft', 'awaiting_address', 'address_confirmation', 'pending')
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
const cancelOrder = db.prepare(`
  UPDATE orders
  SET status = 'cancelled', updated_at = datetime('now')
  WHERE id = ?
`);
const listOrderItems = db.prepare(`
  SELECT id, order_id, service_item_id, title_en, title_ar, quantity, unit_price, currency
  FROM order_items
  WHERE order_id = ?
  ORDER BY id ASC
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
  en: [/^(yes|yeah|yep|sure|ok|okay|confirm|confirmed|confirm order|confirm address|go ahead|sounds good|do it)$/i, /^confirm (order|address)$/i],
  ar: [/^(نعم|ايوه|أيوه|اه|آه|أكيد|اكيد|تمام|موافق|ماشي|اوكي|أوكي|تم|تأكيد الطلب|تأكيد العنوان)$/i, /^تأكيد (الطلب|العنوان)$/i],
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
  ar: [/(اطلب|أطلب|عايز اطلب|عاوز اطلب|عايز أطلب|عاوز أطلب|حابب اطلب|بدي اطلب|بدي طلب|عايز عمل طلب|عاوز عمل طلب|طلب دليفري|توصيل|ابغى اطلب|ابغي اطلب)/],
};

function isCafeOrderingEnabled(business) {
  return String(business?.service_type || '') === 'cafe';
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
  const [action, rawItemId] = rest.split(':');
  const itemId = rawItemId ? Number(rawItemId) : null;
  return {
    action,
    itemId: Number.isFinite(itemId) ? itemId : null,
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

function buildChoiceButtons(lang, stage, hasItems) {
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
    return [
      {
        label: lang === 'ar' ? 'إلغاء الطلب' : 'Cancel',
        value: buildCommand('cancel'),
        style: 'danger',
      },
    ];
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

function buildUiState({ lang, stage, order, items, addressPreview }) {
  return {
    input_locked: stage === 'review' || stage === 'address_confirmation',
    choice_buttons: buildChoiceButtons(lang, stage, items.length > 0),
    address_preview: addressPreview || '',
    order_draft: order ? {
      order_id: order.id,
      status: order.status,
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
    .slice(0, 6)
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
  return recent.length ? recent : getFallbackSuggestions(businessId, lang);
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

function matchItemsForOrder({ text, lang, businessId, context = {} }) {
  const items = getBusinessItems(businessId);
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

function serializeOrderState({ lang, stage, order, items, context }) {
  const suggestions = stage === 'add_item' ? getOrderItemSuggestions(context, order.business_id, lang) : [];
  const addressPreview = stage === 'address_confirmation' ? context?.order_flow?.pending_address || '' : '';
  return {
    suggestions,
    ui_state: buildUiState({ lang, stage, order, items, addressPreview }),
  };
}

function getExistingPhoneStatus(businessId, phone, sessionId) {
  return Boolean(hasPreviousPhoneActivity.get(businessId, phone, sessionId));
}

function startOrderFlow({ business, session, context, lang, seedItems = [] }) {
  const nextContext = normalizeOrderContext(context);
  const existingOrder = getLatestActiveOrderByPhone.get(business.id, session.guest_phone);

  if (existingOrder) {
    attachOrderToSession.run(session.id, session.guest_name || existingOrder.guest_name, session.guest_phone, existingOrder.id);
    const items = getOrderItems(existingOrder.id);
    const stage = items.length ? 'review' : 'add_item';
    const updatedContext = setOrderContext(nextContext, {
      order_id: existingOrder.id,
      stage,
      pending_address: '',
    });

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
        ...serializeOrderState({ lang, stage, order: existingOrder, items, context: updatedContext }),
      },
      intent: 'order_existing',
    };
  }

  const orderId = createOrderId();
  createOrder.run(orderId, business.id, session.id, session.guest_name || '', session.guest_phone);

  if (seedItems.length) {
    addItemsToOrder(orderId, seedItems);
  }

  const order = getOrderById.get(orderId);
  const items = getOrderItems(orderId);
  const stage = items.length ? 'review' : 'add_item';
    const updatedContext = setOrderContext(mergeRecentItemsIntoContext(nextContext, seedItems), {
      order_id: orderId,
      stage,
      pending_address: '',
    });

  const responseText = items.length
    ? buildReviewMessage({ lang, order, items, existingOrder: false })
    : buildAddItemMessage({ lang, order, hasItems: false });

  return {
    phase: stage === 'review' ? 'order_review' : 'order_add_item',
    context: updatedContext,
    response: {
      text: responseText,
      type: 'text',
      buttons: [],
      ...serializeOrderState({ lang, stage, order, items, context: updatedContext }),
    },
    intent: 'order_started',
  };
}

function resolveOrderUiState({ business, session, context, lang }) {
  if (!isCafeOrderingEnabled(business)) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  if (!String(session.phase || '').startsWith('order_')) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  const orderId = context?.order_flow?.order_id;
  if (!orderId) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  const order = getOrderById.get(orderId);
  if (!order || !ACTIVE_ORDER_STATUSES.includes(order.status)) {
    return {
      ui_state: emptyUiState(),
      suggestions: [],
    };
  }

  const items = getOrderItems(order.id);
  if (session.phase === 'order_review') {
    return serializeOrderState({ lang, stage: 'review', order, items, context });
  }
  if (session.phase === 'order_add_item') {
    return serializeOrderState({ lang, stage: 'add_item', order, items, context });
  }
  if (session.phase === 'order_address') {
    return serializeOrderState({ lang, stage: 'address', order, items, context });
  }
  if (session.phase === 'order_address_confirm') {
    return serializeOrderState({ lang, stage: 'address_confirmation', order, items, context });
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
          ...serializeOrderState({ lang, stage: 'add_item', order, items, context: updatedContext }),
        },
        intent: 'order_add_more',
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

  const items = getOrderItems(order.id);

  if (session.phase === 'order_review') {
    if (orderCommand && ['inc', 'dec', 'remove'].includes(orderCommand.action)) {
      if (order.status === 'pending') {
        updateOrderStatus.run('draft', order.id);
      }
      const nextItems = applyOrderItemCommand(order.id, orderCommand);
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
            }),
          },
          intent: 'order_empty_after_edit',
          skipUserMessage: true,
          skipBotMessage: false,
        };
      }

      const updatedContext = setOrderContext(normalizedContext, { stage: 'review' });
      return {
        phase: 'order_review',
        context: updatedContext,
        response: {
          text: '',
          type: 'text',
          buttons: [],
          ...serializeOrderState({
            lang,
            stage: 'review',
            order: getOrderById.get(order.id),
            items: nextItems,
            context: updatedContext,
          }),
        },
        intent: 'order_item_updated',
        skipUserMessage: true,
        skipBotMessage: true,
      };
    }

    if (isYesText(text, lang) || (orderCommand && orderCommand.action === 'confirm')) {
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
        ...serializeOrderState({ lang, stage: 'review', order, items, context: normalizedContext }),
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
          ...serializeOrderState({ lang, stage: 'add_item', order, items, context: normalizedContext }),
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
        ...serializeOrderState({ lang, stage: 'review', order: getOrderById.get(order.id), items: nextItems, context: updatedContext }),
      },
      intent: 'order_items_added',
      skipUserMessage: false,
      skipBotMessage: false,
    };
  }

  if (session.phase === 'order_address') {
    const address = String(text || '').trim();
    if (address.length < 6) {
      return {
        phase: 'order_address',
        context: normalizedContext,
        response: {
          text: buildValidAddressMessage({ lang }),
          type: 'text',
          buttons: [],
          ...serializeOrderState({ lang, stage: 'address', order, items, context: normalizedContext }),
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
          order,
          items,
          context: normalizedContext,
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
  isCafeOrderingEnabled,
  isInternalOrderCommand,
  looksLikeOrderIntent,
  getExistingPhoneStatus,
  startOrderFlow,
  handleOrderMessage,
  resolveOrderUiState,
  matchItemsForOrder,
};
