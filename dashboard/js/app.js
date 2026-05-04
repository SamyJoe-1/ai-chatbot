const state = {
  token: localStorage.getItem('eglotech_dashboard_token') || '',
  user: null,
  cafes: [],
  selectedCafe: null,
  menu: [],
};

const refs = {
  loginPanel: document.getElementById('login-panel'),
  appPanel: document.getElementById('app-panel'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  cafesList: document.getElementById('cafes-list'),
  userMeta: document.getElementById('user-meta'),
  createCafe: document.getElementById('create-cafe'),
  refreshCafes: document.getElementById('refresh-cafes'),
  logout: document.getElementById('logout'),
  emptyState: document.getElementById('empty-state'),
  editor: document.getElementById('editor'),
  editorTitle: document.getElementById('editor-title'),
  editorSubtitle: document.getElementById('editor-subtitle'),
  saveCafe: document.getElementById('save-cafe'),
  copyEmbed: document.getElementById('copy-embed'),
  dashboardStatus: document.getElementById('dashboard-status'),
  syncMenu: document.getElementById('sync-menu'),
  addMenuItem: document.getElementById('add-menu-item'),
  menuList: document.getElementById('menu-list'),
  loadSessions: document.getElementById('load-sessions'),
  sessionsList: document.getElementById('sessions-list'),
  sessionMessages: document.getElementById('session-messages'),
};

const fields = {
  name: document.getElementById('cafe-name'),
  name_ar: document.getElementById('cafe-name-ar'),
  phone: document.getElementById('cafe-phone'),
  email: document.getElementById('cafe-email'),
  primary_color: document.getElementById('cafe-primary'),
  secondary_color: document.getElementById('cafe-secondary'),
  logo_url: document.getElementById('cafe-logo'),
  menu_link: document.getElementById('cafe-menu-link'),
  sheet_id: document.getElementById('cafe-sheet-id'),
  drive_folder_id: document.getElementById('cafe-drive-folder'),
  suggestions_en: document.getElementById('cafe-suggestions-en'),
  suggestions_ar: document.getElementById('cafe-suggestions-ar'),
  about_en: document.getElementById('cafe-about-en'),
  about_ar: document.getElementById('cafe-about-ar'),
  address_en: document.getElementById('cafe-address-en'),
  address_ar: document.getElementById('cafe-address-ar'),
  working_hours_en: document.getElementById('cafe-hours-en'),
  working_hours_ar: document.getElementById('cafe-hours-ar'),
  welcome_en: document.getElementById('cafe-welcome-en'),
  welcome_ar: document.getElementById('cafe-welcome-ar'),
  active: document.getElementById('cafe-active'),
};

function parseTextareaList(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'request_failed');
  }

  return payload;
}

function showStatus(message, isError = false) {
  refs.dashboardStatus.textContent = message;
  refs.dashboardStatus.classList.remove('hidden', 'error');
  if (isError) {
    refs.dashboardStatus.classList.add('error');
  }
}

function clearStatus() {
  refs.dashboardStatus.textContent = '';
  refs.dashboardStatus.classList.add('hidden');
  refs.dashboardStatus.classList.remove('error');
}

function setLoggedIn(loggedIn) {
  refs.loginPanel.classList.toggle('hidden', loggedIn);
  refs.appPanel.classList.toggle('hidden', !loggedIn);
}

function renderCafeList() {
  refs.cafesList.innerHTML = '';
  state.cafes.forEach((cafe) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `cafe-item ${state.selectedCafe && state.selectedCafe.id === cafe.id ? 'active' : ''}`;
    item.innerHTML = `
      <strong>${cafe.name}</strong>
      <div class="muted">${cafe.phone || 'No phone yet'}</div>
      <div class="muted">Token: ${cafe.token}</div>
    `;
    item.addEventListener('click', () => selectCafe(cafe.id));
    refs.cafesList.appendChild(item);
  });
}

function fillEditor() {
  if (!state.selectedCafe) return;
  refs.emptyState.classList.add('hidden');
  refs.editor.classList.remove('hidden');
  refs.editorTitle.textContent = state.selectedCafe.name;
  refs.editorSubtitle.textContent = `Token: ${state.selectedCafe.token}`;

  Object.entries(fields).forEach(([key, element]) => {
    if (key === 'suggestions_en' || key === 'suggestions_ar') {
      element.value = (state.selectedCafe[key] || []).join('\n');
    } else {
      element.value = state.selectedCafe[key] ?? '';
    }
  });
}

function collectCafePayload() {
  return {
    name: fields.name.value.trim(),
    name_ar: fields.name_ar.value.trim(),
    phone: fields.phone.value.trim(),
    email: fields.email.value.trim(),
    primary_color: fields.primary_color.value,
    secondary_color: fields.secondary_color.value,
    logo_url: fields.logo_url.value.trim(),
    menu_link: fields.menu_link.value.trim(),
    sheet_id: fields.sheet_id.value.trim(),
    drive_folder_id: fields.drive_folder_id.value.trim(),
    suggestions_en: parseTextareaList(fields.suggestions_en.value),
    suggestions_ar: parseTextareaList(fields.suggestions_ar.value),
    about_en: fields.about_en.value.trim(),
    about_ar: fields.about_ar.value.trim(),
    address_en: fields.address_en.value.trim(),
    address_ar: fields.address_ar.value.trim(),
    working_hours_en: fields.working_hours_en.value.trim(),
    working_hours_ar: fields.working_hours_ar.value.trim(),
    welcome_en: fields.welcome_en.value.trim(),
    welcome_ar: fields.welcome_ar.value.trim(),
    active: Number(fields.active.value),
  };
}

async function refreshCafes(selectId) {
  state.cafes = await api('/dashboard/cafes');
  renderCafeList();

  if (!state.cafes.length) {
    state.selectedCafe = null;
    refs.editor.classList.add('hidden');
    refs.emptyState.classList.remove('hidden');
    return;
  }

  const nextId = selectId || state.selectedCafe?.id || state.cafes[0].id;
  await selectCafe(nextId);
}

async function selectCafe(id) {
  state.selectedCafe = await api(`/dashboard/cafes/${id}`);
  renderCafeList();
  fillEditor();
  clearStatus();
  refs.sessionMessages.textContent = 'Select a session to view the full conversation.';
  refs.sessionsList.innerHTML = '';
  await loadMenu();
}

function renderMenu() {
  refs.menuList.innerHTML = '';
  if (!state.menu.length) {
    refs.menuList.innerHTML = '<div class="muted">No menu items yet.</div>';
    return;
  }

  state.menu.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.innerHTML = `
      <div class="menu-summary">${item.name_en || 'New item'}${item.category_en ? ` • ${item.category_en}` : ''}${item.price ? ` • ${item.price} ${item.currency || 'EGP'}` : ''}</div>
      <div class="menu-grid">
        <label>Name EN<input data-key="name_en" value="${item.name_en || ''}"></label>
        <label>Name AR<input data-key="name_ar" value="${item.name_ar || ''}"></label>
        <label>Category EN<input data-key="category_en" value="${item.category_en || ''}"></label>
        <label>Category AR<input data-key="category_ar" value="${item.category_ar || ''}"></label>
        <label>Price<input data-key="price" value="${item.price ?? ''}"></label>
        <label>Currency<input data-key="currency" value="${item.currency || 'EGP'}"></label>
        <label>Description EN<textarea data-key="description_en" rows="2">${item.description_en || ''}</textarea></label>
        <label>Description AR<textarea data-key="description_ar" rows="2">${item.description_ar || ''}</textarea></label>
        <label>Sizes (comma separated)<input data-key="sizes" value="${Array.isArray(item.sizes) ? item.sizes.join(', ') : ''}"></label>
        <label>Available
          <select data-key="available">
            <option value="1" ${item.available ? 'selected' : ''}>Yes</option>
            <option value="0" ${item.available ? '' : 'selected'}>No</option>
          </select>
        </label>
      </div>
      <div class="row-actions">
        <button type="button" data-action="save">Save item</button>
        <button type="button" class="secondary" data-action="delete">Delete item</button>
      </div>
    `;

    row.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const payload = {};
      row.querySelectorAll('[data-key]').forEach((field) => {
        payload[field.dataset.key] = field.value;
      });
      payload.available = Number(payload.available);
      payload.sizes = payload.sizes;
      if (item.id) {
        await api(`/dashboard/menu/${state.selectedCafe.id}/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showStatus('Menu item updated.');
      } else {
        await api(`/dashboard/menu/${state.selectedCafe.id}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showStatus('Menu item created.');
      }
      await loadMenu();
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!item.id) {
        state.menu = state.menu.filter((entry) => entry !== item);
        renderMenu();
        return;
      }
      await api(`/dashboard/menu/${state.selectedCafe.id}/${item.id}`, { method: 'DELETE' });
      showStatus('Menu item deleted.');
      await loadMenu();
    });

    refs.menuList.appendChild(row);
  });
}

async function loadMenu() {
  state.menu = await api(`/dashboard/menu/${state.selectedCafe.id}`);
  renderMenu();
}

async function loadSessions() {
  const sessions = await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions`);
  refs.sessionsList.innerHTML = '';
  if (!sessions.length) {
    refs.sessionsList.innerHTML = '<div class="muted">No sessions yet.</div>';
    return;
  }
  sessions.forEach((session) => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <strong>${session.guest_name || 'Guest without name yet'}</strong>
      <div>Phone: ${session.guest_phone || '-'}</div>
      <div>Phase: ${session.phase}</div>
      <div>Messages: ${session.message_count}</div>
      <div>Last active: ${session.last_active}</div>
      <div class="row-actions">
        <button type="button" data-action="view">View conversation</button>
      </div>
    `;
    row.querySelector('[data-action="view"]').addEventListener('click', async () => {
      const result = await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions/${session.id}/messages`);
      refs.sessionMessages.innerHTML = '';
      result.messages.forEach((message) => {
        const div = document.createElement('div');
        div.className = `msg ${message.role}`;
        div.textContent = `${message.role.toUpperCase()}: ${message.content}`;
        refs.sessionMessages.appendChild(div);
      });
    });
    refs.sessionsList.appendChild(row);
  });
}

refs.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  refs.loginError.textContent = '';
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
    refs.userMeta.textContent = `${state.user.username} (${state.user.role})`;
    refs.createCafe.classList.toggle('hidden', state.user.role !== 'admin');
    setLoggedIn(true);
    await refreshCafes();
    showStatus('Logged in successfully.');
  } catch (error) {
    refs.loginError.textContent = error.message;
  }
});

refs.logout.addEventListener('click', () => {
  localStorage.removeItem('eglotech_dashboard_token');
  window.location.reload();
});

refs.refreshCafes.addEventListener('click', () => refreshCafes());

refs.createCafe.addEventListener('click', async () => {
  const name = window.prompt('Cafe name');
  if (!name) return;
  const result = await api('/dashboard/cafes', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await refreshCafes(result.id);
  window.alert(`New token: ${result.token}`);
});

refs.saveCafe.addEventListener('click', async () => {
  await api(`/dashboard/cafes/${state.selectedCafe.id}`, {
    method: 'PUT',
    body: JSON.stringify(collectCafePayload()),
  });
  await refreshCafes(state.selectedCafe.id);
  showStatus('Cafe settings saved.');
});

refs.copyEmbed.addEventListener('click', async () => {
  const snippet = `<script src="${window.location.origin}/widget.js?token=${state.selectedCafe.token}"></script>`;
  await navigator.clipboard.writeText(snippet);
  window.alert('Embed code copied.');
});

refs.syncMenu.addEventListener('click', async () => {
  try {
    const result = await api(`/dashboard/menu/${state.selectedCafe.id}/sync`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadMenu();
    showStatus(`Menu sync finished. Imported ${result.synced || 0} items.`);
  } catch (error) {
    showStatus(`Menu sync failed: ${error.message}`, true);
  }
});

refs.addMenuItem.addEventListener('click', () => {
  state.menu.unshift({
    name_en: '',
    name_ar: '',
    category_en: '',
    category_ar: '',
    description_en: '',
    description_ar: '',
    price: '',
    currency: 'EGP',
    sizes: [],
    available: 1,
  });
  renderMenu();
  showStatus('New menu row added. Fill it and click Save item.');
});

refs.loadSessions.addEventListener('click', loadSessions);

if (state.token) {
  api('/dashboard/auth/me')
    .then(async (user) => {
      state.user = user;
      refs.userMeta.textContent = `${state.user.username} (${state.user.role})`;
      refs.createCafe.classList.toggle('hidden', state.user.role !== 'admin');
      setLoggedIn(true);
      await refreshCafes();
    })
    .catch(() => {
      localStorage.removeItem('eglotech_dashboard_token');
      setLoggedIn(false);
    });
}
