(function () {
  const script = document.currentScript;
  if (!script) return;

  const scriptUrl = new URL(script.src, window.location.href);
  const config = window.ChatbotConfig || {};
  const token = config.token || scriptUrl.searchParams.get('token');
  const backendUrl = (config.backendUrl || scriptUrl.origin).replace(/\/$/, '');
  const storageKey = `guest_chat:${token || 'missing'}`;

  if (!token) return;

  window.__eglotechWidgetLoaded = window.__eglotechWidgetLoaded || new Set();
  if (window.__eglotechWidgetLoaded.has(token)) return;
  window.__eglotechWidgetLoaded.add(token);

  const state = {
    sessionKey: null,
    language: 'en',
    cafe: null,
    automated: true,
    open: false,
    typingEl: null,
    hasHistory: false,
    history: [],
    currentSuggestions: [],
    orderSuggestions: [],
    chitchatSuggestions: [],
    orderDashboardActive: false,
    searchDebounceTimer: null,
    isSearching: false,
    searchResults: [],
    searchQuery: '',
    typedAddress: '',
    confirmCancelActive: false,
    confirmDeleteItem: null,
    uiState: {
      input_locked: false,
      choice_buttons: [],
      address_preview: '',
      order_draft: null,
    },
    pollTimer: null,
    isSending: false,
    isTypingReply: false,
    lastRequestTime: 0,
    typingId: 0,
    cartSyncPending: false,
    lastCartEditTime: 0,
    orderInputMode: null,
  };

  let refs;
  let cartSyncTimer = null;

  // Serialize cart mutations as WHOLE operations. Adding an item is a two-request
  // handshake (add_more -> title, because the server rejects bare titles while in
  // the review phase). If taps overlap, those requests interleave on the shared
  // server session — add_more/add_more/title/title — and the second title lands
  // in the wrong phase, so the wrong item (or no item) is added. Queuing each
  // tap's full handshake as one unit guarantees a tap completes before the next
  // one starts. Cart sync goes through the same queue so it can't slip between a
  // handshake's two requests either.
  let cartOpQueue = Promise.resolve();
  function enqueueCartOp(op) {
    const task = cartOpQueue.catch(() => {}).then(op);
    cartOpQueue = task.catch(() => {});
    return task;
  }

  function scheduleCartSync(orderDraft) {
    if (cartSyncTimer) clearTimeout(cartSyncTimer);
    cartSyncTimer = setTimeout(() => {
      enqueueCartOp(async () => {
        if (!orderDraft || !orderDraft.items) return;
        const items = orderDraft.items.map(i => ({ id: i.order_item_id, qty: i.quantity }));
        await sendMessage({ value: `__order__:sync_cart:${JSON.stringify(items)}`, silent: true });
      });
    }, 800);
  }

  function emptyUiState() {
    return {
      input_locked: false,
      choice_buttons: [],
      address_preview: '',
      order_draft: null,
    };
  }

  function loadStoredSession() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (parsed.session_key) state.sessionKey = parsed.session_key;
    } catch {}
  }

  function persistSession() {
    localStorage.setItem(storageKey, JSON.stringify({ session_key: state.sessionKey }));
  }

  function clearStoredSession() {
    localStorage.removeItem(storageKey);
    state.sessionKey = null;
  }

  async function postJson(path, body) {
    const response = await fetch(`${backendUrl}${path}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'request_failed');
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function createStyles(colors) {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --cb-primary: ${colors.primary};
        --cb-text: #16221f;
        --cb-surface: #ffffff;
        --cb-border: rgba(16, 24, 40, 0.08);
      }
      .cb-root, .cb-root * { box-sizing: border-box; }
      .cb-root {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483000;
        font-family: "Segoe UI", Tahoma, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .cb-bubble {
        width: 68px;
        height: 68px;
        border: 0;
        border-radius: 999px;
        background: var(--cb-primary);
        color: #fff;
        box-shadow: 0 20px 45px rgba(0, 0, 0, 0.2);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        transition: transform 180ms ease, box-shadow 180ms ease;
      }
      .cb-bubble:hover { transform: translateY(-2px); }
      .cb-bubble.has-unread::before {
        content: "";
        position: absolute;
        top: 2px;
        right: 2px;
        width: 14px;
        height: 14px;
        background: #ff3b30;
        border: 2px solid #fff;
        border-radius: 50%;
        z-index: 10;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .cb-bubble-tip {
        display: none;
        transform: translateY(-30px) translateX(10px);
        position: absolute;
        right: 82px;
        width: 240px;
        max-width: calc(100vw - 120px);
        background: rgba(255, 255, 255, 0.68);
        -webkit-backdrop-filter: blur(14px) saturate(160%);
        backdrop-filter: blur(14px) saturate(160%);
        color: #1c2b27;
        border: 1px solid rgba(255, 255, 255, 0.55);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
        padding: 10px 14px;
        border-radius: 18px 18px 6px 18px;
        font-size: 13px;
        line-height: 1.4;
        opacity: 0.98;
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cb-bubble-tip.show {
        display: block;
      }
      .cb-bubble-tip.unread {
        border-color: var(--cb-primary);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2), 0 0 0 1px var(--cb-primary) inset;
        font-weight: 600;
      }
      .cb-panel {
        position: absolute;
        right: 0;
        bottom: 88px;
        width: min(390px, calc(100vw - 24px));
        height: min(560px, calc(100vh - 120px));
        background: #ffffff;
        backdrop-filter: blur(16px);
        border: 1px solid var(--cb-border);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.25);
        transform: translateY(24px) scale(0.96);
        opacity: 0;
        pointer-events: none;
        transition: transform 180ms ease, opacity 180ms ease;
        display: flex;
        flex-direction: column;
      }
      .cb-root.open .cb-panel {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }
      .cb-root.open .cb-bubble-tip { display: none; }
      .cb-header {
        padding: 18px 18px 14px;
        background: var(--cb-primary);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .cb-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      .cb-logo {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        object-fit: cover;
        background: rgba(255,255,255,0.18);
      }
      .cb-brand-text { min-width: 0; }
      .cb-brand-name {
        font-size: 15px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cb-brand-sub {
        font-size: 12px;
        opacity: 0.8;
      }
      .cb-close {
        width: 42px;
        height: 42px;
        border-radius: 999px;
        border: 0;
        background: rgba(255,255,255,0.14);
        color: #fff;
        cursor: pointer;
        font-size: 20px;
        font-weight: 700;
        line-height: 1;
      }
      .cb-messages {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .cb-msg {
        max-width: 86%;
        padding: 12px 14px;
        border-radius: 18px;
        white-space: pre-wrap;
        line-height: 1.45;
        font-size: 14px;
      }
      .cb-msg.bot {
        align-self: flex-start;
        background: #ffffff;
        color: var(--cb-text);
        border-bottom-left-radius: 6px;
        box-shadow: 0 10px 20px rgba(0, 0, 0, 0.08);
      }
      .cb-msg.user {
        align-self: flex-end;
        background: var(--cb-primary);
        color: #fff;
        border-bottom-right-radius: 6px;
      }
      .cb-msg.support {
        background: #f3efe7;
        color: #2d241b;
        border-left: 4px solid #c9772b;
      }
      .cb-msg.system {
        align-self: center;
        max-width: 100%;
        background: rgba(22, 34, 31, 0.08);
        color: #40524e;
        border-radius: 999px;
        font-size: 12px;
        padding: 8px 14px;
        text-align: center;
      }
      .cb-typing {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .cb-typing span {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #7f8b88;
        animation: cb-bounce 900ms infinite ease-in-out;
      }
      .cb-typing span:nth-child(2) { animation-delay: 120ms; }
      .cb-typing span:nth-child(3) { animation-delay: 240ms; }
      @keyframes cb-bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.45; }
        40% { transform: translateY(-4px); opacity: 1; }
      }
      .cb-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 2px;
      }
      .cb-choice-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 2px;
        max-height: 90px !important;
        overflow-y: auto !important;
      }
      .cb-suggestions {
        display: block !important;
        max-height: 100px !important;
        overflow-y: scroll !important;
        overflow-x: hidden !important;
        padding: 0;
        margin-top: 5px;
      }
      .cb-suggestions::-webkit-scrollbar { width: 4px; }
      .cb-suggestions::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 2px; }
      /* Collapse these footer containers when empty so they don't reserve a gap. */
      .cb-order:empty,
      .cb-choice-row:empty,
      .cb-suggestions:empty {
        display: none !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .cb-action, .cb-chip {
        display: inline-block !important;
        margin: 3px;
        border-radius: 999px;
        padding: 6px 10px;
        border: 1px solid var(--cb-border);
        background: rgba(255,255,255,0.92);
        color: var(--cb-text);
        cursor: pointer;
        font-size: 13px;
        text-decoration: none;
      }
      .cb-action:hover, .cb-chip:hover {
        background: rgba(0, 0, 0, 0.05);
      }
      .cb-footer {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        padding: 1px 8px 14px 8px;
        background: rgba(255,255,255,0.9);
        border-top: 1px solid var(--cb-border);
        max-height: 55% !important;
        overflow: hidden;
      }
      .cb-footer-scroller {
        flex: 1;
        overflow-y: auto !important;
        min-height: 0;
        margin-bottom: 8px;
      }
      .cb-footer-scroller::-webkit-scrollbar { width: 4px; }
      .cb-footer-scroller::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 2px; }
      .cb-order {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 10px;
      }
      .cb-order-card {
        border: 1px solid var(--cb-border);
        border-radius: 18px;
        padding: 12px;
        background: #fbfaf8;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .cb-order-items {
        max-height: 100px !important;
        overflow-y: auto !important;
        padding-right: 4px;
        border-bottom: 1px solid rgba(16, 24, 40, 0.04);
      }
      .cb-order-items::-webkit-scrollbar { width: 4px; }
      .cb-order-items::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }
      .cb-order-title {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 8px;
        color: var(--cb-text);
      }
      .cb-order-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 0;
        border-top: 1px solid rgba(16, 24, 40, 0.06);
      }
      .cb-order-row:first-of-type {
        border-top: 0;
        padding-top: 0;
      }
      .cb-order-name {
        flex: 1;
        font-size: 13px;
        color: var(--cb-text);
      }
      .cb-order-qty {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cb-qty-btn {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: 1px solid var(--cb-border);
        background: #fff;
        color: var(--cb-text);
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
      }
      .cb-order-remove {
        border: 0;
        background: transparent;
        color: #b14a4a;
        font-size: 12px;
        cursor: pointer;
      }
      .cb-order-empty, .cb-order-address {
        font-size: 13px;
        color: #5a6965;
        line-height: 1.45;
      }
      .cb-choice-row {
        margin-bottom: 10px;
      }
      .cb-choice {
        border: 0;
        border-radius: 999px;
        padding: 9px 14px;
        color: #fff;
        background: #24443c;
        cursor: pointer;
        font-size: 13px;
      }
      .cb-choice.secondary {
        background: #eef3f1;
        color: var(--cb-text);
        border: 1px solid var(--cb-border);
      }
      .cb-choice.danger { background: #c65353; }
      .cb-footer.live-mode .cb-suggestions,
      .cb-footer.live-mode .cb-order,
      .cb-footer.live-mode .cb-choice-row {
        display: none;
      }
      .cb-root.live-mode .cb-actions {
        display: none;
      }
      .cb-form {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .cb-input {
        flex: 1;
        border: 1px solid var(--cb-border);
        border-radius: 999px;
        color: #606060;
        padding: 12px 14px;
        font-size: 14px;
        outline: none;
      }
      .cb-input:disabled {
        background: #f3f5f4;
        color: #7a8783;
        cursor: not-allowed;
      }
      .cb-send {
        width: 46px;
        height: 46px;
        border-radius: 999px;
        border: 0;
        background: var(--cb-primary);
        color: #fff;
        cursor: pointer;
        font-size: 18px;
      }
      @media (max-width: 640px) {
        .cb-root { right: 8px; bottom: 8px; left: 8px; }
        .cb-bubble { width: 56px; height: 56px; }
        .cb-panel { width: 100%; _height: min(90vh, 640px); bottom: 66px; border-radius: 18px; }
        .cb-header { padding: 14px 14px 10px; }
        .cb-messages { padding: 14px; }
        .cb-bubble-tip { display: none; }
      }
      @media (max-width: 380px) {
        .cb-root { right: 4px; bottom: 4px; left: 4px; }
        .cb-panel { height: min(92vh, 640px); bottom: 2px; border-radius: 14px; }
      }
      
      .cb-panel.order-dashboard-mode .cb-messages,
      .cb-panel.order-dashboard-mode .cb-footer,
      .cb-panel.order-dashboard-mode .cb-header {
        display: none !important;
      }
      .cb-panel.order-dashboard-mode .cb-order-dashboard {
        display: flex !important;
      }
      .cb-order-dashboard {
        display: none;
        flex-direction: column;
        height: 100%;
        background: #fafaf9;
        font-family: inherit;
      }
      .cb-dash-header {
        background: var(--cb-primary);
        color: #fff;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
      }
      .cb-dash-back {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 13px;
        cursor: pointer;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 4px;
        transition: background 150ms ease;
      }
      .cb-dash-back:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      .cb-dash-cancel {
        background: #ef4444;
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 13px;
        cursor: pointer;
        font-weight: 600;
        transition: background 150ms ease;
      }
      .cb-dash-cancel:hover {
        background: #dc2626;
      }
      .cb-dash-title {
        font-size: 14px;
        font-weight: 700;
        opacity: 0.95;
      }
      .cb-dash-content {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cb-dash-content::-webkit-scrollbar {
        width: 4px;
      }
      .cb-dash-content::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,0.1);
        border-radius: 2px;
      }
      .cb-card {
        background: #fff;
        border: 1px solid var(--cb-border);
        border-radius: 12px;
        padding: 10px 12px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02);
      }
      .cb-card-title {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 700;
        color: #78716c;
        margin-bottom: 6px;
      }
      .cb-dash-cart-list {
        max-height: 115px;
        overflow-y: auto;
        margin: 0 -4px;
        padding: 0 4px;
      }
      .cb-dash-cart-list::-webkit-scrollbar {
        width: 4px;
      }
      .cb-dash-cart-list::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,0.1);
        border-radius: 2px;
      }
      .cb-dash-item-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 0;
        border-bottom: 1px solid rgba(16, 24, 40, 0.04);
      }
      .cb-dash-item-row:last-child {
        border-bottom: 0;
      }
      .cb-dash-item-info {
        flex: 1;
      }
      .cb-dash-item-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--cb-text);
      }
      .cb-dash-item-price {
        font-size: 12px;
        color: #78716c;
        margin-top: 2px;
      }
      .cb-dash-item-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cb-dash-qty-btn {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 1px solid var(--cb-border);
        background: #fcfbf9;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 600;
        transition: all 120ms ease;
      }
      .cb-dash-qty-btn:hover {
        background: #f5f4f0;
        border-color: rgba(16, 24, 40, 0.2);
      }
      .cb-dash-item-qty {
        font-size: 14px;
        font-weight: 700;
        min-width: 16px;
        text-align: center;
      }
      .cb-dash-item-qty-input {
        width: 38px;
        height: 26px;
        text-align: center;
        font-size: 14px;
        font-weight: 700;
        color: #1f2937;
        border: 1px solid var(--cb-border);
        border-radius: 8px;
        background: #fff;
        padding: 0 2px;
        -moz-appearance: textfield;
      }
      .cb-dash-item-qty-input:focus {
        outline: none;
        border-color: var(--cb-primary);
      }
      .cb-dash-item-qty-input::-webkit-outer-spin-button,
      .cb-dash-item-qty-input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .cb-dash-item-delete {
        border: 0;
        background: transparent;
        color: #ef4444;
        cursor: pointer;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.75;
        transition: opacity 120ms ease;
      }
      .cb-dash-item-delete:hover {
        opacity: 1;
      }
      
      .cb-wizard { display: flex; flex-direction: column; }
      .cb-wiz-progress { display: flex; gap: 6px; justify-content: center; margin-bottom: 14px; }
      .cb-wiz-dot { width: 30px; height: 4px; border-radius: 2px; background: rgba(0,0,0,0.12); transition: background 150ms ease; }
      .cb-wiz-dot.active { background: var(--cb-primary); }
      .cb-wiz-label { display: block; font-size: 12px; font-weight: 600; color: #57534e; margin: 10px 0 4px; }
      .cb-wiz-input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px; border: 1px solid var(--cb-border); border-radius: 10px; background: #fff; color: #1f2937; }
      .cb-wiz-input:focus { outline: none; border-color: var(--cb-primary); }
      textarea.cb-wiz-input { resize: vertical; min-height: 64px; }
      .cb-wiz-error { color: #ef4444; font-size: 12.5px; margin-top: 6px; }
      .cb-dash-empty-state {
        text-align: center;
        padding: 24px 12px;
        color: #78716c;
      }
      .cb-dash-empty-text {
        font-size: 14px;
        margin-bottom: 12px;
      }
      .cb-dash-btn-first {
        background: var(--cb-primary);
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      }
      
      /* Suggestions Section */
      .cb-section-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--cb-text);
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cb-suggestion-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        max-height: 160px;
        overflow-y: auto;
        padding-right: 4px;
      }
      .cb-suggestion-card {
        background: #fff;
        border: 1px solid var(--cb-border);
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        transition: all 120ms ease;
      }
      .cb-suggestion-card:hover {
        border-color: var(--cb-primary);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
      }
      .cb-sug-name {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--cb-text);
        line-height: 1.3;
      }
      .cb-sug-price {
        font-size: 11px;
        color: #78716c;
        margin-top: 4px;
      }
      
      /* Search Area */
      .cb-dash-search-container {
        position: relative;
      }
      .cb-dash-search-input {
        width: 100%;
        border: 1.5px solid var(--cb-border);
        border-radius: 12px;
        padding: 10px 14px;
        font-size: 13.5px;
        outline: none;
        transition: border-color 150ms ease;
      }
      .cb-dash-search-input:focus {
        border-color: var(--cb-primary);
      }
      .cb-search-status {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 12px;
        color: #78716c;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cb-search-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(0, 0, 0, 0.1);
        border-top-color: var(--cb-primary);
        border-radius: 50%;
        animation: cb-spin 0.6s linear infinite;
      }
      @keyframes cb-spin {
        to { transform: rotate(360deg); }
      }
      
      .cb-search-results-list {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 160px;
        overflow-y: auto;
      }
      .cb-search-result-row {
        background: #fff;
        border: 1px solid var(--cb-border);
        border-radius: 10px;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        cursor: pointer;
        transition: background 100ms;
      }
      .cb-search-result-row:hover {
        background: #fbfaf8;
        border-color: var(--cb-primary);
      }
      
      /* Address Form */
      .cb-address-prompt {
        font-size: 14px;
        line-height: 1.45;
        color: #44403c;
        margin-bottom: 12px;
      }
      .cb-address-textarea {
        width: 100%;
        height: 80px;
        border: 1.5px solid var(--cb-border);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13.5px;
        outline: none;
        resize: none;
        font-family: inherit;
        transition: border-color 150ms ease;
      }
      .cb-address-textarea:focus {
        border-color: var(--cb-primary);
      }
      
      /* Confirm/Action Bar */
      .cb-dash-action-bar {
        padding: 8px 10px;
        background: #fff;
        border-top: 1px solid var(--cb-border);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .cb-dash-btn-primary {
        background: var(--cb-primary);
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 9px 12px;
        font-size: 13.5px;
        font-weight: 700;
        cursor: pointer;
        text-align: center;
        width: 100%;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
        transition: transform 120ms ease;
      }
      .cb-dash-btn-primary:active {
        transform: scale(0.98);
      }
      .cb-dash-btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      
      /* Toggle Tabs */
      .cb-dash-toggle-tabs {
        display: flex;
        background: #f0edea;
        padding: 2px;
        border-radius: 999px;
        gap: 2px;
        margin-bottom: 6px;
      }
      .cb-dash-tab {
        flex: 1;
        border: 0;
        background: transparent;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 700;
        border-radius: 999px;
        cursor: pointer;
        color: #78716c;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 150ms ease;
      }
      .cb-dash-tab.active {
        background: #ffffff;
        color: var(--cb-primary);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
      }
      
      /* Floating Order Badge in Chat View */
      .cb-active-order-badge {
        background: rgba(23, 68, 58, 0.08);
        border-bottom: 1px solid rgba(23, 68, 58, 0.12);
        padding: 8px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12.5px;
        color: var(--cb-primary);
        font-weight: 600;
        animation: cb-slide-down 200ms ease;
      }
      @keyframes cb-slide-down {
        from { transform: translateY(-100%); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .cb-active-order-badge button {
        background: var(--cb-primary);
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11.5px;
        cursor: pointer;
        font-weight: 700;
      }
      
      /* Premium Inline Confirmation View */
      .cb-dash-confirm-screen {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 32px 24px;
        height: 100%;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(12px);
        animation: cb-fade-in 200ms ease;
      }
      @keyframes cb-fade-in {
        from { opacity: 0; transform: scale(0.98); }
        to { opacity: 1; transform: scale(1); }
      }
      .cb-dash-confirm-icon {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.06);
      }
      .cb-dash-confirm-icon-danger {
        background: #fee2e2;
        color: #ef4444;
      }
      .cb-dash-confirm-icon-warning {
        background: #fef3c7;
        color: #d97706;
      }
      .cb-dash-confirm-title {
        font-size: 18px;
        font-weight: 800;
        color: #1c1917;
        margin: 0 0 10px 0;
      }
      .cb-dash-confirm-text {
        font-size: 13.5px;
        color: #78716c;
        line-height: 1.5;
        margin: 0 0 24px 0;
      }
      .cb-dash-confirm-actions {
        display: flex;
        flex-direction: column;
        width: 100%;
        gap: 10px;
      }
      .cb-dash-confirm-btn-danger {
        background: #ef4444;
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 12px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: background 150ms;
        width: 100%;
      }
      .cb-dash-confirm-btn-danger:hover {
        background: #dc2626;
      }
      .cb-dash-confirm-btn-secondary {
        background: #f5f5f4;
        color: #44403c;
        border: 1px solid var(--cb-border);
        border-radius: 999px;
        padding: 12px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: background 150ms;
        width: 100%;
      }
      .cb-dash-confirm-btn-secondary:hover {
        background: #e7e5e4;
      }
    `;
    document.head.appendChild(style);
  }

  // Escape HTML so message text can never inject markup, THEN turn **bold** into
  // <strong>. Without this the raw ** markdown the bot emits shows literally.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function formatRichText(s) {
    return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  // Plain version (markers removed) used during the typing animation so a half
  // "*" never flashes mid-reveal; the final text is swapped to formatted HTML.
  function stripMarkdown(s) {
    return String(s == null ? '' : s).replace(/\*\*([^*]+)\*\*/g, '$1');
  }

  function appendMessage(text, role, lang, allowAutoOpen, thumbnail) {
    const message = document.createElement('div');
    message.className = `cb-msg ${role}`;
    message.dir = lang === 'ar' ? 'rtl' : 'ltr';

    if (thumbnail) {
      const img = document.createElement('img');
      img.src = thumbnail;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      img.style.marginBottom = '8px';
      img.style.display = 'block';
      img.style.maxHeight = '200px';
      img.style.objectFit = 'cover';
      message.appendChild(img);
    }

    const textSpan = document.createElement('span');
    textSpan.innerHTML = formatRichText(text);
    message.appendChild(textSpan);

    refs.messages.appendChild(message);
    refs.messages.scrollTop = refs.messages.scrollHeight;
    if (allowAutoOpen !== false && role === 'bot' && !state.open) {
      refs.bubble.classList.add('has-unread');
      showUnreadPreview(text);
      playNotifySound();
    }
    return message;
  }

  function renderMessageEntry(entry, lang, allowAutoOpen) {
    if (entry.intent === 'human_joined') {
      const notice = document.createElement('div');
      notice.className = 'cb-msg system';
      notice.dir = 'auto';
      notice.textContent = entry.content;
      refs.messages.appendChild(notice);
      refs.messages.scrollTop = refs.messages.scrollHeight;
      if (allowAutoOpen !== false && !state.open) {
        refs.bubble.classList.add('has-unread');
        showUnreadPreview(entry.content);
        playNotifySound();
      }
      return notice;
    }

    const message = appendMessage(entry.content, entry.role, lang, allowAutoOpen, entry.thumbnail);
    if (entry.intent === 'admin_manual') {
      message.classList.add('support');
    }
    return message;
  }

  async function typeMessage(text, role, lang, thumbnail, budgetMs = 2700) {
    state.typingId++;
    const currentId = state.typingId;
    const message = appendMessage('', role, lang, false, thumbnail);
    const textSpan = message.querySelector('span');

    // Cap the whole animation at budgetMs no matter how long the text is. Short
    // messages keep the one-char-at-a-time feel; long ones reveal several chars
    // per tick so they still finish on time — the full text is never cut.
    const TICK_MS = 12;
    // Animate over the plain (marker-free) text so no stray "*" flashes; the
    // final swap below renders the real **bold** as HTML.
    const plain = stripMarkdown(text);
    const len = plain.length;
    const maxTicks = Math.max(1, Math.floor(budgetMs / TICK_MS));
    const step = len <= maxTicks ? 1 : Math.ceil(len / maxTicks);

    for (let i = 0; i < len; i += step) {
      if (currentId !== state.typingId) return;
      textSpan.textContent = plain.slice(0, i + step);
      refs.messages.scrollTop = refs.messages.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
    if (currentId === state.typingId) textSpan.innerHTML = formatRichText(text);
    if (!state.open) {
      refs.bubble.classList.add('has-unread');
      showUnreadPreview(text);
      playNotifySound();
    }
    return message;
  }

  function showUnreadPreview(text) {
    if (!refs.bubbleTip) return;
    // Truncation is width based (CSS clamps to one line + ellipsis), not a
    // fixed char count — long text just ellipsizes at the widget's current
    // size, e.g. "hello there...".
    const plain = stripMarkdown(String(text || '')).trim();
    if (!plain) { clearUnreadPreview(); return; }
    refs.bubbleTip.textContent = plain;
    refs.bubbleTip.classList.add('unread', 'show');
  }

  function clearUnreadPreview() {
    if (!refs.bubbleTip) return;
    // Once the guest has opened the chat and seen it, the tip is hidden
    // entirely — it must NOT fall back to a static "Ask us" bubble.
    refs.bubbleTip.textContent = '';
    refs.bubbleTip.classList.remove('unread', 'show');
  }

  function playNotifySound() {
    try {
      const sfx = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
      sfx.volume = 0.4;
      sfx.play().catch(() => {});
    } catch {}
  }

  function renderHistory(history, lang) {
    refs.messages.innerHTML = '';
    state.history = Array.isArray(history) ? history.map((message) => ({ ...message })) : [];
    state.history.forEach((message) => {
      renderMessageEntry(message, lang, false);
    });
    state.hasHistory = Boolean(state.history.length);
  }

  function isSameMessage(a, b) {
    return a && b && a.role === b.role && a.content === b.content;
  }

  function syncIncomingHistory(history, lang) {
    const nextHistory = Array.isArray(history) ? history : [];
    const samePrefix = state.history.every((message, index) => isSameMessage(message, nextHistory[index]));

    if (!samePrefix) {
      renderHistory(nextHistory, lang);
      return { changed: true, additions: nextHistory.length };
    }

    const additions = nextHistory.slice(state.history.length);
    additions.forEach((message) => {
      renderMessageEntry(message, lang, !state.open);
    });
    state.history = nextHistory.map((message) => ({ ...message }));
    state.hasHistory = Boolean(state.history.length);
    return { changed: additions.length > 0, additions: additions.length };
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function normalizeUiState(uiState) {
    return {
      input_locked: Boolean(uiState && uiState.input_locked),
      choice_buttons: Array.isArray(uiState && uiState.choice_buttons) ? uiState.choice_buttons : [],
      address_preview: uiState && uiState.address_preview ? String(uiState.address_preview) : '',
      order_draft: uiState && uiState.order_draft ? uiState.order_draft : null,
    };
  }

  function setInputPlaceholder() {
    if (!refs || !refs.input) return;
    const isLocked = state.automated && state.uiState.input_locked && (!state.uiState.order_draft || state.orderDashboardActive);
    refs.input.placeholder = isLocked
      ? (state.language === 'ar' ? 'اختر من الخيارات الظاهرة' : 'Choose one of the visible options')
      : (state.language === 'ar' ? 'اكتب رسالتك...' : 'Type your message...');
  }

  function syncComposerState() {
    if (!refs) return;
    const locked = state.automated ? (state.uiState.input_locked && (!state.uiState.order_draft || state.orderDashboardActive)) : false;
    refs.input.disabled = locked;
    refs.send.disabled = locked || state.isSending;
  }

  function renderButtons(buttons) {
    if (!buttons || !buttons.length) return;
    const row = document.createElement('div');
    row.className = 'cb-actions';
    buttons.forEach((button) => {
      const link = document.createElement('a');
      link.className = 'cb-action';
      link.href = button.url;
      link.target = button.target || '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = button.label;
      row.appendChild(link);
    });
    refs.messages.appendChild(row);
    refs.messages.scrollTop = refs.messages.scrollHeight;
  }

  function renderSuggestions(list) {
    const suggestions = Array.isArray(list) ? list.slice(0, 10) : [];
    refs.suggestions.innerHTML = '';
    if (!state.automated) return;
    suggestions.forEach((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cb-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => sendMessage({ value: text, displayText: text, silent: false }));
      refs.suggestions.appendChild(chip);
    });
  }

  function renderChoiceButtons(buttons) {
    refs.choices.innerHTML = '';
    if (state.uiState.order_draft && !state.orderDashboardActive) {
      return;
    }
    buttons.forEach((button) => {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = `cb-choice ${button.style || 'primary'}`.trim();
      choice.textContent = button.label || button.value;
      choice.addEventListener('click', () => sendMessage({
        value: button.value || button.label,
        displayText: button.label || button.value,
        silent: false,
      }));
      refs.choices.appendChild(choice);
    });
  }

  function renderOrderDraft(orderDraft, addressPreview) {
    refs.order.innerHTML = '';
  }

  function applyUiState(uiState) {
    const previousDraft = state.uiState.order_draft;
    const normalized = normalizeUiState(uiState || emptyUiState());
    // Keep the local draft when a sync is in flight OR a qty field is being
    // edited. During typing `cartSyncPending` is still false (change hasn't
    // fired yet), so without the focus check a poll would swap out order_draft
    // and the change handler would commit against a stale draft reference.
    const fEl = document.activeElement;
    const editingQtyNow = !!(fEl && fEl.classList &&
      fEl.classList.contains('cb-dash-item-qty-input'));
    if ((state.cartSyncPending || editingQtyNow) && state.uiState.order_draft) {
      normalized.order_draft = state.uiState.order_draft;
    }
    state.uiState = normalized;
    
    // Automatically open dashboard when a draft order exists and is newly loaded, otherwise close it
    if (state.uiState.order_draft && !previousDraft) {
      state.orderDashboardActive = true;
      state.orderInputMode = null;
    } else if (!state.uiState.order_draft) {
      state.orderDashboardActive = false;
      state.orderInputMode = null;
    }
    
    renderChoiceButtons(state.uiState.choice_buttons);
    renderOrderDraft(state.uiState.order_draft, state.uiState.address_preview);
    setInputPlaceholder();
    syncComposerState();
    
    // Renders the full screen dashboard overlay if orderDashboardActive is true
    updateDashboardUi();
  }

  function updateChatModeUi() {
    if (!refs) return;
    refs.root.classList.toggle('live-mode', !state.automated);
    refs.brandSub.textContent = state.automated
      ? (state.language === 'ar' ? 'مساعدة فورية' : 'Instant support')
      : (state.language === 'ar' ? 'تم تحويل المحادثة إلى خدمة العملاء' : 'Chat handed to customer support');
    refs.footer.classList.toggle('live-mode', !state.automated);
    syncComposerState();
  }

  function renderFloatingOrderBadge() {
    const draft = state.uiState.order_draft;
    if (!draft) {
      removeFloatingOrderBadge();
      return;
    }
    
    const existing = refs.root.querySelector('.cb-active-order-badge');
    if (existing) {
      const orderIdAttr = existing.getAttribute('data-order-id');
      if (orderIdAttr === String(draft.order_id)) {
        return;
      }
      existing.remove();
    }
    
    const badge = document.createElement('div');
    badge.className = 'cb-active-order-badge';
    badge.setAttribute('data-order-id', draft.order_id);
    badge.innerHTML = `
      <span>🛒 ${state.language === 'ar' ? `طلب نشط قيد التنفيذ (#${draft.order_id})` : `Order in progress (#${draft.order_id})`}</span>
      <button type="button">${state.language === 'ar' ? 'عرض الطلب' : 'View Order'}</button>
    `;
    
    badge.querySelector('button').addEventListener('click', () => {
      state.orderDashboardActive = true;
      updateDashboardUi();
    });
    
    refs.messages.parentNode.insertBefore(badge, refs.messages);
  }

  function removeFloatingOrderBadge() {
    const existing = refs.root.querySelector('.cb-active-order-badge');
    if (existing) existing.remove();
  }

  function addCatalogItem(title) {
    const draft = state.uiState.order_draft;
    // An order that's already been placed (not a draft) is locked — ignore taps.
    if (draft && draft.status !== 'draft') {
      return Promise.resolve();
    }

    const items = draft && Array.isArray(draft.items) ? draft.items : null;

    // Case 1: the item is already confirmed in the cart -> this is just a +1.
    // Bump the quantity locally and re-render NOW, then sync in the background,
    // exactly like the +/- buttons. No server handshake, so it feels instant.
    const confirmed = items && items.find((i) => i.title === title && !i._optimistic);
    if (confirmed) {
      state.cartSyncPending = true;
      state.lastCartEditTime = Date.now();
      confirmed.quantity++;
      updateDashboardUi();
      scheduleCartSync(draft);
      return Promise.resolve();
    }

    // Case 2: a brand-new item. Show it immediately as an optimistic row so the
    // UI reacts on the tap, then create it on the server with a single atomic
    // add_item request. The server response (real item, same title) seamlessly
    // replaces the optimistic placeholder.
    if (items) {
      const pending = items.find((i) => i.title === title && i._optimistic);
      if (pending) {
        pending.quantity++;
      } else {
        // Insert at the TOP so a newly added item shows first in the cart,
        // matching the server order (newest-first).
        items.unshift({ order_item_id: `temp-${Date.now()}`, title, quantity: 1, _optimistic: true });
      }
      updateDashboardUi();
    }

    // Queue the request so concurrent taps reconcile in order. One round-trip
    // each now (vs the old add_more -> title two-request handshake).
    return enqueueCartOp(async () => {
      if (state.uiState.order_draft && state.uiState.order_draft.status !== 'draft') {
        return;
      }
      await sendMessage({ value: `__order__:add_item:${title}`, silent: true });
    });
  }

  function updateDashboardUi() {
    if (!refs || !refs.dashboard) return;
    
    const draft = state.uiState.order_draft;
    const addressPreview = state.uiState.address_preview;
    
    if (!draft || !state.orderDashboardActive) {
      refs.root.querySelector('.cb-panel').classList.remove('order-dashboard-mode');
      
      // Clear data-stage attribute when leaving dashboard
      refs.dashboard.removeAttribute('data-stage');
      refs.dashboard.innerHTML = '';
      
      // Clean up chat view order UI elements and unlock composer
      renderChoiceButtons(state.uiState.choice_buttons);
      renderSuggestions(state.currentSuggestions);
      setInputPlaceholder();
      syncComposerState();
      
      renderFloatingOrderBadge();
      return;
    }
    
    removeFloatingOrderBadge();
    refs.root.querySelector('.cb-panel').classList.add('order-dashboard-mode');

    // Modals/screens override the stage and rebuild entirely. Guard each with a
    // data-screen signature so a background 3s poll does NOT rebuild the same
    // screen's innerHTML underneath the user's finger — replacing a button
    // mid-tap is exactly what made Cancel/Confirm need several presses to land.
    if (state.confirmCancelActive) {
      if (refs.dashboard.dataset.screen !== 'confirm-cancel') {
      refs.dashboard.dataset.screen = 'confirm-cancel';
      refs.dashboard.removeAttribute('data-stage');
      refs.dashboard.innerHTML = `
        <div class="cb-dash-confirm-screen">
          <div class="cb-dash-confirm-icon cb-dash-confirm-icon-danger">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="15" y1="9" x2="9" y2="15"></line>
              <line x1="9" y1="9" x2="15" y2="15"></line>
            </svg>
          </div>
          <h3 class="cb-dash-confirm-title">${state.language === 'ar' ? 'إلغاء الطلب?' : 'Cancel Order?'}</h3>
          <p class="cb-dash-confirm-text">
            ${state.language === 'ar' ? 'هل أنت متأكد من إلغاء هذا الطلب؟ سيتم مسح جميع الأصناف من سلتك.' : 'Are you sure you want to cancel this order? All items in your cart will be permanently removed.'}
          </p>
          <div class="cb-dash-confirm-actions">
            <button type="button" class="cb-dash-confirm-btn-danger cb-dash-cancel-yes">${state.language === 'ar' ? 'نعم، إلغاء الطلب' : 'Yes, Cancel Order'}</button>
            <button type="button" class="cb-dash-confirm-btn-secondary cb-dash-cancel-no">${state.language === 'ar' ? 'لا، تراجع' : 'No, Keep Order'}</button>
          </div>
        </div>
      `;

      refs.dashboard.querySelector('.cb-dash-cancel-yes').addEventListener('click', async () => {
        state.confirmCancelActive = false;
        state.orderDashboardActive = false;
        await sendMessage({ value: '__order__:cancel', silent: false });
      });

      refs.dashboard.querySelector('.cb-dash-cancel-no').addEventListener('click', () => {
        state.confirmCancelActive = false;
        updateDashboardUi();
      });
      }
      return;
    }

    if (state.confirmDeleteItem) {
      const deleteSig = 'delete:' + state.confirmDeleteItem.order_item_id;
      if (refs.dashboard.dataset.screen !== deleteSig) {
      refs.dashboard.dataset.screen = deleteSig;
      refs.dashboard.removeAttribute('data-stage');
      const itemToDelete = state.confirmDeleteItem;
      refs.dashboard.innerHTML = `
        <div class="cb-dash-confirm-screen">
          <div class="cb-dash-confirm-icon cb-dash-confirm-icon-warning">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </div>
          <h3 class="cb-dash-confirm-title">${state.language === 'ar' ? 'إزالة الصنف؟' : 'Remove Item?'}</h3>
          <p class="cb-dash-confirm-text">
            ${state.language === 'ar' 
              ? `هل أنت متأكد من إزالة "${itemToDelete.title}" من السلة؟` 
              : `Are you sure you want to remove "${itemToDelete.title}" from your cart?`}
          </p>
          <div class="cb-dash-confirm-actions">
            <button type="button" class="cb-dash-confirm-btn-danger cb-dash-delete-yes">${state.language === 'ar' ? 'إزالة' : 'Yes, Remove'}</button>
            <button type="button" class="cb-dash-confirm-btn-secondary cb-dash-delete-no">${state.language === 'ar' ? 'إلغاء' : 'No, Keep It'}</button>
          </div>
        </div>
      `;

      refs.dashboard.querySelector('.cb-dash-delete-yes').addEventListener('click', () => {
        const itemId = itemToDelete.order_item_id;
        state.confirmDeleteItem = null;
        state.cartSyncPending = true;
        state.lastCartEditTime = Date.now();
        draft.items = draft.items.filter(i => i.order_item_id !== itemId);
        updateDashboardUi();
        scheduleCartSync(draft);
      });

      refs.dashboard.querySelector('.cb-dash-delete-no').addEventListener('click', () => {
        state.confirmDeleteItem = null;
        updateDashboardUi();
      });
      }
      return;
    }

    // Not on a modal screen anymore — clear the screen marker so returning to a
    // screen later rebuilds it, and so the shell logic below runs normally.
    if (refs.dashboard.dataset.screen) delete refs.dashboard.dataset.screen;

    const status = draft.status;
    const currentStage = refs.dashboard.getAttribute('data-stage');

    // If stage changed, build the shell HTML once
    if (currentStage !== status) {
      refs.dashboard.setAttribute('data-stage', status);
      
      let shellHtml = `
        <header class="cb-dash-header">
          <button type="button" class="cb-dash-back">${state.language === 'ar' ? '← الدردشة' : '← Back'}</button>
          <span class="cb-dash-title">${state.language === 'ar' ? 'تفاصيل الطلب' : 'Order Details'} #${draft.order_id}</span>
          <button type="button" class="cb-dash-cancel">${state.language === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        </header>
        <div class="cb-dash-content">
      `;
      
      if (status === 'draft') {
        shellHtml += `
          <div class="cb-card">
            <div class="cb-card-title">${state.language === 'ar' ? 'السلة' : 'Shopping Cart'}</div>
            <div class="cb-dash-cart-list"></div>
          </div>
          
          <div class="cb-dash-toggle-tabs" style="display: none;">
            <button type="button" class="cb-dash-tab cb-dash-tab-suggestions">
              ✨ ${state.language === 'ar' ? 'اقتراحات' : 'Suggestions'}
            </button>
            <button type="button" class="cb-dash-tab cb-dash-tab-search">
              🔍 ${state.language === 'ar' ? 'بحث' : 'Search'}
            </button>
          </div>
          
          <div class="cb-suggestions-section" style="display: none;">
            <div class="cb-section-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
              <span>${state.language === 'ar' ? 'اقتراحات لك' : 'Recommended for You'}</span>
            </div>
            <div class="cb-suggestion-grid"></div>
          </div>
          
          <div class="cb-card cb-dash-search-container" style="display: none;">
            <div class="cb-card-title">${state.language === 'ar' ? 'بحث سريع' : 'Quick Search'}</div>
            <input type="text" class="cb-dash-search-input" placeholder="${state.language === 'ar' ? 'ابحث عن أصناف أخرى...' : 'Search for other items...'}" value="${state.searchQuery || ''}">
            <div class="cb-search-status" style="display: none;">
              <div class="cb-search-spinner"></div>
              <span>${state.language === 'ar' ? 'جاري البحث...' : 'Searching...'}</span>
            </div>
            <div class="cb-search-results-list" style="display: none;"></div>
          </div>
        `;
      } else if (status === 'awaiting_details') {
        const ar = state.language === 'ar';
        shellHtml += `
          <div class="cb-wizard">
            <div class="cb-wiz-progress">
              <span class="cb-wiz-dot" data-dot="0"></span>
              <span class="cb-wiz-dot" data-dot="1"></span>
              <span class="cb-wiz-dot" data-dot="2"></span>
            </div>
            <div class="cb-card cb-wiz-step" data-step="0">
              <div class="cb-card-title">${ar ? 'بياناتك' : 'Your details'}</div>
              <label class="cb-wiz-label">${ar ? 'الاسم' : 'Name'}</label>
              <input class="cb-wiz-input cb-wiz-name" type="text" value="${escapeHtml(draft.guest_name)}" placeholder="${ar ? 'اسمك' : 'Your name'}">
              <label class="cb-wiz-label">${ar ? 'رقم الهاتف' : 'Phone'}</label>
              <input class="cb-wiz-input cb-wiz-phone" type="tel" value="${escapeHtml(draft.guest_phone)}" placeholder="${ar ? 'رقم هاتفك' : 'Your phone'}">
              <label class="cb-wiz-label">${ar ? 'الإيميل (اختياري)' : 'Email (optional)'}</label>
              <input class="cb-wiz-input cb-wiz-email" type="email" value="${escapeHtml(draft.email)}" placeholder="${ar ? 'بريدك الإلكتروني' : 'you@example.com'}">
            </div>
            <div class="cb-card cb-wiz-step" data-step="1" style="display:none">
              <div class="cb-card-title">${ar ? 'الدولة *' : 'Country *'}</div>
              <input class="cb-wiz-input cb-wiz-country" type="text" value="${escapeHtml(draft.country)}" placeholder="${ar ? 'مثال: السعودية' : 'e.g., Saudi Arabia'}">
              <div class="cb-wiz-error" style="display:none">${ar ? 'من فضلك أدخل الدولة لإتمام الطلب' : 'Please enter your country to continue'}</div>
            </div>
            <div class="cb-card cb-wiz-step" data-step="2" style="display:none">
              <div class="cb-card-title">${ar ? 'ملاحظة (اختياري)' : 'Note (optional)'}</div>
              <textarea class="cb-wiz-input cb-wiz-note" rows="3" placeholder="${ar ? 'أي تفاصيل إضافية تريد إضافتها...' : 'Any extra details you want to add...'}">${escapeHtml(draft.note)}</textarea>
            </div>
          </div>
        `;
      } else if (status === 'awaiting_address') {
        shellHtml += `
          <div class="cb-card">
            <div class="cb-card-title">${state.language === 'ar' ? 'عنوان التوصيل' : 'Delivery Address'}</div>
            <div class="cb-address-prompt">
              ${state.language === 'ar' ? 'من فضلك أرسل عنوان التوصيل الكامل والواضح للمتابعة:' : 'Please enter your complete and clear delivery address to proceed:'}
            </div>
            <textarea class="cb-address-textarea" placeholder="${state.language === 'ar' ? 'مثال: شارع التسعين، التجمع الخامس، القاهرة، شقة ٥...' : 'e.g., 90th Street, Fifth Settlement, Cairo, Apt 5...'}">${state.typedAddress || ''}</textarea>
          </div>
        `;
      } else if (status === 'address_confirmation') {
        shellHtml += `
          <div class="cb-card">
            <div class="cb-card-title">${state.language === 'ar' ? 'تأكيد العنوان' : 'Confirm Address'}</div>
            <div class="cb-address-prompt" style="font-weight:600;color:var(--cb-primary);background:rgba(23,68,58,0.04);padding:12px;border-radius:10px;border-left:4px solid var(--cb-primary);">
              ${addressPreview}
            </div>
            <div style="font-size:13px;color:#78716c;margin-top:12px;line-height:1.4;">
              ${state.language === 'ar' ? 'هل هذا العنوان صحيح؟ يمكنك تأكيد الطلب أو تعديل العنوان إذا لزم الأمر.' : 'Is this address correct? You can confirm or rewrite if needed.'}
            </div>
          </div>
        `;
      } else if (status === 'pending') {
        shellHtml += `
          <div class="cb-card cb-dash-pending-status-card" style="background: rgba(23,68,58,0.04); border-left: 4px solid var(--cb-primary); padding: 16px; border-radius: 12px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px;">
            <div style="background: var(--cb-primary); color: #fff; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--cb-primary); font-size: 15px;">
                ${state.language === 'ar' ? 'تم تأكيد الطلب بنجاح!' : 'Order Confirmed successfully!'}
              </div>
              <div style="font-size: 13px; color: #4b5563; margin-top: 2px;">
                ${state.language === 'ar' ? 'طلبك قيد التجهيز والتوصيل حالياً.' : 'Your order is currently being prepared & delivered.'}
              </div>
            </div>
          </div>
          
          <div class="cb-card">
            <div class="cb-card-title">${state.language === 'ar' ? 'الأصناف المطلوبة' : 'Ordered Items'}</div>
            <div class="cb-dash-cart-list cb-dash-cart-list-readonly"></div>
          </div>
          
          <div class="cb-card">
            <div class="cb-card-title">${state.language === 'ar' ? 'عنوان التوصيل' : 'Delivery Address'}</div>
            <div class="cb-address-prompt" style="font-weight:600; color:#1f2937; padding: 12px; background: rgba(0,0,0,0.02); border-radius: 8px; font-size: 14px;">
              ${draft.address || ''}
            </div>
          </div>
        `;
      }
      
      shellHtml += `
        </div>
        <div class="cb-dash-action-bar"></div>
      `;
      
      refs.dashboard.innerHTML = shellHtml;
      
      // Bind stage-invariant header listeners
      refs.dashboard.querySelector('.cb-dash-back').addEventListener('click', () => {
        state.orderDashboardActive = false;
        updateDashboardUi();
      });
      
      refs.dashboard.querySelector('.cb-dash-cancel').addEventListener('click', () => {
        state.confirmCancelActive = true;
        updateDashboardUi();
      });
      
      // Bind stage-specific listeners for inputs
      if (status === 'draft') {
        const tabSuggestions = refs.dashboard.querySelector('.cb-dash-tab-suggestions');
        const tabSearch = refs.dashboard.querySelector('.cb-dash-tab-search');
        if (tabSuggestions && tabSearch) {
          tabSuggestions.addEventListener('click', () => {
            state.orderInputMode = 'suggestions';
            updateDashboardUi();
          });
          tabSearch.addEventListener('click', () => {
            state.orderInputMode = 'search';
            updateDashboardUi();
            const input = refs.dashboard.querySelector('.cb-dash-search-input');
            if (input) input.focus();
          });
        }

        const searchInput = refs.dashboard.querySelector('.cb-dash-search-input');
        if (searchInput) {
          searchInput.addEventListener('input', (e) => {
            const value = e.target.value;
            state.searchQuery = value;
            
            if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
            
            if (!value.trim()) {
              state.isSearching = false;
              state.searchResults = [];
              updateDashboardUi();
              return;
            }
            
            state.isSearching = true;
            const statusEl = refs.dashboard.querySelector('.cb-search-status');
            if (statusEl) statusEl.style.display = 'flex';
            
            state.searchDebounceTimer = setTimeout(async () => {
              try {
                const res = await postJson('/api/search', {
                  query: value,
                  lang: state.language,
                  context: {
                    recent_item_ids: state.uiState.order_draft?.items?.map(i => i.order_item_id) || []
                  }
                });
                state.searchResults = res.items || [];
              } catch (e) {
                state.searchResults = [];
              } finally {
                state.isSearching = false;
                updateDashboardUi();
              }
            }, 1000);
          });
        }
      } else if (status === 'awaiting_details') {
        // Entering the e-commerce checkout wizard — always start at step 1.
        state.detailsStep = 0;
      } else if (status === 'awaiting_address') {
        const textarea = refs.dashboard.querySelector('.cb-address-textarea');
        if (textarea) {
          textarea.addEventListener('input', (e) => {
            const val = e.target.value;
            state.typedAddress = val;
            const btn = refs.dashboard.querySelector('.cb-dash-btn-confirm-address');
            if (btn) btn.disabled = val.trim().length < 6;
          });
        }
      }
    }

    // Now perform dynamic, incremental updates to DOM elements without rewriting the shell!
    if (status === 'draft' || status === 'pending') {
      // 1. Update Cart Items List
      const cartListEl = refs.dashboard.querySelector('.cb-dash-cart-list');
      // While the user is typing into a qty field, don't rebuild the cart list:
      // replacing innerHTML drops focus and reverts the in-progress value. Both
      // the 3s poll and the background cart sync funnel through here, so without
      // this guard an edit gets clobbered mid-typing. The list re-renders on the
      // next pass once the field is blurred — which is also when `change` commits.
      const focusedEl = document.activeElement;
      const editingQty = !!(focusedEl && focusedEl.classList &&
        focusedEl.classList.contains('cb-dash-item-qty-input') &&
        cartListEl && cartListEl.contains(focusedEl));
      if (cartListEl && !editingQty) {
        let cartHtml = '';
        if (Array.isArray(draft.items) && draft.items.length > 0) {
          draft.items.forEach((item) => {
            if (status === 'pending') {
              cartHtml += `
                <div class="cb-dash-item-row" data-item-id="${item.order_item_id}" style="padding: 10px 0; border-bottom: 1px dashed rgba(0,0,0,0.06);">
                  <div class="cb-dash-item-info">
                    <div class="cb-dash-item-name" style="font-weight: 600; color: #1f2937;">${item.title}</div>
                  </div>
                  <div class="cb-dash-item-controls" style="font-weight: 700; color: var(--cb-primary); font-size: 15px;">
                    <span>x ${item.quantity}</span>
                  </div>
                </div>
              `;
            } else {
              cartHtml += `
                <div class="cb-dash-item-row" data-item-id="${item.order_item_id}">
                  <div class="cb-dash-item-info">
                    <div class="cb-dash-item-name">${item.title}</div>
                  </div>
                  <div class="cb-dash-item-controls">
                    <button type="button" class="cb-dash-qty-btn cb-dash-qty-dec" data-item-id="${item.order_item_id}" title="${state.language === 'ar' ? 'إنقاص (يحذف عند الصفر)' : 'Decrease (removes at zero)'}">&minus;</button>
                    <input type="number" class="cb-dash-item-qty-input" data-item-id="${item.order_item_id}" min="0" inputmode="numeric" value="${item.quantity}" aria-label="${state.language === 'ar' ? 'الكمية' : 'Quantity'}">
                    <button type="button" class="cb-dash-qty-btn cb-dash-qty-inc" data-item-id="${item.order_item_id}">+</button>
                  </div>
                </div>
              `;
            }
          });
        } else {
          cartHtml += `
            <div class="cb-dash-empty-state">
              <div class="cb-dash-empty-text">${state.language === 'ar' ? 'الطلب فارغ حالياً' : 'Your order is currently empty'}</div>
              <button type="button" class="cb-dash-btn-first">${state.language === 'ar' ? 'أضف صنفك الأول' : 'Add Your First Item'}</button>
            </div>
          `;
        }
        cartListEl.innerHTML = cartHtml;

        // Bind cart action listeners
        if (status === 'draft') {
          cartListEl.querySelectorAll('.cb-dash-qty-dec').forEach((btn) => {
            btn.addEventListener('click', () => {
              const itemId = Number(btn.getAttribute('data-item-id'));
              const item = draft.items.find(i => i.order_item_id === itemId);
              if (item) {
                state.cartSyncPending = true;
                state.lastCartEditTime = Date.now();
                item.quantity = Math.max(0, item.quantity - 1);
                if (item.quantity === 0) {
                  draft.items = draft.items.filter(i => i.order_item_id !== itemId);
                }
                updateDashboardUi();
                scheduleCartSync(draft);
              }
            });
          });

          cartListEl.querySelectorAll('.cb-dash-qty-inc').forEach((btn) => {
            btn.addEventListener('click', () => {
              const itemId = Number(btn.getAttribute('data-item-id'));
              const item = draft.items.find(i => i.order_item_id === itemId);
              if (item) {
                state.cartSyncPending = true;
                state.lastCartEditTime = Date.now();
                item.quantity++;
                updateDashboardUi();
                scheduleCartSync(draft);
              }
            });
          });

          // Manual quantity entry — set the number directly. Committing 0 (or
          // blank) removes the item, same as decrementing past 1. Synced via
          // sync_cart (qty <= 0 -> delete). Fires on change/blur, not per
          // keystroke, so the field keeps focus while typing.
          cartListEl.querySelectorAll('.cb-dash-item-qty-input').forEach((inp) => {
            inp.addEventListener('focus', () => { try { inp.select(); } catch (e) {} });
            inp.addEventListener('change', () => {
              const itemId = Number(inp.getAttribute('data-item-id'));
              const item = draft.items.find(i => i.order_item_id === itemId);
              if (!item) return;
              let q = parseInt(inp.value, 10);
              if (!Number.isFinite(q) || q < 0) q = 0;
              state.cartSyncPending = true;
              state.lastCartEditTime = Date.now();
              item.quantity = q;
              if (q === 0) {
                draft.items = draft.items.filter(i => i.order_item_id !== itemId);
              }
              updateDashboardUi();
              scheduleCartSync(draft);
            });
          });

          cartListEl.querySelectorAll('.cb-dash-item-delete').forEach((btn) => {
            btn.addEventListener('click', () => {
              const itemId = Number(btn.getAttribute('data-item-id'));
              const item = draft.items.find(i => i.order_item_id === itemId);
              if (item) {
                state.confirmDeleteItem = item;
                updateDashboardUi();
              }
            });
          });

          const btnFirst = cartListEl.querySelector('.cb-dash-btn-first');
          if (btnFirst) {
            btnFirst.addEventListener('click', () => {
              state.orderInputMode = 'search';
              updateDashboardUi();
              const searchInput = refs.dashboard.querySelector('.cb-dash-search-input');
              if (searchInput) searchInput.focus();
            });
          }
        }
      }

      // Show/Hide inputs depending on orderSuggestions length and orderInputMode
      const toggleTabsEl = refs.dashboard.querySelector('.cb-dash-toggle-tabs');
      const sugSectionEl = refs.dashboard.querySelector('.cb-suggestions-section');
      const searchContainerEl = refs.dashboard.querySelector('.cb-dash-search-container');
      
      if (toggleTabsEl && sugSectionEl && searchContainerEl) {
        if (!state.orderSuggestions || state.orderSuggestions.length === 0) {
          // If empty, directly hide suggestions toggle and suggestions section, show search box
          toggleTabsEl.style.display = 'none';
          sugSectionEl.style.display = 'none';
          searchContainerEl.style.display = 'block';
        } else {
          // If not empty, show toggle tabs and toggle active view
          toggleTabsEl.style.display = 'flex';
          if (!state.orderInputMode) {
            state.orderInputMode = 'suggestions';
          }
          
          const tabSug = toggleTabsEl.querySelector('.cb-dash-tab-suggestions');
          const tabSrc = toggleTabsEl.querySelector('.cb-dash-tab-search');
          
          if (state.orderInputMode === 'suggestions') {
            tabSug.classList.add('active');
            tabSrc.classList.remove('active');
            sugSectionEl.style.display = 'block';
            searchContainerEl.style.display = 'none';
          } else {
            tabSrc.classList.add('active');
            tabSug.classList.remove('active');
            sugSectionEl.style.display = 'none';
            searchContainerEl.style.display = 'block';
          }
        }
      }

      // 2. Update Recommendations
      const sugGridEl = refs.dashboard.querySelector('.cb-suggestion-grid');
      if (sugGridEl) {
        let sugHtml = '';
        state.orderSuggestions.forEach((text) => {
          sugHtml += `
            <div class="cb-suggestion-card" data-title="${text}">
              <div class="cb-sug-name">${text}</div>
              <div class="cb-sug-price">${state.language === 'ar' ? 'اضغط للإضافة' : 'Tap to add'}</div>
            </div>
          `;
        });
        sugGridEl.innerHTML = sugHtml;

        sugGridEl.querySelectorAll('.cb-suggestion-card').forEach((card) => {
          card.addEventListener('click', async () => {
            const title = card.getAttribute('data-title');
            card.style.transform = 'scale(0.96)';
            setTimeout(() => card.style.transform = '', 100);
            playNotifySound();
            await addCatalogItem(title);
          });
        });
      }

      // 3. Update Search Status & Results
      const searchStatusEl = refs.dashboard.querySelector('.cb-search-status');
      const resultsListEl = refs.dashboard.querySelector('.cb-search-results-list');
      if (searchStatusEl) {
        searchStatusEl.style.display = state.isSearching ? 'flex' : 'none';
      }
      if (resultsListEl) {
        let resHtml = '';
        if (state.searchResults.length > 0) {
          state.searchResults.forEach((item) => {
            const title = state.language === 'ar' ? item.title_ar || item.title_en : item.title_en || item.title_ar;
            const priceStr = item.price !== null && item.price !== undefined ? `${item.price} ${item.currency}` : '';
            resHtml += `
              <div class="cb-search-result-row" data-title="${title}">
                <span>${title}</span>
                <strong style="color:var(--cb-primary);">${priceStr}</strong>
              </div>
            `;
          });
          resultsListEl.style.display = 'flex';
        } else if (state.searchQuery && !state.isSearching) {
          resHtml += `
            <div style="font-size:12.5px;color:#78716c;text-align:center;padding:8px 0;">
              ${state.language === 'ar' ? 'لم يتم العثور على نتائج' : 'No items found'}
            </div>
          `;
          resultsListEl.style.display = 'flex';
        } else {
          resultsListEl.style.display = 'none';
        }
        resultsListEl.innerHTML = resHtml;

        resultsListEl.querySelectorAll('.cb-search-result-row').forEach((row) => {
          row.addEventListener('click', async () => {
            const title = row.getAttribute('data-title');
            playNotifySound();
            await addCatalogItem(title);
          });
        });
      }

      // 4. Update Bottom Action Bar
      const actionBarEl = refs.dashboard.querySelector('.cb-dash-action-bar');
      if (actionBarEl) {
        const hasItems = Array.isArray(draft.items) && draft.items.length > 0;
        // Only rebuild when the button's state actually changes — otherwise the
        // 3s poll replaces the Confirm button under the user's tap (the "had to
        // hit it a bunch of times" bug).
        const sig = 'confirm-items:' + (hasItems ? '1' : '0');
        if (actionBarEl.dataset.sig !== sig) {
          actionBarEl.dataset.sig = sig;
          actionBarEl.innerHTML = `
            <button type="button" class="cb-dash-btn-primary cb-dash-btn-confirm-items" ${hasItems ? '' : 'disabled'}>
              ${state.language === 'ar' ? 'تأكيد أصناف الطلب' : 'Confirm Order Items'}
            </button>
          `;

          const btnConfirm = actionBarEl.querySelector('.cb-dash-btn-confirm-items');
          if (btnConfirm) {
            btnConfirm.addEventListener('click', async () => {
              btnConfirm.disabled = true;
              btnConfirm.textContent = state.language === 'ar' ? 'جاري التأكيد...' : 'Confirming...';
              await sendMessage({ value: '__order__:confirm', silent: false });
            });
          }
        }
      }
    } else if (status === 'awaiting_address') {
      const actionBarEl = refs.dashboard.querySelector('.cb-dash-action-bar');
      if (actionBarEl) {
        const isAddressValid = String(state.typedAddress || '').trim().length >= 6;
        const sig = 'addr:' + (isAddressValid ? '1' : '0');
        if (actionBarEl.dataset.sig !== sig) {
          actionBarEl.dataset.sig = sig;
          actionBarEl.innerHTML = `
            <button type="button" class="cb-dash-btn-primary cb-dash-btn-confirm-address" ${isAddressValid ? '' : 'disabled'}>
              ${state.language === 'ar' ? 'تأكيد العنوان' : 'Confirm Address'}
            </button>
          `;

          const btnConfirmAddr = actionBarEl.querySelector('.cb-dash-btn-confirm-address');
          if (btnConfirmAddr) {
            btnConfirmAddr.addEventListener('click', async () => {
              btnConfirmAddr.disabled = true;
              btnConfirmAddr.textContent = state.language === 'ar' ? 'جاري الحفظ...' : 'Saving...';
              await sendMessage({ value: state.typedAddress, silent: false });
            });
          }
        }
      }
    } else if (status === 'awaiting_details') {
      const ar = state.language === 'ar';
      const step = state.detailsStep || 0;
      const isLast = step === 2;

      // Show only the active step + light up progress dots up to it.
      refs.dashboard.querySelectorAll('.cb-wiz-step').forEach((el) => {
        el.style.display = Number(el.getAttribute('data-step')) === step ? 'block' : 'none';
      });
      refs.dashboard.querySelectorAll('.cb-wiz-dot').forEach((el) => {
        el.classList.toggle('active', Number(el.getAttribute('data-dot')) <= step);
      });

      const actionBarEl = refs.dashboard.querySelector('.cb-dash-action-bar');
      const wizSig = 'wiz:' + step;
      if (actionBarEl && actionBarEl.dataset.sig !== wizSig) {
        actionBarEl.dataset.sig = wizSig;
        actionBarEl.style.display = 'flex';
        actionBarEl.style.gap = '8px';
        actionBarEl.innerHTML = `
          ${step > 0 ? `<button type="button" class="cb-choice secondary cb-wiz-back" style="flex:1;padding:11px;font-weight:600;margin:0;">${ar ? 'السابق' : 'Back'}</button>` : ''}
          <button type="button" class="cb-dash-btn-primary cb-wiz-next" style="flex:2;">${isLast ? (ar ? 'تأكيد الطلب' : 'Place Order') : (ar ? 'التالي' : 'Next')}</button>
        `;

        const backBtn = actionBarEl.querySelector('.cb-wiz-back');
        if (backBtn) backBtn.addEventListener('click', () => { state.detailsStep = Math.max(0, step - 1); updateDashboardUi(); });

        const nextBtn = actionBarEl.querySelector('.cb-wiz-next');
        nextBtn.addEventListener('click', async () => {
          // Country (step 1) is the only required field.
          if (step === 1) {
            const countryEl = refs.dashboard.querySelector('.cb-wiz-country');
            const errEl = refs.dashboard.querySelector('.cb-wiz-error');
            if (countryEl && !countryEl.value.trim()) {
              if (errEl) errEl.style.display = 'block';
              countryEl.focus();
              return;
            }
            if (errEl) errEl.style.display = 'none';
          }
          if (!isLast) { state.detailsStep = step + 1; updateDashboardUi(); return; }

          const val = (sel) => { const el = refs.dashboard.querySelector(sel); return el ? el.value.trim() : ''; };
          const payload = {
            name: val('.cb-wiz-name'),
            phone: val('.cb-wiz-phone'),
            email: val('.cb-wiz-email'),
            country: val('.cb-wiz-country'),
            note: val('.cb-wiz-note'),
          };
          if (!payload.country) { state.detailsStep = 1; updateDashboardUi(); return; }
          nextBtn.disabled = true;
          nextBtn.textContent = ar ? 'جاري إرسال الطلب...' : 'Placing order...';
          await sendMessage({ value: '__order__:submit_details:' + JSON.stringify(payload), silent: false });
        });
      }
    } else if (status === 'address_confirmation') {
      const actionBarEl = refs.dashboard.querySelector('.cb-dash-action-bar');
      if (actionBarEl && actionBarEl.dataset.sig !== 'addr-confirm') {
        actionBarEl.dataset.sig = 'addr-confirm';
        actionBarEl.innerHTML = `
          <button type="button" class="cb-dash-btn-primary cb-dash-btn-final-confirm">
            ${state.language === 'ar' ? 'تأكيد نهائي وإرسال الطلب' : 'Confirm and Place Order'}
          </button>
          <button type="button" class="cb-choice secondary cb-dash-btn-rewrite-address" style="width:100%;padding:11px;font-weight:600;margin:0;">
            ${state.language === 'ar' ? 'تعديل العنوان' : 'Rewrite Address'}
          </button>
        `;

        actionBarEl.querySelector('.cb-dash-btn-final-confirm').addEventListener('click', async () => {
          const btn = actionBarEl.querySelector('.cb-dash-btn-final-confirm');
          btn.disabled = true;
          btn.textContent = state.language === 'ar' ? 'جاري إرسال الطلب...' : 'Submitting order...';
          await sendMessage({ value: '__order__:confirm_address', silent: false });
        });

        actionBarEl.querySelector('.cb-dash-btn-rewrite-address').addEventListener('click', async () => {
          await sendMessage({ value: '__order__:rewrite_address', silent: false });
        });
      }
    }
  }

  function openPanel(force) {
    state.open = force !== undefined ? force : !state.open;
    refs.root.classList.toggle('open', state.open);
    if (state.open) {
      refs.bubble.classList.remove('has-unread');
      clearUnreadPreview();
      if (!state.orderDashboardActive && !refs.input.disabled) {
        refs.input.focus();
      } else if (state.orderDashboardActive) {
        const searchInput = refs.dashboard.querySelector('.cb-dash-search-input');
        if (searchInput) {
          searchInput.focus();
        } else {
          const textarea = refs.dashboard.querySelector('.cb-address-textarea');
          if (textarea) textarea.focus();
        }
      }
    }
  }

  function buildWidget(cafe) {
    createStyles({
      primary: cafe.primary_color || '#17443a',
    });

    const root = document.createElement('div');
    root.className = 'cb-root';
    root.innerHTML = `
      <button class="cb-bubble" type="button" aria-label="Open chatbot">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3C6.477 3 2 6.91 2 11.733c0 2.143.904 4.106 2.41 5.622L3.3 21l4.575-1.527c1.228.46 2.567.705 3.995.705 5.523 0 10-3.91 10-8.445S17.523 3 12 3Z"></path>
        </svg>
        <span class="cb-bubble-tip"></span>
      </button>
      <section class="cb-panel" aria-label="Chatbot panel">
        <header class="cb-header">
          <div class="cb-brand">
            ${cafe.logo_url ? `<img class="cb-logo" src="${cafe.logo_url}" alt="${cafe.name}">` : `
              <div class="cb-logo" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.15);">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 8V4H8"></path>
                  <rect width="16" height="12" x="4" y="8" rx="2"></rect>
                  <path d="M2 14h2"></path>
                  <path d="M20 14h2"></path>
                  <path d="M15 13v2"></path>
                  <path d="M9 13v2"></path>
                </svg>
              </div>
            `}
            <div class="cb-brand-text">
              <div class="cb-brand-name">${cafe.name}</div>
              <div class="cb-brand-sub">Instant support</div>
            </div>
          </div>
          <div>
            <button type="button" class="cb-close cb-new" aria-label="Start new chat">&#8635;</button>
            <button type="button" class="cb-close" aria-label="Close chatbot">&times;</button>
          </div>
        </header>
        <div class="cb-messages"></div>
        <footer class="cb-footer">
          <div class="cb-footer-scroller">
            <div class="cb-order"></div>
            <div class="cb-choice-row"></div>
            <div class="cb-suggestions"></div>
          </div>
          <div class="cb-form">
            <input class="cb-input" type="text" placeholder="Type your message..." />
            <button class="cb-send" type="button" aria-label="Send message">&#10148;</button>
          </div>
        </footer>
        <div class="cb-order-dashboard"></div>
      </section>
    `;

    document.body.appendChild(root);

    return {
      root,
      bubble: root.querySelector('.cb-bubble'),
      bubbleTip: root.querySelector('.cb-bubble-tip'),
      newChat: root.querySelector('.cb-new'),
      close: root.querySelector('.cb-close:not(.cb-new)'),
      messages: root.querySelector('.cb-messages'),
      order: root.querySelector('.cb-order'),
      choices: root.querySelector('.cb-choice-row'),
      suggestions: root.querySelector('.cb-suggestions'),
      brandSub: root.querySelector('.cb-brand-sub'),
      footer: root.querySelector('.cb-footer'),
      input: root.querySelector('.cb-input'),
      send: root.querySelector('.cb-send'),
      dashboard: root.querySelector('.cb-order-dashboard'),
    };
  }

  async function initSession(forceNew) {
    let payload;
    try {
      payload = await postJson('/api/init', {
        session_key: state.sessionKey,
        force_new: Boolean(forceNew),
        order_dashboard_active: state.orderDashboardActive,
      });
    } catch (error) {
      if (error && error.payload && error.payload.error === 'invalid_token') return;
      return;
    }

    state.sessionKey = payload.session_key;
    state.language = payload.language || 'en';
    state.cafe = payload.cafe;
    state.automated = payload.automated !== false;
    persistSession();

    return payload;
  }

  function applyPayloadUi(payload) {
    if (!payload) return;

    if (payload.order_suggestions) {
      state.orderSuggestions = Array.isArray(payload.order_suggestions) ? payload.order_suggestions.slice(0, 10) : [];
    } else if (payload.response && payload.response.order_suggestions) {
      state.orderSuggestions = Array.isArray(payload.response.order_suggestions) ? payload.response.order_suggestions.slice(0, 10) : [];
    }

    if (state.orderSuggestions.length === 0) {
      state.orderInputMode = 'search';
    } else if (!state.orderInputMode) {
      state.orderInputMode = 'suggestions';
    }

    const incomingSuggestions = payload.suggestions || (payload.response && payload.response.suggestions) || [];
    state.chitchatSuggestions = Array.isArray(incomingSuggestions) ? incomingSuggestions.slice(0, 10) : [];
    state.currentSuggestions = state.chitchatSuggestions;

    applyUiState(payload.ui_state || (payload.response && payload.response.ui_state) || emptyUiState());
    setInputPlaceholder();
    updateChatModeUi();
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.sessionKey || !refs || state.isSending || state.isTypingReply) return;
      try {
        const payload = await initSession(false);
        if (!payload || state.isSending || state.isTypingReply) return;
        state.language = payload.language || state.language;
        state.automated = payload.automated !== false;
        syncIncomingHistory(payload.history, state.language);
        applyPayloadUi(payload);
      } catch {}
    }, 3000);
  }

  function showTyping() {
    removeTyping();
    const wrapper = document.createElement('div');
    wrapper.className = 'cb-msg bot';
    wrapper.innerHTML = '<div class="cb-typing"><span></span><span></span><span></span></div>';
    refs.messages.appendChild(wrapper);
    refs.messages.scrollTop = refs.messages.scrollHeight;
    state.typingEl = wrapper;
  }

  function removeTyping() {
    if (state.typingEl) {
      state.typingEl.remove();
      state.typingEl = null;
    }
  }

  async function sendMessage(forcedInput) {
    const isObjectInput = forcedInput && typeof forcedInput === 'object' && !Array.isArray(forcedInput);
    const requestText = isObjectInput ? String(forcedInput.value || '').trim() : String(forcedInput || refs.input.value || '').trim();
    const displayText = isObjectInput ? String(forcedInput.displayText || forcedInput.value || '').trim() : requestText;
    const silent = Boolean(isObjectInput && forcedInput.silent);
    const syncEditTime = state.lastCartEditTime;

    if (!requestText) return;
    if (!forcedInput && refs.send.disabled) return;
    const isLocked = state.automated && state.uiState.input_locked && (!state.uiState.order_draft || state.orderDashboardActive);
    if (isLocked && !forcedInput) return;

    if (!silent) {
      refs.input.value = '';
      appendMessage(displayText, 'user', state.language);
      state.history.push({ role: 'user', content: displayText });
    }

    if (state.automated && !silent) showTyping();
    if (!silent) {
      state.isSending = true;
      syncComposerState();
    }

    try {
      const startTime = Date.now();
      state.lastRequestTime = startTime;

      const payload = await postJson('/api/message', {
        session_key: state.sessionKey,
        message: requestText,
        order_dashboard_active: state.orderDashboardActive,
      });

      // If a newer silent request was sent, ignore this one's UI update to prevent flicker
      if (silent && startTime < state.lastRequestTime) return;

      if (silent && syncEditTime === state.lastCartEditTime) {
        state.cartSyncPending = false;
      }

      // Brief floor so the typing indicator doesn't flash for instant replies,
      // but small enough to keep the full response well under ~2s.
      const elapsed = Date.now() - startTime;
      if (!silent && elapsed < 350) {
        await new Promise((resolve) => setTimeout(resolve, 350 - elapsed));
      }

      state.language = payload.language || state.language;
      state.automated = payload.automated !== false;
      removeTyping();

      if (payload.reset) {
        renderHistory(payload.history || [], state.language);
        applyPayloadUi(payload);
        return;
      }

      if (payload.response && payload.response.buttons) {
        renderButtons(payload.response.buttons);
      }

      if (payload.intent === 'order_existing' || payload.intent === 'order_started') {
        state.orderDashboardActive = true;
      }

      applyPayloadUi(payload);

      if (payload.response && Array.isArray(payload.response.messages) && payload.response.messages.length > 0) {
        // Multi-item reply: render each bubble with its own thumbnail, exactly as
        // the backend split them (shared image once, or one image per item).
        state.isTypingReply = true;
        // Share the total typing budget across all bubbles so the whole reply
        // finishes within ~2.7s, not 2.7s per bubble.
        const perMsgBudget = Math.floor(2700 / payload.response.messages.length);
        for (const msg of payload.response.messages) {
          const thumb = msg.thumbnail || null;
          state.history.push({ role: 'bot', content: msg.text, thumbnail: thumb });
          await typeMessage(msg.text, 'bot', state.language, thumb, perMsgBudget);
        }
      } else if (payload.response && payload.response.text) {
        state.history.push({ role: 'bot', content: payload.response.text, thumbnail: payload.response.thumbnail });
        state.isTypingReply = true;
        await typeMessage(payload.response.text, 'bot', state.language, payload.response.thumbnail);
      }
    } catch (_error) {
      removeTyping();
      // A silent request is a background sync/add (cart sync, item add). If it
      // fails we must NOT show the scary fallback or wipe the order container —
      // that's what was kicking users out of the dashboard on rapid taps. Leave
      // the current UI intact; the next user-driven request will re-sync state.
      if (!silent) {
        const fallback = state.language === 'ar'
          ? `حدث خطأ ما. تواصل معنا على ${state.cafe && state.cafe.phone ? state.cafe.phone : 'رقم الهاتف'}.`
          : `Something went wrong. Contact us at ${state.cafe && state.cafe.phone ? state.cafe.phone : 'our phone number'}.`;
        appendMessage(fallback, 'bot', state.language);
        // Deliberately NOT pushed into state.history: the backend never saved this
        // client-only error bubble, so if we added it here the next 3s poll would
        // see state.history longer than the server's, fail the same-prefix check,
        // and renderHistory() would WIPE the whole thread — making this very
        // message "fade out". Keeping it DOM-only lets the prefix stay in sync so
        // the error stays visible until the conversation naturally moves on.
        applyUiState(emptyUiState());
      }
    } finally {
      state.isSending = false;
      state.isTypingReply = false;
      syncComposerState();
      if (!state.orderDashboardActive && !refs.input.disabled) refs.input.focus();
    }
  }

  async function startNewChat() {
    state.orderInputMode = null;
    clearStoredSession();
    const payload = await initSession(true);
    if (!payload) return;
    renderHistory(payload.history, payload.language);
    applyPayloadUi(payload);
    startPolling();
    openPanel(true);
  }

  async function init() {
    loadStoredSession();
    const payload = await initSession(false);
    if (!payload) return;

    refs = buildWidget({
      // Brand name in the header is ALWAYS the English name (never switches to
      // name_ar with the chat language). Falls back to name_ar only if there is
      // no English name at all.
      name: payload.cafe.name || payload.cafe.name_ar,
      logo_url: payload.cafe.logo_url,
      primary_color: payload.cafe.primary_color,
    });

    refs.bubble.addEventListener('click', () => openPanel());
    refs.newChat.addEventListener('click', () => startNewChat());
    refs.close.addEventListener('click', () => openPanel(false));
    refs.send.addEventListener('click', () => sendMessage());
    refs.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sendMessage();
    });

    renderHistory(payload.history, payload.language);
    applyPayloadUi(payload);
    startPolling();

    // No auto-open on load — just surface the unread mark + a short preview
    // of the last bot message (if the guest hasn't replied to it yet) so
    // they're nudged to open the chat themselves.
    const lastMessage = state.history[state.history.length - 1];
    if (lastMessage && lastMessage.role === 'bot' && !state.open) {
      refs.bubble.classList.add('has-unread');
      showUnreadPreview(lastMessage.content);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
