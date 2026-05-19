'use strict';

const state = {
  token: localStorage.getItem('eglotech_portal_token') || '',
  business: null,
  catalog: [],
  orders: [],
  sessions: [],
  catalogPage: 1,
  catalogFilter: {
    search: '',
    category: 'all',
    availability: 'all',
  },
  ordersPage: 1,
  ordersFilter: {
    search: '',
    status: 'all',
  },
  sessionsPage: 1,
  sessionFilter: {},
  CATALOG_PER_PAGE: 15,
  ORDERS_PER_PAGE: 15,
  SESSIONS_PER_PAGE: 20,
  activeSessionChatId: null,
  activeSessionChatSignature: '',
  sessionChatPollTimer: null,
  globalPollTimer: null,
};

const notificationState = {
  pendingMap: {},
  bellAudio: null,
};

const routeConfig = {
  profile: {
    path: '/portal/profile',
    sectionId: 'section-profile',
    title: 'Profile',
    description: 'Business identity and customer-facing details.',
    chip: 'Public info',
    icon: 'fa-id-card',
    canSaveBusiness: true,
  },
  integration: {
    path: '/portal/integration',
    sectionId: 'section-integration',
    title: 'Integration',
    description: 'Connect the catalog sheet without exposing Drive folder details here.',
    chip: 'Sheet sync',
    icon: 'fa-table-cells-large',
    canSaveBusiness: true,
  },
  assistant: {
    path: '/portal/assistant',
    sectionId: 'section-assistant',
    title: 'Assistant Setup',
    description: 'Control the messages customers actually see, with a live widget simulation.',
    chip: 'Live preview',
    icon: 'fa-comments',
    canSaveBusiness: true,
  },
  catalog: {
    path: '/portal/catalog',
    sectionId: 'section-catalog',
    title: 'Catalog',
    description: 'Manage item data manually or sync directly from your sheet.',
    chip: 'Live data',
    icon: 'fa-box-open',
    canSaveBusiness: false,
  },
  orders: {
    path: '/portal/orders',
    sectionId: 'section-orders',
    title: 'Orders',
    description: 'Track customer orders and update status live.',
    chip: 'Live queue',
    icon: 'fa-shopping-cart',
    canSaveBusiness: false,
  },
  inbox: {
    path: '/portal/inbox',
    sectionId: 'section-inbox',
    title: 'Inbox',
    description: 'Review customer conversations, pending messages, and manual replies.',
    chip: 'Events + replies',
    icon: 'fa-inbox',
    canSaveBusiness: false,
  },
  account: {
    path: '/portal/account',
    sectionId: 'section-account',
    title: 'Account',
    description: 'Everything related to your API token and embed access.',
    chip: 'API token',
    icon: 'fa-key',
    canSaveBusiness: false,
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-bot-token': state.token } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request_failed');
  return data;
}

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
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(msg, icon = 'success') {
  Swal.fire({ toast: true, position: 'top-end', icon, title: msg, showConfirmButton: false, timer: 2500, timerProgressBar: true, background: '#161b22', color: '#e6edf3' });
}
function toastErr(msg) { toast(msg, 'error'); }
function parseTextareaList(v) { return String(v || '').split('\n').map((line) => line.trim()).filter(Boolean); }

function setLoggedIn(yes) {
  document.getElementById('login-page').classList.toggle('hidden', yes);
  document.getElementById('dashboard-shell').classList.toggle('hidden', !yes);
}

function getRouteKeyFromPath(pathname = window.location.pathname) {
  const trimmed = pathname.replace(/\/+$/, '') || '/portal';
  if (trimmed === '/portal') return 'profile';
  if (!trimmed.startsWith('/portal/')) return 'profile';
  const routeKey = trimmed.slice('/portal/'.length);
  return routeConfig[routeKey] ? routeKey : 'profile';
}

function setRouteHeader(route) {
  document.getElementById('portal-page-title').innerHTML = `<i class="fas ${route.icon}"></i> ${route.title}`;
  document.getElementById('portal-page-description').textContent = route.description;
  document.getElementById('portal-page-chip').textContent = route.chip;
  document.getElementById('save-business-btn').classList.toggle('hidden', !route.canSaveBusiness);
  document.title = `${route.title} | E-Glotech Portal`;
}

function setActiveRoute(routeKey, { updateHistory = true, replaceHistory = false } = {}) {
  const activeKey = routeConfig[routeKey] ? routeKey : 'profile';
  const route = routeConfig[activeKey];

  document.querySelectorAll('.portal-panel').forEach((panel) => {
    panel.classList.toggle('route-hidden', panel.id !== route.sectionId);
  });
  document.querySelectorAll('.nav-btn[data-route]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === activeKey);
  });
  setRouteHeader(route);
  document.querySelector('.sidebar')?.classList.remove('open');
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo({ top: 0, behavior: 'auto' });

  if (updateHistory) {
    const targetPath = route.path;
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/portal';
    if (currentPath !== targetPath) {
      const fn = replaceHistory ? window.history.replaceState : window.history.pushState;
      fn.call(window.history, { route: activeKey }, '', targetPath);
    }
  }
}

document.querySelectorAll('.nav-btn[data-route]').forEach((btn) => {
  btn.addEventListener('click', () => setActiveRoute(btn.dataset.route));
});

document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.toggle('open');
});

window.addEventListener('popstate', () => {
  setActiveRoute(getRouteKeyFromPath(), { updateHistory: false });
});

document.addEventListener('click', (e) => {
  const media = window.matchMedia('(max-width: 1100px)');
  if (!media.matches) return;
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (!sidebar?.classList.contains('open')) return;
  if (sidebar.contains(e.target) || toggle?.contains(e.target)) return;
  sidebar.classList.remove('open');
});

document.querySelectorAll('input[type="color"]').forEach((inp) => {
  const hex = inp.parentElement.querySelector('.color-hex');
  if (!hex) return;
  hex.textContent = inp.value;
  inp.addEventListener('input', () => { hex.textContent = inp.value; });
});

document.querySelectorAll('.btn-ar-toggle').forEach((btn) => {
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
    }).then((result) => {
      if (result.isConfirmed) arField.value = result.value;
    });
  });
});

function getPreviewText(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function getPreviewSubtitle(serviceType) {
  switch (serviceType) {
    case 'real_estate': return 'Property assistant preview';
    case 'clinic': return 'Clinic assistant preview';
    default: return 'Chat assistant preview';
  }
}

function renderAssistantPreview() {
  const shell = document.getElementById('assistant-preview-shell');
  if (!shell) return;

  const businessName = getPreviewText('business-name') || 'Business Name';
  const serviceType = document.getElementById('business-service-type')?.value || 'cafe';
  const primaryColor = document.getElementById('business-primary-color')?.value || '#d66020';
  const logoUrl = getPreviewText('business-logo-url');
  const suggestions = parseTextareaList(getPreviewText('business-suggestions-en')).slice(0, 4);
  const welcome = getPreviewText('business-welcome-en') || `Welcome to ${businessName}! How can I help you today?`;
  const about = getPreviewText('business-about-en') || 'Add your About Us text to preview how customers will see your intro.';
  const address = getPreviewText('business-address-en');
  const hours = getPreviewText('business-hours-en');
  const location = [
    address ? `Address:\n${address}` : '',
    hours ? `Hours:\n${hours}` : '',
  ].filter(Boolean).join('\n\n') || 'Add address and working hours to preview the location reply.';

  shell.style.setProperty('--preview-accent', primaryColor);
  document.getElementById('preview-business-name').textContent = businessName;
  document.getElementById('preview-business-subtitle').textContent = getPreviewSubtitle(serviceType);
  document.getElementById('preview-welcome').textContent = welcome;
  document.getElementById('preview-about').textContent = about;
  document.getElementById('preview-location').textContent = location;

  const logoImage = document.getElementById('preview-logo-image');
  const logoFallback = document.getElementById('preview-logo-fallback');
  logoFallback.textContent = businessName.charAt(0).toUpperCase() || 'B';
  if (logoUrl) {
    logoImage.src = logoUrl;
    logoImage.classList.remove('hidden');
    logoFallback.classList.add('hidden');
  } else {
    logoImage.removeAttribute('src');
    logoImage.classList.add('hidden');
    logoFallback.classList.remove('hidden');
  }

  const suggestionsEl = document.getElementById('preview-suggestions');
  suggestionsEl.innerHTML = '';
  if (!suggestions.length) {
    const placeholder = document.createElement('span');
    placeholder.className = 'widget-preview-pill is-placeholder';
    placeholder.textContent = 'Suggestion pills appear here';
    suggestionsEl.appendChild(placeholder);
  } else {
    suggestions.forEach((text) => {
      const pill = document.createElement('span');
      pill.className = 'widget-preview-pill';
      pill.textContent = text;
      suggestionsEl.appendChild(pill);
    });
  }
}

[
  'business-name',
  'business-service-type',
  'business-primary-color',
  'business-logo-url',
  'business-suggestions-en',
  'business-about-en',
  'business-address-en',
  'business-hours-en',
  'business-welcome-en',
].forEach((id) => {
  document.addEventListener('input', (e) => {
    if (e.target?.id === id) renderAssistantPreview();
  });
  document.addEventListener('change', (e) => {
    if (e.target?.id === id) renderAssistantPreview();
  });
});

function fillBusiness() {
  const business = state.business;
  if (!business) return;

  document.getElementById('business-name').value = business.name || '';
  document.getElementById('business-name-ar').value = business.name_ar || '';
  document.getElementById('business-service-type').value = business.service_type || 'cafe';
  document.getElementById('business-phone').value = business.phone || '';
  document.getElementById('business-email').value = business.email || '';
  document.getElementById('business-primary-color').value = business.primary_color || '#d66020';
  document.getElementById('business-primary-color-hex').textContent = business.primary_color || '#d66020';
  document.getElementById('business-logo-url').value = business.logo_url || '';
  document.getElementById('business-catalog-link').value = business.catalog_link || '';
  document.getElementById('business-sheet-id').value = business.sheet_id || '';
  document.getElementById('business-sheet-name').value = business.sheet_name || '';
  document.getElementById('business-suggestions-en').value = (Array.isArray(business.suggestions_en) ? business.suggestions_en : []).join('\n');
  document.getElementById('business-suggestions-ar').value = (Array.isArray(business.suggestions_ar) ? business.suggestions_ar : []).join('\n');
  document.getElementById('business-about-en').value = business.about_en || '';
  document.getElementById('business-about-ar').value = business.about_ar || '';
  document.getElementById('business-address-en').value = business.address_en || '';
  document.getElementById('business-address-ar').value = business.address_ar || '';
  document.getElementById('business-hours-en').value = business.working_hours_en || '';
  document.getElementById('business-hours-ar').value = business.working_hours_ar || '';
  document.getElementById('business-welcome-en').value = business.welcome_en || '';
  document.getElementById('business-welcome-ar').value = business.welcome_ar || '';
  document.getElementById('account-token').value = state.token;

  document.getElementById('sidebar-business-name').textContent = business.name || 'Business Portal';
  document.getElementById('mobile-business-name').textContent = business.name || 'Business Portal';
  document.getElementById('sidebar-business-type').textContent = String(business.service_type || 'workspace').replace('_', ' ');
  document.getElementById('user-meta').textContent = `${business.name || 'Business'} workspace`;

  renderAssistantPreview();
}

function collectBusinessPayload() {
  return {
    name: document.getElementById('business-name').value.trim(),
    name_ar: document.getElementById('business-name-ar').value.trim(),
    service_type: document.getElementById('business-service-type').value,
    phone: document.getElementById('business-phone').value.trim(),
    email: document.getElementById('business-email').value.trim(),
    primary_color: document.getElementById('business-primary-color').value,
    secondary_color: state.business?.secondary_color || '#f6efe4',
    logo_url: document.getElementById('business-logo-url').value.trim(),
    catalog_link: document.getElementById('business-catalog-link').value.trim(),
    sheet_id: document.getElementById('business-sheet-id').value.trim(),
    sheet_name: document.getElementById('business-sheet-name').value.trim(),
    drive_folder_id: state.business?.drive_folder_id || '',
    suggestions_en: parseTextareaList(document.getElementById('business-suggestions-en').value),
    suggestions_ar: parseTextareaList(document.getElementById('business-suggestions-ar').value),
    about_en: document.getElementById('business-about-en').value.trim(),
    about_ar: document.getElementById('business-about-ar').value.trim(),
    address_en: document.getElementById('business-address-en').value.trim(),
    address_ar: document.getElementById('business-address-ar').value.trim(),
    working_hours_en: document.getElementById('business-hours-en').value.trim(),
    working_hours_ar: document.getElementById('business-hours-ar').value.trim(),
    welcome_en: document.getElementById('business-welcome-en').value.trim(),
    welcome_ar: document.getElementById('business-welcome-ar').value.trim(),
    active: state.business?.active ?? 1,
  };
}

async function saveBusiness() {
  const btn = document.getElementById('save-business-btn');
  btnLoad(btn, true);
  try {
    const result = await api('/portal/api/business', {
      method: 'PUT',
      body: JSON.stringify(collectBusinessPayload()),
    });
    state.business = result.business;
    fillBusiness();
    toast('Business settings saved!');
  } catch (err) {
    toastErr(err.message || 'Failed to save business');
  } finally {
    btnLoad(btn, false);
  }
}

function updateStats() {
  document.getElementById('stat-catalog-count').textContent = state.catalog.length;
  document.getElementById('stat-open-orders').textContent = state.orders.filter((order) => ['pending', 'draft', 'review', 'awaiting_address', 'address_confirmation'].includes(order.status)).length;
  document.getElementById('stat-pending-chats').textContent = state.sessions.reduce((sum, session) => sum + Number(session.pending_human_messages || 0), 0);
}

async function loadCatalog() {
  state.catalog = await api('/portal/api/catalog');
  syncCatalogCategoryOptions();
  renderCatalog();
  updateStats();
}

function syncCatalogCategoryOptions() {
  const select = document.getElementById('catalog-filter-category');
  const previous = state.catalogFilter.category || 'all';
  const categories = [...new Set(
    state.catalog
      .map((item) => String(item.category_en || item.category_ar || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="all">All Categories</option>';
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  state.catalogFilter.category = categories.includes(previous) ? previous : 'all';
  select.value = state.catalogFilter.category;
}

function getFilteredCatalogItems() {
  const search = (state.catalogFilter.search || '').trim().toLowerCase();
  const category = state.catalogFilter.category || 'all';
  const availability = state.catalogFilter.availability || 'all';

  return state.catalog.filter((item) => {
    const haystack = [
      item.title_en,
      item.title_ar,
      item.category_en,
      item.category_ar,
      item.description_en,
      item.description_ar,
      JSON.stringify(item.metadata || {}),
    ].join(' ').toLowerCase();

    if (search && !haystack.includes(search)) return false;
    if (category !== 'all') {
      const itemCategory = String(item.category_en || item.category_ar || '').trim();
      if (itemCategory !== category) return false;
    }
    if (availability === 'available' && Number(item.available) === 0) return false;
    if (availability === 'unavailable' && Number(item.available) !== 0) return false;
    return true;
  });
}

function renderPagination(el, current, total, onSelect) {
  el.innerHTML = '';
  if (total <= 1) return;

  const addBtn = (label, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = `page-btn${active ? ' active' : ''}`;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', () => onSelect(page));
    el.appendChild(btn);
  };

  addBtn('<', current - 1, current === 1);
  for (let page = 1; page <= total; page += 1) {
    addBtn(String(page), page, false, page === current);
  }
  addBtn('>', current + 1, current === total);
}

function renderCatalog() {
  const list = document.getElementById('catalog-list');
  const pagEl = document.getElementById('catalog-pagination');
  list.innerHTML = '';
  pagEl.innerHTML = '';

  if (!state.catalog.length) {
    list.innerHTML = '<div class="menu-empty"><i class="fas fa-box-open"></i><p>No catalog items yet.</p></div>';
    return;
  }

  const filtered = getFilteredCatalogItems();
  if (!filtered.length) {
    list.innerHTML = '<div class="menu-filter-empty"><i class="fas fa-filter-circle-xmark"></i><p>No catalog items match the current filters.</p></div>';
    return;
  }

  const total = Math.ceil(filtered.length / state.CATALOG_PER_PAGE);
  if (state.catalogPage > total) state.catalogPage = total;
  const start = (state.catalogPage - 1) * state.CATALOG_PER_PAGE;
  const slice = filtered.slice(start, start + state.CATALOG_PER_PAGE);

  slice.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.innerHTML = `
      <span class="mr-name">${esc(item.title_en || item.title_ar || 'Untitled')}</span>
      <span class="mr-cat">${esc(item.category_en || item.category_ar || '-')}</span>
      <span class="mr-price">${item.price != null ? `${item.price} ${item.currency || 'EGP'}` : '-'}</span>
      <span class="mr-actions">
        <button class="icon-btn icon-btn-edit" title="Edit"><i class="fas fa-pen-to-square"></i></button>
        <button class="icon-btn icon-btn-del" title="Delete"><i class="fas fa-trash-can"></i></button>
      </span>`;
    row.querySelector('.icon-btn-edit').addEventListener('click', () => openCatalogItemModal(item));
    row.querySelector('.icon-btn-del').addEventListener('click', () => deleteCatalogItem(item));
    list.appendChild(row);
  });

  renderPagination(pagEl, state.catalogPage, total, (page) => {
    state.catalogPage = page;
    renderCatalog();
  });
}

function normalizeMetadataForForm(item) {
  try {
    return JSON.stringify(item.metadata || {}, null, 2);
  } catch {
    return '{}';
  }
}

function parseMetadataInput(value) {
  if (!String(value || '').trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Metadata must be valid JSON');
  }
}

function openCatalogItemModal(item = {}) {
  const isNew = !item.id;
  Swal.fire({
    title: isNew ? 'Add Catalog Item' : 'Edit Catalog Item',
    html: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left;font-size:13px">
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Title EN</label><input id="swal-title-en" class="swal2-input" style="margin:0;width:100%" value="${esc(item.title_en || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Title AR</label><input id="swal-title-ar" class="swal2-input" style="margin:0;width:100%" dir="rtl" value="${esc(item.title_ar || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Category EN</label><input id="swal-cat-en" class="swal2-input" style="margin:0;width:100%" value="${esc(item.category_en || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Category AR</label><input id="swal-cat-ar" class="swal2-input" style="margin:0;width:100%" dir="rtl" value="${esc(item.category_ar || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Price</label><input id="swal-price" class="swal2-input" style="margin:0;width:100%" value="${item.price ?? ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Currency</label><input id="swal-currency" class="swal2-input" style="margin:0;width:100%" value="${esc(item.currency || 'EGP')}"></div>
        <div style="grid-column:1/-1"><label style="font-weight:600;display:block;margin-bottom:4px">Description EN</label><textarea id="swal-desc-en" class="swal2-textarea" style="margin:0;width:100%;min-height:50px">${esc(item.description_en || '')}</textarea></div>
        <div style="grid-column:1/-1"><label style="font-weight:600;display:block;margin-bottom:4px">Description AR</label><textarea id="swal-desc-ar" class="swal2-textarea" style="margin:0;width:100%;min-height:50px" dir="rtl">${esc(item.description_ar || '')}</textarea></div>
        <div style="grid-column:1/-1"><label style="font-weight:600;display:block;margin-bottom:4px">Metadata JSON</label><textarea id="swal-metadata" class="swal2-textarea" style="margin:0;width:100%;min-height:120px">${esc(normalizeMetadataForForm(item))}</textarea></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Available</label><select id="swal-avail" class="swal2-input" style="margin:0;width:100%;padding:8px"><option value="1" ${item.available !== 0 ? 'selected' : ''}>Yes</option><option value="0" ${item.available === 0 ? 'selected' : ''}>No</option></select></div>
      </div>`,
    width: 640,
    showCancelButton: true,
    confirmButtonText: isNew ? 'Create' : 'Save',
    showLoaderOnConfirm: true,
    preConfirm: async () => {
      let metadata;
      try {
        metadata = parseMetadataInput(document.getElementById('swal-metadata').value);
      } catch (error) {
        Swal.showValidationMessage(error.message);
        return false;
      }

      const payload = {
        title_en: document.getElementById('swal-title-en').value.trim(),
        title_ar: document.getElementById('swal-title-ar').value.trim(),
        category_en: document.getElementById('swal-cat-en').value.trim(),
        category_ar: document.getElementById('swal-cat-ar').value.trim(),
        description_en: document.getElementById('swal-desc-en').value.trim(),
        description_ar: document.getElementById('swal-desc-ar').value.trim(),
        price: document.getElementById('swal-price').value.trim(),
        currency: document.getElementById('swal-currency').value.trim() || 'EGP',
        metadata,
        available: Number(document.getElementById('swal-avail').value),
      };

      if (!payload.title_en && !payload.title_ar) {
        Swal.showValidationMessage('At least one title is required');
        return false;
      }

      if (isNew) {
        await api('/portal/api/catalog', { method: 'POST', body: JSON.stringify(payload) });
      } else {
        await api(`/portal/api/catalog/${item.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      }

      await loadCatalog();
      toast(isNew ? 'Catalog item created!' : 'Catalog item updated!');
      return true;
    },
  });
}

async function deleteCatalogItem(item) {
  const { isConfirmed } = await Swal.fire({
    title: 'Delete catalog item?',
    text: item.title_en || item.title_ar || 'Untitled item',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Delete',
  });
  if (!isConfirmed) return;
  try {
    await api(`/portal/api/catalog/${item.id}`, { method: 'DELETE' });
    toast('Catalog item deleted');
    await loadCatalog();
  } catch (err) {
    toastErr(err.message || 'Failed to delete item');
  }
}

async function syncCatalog() {
  const btn = document.getElementById('sync-catalog-btn');
  btnLoad(btn, true);
  try {
    const result = await api('/portal/api/catalog/sync', {
      method: 'POST',
      body: JSON.stringify({ sheet_name: document.getElementById('business-sheet-name').value.trim() }),
    });
    toast(`Catalog synced: ${result.synced} items`);
    await loadCatalog();
  } catch (err) {
    toastErr(err.message || 'Failed to sync catalog');
  } finally {
    btnLoad(btn, false);
  }
}

async function loadOrders() {
  state.orders = await api('/portal/api/orders');
  renderOrders();
  updateStats();
}

function renderOrders() {
  const list = document.getElementById('orders-list');
  const pagEl = document.getElementById('orders-pagination');
  list.innerHTML = '';
  pagEl.innerHTML = '';

  const search = (state.ordersFilter.search || '').toLowerCase();
  const status = state.ordersFilter.status || 'all';
  const filtered = state.orders.filter((order) => {
    const haystack = [order.id, order.guest_name, order.guest_phone, order.address].join(' ').toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (status !== 'all') {
      if (status === 'draft' && !['draft', 'review', 'awaiting_address', 'address_confirmation'].includes(order.status)) return false;
      if (status !== 'draft' && order.status !== status) return false;
    }
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="orders-empty"><i class="fas fa-shopping-cart"></i><p>No orders found.</p></div>';
    return;
  }

  const total = Math.ceil(filtered.length / state.ORDERS_PER_PAGE);
  if (state.ordersPage > total) state.ordersPage = total;
  const start = (state.ordersPage - 1) * state.ORDERS_PER_PAGE;
  const slice = filtered.slice(start, start + state.ORDERS_PER_PAGE);

  slice.forEach((order) => {
    const row = document.createElement('div');
    row.className = 'order-row';
    row.innerHTML = `
      <div class="order-info">
        <div class="order-header">
          <span class="order-id">#${order.id}</span>
          <span class="order-status-badge status-${esc(order.status || 'draft')}">${esc(order.status || 'draft')}</span>
          <span class="order-time">${esc(order.created_at || '-')}</span>
        </div>
        <div class="order-customer"><strong>${esc(order.guest_name || 'Guest')}</strong> · ${esc(order.guest_phone || '-')}</div>
        <div class="order-address">${esc(order.address || 'No address provided')}</div>
        <ul class="order-items-list">
          ${(order.items || []).map((item) => `<li><span>${esc(item.title_en || item.title_ar || 'Item')}</span><span>x${item.quantity}</span></li>`).join('')}
        </ul>
      </div>
      <div class="order-actions">
        <select class="status-select">
          ${['pending', 'completed', 'cancelled', 'rejected', 'draft'].map((value) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </div>`;
    row.querySelector('.status-select').addEventListener('change', async (e) => {
      try {
        await api(`/portal/api/orders/${order.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: e.target.value }),
        });
        toast('Order status updated');
        await loadOrders();
      } catch (err) {
        toastErr(err.message || 'Failed to update status');
      }
    });
    list.appendChild(row);
  });

  renderPagination(pagEl, state.ordersPage, total, (page) => {
    state.ordersPage = page;
    renderOrders();
  });
}

async function exportOrders() {
  try {
    const response = await fetch('/portal/api/orders/export', {
      headers: { 'x-bot-token': state.token },
    });
    if (!response.ok) throw new Error('Failed to export orders');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders_${state.business?.id || 'business'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toastErr(err.message || 'Failed to export orders');
  }
}

function getOrCreateBell() {
  if (notificationState.bellAudio) return notificationState.bellAudio;
  notificationState.bellAudio = new (window.AudioContext || window.webkitAudioContext)();
  return notificationState.bellAudio;
}

function playBell() {
  try {
    const ctx = getOrCreateBell();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch {}
}

function updateSessionBadgeInDOM(sessionId, count) {
  document.querySelectorAll('.session-row').forEach((row) => {
    const badge = row.querySelector('.session-pending-badge');
    if (String(row.dataset.sessionId) !== String(sessionId)) return;
    if (count > 0) {
      if (badge) {
        badge.textContent = count;
      } else {
        const modeBadge = row.querySelector('.session-mode-badge');
        const newBadge = document.createElement('span');
        newBadge.className = 'session-pending-badge';
        newBadge.textContent = count;
        modeBadge?.insertAdjacentElement('afterend', newBadge);
      }
    } else if (badge) {
      badge.remove();
    }
  });
}

async function loadSessions({ silent = false } = {}) {
  try {
    const sessions = await api('/portal/api/sessions');
    sessions.forEach((session) => {
      const pending = Number(session.pending_human_messages || 0);
      const previous = notificationState.pendingMap[session.id];
      if (previous !== undefined && pending > previous && state.activeSessionChatId !== session.id) {
        toast(`New message from ${session.guest_name || 'Guest'}`, 'info');
        playBell();
      }
      notificationState.pendingMap[session.id] = pending;
      updateSessionBadgeInDOM(session.id, pending);
    });
    state.sessions = sessions;
    if (!silent) renderSessions();
    updateStats();
  } catch (err) {
    if (!silent) toastErr('Failed to load inbox');
  }
}

function renderSessions() {
  const list = document.getElementById('sessions-list');
  const pagEl = document.getElementById('sessions-pagination');
  list.innerHTML = '';
  pagEl.innerHTML = '';

  let filtered = state.sessions;
  const f = state.sessionFilter;
  if (f.name) filtered = filtered.filter((s) => (s.guest_name || '').toLowerCase().includes(f.name.toLowerCase()));
  if (f.phone) filtered = filtered.filter((s) => (s.guest_phone || '').includes(f.phone));
  if (f.date) filtered = filtered.filter((s) => (s.last_active || '').startsWith(f.date));

  if (!filtered.length) {
    list.innerHTML = '<div class="sessions-empty"><i class="fas fa-comments"></i><p>No sessions found.</p></div>';
    return;
  }

  const total = Math.ceil(filtered.length / state.SESSIONS_PER_PAGE);
  if (state.sessionsPage > total) state.sessionsPage = total;
  const start = (state.sessionsPage - 1) * state.SESSIONS_PER_PAGE;
  const slice = filtered.slice(start, start + state.SESSIONS_PER_PAGE);

  slice.forEach((session) => {
    const automated = Number(session.automated) !== 0;
    const pending = Number(session.pending_human_messages || 0);
    const row = document.createElement('div');
    row.className = 'session-row';
    row.dataset.sessionId = session.id;
    row.innerHTML = `
      <div class="session-info">
        <div class="session-name">
          <span><i class="fas fa-user" style="color:var(--accent);margin-right:6px;font-size:11px"></i>${esc(session.guest_name || 'Guest')}</span>
          <span class="session-mode-badge ${automated ? 'auto' : 'live'}">${automated ? 'Automated' : 'Human Joined'}</span>
          ${!automated && pending > 0 ? `<span class="session-pending-badge">${pending}</span>` : ''}
        </div>
        <div class="session-detail">
          <span><i class="fas fa-phone" style="font-size:10px"></i> ${esc(session.guest_phone || '-')}</span>
          <span><i class="fas fa-comments" style="font-size:10px"></i> ${session.message_count} msgs</span>
          <span><i class="fas fa-clock" style="font-size:10px"></i> ${esc(session.last_active || '-')}</span>
        </div>
      </div>
      <div class="session-actions">
        <button class="icon-btn icon-btn-edit" title="View chat"><i class="fas fa-eye"></i></button>
        <button class="icon-btn icon-btn-del" title="Delete session"><i class="fas fa-trash-can"></i></button>
      </div>`;
    row.addEventListener('click', () => viewSession(session));
    row.querySelector('.icon-btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      viewSession(session);
    });
    row.querySelector('.icon-btn-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(session);
    });
    list.appendChild(row);
  });

  renderPagination(pagEl, state.sessionsPage, total, (page) => {
    state.sessionsPage = page;
    renderSessions();
  });
}

async function fetchSessionMessages(sessionId) {
  return api(`/portal/api/sessions/${sessionId}/messages`);
}

function getChatMessagesSignature(messages) {
  const last = messages[messages.length - 1];
  return `${messages.length}:${last?.role || ''}:${last?.created_at || ''}:${last?.content || ''}`;
}

function renderSessionMessages(container, messages, { forceScroll = false } = {}) {
  const shouldStickToBottom = forceScroll || (container.scrollHeight - container.scrollTop - container.clientHeight < 60);
  container.innerHTML = messages.map((message) => {
    if (message.intent === 'human_joined') {
      return `<div class="chat-msg system">${esc(message.content)}</div>`;
    }
    const extraClass = message.intent === 'admin_manual' ? ' support' : '';
    return `
      <div class="chat-msg ${message.role === 'user' ? 'user' : 'bot'}${extraClass}">
        ${esc(message.content)}
        <div class="chat-msg-time">${message.created_at || ''}</div>
      </div>
    `;
  }).join('') || '<p style="color:var(--text-muted)">No messages yet</p>';
  if (shouldStickToBottom) container.scrollTop = container.scrollHeight;
}

function stopSessionChatPolling() {
  if (state.sessionChatPollTimer) {
    clearInterval(state.sessionChatPollTimer);
    state.sessionChatPollTimer = null;
  }
  state.activeSessionChatId = null;
  state.activeSessionChatSignature = '';
}

function startSessionChatPolling(session, scrollEl) {
  stopSessionChatPolling();
  state.activeSessionChatId = session.id;

  state.sessionChatPollTimer = setInterval(async () => {
    if (!Swal.isVisible() || state.activeSessionChatId !== session.id) {
      stopSessionChatPolling();
      return;
    }

    try {
      const result = await fetchSessionMessages(session.id);
      const signature = getChatMessagesSignature(result.messages);
      if (signature !== state.activeSessionChatSignature) {
        state.activeSessionChatSignature = signature;
        renderSessionMessages(scrollEl, result.messages);
        await loadSessions({ silent: true });
      }
    } catch {}
  }, 2500);
}

async function viewSession(session) {
  try {
    const result = await fetchSessionMessages(session.id);
    state.activeSessionChatSignature = getChatMessagesSignature(result.messages);
    const automated = result.session.automated !== false;

    await Swal.fire({
      title: `Chat - ${esc(session.guest_name || 'Guest')}`,
      html: `
        <div class="chat-status-banner ${automated ? 'auto' : ''}" id="chat-status-banner">
          <span id="chat-status-text">${automated ? 'Bot is handling this chat right now.' : 'Customer support joined this chat.'}</span>
          <span class="chat-status-pill" id="chat-status-pill">${automated ? 'Automated' : 'Human support'}</span>
        </div>
        <div class="chat-modal-body" id="chat-scroll"></div>
        <div class="chat-input-row">
          <input id="admin-msg-input" placeholder="${automated ? 'Type reply to take over chat...' : 'Type support message...'}" autocomplete="off">
          <button class="btn btn-primary btn-sm" id="send-admin-msg" type="button"><i class="fas fa-paper-plane"></i></button>
        </div>`,
      width: 560,
      showConfirmButton: false,
      showCloseButton: true,
      didOpen: () => {
        const scroll = document.getElementById('chat-scroll');
        renderSessionMessages(scroll, result.messages, { forceScroll: true });
        startSessionChatPolling(session, scroll);

        async function sendAdminMessage() {
          const inp = document.getElementById('admin-msg-input');
          const msg = inp.value.trim();
          if (!msg) return;
          const sendBtn = document.getElementById('send-admin-msg');
          sendBtn.disabled = true;
          try {
            await api(`/portal/api/sessions/${session.id}/messages`, {
              method: 'POST',
              body: JSON.stringify({ content: msg }),
            });
            inp.value = '';
            inp.focus();
            const refreshed = await fetchSessionMessages(session.id);
            state.activeSessionChatSignature = getChatMessagesSignature(refreshed.messages);
            renderSessionMessages(scroll, refreshed.messages, { forceScroll: true });
            notificationState.pendingMap[session.id] = 0;
            updateSessionBadgeInDOM(session.id, 0);
            await loadSessions({ silent: true });
          } catch (err) {
            toastErr(err.message || 'Failed to send message');
          } finally {
            sendBtn.disabled = false;
          }
        }

        document.getElementById('send-admin-msg').addEventListener('click', sendAdminMessage);
        document.getElementById('admin-msg-input').addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAdminMessage();
          }
        });
      },
      willClose: () => {
        stopSessionChatPolling();
      },
    });
  } catch (err) {
    toastErr(err.message || 'Failed to open chat');
  }
}

async function deleteSession(session) {
  const { isConfirmed } = await Swal.fire({
    title: 'Delete session?',
    text: `${session.guest_name || 'Guest'} - ${session.message_count} messages`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Delete',
  });
  if (!isConfirmed) return;
  try {
    await api(`/portal/api/sessions/${session.id}`, { method: 'DELETE' });
    toast('Session deleted');
    await loadSessions();
  } catch (err) {
    toastErr(err.message || 'Failed to delete session');
  }
}

function startGlobalPoller() {
  if (state.globalPollTimer) return;
  state.globalPollTimer = setInterval(async () => {
    if (!state.token) return;
    await Promise.all([
      loadOrders().catch(() => {}),
      loadSessions({ silent: false }).catch(() => {}),
    ]);
  }, 8000);
}

function stopGlobalPoller() {
  if (!state.globalPollTimer) return;
  clearInterval(state.globalPollTimer);
  state.globalPollTimer = null;
}

async function refreshPortalData() {
  await Promise.all([loadCatalog(), loadOrders(), loadSessions()]);
}

async function bootstrapPortal() {
  showLoader();
  try {
    const result = await api('/portal/api/auth/me');
    state.business = result.business;
    state.token = result.token;
    localStorage.setItem('eglotech_portal_token', state.token);
    fillBusiness();
    setLoggedIn(true);
    setActiveRoute(getRouteKeyFromPath(), { replaceHistory: true });
    await refreshPortalData();
    startGlobalPoller();
  } catch {
    localStorage.removeItem('eglotech_portal_token');
    state.token = '';
    setLoggedIn(false);
  } finally {
    hideLoader();
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btnLoad(btn, true);
  try {
    const token = document.getElementById('portal-token').value.trim();
    const result = await api('/portal/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    state.token = result.token;
    state.business = result.business;
    localStorage.setItem('eglotech_portal_token', state.token);
    fillBusiness();
    setLoggedIn(true);
    setActiveRoute(getRouteKeyFromPath(), { replaceHistory: true });
    await refreshPortalData();
    startGlobalPoller();
    toast('Portal opened!');
  } catch (err) {
    toastErr(err.message || 'Login failed');
  } finally {
    btnLoad(btn, false);
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  stopGlobalPoller();
  stopSessionChatPolling();
  localStorage.removeItem('eglotech_portal_token');
  state.token = '';
  window.location.reload();
});

document.getElementById('save-business-btn').addEventListener('click', saveBusiness);
document.getElementById('sync-catalog-btn').addEventListener('click', syncCatalog);
document.getElementById('add-catalog-btn').addEventListener('click', () => openCatalogItemModal());
document.getElementById('catalog-search').addEventListener('input', (e) => {
  state.catalogFilter.search = e.target.value;
  state.catalogPage = 1;
  renderCatalog();
});
document.getElementById('catalog-filter-category').addEventListener('change', (e) => {
  state.catalogFilter.category = e.target.value;
  state.catalogPage = 1;
  renderCatalog();
});
document.getElementById('catalog-filter-availability').addEventListener('change', (e) => {
  state.catalogFilter.availability = e.target.value;
  state.catalogPage = 1;
  renderCatalog();
});

document.getElementById('order-search').addEventListener('input', (e) => {
  state.ordersFilter.search = e.target.value;
  state.ordersPage = 1;
  renderOrders();
});
document.getElementById('order-filter-status').addEventListener('change', (e) => {
  state.ordersFilter.status = e.target.value;
  state.ordersPage = 1;
  renderOrders();
});
document.getElementById('refresh-orders-btn').addEventListener('click', () => loadOrders().catch((err) => toastErr(err.message)));
document.getElementById('export-orders-btn').addEventListener('click', exportOrders);

document.getElementById('filter-sessions-btn').addEventListener('click', () => {
  Swal.fire({
    title: 'Filter Inbox',
    html: `
      <div style="text-align:left;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Client Name</label><input id="swal-f-name" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.name || ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Phone</label><input id="swal-f-phone" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.phone || ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Date (YYYY-MM-DD)</label><input id="swal-f-date" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.date || ''}" placeholder="2026-05-07"></div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'Apply',
    cancelButtonText: 'Clear Filters',
  }).then((result) => {
    if (result.isConfirmed) {
      state.sessionFilter = {
        name: document.getElementById('swal-f-name').value.trim(),
        phone: document.getElementById('swal-f-phone').value.trim(),
        date: document.getElementById('swal-f-date').value.trim(),
      };
    } else if (result.dismiss === Swal.DismissReason.cancel) {
      state.sessionFilter = {};
    }
    state.sessionsPage = 1;
    renderSessions();
  });
});

document.getElementById('clear-sessions-btn').addEventListener('click', async () => {
  const btn = document.getElementById('clear-sessions-btn');
  const { isConfirmed } = await Swal.fire({
    title: 'Clear all sessions?',
    text: 'This will permanently delete all conversation history for this business.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Clear All',
  });
  if (!isConfirmed) return;
  btnLoad(btn, true);
  try {
    await api('/portal/api/sessions', { method: 'DELETE' });
    toast('All sessions cleared');
    await loadSessions();
  } catch (err) {
    toastErr(err.message || 'Failed to clear sessions');
  } finally {
    btnLoad(btn, false);
  }
});

document.getElementById('copy-token-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.token);
  toast('Token copied to clipboard!');
});

document.getElementById('copy-embed-btn').addEventListener('click', async () => {
  const snippet = `<script src="${window.location.origin}/widget.js?token=${state.token}"><\/script>`;
  await navigator.clipboard.writeText(snippet);
  toast('Embed code copied!');
});

document.getElementById('regenerate-token-btn').addEventListener('click', async () => {
  const btn = document.getElementById('regenerate-token-btn');
  const { isConfirmed } = await Swal.fire({
    title: 'Regenerate token?',
    text: 'The old token will stop working immediately, including current widget embeds and this portal login.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Regenerate',
  });
  if (!isConfirmed) return;
  btnLoad(btn, true);
  try {
    const result = await api('/portal/api/business/regenerate-token', { method: 'POST' });
    state.token = result.token;
    state.business = result.business;
    localStorage.setItem('eglotech_portal_token', state.token);
    fillBusiness();
    toast('Token regenerated!');
  } catch (err) {
    toastErr(err.message || 'Failed to regenerate token');
  } finally {
    btnLoad(btn, false);
  }
});

renderAssistantPreview();
setActiveRoute(getRouteKeyFromPath(), { replaceHistory: true });
if (state.token) bootstrapPortal();
