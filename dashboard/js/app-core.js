/* ═══════ STATE ═══════ */
const state = {
  token: localStorage.getItem('eglotech_dashboard_token') || '',
  user: null,
  cafes: [],
  selectedCafe: null,
  menu: [],
  sessions: [],
  menuPage: 1,
  menuFilter: {
    search: '',
    category: 'all',
    availability: 'all',
  },
  sessionsPage: 1,
  sessionFilter: {},
  orders: [],
  ordersPage: 1,
  ordersFilter: {
    search: '',
    status: 'all',
  },
  MENU_PER_PAGE: 15,
  SESSIONS_PER_PAGE: 20,
  ORDERS_PER_PAGE: 15,
  // Chat polling
  activeSessionChatId: null,
  activeSessionChatSignature: '',
  sessionChatPollTimer: null,
};

/* ═══════ API HELPER ═══════ */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request_failed');
  return data;
}

/* ═══════ LOADING BUTTON HELPER ═══════ */
function btnLoad(btn, loading) {
  const t = btn.querySelector('.btn-text');
  const l = btn.querySelector('.btn-loader');
  if (!t || !l) return;
  if (loading) {
    t.classList.add('hidden');
    l.classList.remove('hidden');
    btn.disabled = true;
  } else {
    t.classList.remove('hidden');
    l.classList.add('hidden');
    btn.disabled = false;
  }
}

function showLoader() { document.getElementById('page-loader').classList.remove('hidden'); }
function hideLoader() { document.getElementById('page-loader').classList.add('hidden'); }

function toast(msg, icon = 'success') {
  Swal.fire({ toast: true, position: 'top-end', icon, title: msg, showConfirmButton: false, timer: 2500, timerProgressBar: true, background: '#161b22', color: '#e6edf3' });
}
function toastErr(msg) { toast(msg, 'error'); }

/* ═══════ NAVIGATION ═══════ */
function getCurrentPage() {
  return document.querySelector('.page.active')?.id.replace('page-', '') || 'home';
}

function getCurrentRoute() {
  const page = getCurrentPage();
  return {
    page,
    cafeId: page === 'edit-cafe' ? Number(state.selectedCafe?.id || 0) || null : null,
  };
}

function parseHashRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  if (!raw) return { page: 'home', cafeId: null };

  const [page, maybeId] = raw.split('/');
  if (page === 'edit-cafe') {
    const cafeId = Number(maybeId);
    return {
      page,
      cafeId: Number.isFinite(cafeId) && cafeId > 0 ? cafeId : null,
    };
  }

  if (['home', 'all-cafes', 'add-cafe', 'ai-usage'].includes(page)) {
    return { page, cafeId: null };
  }

  return { page: 'home', cafeId: null };
}

function syncHashRoute(page, { cafeId = null, replace = false } = {}) {
  const nextHash = page === 'edit-cafe' && cafeId ? `#/edit-cafe/${cafeId}` : `#/${page}`;
  if (window.location.hash === nextHash) return;
  if (replace) {
    window.history.replaceState(null, '', nextHash);
    return;
  }
  window.location.hash = nextHash;
}

async function applyRouteFromHash({ replace = false } = {}) {
  if (!state.token || !state.user) return;

  const route = parseHashRoute();
  const current = getCurrentRoute();
  if (route.page === current.page && Number(route.cafeId || 0) === Number(current.cafeId || 0)) return;

  if (route.page === 'edit-cafe') {
    if (route.cafeId) {
      await selectCafe(route.cafeId, { updateHash: false });
      return;
    }
    if (state.selectedCafe?.id) {
      navigateTo('edit-cafe', { updateHash: false });
      return;
    }
    navigateTo('all-cafes', { updateHash: false });
    if (replace) syncHashRoute('all-cafes', { replace: true });
    return;
  }

  navigateTo(route.page, { updateHash: false });
  if (replace) syncHashRoute(route.page, { replace: true });
}

function navigateTo(page, { updateHash = true, replaceHash = false } = {}) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const nb = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (nb) nb.classList.add('active');
  document.querySelector('.sidebar')?.classList.remove('open');
  if (page === 'ai-usage' && typeof loadAiUsage === 'function') loadAiUsage();
  if (updateHash) {
    syncHashRoute(page, {
      cafeId: page === 'edit-cafe' ? state.selectedCafe?.id : null,
      replace: replaceHash,
    });
  }
}

document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

window.addEventListener('hashchange', () => {
  applyRouteFromHash();
});

// Mobile menu toggle
document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

const mobileNavMedia = window.matchMedia('(max-width: 1100px)');

function syncSidebarState(e = mobileNavMedia) {
  if (!e.matches) {
    document.querySelector('.sidebar')?.classList.remove('open');
  }
}

if (typeof mobileNavMedia.addEventListener === 'function') {
  mobileNavMedia.addEventListener('change', syncSidebarState);
} else if (typeof mobileNavMedia.addListener === 'function') {
  mobileNavMedia.addListener(syncSidebarState);
}

document.addEventListener('click', e => {
  if (!mobileNavMedia.matches) return;
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (!sidebar?.classList.contains('open')) return;
  if (sidebar.contains(e.target) || toggle?.contains(e.target)) return;
  sidebar.classList.remove('open');
});

syncSidebarState();

/* ═══════ ACCORDION ═══════ */
document.querySelectorAll('.accordion-header').forEach(header => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('open');
  });
});

/* ═══════ COLOR HEX DISPLAY ═══════ */
document.querySelectorAll('input[type="color"]').forEach(inp => {
  const hex = inp.parentElement.querySelector('.color-hex');
  if (hex) {
    hex.textContent = inp.value;
    inp.addEventListener('input', () => { hex.textContent = inp.value; });
  }
});

/* ═══════ AR POPUP TOGGLE ═══════ */
document.querySelectorAll('.btn-ar-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.arTarget;
    const arField = document.getElementById(targetId);
    if (!arField) return;
    const isTextarea = arField.tagName === 'TEXTAREA';
    Swal.fire({
      title: 'Arabic Version',
      input: isTextarea ? 'textarea' : 'text',
      inputValue: arField.value || '',
      inputAttributes: { dir: 'rtl', style: 'font-size:15px' },
      showCancelButton: true,
      confirmButtonText: 'Save',
      cancelButtonText: 'Cancel',
    }).then(r => { if (r.isConfirmed) arField.value = r.value; });
  });
});

/* ═══════ LOGIN ═══════ */
function setLoggedIn(yes) {
  document.getElementById('login-page').classList.toggle('hidden', yes);
  document.getElementById('dashboard-shell').classList.toggle('hidden', !yes);
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btnLoad(btn, true);
  try {
    const result = await api('/dashboard/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem('eglotech_dashboard_token', state.token);
    document.getElementById('user-meta').textContent = `${state.user.username} (${state.user.role})`;
    setLoggedIn(true);
    await refreshCafes();
    await applyRouteFromHash({ replace: true });
    toast('Welcome back!');
  } catch (err) {
    toastErr(err.message || 'Login failed');
  } finally {
    btnLoad(btn, false);
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  Swal.fire({
    title: 'Logout?',
    text: 'You will be signed out.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Logout',
  }).then(r => {
    if (r.isConfirmed) {
      if (typeof stopGlobalSessionsPoller === 'function') stopGlobalSessionsPoller();
      localStorage.removeItem('eglotech_dashboard_token');
      window.location.reload();
    }
  });
});

/* ═══════ CAFE LIST (ALL CAFES TABLE) ═══════ */
async function refreshCafes(selectId) {
  showLoader();
  try {
    state.cafes = await api('/dashboard/businesses');
    renderCafesTable();
    updateHomeStats();
    if (selectId) await selectCafe(selectId);
  } catch (err) {
    toastErr('Failed to load businesses');
  } finally {
    hideLoader();
  }
}

function updateHomeStats() {
  document.getElementById('stat-cafes').textContent = state.cafes.length;
  document.getElementById('stat-active').textContent = state.cafes.filter(c => c.active).length;
  document.getElementById('stat-inactive').textContent = state.cafes.filter(c => !c.active).length;
}

function renderCafesTable() {
  const tbody = document.getElementById('cafes-tbody');
  const empty = document.getElementById('cafes-empty');
  const search = (document.getElementById('cafe-search').value || '').toLowerCase();
  const status = document.getElementById('cafe-filter-status').value;

  let filtered = state.cafes.filter(c => {
    if (search && !c.name.toLowerCase().includes(search) && !(c.phone || '').toLowerCase().includes(search)) return false;
    if (status === 'active' && !c.active) return false;
    if (status === 'paused' && c.active) return false;
    return true;
  });

  tbody.innerHTML = '';
  if (!filtered.length) {
    document.querySelector('.table-wrap').classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  document.querySelector('.table-wrap').classList.remove('hidden');
  empty.classList.add('hidden');

  filtered.forEach(cafe => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(cafe.name)}</strong></td>
      <td>${esc(cafe.phone || '-')}</td>
      <td>${esc(cafe.email || '-')}</td>
      <td><span class="badge ${cafe.active ? 'badge-active' : 'badge-paused'}"><i class="fas fa-circle" style="font-size:6px"></i> ${cafe.active ? 'Active' : 'Paused'}</span></td>
      <td class="table-actions">
        <button class="btn btn-outline btn-sm" data-edit="${cafe.id}" title="Edit"><i class="fas fa-pen"></i></button>
        <button class="btn btn-ghost btn-sm" data-toggle="${cafe.id}" title="Toggle status"><i class="fas fa-power-off"></i></button>
      </td>`;
    tr.querySelector('[data-edit]').addEventListener('click', () => selectCafe(cafe.id));
    tr.querySelector('[data-toggle]').addEventListener('click', () => toggleCafe(cafe.id));
    tbody.appendChild(tr);
  });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.getElementById('cafe-search').addEventListener('input', renderCafesTable);
document.getElementById('cafe-filter-status').addEventListener('change', renderCafesTable);
document.getElementById('refresh-cafes-btn').addEventListener('click', () => refreshCafes());

async function toggleCafe(id) {
  try {
    const r = await api(`/dashboard/businesses/${id}/toggle`, { method: 'PATCH' });
    toast(r.active ? 'Business activated' : 'Business paused');
    await refreshCafes();
  } catch (err) { toastErr(err.message); }
}

/* ═══════ CREATE CAFE ═══════ */
document.getElementById('create-cafe-btn').addEventListener('click', async () => {
  const btn = document.getElementById('create-cafe-btn');
  const name = document.getElementById('new-cafe-name').value.trim();
  if (!name) return toastErr('Business name is required');
  btnLoad(btn, true);
  try {
    const result = await api('/dashboard/businesses', {
      method: 'POST',
      body: JSON.stringify({
        name,
        service_type: document.getElementById('new-business-service-type').value,
        name_ar: document.getElementById('new-cafe-name-ar').value.trim(),
        phone: document.getElementById('new-cafe-phone').value.trim(),
        email: document.getElementById('new-cafe-email').value.trim(),
        primary_color: document.getElementById('new-cafe-color').value,
      }),
    });
    toast('Business created successfully!');
    // Clear form
    document.getElementById('new-cafe-name').value = '';
    document.getElementById('new-cafe-name-ar').value = '';
    document.getElementById('new-cafe-phone').value = '';
    document.getElementById('new-cafe-email').value = '';
    await refreshCafes(result.id);
    navigateTo('edit-cafe');
  } catch (err) { toastErr(err.message); }
  finally { btnLoad(btn, false); }
});

/* ═══════ SELECT & EDIT CAFE ═══════ */
function parseTextareaList(v) {
  return String(v || '').split('\n').map(l => l.trim()).filter(Boolean);
}

/* ═══════ FAQ EDITOR (friendly Q/A repeater) ═══════
   DB still stores two independent JSON arrays (faq_en / faq_ar). The UI pairs
   them by row so each English question can carry its Arabic translation; rows
   with no Arabic simply don't contribute to faq_ar (counts can differ). */
function makeFaqRow(data = {}) {
  const row = document.createElement('div');
  row.className = 'faq-row';
  const hasAr = Boolean(String(data.q_ar || '').trim() || String(data.a_ar || '').trim());
  row.innerHTML = `
    <div class="faq-row-main">
      <span class="faq-row-num"></span>
      <div class="faq-row-fields">
        <input type="text" class="faq-q-en" placeholder="Question (EN) — e.g. Do you have wifi?" />
        <textarea class="faq-a-en" rows="1" placeholder="Answer (EN)"></textarea>
      </div>
      <div class="faq-row-actions">
        <button type="button" class="faq-ar-btn${hasAr ? ' open' : ''}" title="Arabic translation">ع</button>
        <button type="button" class="faq-del-btn" title="Remove question">&times;</button>
      </div>
    </div>
    <div class="faq-ar-fields"${hasAr ? '' : ' style="display:none"'}>
      <input type="text" class="faq-q-ar" dir="rtl" placeholder="السؤال بالعربي" />
      <textarea class="faq-a-ar" dir="rtl" rows="1" placeholder="الإجابة بالعربي"></textarea>
    </div>`;
  row.querySelector('.faq-q-en').value = data.q_en || '';
  row.querySelector('.faq-a-en').value = data.a_en || '';
  row.querySelector('.faq-q-ar').value = data.q_ar || '';
  row.querySelector('.faq-a-ar').value = data.a_ar || '';
  return row;
}

function renumberFaqRows() {
  document.querySelectorAll('#cafe-faq-list .faq-row .faq-row-num')
    .forEach((el, i) => { el.textContent = 'Q' + (i + 1); });
}

function renderFaqEditor(faqEn, faqAr) {
  const list = document.getElementById('cafe-faq-list');
  if (!list) return;
  list.innerHTML = '';
  const en = Array.isArray(faqEn) ? faqEn : [];
  const ar = Array.isArray(faqAr) ? faqAr : [];
  const count = Math.max(en.length, ar.length);
  for (let i = 0; i < count; i++) {
    list.appendChild(makeFaqRow({
      q_en: en[i] && en[i].q, a_en: en[i] && en[i].a,
      q_ar: ar[i] && ar[i].q, a_ar: ar[i] && ar[i].a,
    }));
  }
  if (count === 0) list.appendChild(makeFaqRow());
  renumberFaqRows();
}

function collectFaq() {
  const faq_en = [];
  const faq_ar = [];
  document.querySelectorAll('#cafe-faq-list .faq-row').forEach((row) => {
    const qen = row.querySelector('.faq-q-en').value.trim();
    const aen = row.querySelector('.faq-a-en').value.trim();
    const qar = row.querySelector('.faq-q-ar').value.trim();
    const aar = row.querySelector('.faq-a-ar').value.trim();
    if (qen && aen) faq_en.push({ q: qen, a: aen });
    if (qar && aar) faq_ar.push({ q: qar, a: aar });
  });
  return { faq_en, faq_ar };
}

(function initFaqEditor() {
  const list = document.getElementById('cafe-faq-list');
  const addBtn = document.getElementById('cafe-faq-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      document.getElementById('cafe-faq-list').appendChild(makeFaqRow());
      renumberFaqRows();
    });
  }
  if (list) {
    list.addEventListener('click', (e) => {
      const arBtn = e.target.closest('.faq-ar-btn');
      if (arBtn) {
        const fields = arBtn.closest('.faq-row').querySelector('.faq-ar-fields');
        const show = fields.style.display === 'none' || !fields.style.display;
        fields.style.display = show ? '' : 'none';
        arBtn.classList.toggle('open', show);
        return;
      }
      const delBtn = e.target.closest('.faq-del-btn');
      if (delBtn) {
        const row = delBtn.closest('.faq-row');
        const parent = row.parentElement;
        row.remove();
        if (!parent.querySelector('.faq-row')) parent.appendChild(makeFaqRow());
        renumberFaqRows();
      }
    });
  }
})();

async function selectCafe(id, { updateHash = true } = {}) {
  showLoader();
  // Stop any previous poller when switching business
  if (typeof stopGlobalSessionsPoller === 'function') stopGlobalSessionsPoller();
  try {
    state.selectedCafe = await api(`/dashboard/businesses/${id}`);
    fillEditor();
    navigateTo('edit-cafe', { updateHash: false });
    state.menuPage = 1;
    state.sessionsPage = 1;
    state.ordersPage = 1;
    await Promise.all([loadMenu(), loadSessions(), loadOrders()]);
    if (updateHash) syncHashRoute('edit-cafe', { cafeId: state.selectedCafe.id });
    // Start live notification poller after initial sessions load
    if (typeof startGlobalSessionsPoller === 'function') startGlobalSessionsPoller();
  } catch (err) { toastErr(err.message); }
  finally { hideLoader(); }
}

function fillEditor() {
  const c = state.selectedCafe;
  if (!c) return;
  document.getElementById('edit-cafe-title').textContent = 'Edit: ' + c.name;
  document.getElementById('business-service-type').value = c.service_type || 'cafe';
  document.getElementById('business-ai-enabled').checked = Number(c.ai_enabled) === 1;
  document.getElementById('cafe-name').value = c.name || '';
  document.getElementById('cafe-name-ar').value = c.name_ar || '';
  document.getElementById('cafe-phone').value = c.phone || '';
  document.getElementById('cafe-email').value = c.email || '';
  document.getElementById('cafe-primary').value = c.primary_color || '#d66020';
  const hex = document.getElementById('cafe-primary-hex');
  if (hex) hex.textContent = c.primary_color || '#d66020';
  document.getElementById('cafe-logo').value = c.logo_url || '';
  document.getElementById('cafe-menu-link').value = c.catalog_link || '';
  document.getElementById('cafe-sheet-id').value = c.sheet_id || '';
  document.getElementById('business-sheet-name').value = c.sheet_name || '';
  document.getElementById('cafe-drive-folder').value = c.drive_folder_id || '';
  document.getElementById('cafe-suggestions-en').value = (Array.isArray(c.suggestions_en) ? c.suggestions_en : []).join('\n');
  document.getElementById('cafe-suggestions-ar').value = (Array.isArray(c.suggestions_ar) ? c.suggestions_ar : []).join('\n');
  renderFaqEditor(c.faq_en, c.faq_ar);
  document.getElementById('cafe-about-en').value = c.about_en || '';
  document.getElementById('cafe-about-ar').value = c.about_ar || '';
  document.getElementById('cafe-address-en').value = c.address_en || '';
  document.getElementById('cafe-address-ar').value = c.address_ar || '';
  document.getElementById('cafe-hours-en').value = c.working_hours_en || '';
  document.getElementById('cafe-hours-ar').value = c.working_hours_ar || '';
  document.getElementById('cafe-welcome-en').value = c.welcome_en || '';
  document.getElementById('cafe-welcome-ar').value = c.welcome_ar || '';
  document.getElementById('token-masked').textContent = '••••••••••••••••••••••••••';
}

function collectCafePayload() {
  const faq = collectFaq();
  return {
    name: document.getElementById('cafe-name').value.trim(),
    service_type: document.getElementById('business-service-type').value,
    ai_enabled: document.getElementById('business-ai-enabled').checked ? 1 : 0,
    name_ar: document.getElementById('cafe-name-ar').value.trim(),
    phone: document.getElementById('cafe-phone').value.trim(),
    email: document.getElementById('cafe-email').value.trim(),
    primary_color: document.getElementById('cafe-primary').value,
    secondary_color: state.selectedCafe?.secondary_color || '#f6efe4',
    logo_url: document.getElementById('cafe-logo').value.trim(),
    catalog_link: document.getElementById('cafe-menu-link').value.trim(),
    sheet_id: document.getElementById('cafe-sheet-id').value.trim(),
    sheet_name: document.getElementById('business-sheet-name').value.trim(),
    drive_folder_id: document.getElementById('cafe-drive-folder').value.trim(),
    suggestions_en: parseTextareaList(document.getElementById('cafe-suggestions-en').value),
    suggestions_ar: parseTextareaList(document.getElementById('cafe-suggestions-ar').value),
    faq_en: faq.faq_en,
    faq_ar: faq.faq_ar,
    about_en: document.getElementById('cafe-about-en').value.trim(),
    about_ar: document.getElementById('cafe-about-ar').value.trim(),
    address_en: document.getElementById('cafe-address-en').value.trim(),
    address_ar: document.getElementById('cafe-address-ar').value.trim(),
    working_hours_en: document.getElementById('cafe-hours-en').value.trim(),
    working_hours_ar: document.getElementById('cafe-hours-ar').value.trim(),
    welcome_en: document.getElementById('cafe-welcome-en').value.trim(),
    welcome_ar: document.getElementById('cafe-welcome-ar').value.trim(),
    active: state.selectedCafe?.active ?? 1,
  };
}

document.getElementById('save-cafe-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-cafe-btn');
  btnLoad(btn, true);
  try {
    await api(`/dashboard/businesses/${state.selectedCafe.id}`, {
      method: 'PUT',
      body: JSON.stringify(collectCafePayload()),
    });
    toast('Business settings saved!');
    await refreshCafes(state.selectedCafe.id);
    fillEditor();
  } catch (err) { toastErr(err.message); }
  finally { btnLoad(btn, false); }
});

/* ═══════ EMBED CODE ═══════ */
document.getElementById('copy-embed-btn').addEventListener('click', async () => {
  const snippet = `<script src="${window.location.origin}/widget.js?token=${state.selectedCafe.token}"><\/script>`;
  await navigator.clipboard.writeText(snippet);
  toast('Embed code copied!');
});

/* ═══════ TOKEN MANAGEMENT ═══════ */
document.getElementById('copy-token-btn').addEventListener('click', async () => {
  if (!state.selectedCafe) return;
  await navigator.clipboard.writeText(state.selectedCafe.token);
  toast('Token copied to clipboard!');
});

document.getElementById('regenerate-token-btn').addEventListener('click', async () => {
  const btn = document.getElementById('regenerate-token-btn');
  const { isConfirmed } = await Swal.fire({
    title: 'Regenerate Token?',
    text: 'The old token will stop working immediately. Your widget embed code will need to be updated.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Regenerate',
  });
  if (!isConfirmed) return;
  btnLoad(btn, true);
  try {
    const r = await api(`/dashboard/businesses/${state.selectedCafe.id}/regenerate-token`, { method: 'POST' });
    state.selectedCafe.token = r.token;
    toast('Token regenerated!');
  } catch (err) { toastErr(err.message); }
  finally { btnLoad(btn, false); }
});

/* ═══════ BOOT ═══════ */
if (state.token) {
  showLoader();
  api('/dashboard/auth/me')
    .then(async user => {
      state.user = user;
      document.getElementById('user-meta').textContent = `${user.username} (${user.role})`;
      setLoggedIn(true);
      await refreshCafes();
      await applyRouteFromHash({ replace: true });
    })
    .catch(() => {
      localStorage.removeItem('eglotech_dashboard_token');
      setLoggedIn(false);
    })
    .finally(hideLoader);
}
