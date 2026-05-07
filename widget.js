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
    pollTimer: null,
    isSending: false,
    isTypingReply: false,
  };

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
      .cb-bubble::after {
        content: "Ask us";
        position: absolute;
        right: 78px;
        white-space: nowrap;
        background: var(--cb-surface);
        color: var(--cb-text);
        border: 1px solid var(--cb-border);
        padding: 10px 14px;
        border-radius: 999px;
        font-size: 13px;
        opacity: 0.96;
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
      .cb-root.open .cb-bubble::after { display: none; }
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
      .cb-status-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        padding: 5px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(255,255,255,0.16);
      }
      .cb-status-chip.live {
        background: rgba(255,255,255,0.24);
      }
      .cb-close {
        width: 38px;
        height: 38px;
        border-radius: 999px;
        border: 0;
        background: rgba(255,255,255,0.14);
        color: #fff;
        cursor: pointer;
      }
      .cb-messages {
        flex: 1;
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
      .cb-actions, .cb-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 2px;
      }
      .cb-action, .cb-chip {
        border-radius: 999px;
        padding: 6px 12px;
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
        padding: 14px;
        background: rgba(255,255,255,0.9);
        border-top: 1px solid var(--cb-border);
      }
      .cb-footer.live-mode .cb-suggestions {
        display: none;
      }
      .cb-root.live-mode .cb-actions {
        display: none;
      }
      .cb-form {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cb-input {
        flex: 1;
        border: 1px solid var(--cb-border);
        border-radius: 999px;
        padding: 12px 14px;
        font-size: 14px;
        outline: none;
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
        .cb-root { right: 12px; bottom: 12px; left: 12px; }
        .cb-panel { width: 100%; height: min(60vh, 540px); }
        .cb-bubble::after { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function appendMessage(text, role, lang, allowAutoOpen) {
    const message = document.createElement('div');
    message.className = `cb-msg ${role}`;
    message.dir = lang === 'ar' ? 'rtl' : 'ltr';
    message.textContent = text;
    refs.messages.appendChild(message);
    refs.messages.scrollTop = refs.messages.scrollHeight;
    if (allowAutoOpen !== false && role === 'bot' && !state.open) {
      // openPanel(true); // Disable auto-open to show the badge instead
      refs.root.querySelector('.cb-bubble').classList.add('has-unread');
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
        playNotifySound();
      }
      return notice;
    }

    const message = appendMessage(entry.content, entry.role, lang, allowAutoOpen);
    if (entry.intent === 'admin_manual') {
      message.classList.add('support');
    }
    return message;
  }

  async function typeMessage(text, role, lang) {
    const message = appendMessage('', role, lang, false);
    for (let i = 0; i < text.length; i++) {
      message.textContent += text[i];
      refs.messages.scrollTop = refs.messages.scrollHeight;
      await new Promise(r => setTimeout(r, 12));
    }
    if (!state.open) {
      refs.bubble.classList.add('has-unread');
      playNotifySound();
    }
    return message;
  }

  function playNotifySound() {
    try {
      const audio = new Audio('https://fonts.gstatic.com/s/i/productlogos/googleg/v6/web-24dp/logo_googleg_color_24dp.png'); // Placeholder or better sound
      // Real sound link
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
      return;
    }

    const additions = nextHistory.slice(state.history.length);
    additions.forEach((message) => {
      renderMessageEntry(message, lang, !state.open);
    });
    state.history = nextHistory.map((message) => ({ ...message }));
    state.hasHistory = Boolean(state.history.length);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.sessionKey || !refs || state.isSending || state.isTypingReply) return;
      try {
        const payload = await initSession(false);
        if (!payload) return;
        if (state.isSending || state.isTypingReply) return;
        state.language = payload.language || state.language;
        state.automated = payload.automated !== false;
        syncIncomingHistory(payload.history, state.language);
        renderSuggestions(payload.suggestions);
        setInputPlaceholder();
        updateChatModeUi();
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
    refs.suggestions.innerHTML = '';
    if (!state.automated) return;
    (list || []).slice(0, 4).forEach((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cb-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => sendMessage(text));
      refs.suggestions.appendChild(chip);
    });
  }

  function setInputPlaceholder() {
    if (!refs || !refs.input) return;
    refs.input.placeholder = state.language === 'ar' ? 'اكتب رسالتك...' : 'Type your message...';
  }

  function updateChatModeUi() {
    if (!refs) return;
    refs.root.classList.toggle('live-mode', !state.automated);
    // refs.statusChip.textContent = state.automated
    //   ? (state.language === 'ar' ? 'مساعد آلي' : 'Automated assistant')
    //   : (state.language === 'ar' ? 'دعم بشري مباشر' : 'Live customer support');
    refs.statusChip.classList.toggle('live', !state.automated);
    refs.brandSub.textContent = state.automated
      ? (state.language === 'ar' ? 'مساعدة فورية' : 'Instant support')
      : (state.language === 'ar' ? 'تم تحويل المحادثة إلى خدمة العملاء' : 'Chat handed to customer support');
    refs.footer.classList.toggle('live-mode', !state.automated);
  }

  function openPanel(force) {
    state.open = force !== undefined ? force : !state.open;
    refs.root.classList.toggle('open', state.open);
    if (state.open) {
      refs.bubble.classList.remove('has-unread');
      refs.input.focus();
    }
  }

  async function sendMessage(forcedText) {
    const text = (forcedText || refs.input.value || '').trim();
    if (!text || refs.send.disabled) return;

    refs.input.value = '';
    appendMessage(text, 'user', state.language);
    state.history.push({ role: 'user', content: text });
    if (state.automated) showTyping();
    refs.send.disabled = true;
    state.isSending = true;

    try {
      const startTime = Date.now();
      const payload = await postJson('/api/message', {
        session_key: state.sessionKey,
        message: text,
      });

      const elapsed = Date.now() - startTime;
      if (elapsed < 800) await new Promise(r => setTimeout(r, 800 - elapsed));

      state.language = payload.language || state.language;
      removeTyping();
      if (payload.reset) {
        state.automated = payload.automated !== false;
        renderHistory(payload.history || [], state.language);
        renderSuggestions(payload.response?.suggestions || []);
        setInputPlaceholder();
        updateChatModeUi();
        return;
      }
      state.automated = payload.automated !== false;
      updateChatModeUi();
      if (!payload.response || !payload.response.text) {
        renderSuggestions(payload.suggestions || []);
        setInputPlaceholder();
        return;
      }
      state.history.push({ role: 'bot', content: payload.response.text });
      state.isTypingReply = true;
      await typeMessage(payload.response.text, 'bot', state.language);
      renderButtons(payload.response.buttons);
      renderSuggestions(payload.response.suggestions);
      setInputPlaceholder();
    } catch (_error) {
      removeTyping();
      const fallback = state.language === 'ar'
        ? `حصل خطأ. تواصل معنا على ${state.cafe.phone || 'رقم التواصل'}.`
        : `Something went wrong. Contact us at ${state.cafe.phone || 'our phone number'}.`;
      appendMessage(fallback, 'bot', state.language);
      state.history.push({ role: 'bot', content: fallback });
    } finally {
      state.isSending = false;
      state.isTypingReply = false;
      refs.send.disabled = false;
      refs.input.focus();
    }
  }

  function buildWidget(cafe) {
    createStyles({
      primary: cafe.primary_color || '#17443a'
    });

    const root = document.createElement('div');
    root.className = 'cb-root';
    root.innerHTML = `
      <button class="cb-bubble" type="button" aria-label="Open chatbot">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3C6.477 3 2 6.91 2 11.733c0 2.143.904 4.106 2.41 5.622L3.3 21l4.575-1.527c1.228.46 2.567.705 3.995.705 5.523 0 10-3.91 10-8.445S17.523 3 12 3Z"></path>
        </svg>
      </button>
      <section class="cb-panel" aria-label="Chatbot panel">
        <header class="cb-header">
          <div class="cb-brand">
            ${cafe.logo_url ? `<img class="cb-logo" src="${cafe.logo_url}" alt="${cafe.name}">` : `
              <div class="cb-logo" style="display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.15);">
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
            <button type="button" class="cb-close cb-new" aria-label="Start new chat">↺</button>
            <button type="button" class="cb-close" aria-label="Close chatbot">×</button>
          </div>
        </header>
        <div class="cb-messages"></div>
        <footer class="cb-footer">
          <div class="cb-suggestions"></div>
          <div class="cb-form">
            <input class="cb-input" type="text" placeholder="Type your message..." />
            <button class="cb-send" type="button" aria-label="Send message">➜</button>
          </div>
        </footer>
      </section>
    `;

    document.body.appendChild(root);

    return {
      root,
      bubble: root.querySelector('.cb-bubble'),
      newChat: root.querySelector('.cb-new'),
      close: root.querySelector('.cb-close:not(.cb-new)'),
      messages: root.querySelector('.cb-messages'),
      suggestions: root.querySelector('.cb-suggestions'),
      brandSub: root.querySelector('.cb-brand-sub'),
      statusChip: root.querySelector('.cb-status-chip'),
      footer: root.querySelector('.cb-footer'),
      input: root.querySelector('.cb-input'),
      send: root.querySelector('.cb-send'),
    };
  }

  let refs;

  async function initSession(forceNew) {
    let payload;
    try {
      payload = await postJson('/api/init', { session_key: state.sessionKey, force_new: Boolean(forceNew) });
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

  async function startNewChat() {
    clearStoredSession();
    const payload = await initSession(true);
    if (!payload) return;
    renderHistory(payload.history, payload.language);
    renderSuggestions(payload.suggestions);
    setInputPlaceholder();
    updateChatModeUi();
    startPolling();
    openPanel(true);
  }

  async function init() {
    loadStoredSession();
    const payload = await initSession(false);
    if (!payload) return;

    refs = buildWidget({
      name: state.language === 'ar' ? payload.cafe.name_ar || payload.cafe.name : payload.cafe.name,
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
    renderSuggestions(payload.suggestions);
    setInputPlaceholder();
    updateChatModeUi();
    startPolling();

    if (payload.is_new || !state.hasHistory) {
      openPanel(true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
