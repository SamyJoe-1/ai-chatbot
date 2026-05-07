/* ═══════ MENU ═══════ */
async function loadMenu() {
  if (!state.selectedCafe) return;
  try {
    state.menu = await api(`/dashboard/menu/${state.selectedCafe.id}`);
    syncMenuFilterControls();
    syncMenuCategoryOptions();
    renderMenu();
  } catch (err) { toastErr('Failed to load menu'); }
}

function syncMenuFilterControls() {
  const search = document.getElementById('menu-search');
  const category = document.getElementById('menu-filter-category');
  const availability = document.getElementById('menu-filter-availability');
  if (search) search.value = state.menuFilter.search || '';
  if (category) category.value = state.menuFilter.category || 'all';
  if (availability) availability.value = state.menuFilter.availability || 'all';
}

function syncMenuCategoryOptions() {
  const select = document.getElementById('menu-filter-category');
  if (!select) return;

  const previous = state.menuFilter.category || select.value || 'all';
  const categories = [...new Set(
    state.menu
      .map(item => String(item.category_en || item.category_ar || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="all">All Categories</option>';
  categories.forEach(category => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });

  state.menuFilter.category = categories.includes(previous) ? previous : 'all';
  select.value = state.menuFilter.category;
}

function getFilteredMenuItems() {
  const search = (state.menuFilter.search || '').trim().toLowerCase();
  const category = state.menuFilter.category || 'all';
  const availability = state.menuFilter.availability || 'all';

  return state.menu.filter(item => {
    const haystack = [
      item.name_en,
      item.name_ar,
      item.category_en,
      item.category_ar,
      item.description_en,
      item.description_ar,
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

function renderMenu() {
  const list = document.getElementById('menu-list');
  const pagEl = document.getElementById('menu-pagination');
  list.innerHTML = '';
  pagEl.innerHTML = '';

  if (!state.menu.length) {
    list.innerHTML = '<div class="menu-empty"><i class="fas fa-utensils"></i><p>No menu items yet.</p></div>';
    return;
  }

  const filteredMenu = getFilteredMenuItems();
  if (!filteredMenu.length) {
    list.innerHTML = '<div class="menu-filter-empty"><i class="fas fa-filter-circle-xmark"></i><p>No items match the current filters.</p></div>';
    return;
  }

  const perPage = state.MENU_PER_PAGE;
  const total = Math.ceil(filteredMenu.length / perPage);
  if (state.menuPage > total) state.menuPage = total;
  const start = (state.menuPage - 1) * perPage;
  const slice = filteredMenu.slice(start, start + perPage);

  slice.forEach(item => {
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.innerHTML = `
      <span class="mr-name">${esc(item.name_en || 'Untitled')}</span>
      <span class="mr-cat">${esc(item.category_en || '-')}</span>
      <span class="mr-price">${item.price != null ? item.price + ' ' + (item.currency || 'EGP') : '-'}</span>
      <span class="mr-actions">
        <button class="icon-btn icon-btn-edit" title="Edit"><i class="fas fa-pen-to-square"></i></button>
        <button class="icon-btn icon-btn-del" title="Delete"><i class="fas fa-trash-can"></i></button>
      </span>`;
    row.querySelector('.icon-btn-edit').addEventListener('click', () => openMenuItemModal(item));
    row.querySelector('.icon-btn-del').addEventListener('click', () => deleteMenuItem(item));
    list.appendChild(row);
  });

  if (total > 1) renderPagination(pagEl, state.menuPage, total, p => { state.menuPage = p; renderMenu(); });
}

function openMenuItemModal(item) {
  const isNew = !item.id;
  Swal.fire({
    title: isNew ? 'Add Menu Item' : 'Edit Menu Item',
    html: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left;font-size:13px">
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Name EN</label><input id="swal-name-en" class="swal2-input" style="margin:0;width:100%" value="${esc(item.name_en || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Name AR</label><input id="swal-name-ar" class="swal2-input" style="margin:0;width:100%" dir="rtl" value="${esc(item.name_ar || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Category EN</label><input id="swal-cat-en" class="swal2-input" style="margin:0;width:100%" value="${esc(item.category_en || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Category AR</label><input id="swal-cat-ar" class="swal2-input" style="margin:0;width:100%" dir="rtl" value="${esc(item.category_ar || '')}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Price</label><input id="swal-price" class="swal2-input" style="margin:0;width:100%" value="${item.price ?? ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Currency</label><input id="swal-currency" class="swal2-input" style="margin:0;width:100%" value="${esc(item.currency || 'EGP')}"></div>
        <div style="grid-column:1/-1"><label style="font-weight:600;display:block;margin-bottom:4px">Description EN</label><textarea id="swal-desc-en" class="swal2-textarea" style="margin:0;width:100%;min-height:50px">${esc(item.description_en || '')}</textarea></div>
        <div style="grid-column:1/-1"><label style="font-weight:600;display:block;margin-bottom:4px">Description AR</label><textarea id="swal-desc-ar" class="swal2-textarea" style="margin:0;width:100%;min-height:50px" dir="rtl">${esc(item.description_ar || '')}</textarea></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Sizes (comma sep)</label><input id="swal-sizes" class="swal2-input" style="margin:0;width:100%" value="${Array.isArray(item.sizes) ? item.sizes.join(', ') : ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px">Available</label><select id="swal-avail" class="swal2-input" style="margin:0;width:100%;padding:8px"><option value="1" ${item.available !== 0 ? 'selected' : ''}>Yes</option><option value="0" ${item.available === 0 ? 'selected' : ''}>No</option></select></div>
      </div>`,
    width: 600,
    showCancelButton: true,
    confirmButtonText: isNew ? 'Create' : 'Save',
    showLoaderOnConfirm: true,
    preConfirm: async () => {
      const payload = {
        name_en: document.getElementById('swal-name-en').value,
        name_ar: document.getElementById('swal-name-ar').value,
        category_en: document.getElementById('swal-cat-en').value,
        category_ar: document.getElementById('swal-cat-ar').value,
        price: document.getElementById('swal-price').value,
        currency: document.getElementById('swal-currency').value,
        description_en: document.getElementById('swal-desc-en').value,
        description_ar: document.getElementById('swal-desc-ar').value,
        sizes: document.getElementById('swal-sizes').value,
        available: Number(document.getElementById('swal-avail').value),
      };
      try {
        if (item.id) {
          await api(`/dashboard/menu/${state.selectedCafe.id}/${item.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await api(`/dashboard/menu/${state.selectedCafe.id}`, { method: 'POST', body: JSON.stringify(payload) });
        }
        return true;
      } catch (err) { Swal.showValidationMessage(err.message); }
    },
    allowOutsideClick: () => !Swal.isLoading(),
  }).then(r => {
    if (r.isConfirmed) {
      toast(isNew ? 'Item created!' : 'Item updated!');
      loadMenu();
    }
  });
}

async function deleteMenuItem(item) {
  if (!item.id) { state.menu = state.menu.filter(i => i !== item); renderMenu(); return; }
  const { isConfirmed } = await Swal.fire({ title: 'Delete item?', text: item.name_en, icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete' });
  if (!isConfirmed) return;
  try {
    await api(`/dashboard/menu/${state.selectedCafe.id}/${item.id}`, { method: 'DELETE' });
    toast('Item deleted');
    await loadMenu();
  } catch (err) { toastErr(err.message); }
}

document.getElementById('sync-menu-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-menu-btn');
  btnLoad(btn, true);
  try {
    const r = await api(`/dashboard/menu/${state.selectedCafe.id}/sync`, { method: 'POST', body: JSON.stringify({}) });
    toast(`Synced ${r.synced || 0} items from sheet!`);
    await loadMenu();
  } catch (err) { toastErr('Sync failed: ' + err.message); }
  finally { btnLoad(btn, false); }
});

document.getElementById('add-menu-btn').addEventListener('click', () => {
  openMenuItemModal({ name_en: '', name_ar: '', category_en: '', category_ar: '', description_en: '', description_ar: '', price: '', currency: 'EGP', sizes: [], available: 1 });
});

document.getElementById('menu-search').addEventListener('input', e => {
  state.menuFilter.search = e.target.value;
  state.menuPage = 1;
  renderMenu();
});

document.getElementById('menu-filter-category').addEventListener('change', e => {
  state.menuFilter.category = e.target.value;
  state.menuPage = 1;
  renderMenu();
});

document.getElementById('menu-filter-availability').addEventListener('change', e => {
  state.menuFilter.availability = e.target.value;
  state.menuPage = 1;
  renderMenu();
});

/* ═══════ SESSIONS ═══════ */
async function loadSessions() {
  if (!state.selectedCafe) return;
  try {
    state.sessions = await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions`);
    renderSessions();
  } catch (err) { toastErr('Failed to load sessions'); }
}

function renderSessions() {
  const list = document.getElementById('sessions-list');
  const pagEl = document.getElementById('sessions-pagination');
  list.innerHTML = '';
  pagEl.innerHTML = '';

  let filtered = state.sessions;
  const f = state.sessionFilter;
  if (f.name) filtered = filtered.filter(s => (s.guest_name || '').toLowerCase().includes(f.name.toLowerCase()));
  if (f.phone) filtered = filtered.filter(s => (s.guest_phone || '').includes(f.phone));
  if (f.date) filtered = filtered.filter(s => (s.last_active || '').startsWith(f.date));

  if (!filtered.length) {
    list.innerHTML = '<div class="sessions-empty"><i class="fas fa-comments"></i><p>No sessions found.</p></div>';
    return;
  }

  const perPage = state.SESSIONS_PER_PAGE;
  const total = Math.ceil(filtered.length / perPage);
  if (state.sessionsPage > total) state.sessionsPage = total;
  const start = (state.sessionsPage - 1) * perPage;
  const slice = filtered.slice(start, start + perPage);

  slice.forEach(s => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <div class="session-info">
        <div class="session-name"><i class="fas fa-user" style="color:var(--accent);margin-right:6px;font-size:11px"></i>${esc(s.guest_name || 'Guest')}</div>
        <div class="session-detail">
          <span><i class="fas fa-phone" style="font-size:10px"></i> ${esc(s.guest_phone || '-')}</span>
          <span><i class="fas fa-comments" style="font-size:10px"></i> ${s.message_count} msgs</span>
          <span><i class="fas fa-clock" style="font-size:10px"></i> ${s.last_active || '-'}</span>
        </div>
      </div>
      <div class="session-actions">
        <button class="icon-btn icon-btn-edit" title="View chat"><i class="fas fa-eye"></i></button>
        <button class="icon-btn icon-btn-del" title="Delete session"><i class="fas fa-trash-can"></i></button>
      </div>`;
    row.querySelector('.icon-btn-edit').addEventListener('click', e => { e.stopPropagation(); viewSession(s); });
    row.querySelector('.icon-btn-del').addEventListener('click', e => { e.stopPropagation(); deleteSession(s); });
    list.appendChild(row);
  });

  if (total > 1) renderPagination(pagEl, state.sessionsPage, total, p => { state.sessionsPage = p; renderSessions(); });
}

async function fetchSessionMessages(sessionId) {
  return api(`/dashboard/cafes/${state.selectedCafe.id}/sessions/${sessionId}/messages`);
}

function getChatMessagesSignature(messages) {
  const last = messages[messages.length - 1];
  return `${messages.length}:${last?.role || ''}:${last?.created_at || ''}:${last?.content || ''}`;
}

function renderSessionMessages(container, messages, { forceScroll = false } = {}) {
  const shouldStickToBottom = forceScroll || (container.scrollHeight - container.scrollTop - container.clientHeight < 60);
  container.innerHTML = messages.map(m => `
    <div class="chat-msg ${m.role === 'user' ? 'user' : 'bot'}">
      ${esc(m.content)}
      <div class="chat-msg-time">${m.created_at || ''}</div>
    </div>
  `).join('') || '<p style="color:var(--text-muted)">No messages yet</p>';
  if (shouldStickToBottom) {
    container.scrollTop = container.scrollHeight;
  }
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
        await loadSessions();
      }
    } catch {}
  }, 2500);
}

async function viewSession(session) {
  try {
    const result = await fetchSessionMessages(session.id);
    state.activeSessionChatSignature = getChatMessagesSignature(result.messages);

    await Swal.fire({
      title: `Chat — ${esc(session.guest_name || 'Guest')}`,
      html: `
        <div class="chat-modal-body" id="chat-scroll"></div>
        <div class="chat-input-row">
          <input id="admin-msg-input" placeholder="Type admin message..." autocomplete="off">
          <button class="btn btn-primary btn-sm" id="send-admin-msg" type="button"><i class="fas fa-paper-plane"></i></button>
        </div>`,
      width: 560,
      showConfirmButton: false,
      showCloseButton: true,
      didOpen: () => {
        const scroll = document.getElementById('chat-scroll');
        renderSessionMessages(scroll, result.messages, { forceScroll: true });
        startSessionChatPolling(session, scroll);
        document.getElementById('send-admin-msg').addEventListener('click', async () => {
          const inp = document.getElementById('admin-msg-input');
          const msg = inp.value.trim();
          if (!msg) return;
          try {
            await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions/${session.id}/messages`, {
              method: 'POST',
              body: JSON.stringify({ content: msg }),
            });
            inp.value = '';
            const refreshed = await fetchSessionMessages(session.id);
            state.activeSessionChatSignature = getChatMessagesSignature(refreshed.messages);
            renderSessionMessages(scroll, refreshed.messages, { forceScroll: true });
            await loadSessions();
            toast('Message sent!');
          } catch (err) { toastErr(err.message); }
        });
        document.getElementById('admin-msg-input').addEventListener('keydown', e => {
          if (e.key === 'Enter') document.getElementById('send-admin-msg').click();
        });
      },
      willClose: () => {
        stopSessionChatPolling();
      },
    });
  } catch (err) { toastErr(err.message); }
}

async function deleteSession(session) {
  const { isConfirmed } = await Swal.fire({
    title: 'Delete session?',
    text: `${session.guest_name || 'Guest'} — ${session.message_count} messages`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Delete',
  });
  if (!isConfirmed) return;
  try {
    await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions/${session.id}`, { method: 'DELETE' });
    toast('Session deleted');
    await loadSessions();
  } catch (err) { toastErr(err.message); }
}

document.getElementById('filter-sessions-btn').addEventListener('click', () => {
  Swal.fire({
    title: 'Filter Sessions',
    html: `
      <div style="text-align:left;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Client Name</label><input id="swal-f-name" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.name || ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Phone</label><input id="swal-f-phone" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.phone || ''}"></div>
        <div><label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Date (YYYY-MM-DD)</label><input id="swal-f-date" class="swal2-input" style="margin:0;width:100%" value="${state.sessionFilter.date || ''}" placeholder="2026-05-07"></div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'Apply',
    cancelButtonText: 'Clear Filters',
  }).then(r => {
    if (r.isConfirmed) {
      state.sessionFilter = {
        name: document.getElementById('swal-f-name').value.trim(),
        phone: document.getElementById('swal-f-phone').value.trim(),
        date: document.getElementById('swal-f-date').value.trim(),
      };
    } else if (r.dismiss === Swal.DismissReason.cancel) {
      state.sessionFilter = {};
    }
    state.sessionsPage = 1;
    renderSessions();
  });
});

document.getElementById('clear-sessions-btn').addEventListener('click', async () => {
  if (!state.selectedCafe) return;
  const btn = document.getElementById('clear-sessions-btn');
  const { isConfirmed } = await Swal.fire({
    title: 'Clear ALL sessions?',
    text: 'This will permanently delete all chat sessions and messages for this cafe.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Clear All',
  });
  if (!isConfirmed) return;
  btnLoad(btn, true);
  try {
    await api(`/dashboard/cafes/${state.selectedCafe.id}/sessions`, { method: 'DELETE' });
    toast('All sessions cleared');
    await loadSessions();
  } catch (err) { toastErr(err.message); }
  finally { btnLoad(btn, false); }
});

/* ═══════ PAGINATION HELPER ═══════ */
function renderPagination(container, current, total, onChange) {
  container.innerHTML = '';
  const prev = document.createElement('button');
  prev.className = 'page-btn';
  prev.innerHTML = '<i class="fas fa-chevron-left"></i>';
  prev.disabled = current <= 1;
  prev.addEventListener('click', () => onChange(current - 1));
  container.appendChild(prev);

  for (let i = 1; i <= total; i++) {
    if (total > 7 && i > 3 && i < total - 1 && Math.abs(i - current) > 1) {
      if (i === 4 || i === total - 2) {
        const dots = document.createElement('span');
        dots.className = 'page-btn';
        dots.textContent = '…';
        dots.style.cursor = 'default';
        dots.style.border = 'none';
        container.appendChild(dots);
      }
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (i === current ? ' active' : '');
    btn.textContent = i;
    btn.addEventListener('click', () => onChange(i));
    container.appendChild(btn);
  }

  const next = document.createElement('button');
  next.className = 'page-btn';
  next.innerHTML = '<i class="fas fa-chevron-right"></i>';
  next.disabled = current >= total;
  next.addEventListener('click', () => onChange(current + 1));
  container.appendChild(next);
}
