/**
 * dashboard.js — Full-page dashboard for Transmission Remote extension.
 * Displays all torrents in a list with a slide-in sidebar detail panel.
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   STATE
   ───────────────────────────────────────────────────────────── */

let allTorrents = [];           // Raw torrent list from last fetch
let filteredTorrents = [];      // After search + filter + sort
let selectedIds = new Set();    // Multi-select set of torrent IDs
let sidebarTorrentId = null;    // Currently shown in sidebar
let sidebarDetail = null;       // Full detail data for sidebar torrent

// Filters / search / sort
let searchQuery = '';
let activeFilter = 'all';
let sortBy = 'queue';
let sortDir = 'asc';

// Sidebar tab state
let activeSidebarTab = 'info';

// Peers sort (sidebar)
let sbPeerSort = { col: 'address', dir: 'asc' };

// Files sort (sidebar)
let sbFileSort = { col: 'name', dir: 'asc' };
const sbFolderOpenState = {};

// Turtle mode
let turtleEnabled = false;

// Session info (fetched once)
let sessionInfo = null;
let defaultDownloadDir = '';

// Timers
let listRefreshTimer = null;
let sidebarRefreshTimer = null;
let statsRefreshTimer = null;
let turtleRefreshTimer = null;
let footerTickTimer = null;
let lastUpdated = null;

// Context menu target
let ctxTargetId = null;

// Row remove dropdown target
let rowRemoveTargetId = null;

/* ─────────────────────────────────────────────────────────────
   MESSAGING — with timeout (CRITICAL)
   ───────────────────────────────────────────────────────────── */

function send(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No response from background')), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (resp === undefined) reject(new Error('No response'));
        else resolve(resp);
      });
    } catch (err) { clearTimeout(timer); reject(err); }
  });
}

/* ─────────────────────────────────────────────────────────────
   XSS PROTECTION
   ───────────────────────────────────────────────────────────── */

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─────────────────────────────────────────────────────────────
   INITIALIZATION
   ───────────────────────────────────────────────────────────── */

async function init() {
  setupToolbar();
  setupSidebar();
  setupBulkBar();
  setupContextMenu();
  setupRowRemoveDropdown();
  setupKeyboardShortcuts();
  setupAddBar();
  setupTopbarButtons();

  // Initial data load
  await initialLoad();
}

async function initialLoad() {
  showState('loading');
  try {
    // Fetch session info (once)
    const sessionResp = await send({ type: 'GET_SESSION' });
    if (sessionResp && sessionResp.success && sessionResp.data) {
      sessionInfo = sessionResp.data;
      defaultDownloadDir = sessionInfo['download-dir'] || '';
      updateServerInfo(sessionInfo);
    }

    // Fetch turtle mode (once)
    fetchTurtleMode();

    // Load torrents
    await loadTorrents();
    showState('list');

    // Start refresh timers
    scheduleListRefresh();
    scheduleStatsRefresh();
    scheduleTurtleRefresh();
    startFooterTick();
  } catch (err) {
    showState('error', err.message);
  }
}

function showState(state, errMsg) {
  document.getElementById('loading-state').classList.toggle('hidden', state !== 'loading');
  document.getElementById('connection-error').classList.toggle('hidden', state !== 'error');
  document.getElementById('torrent-list-wrap').classList.toggle('hidden', state !== 'list');
  if (state === 'error' && errMsg) {
    document.getElementById('err-desc').textContent = errMsg;
  }
}

/* ─────────────────────────────────────────────────────────────
   TORRENT LIST FETCHING
   ───────────────────────────────────────────────────────────── */

async function loadTorrents() {
  const resp = await send({ type: 'GET_TORRENTS' });
  if (!resp.success) throw new Error(resp.error || 'Failed to load torrents');
  allTorrents = (resp.data && resp.data.torrents) || [];
  lastUpdated = Date.now();
  applyFilterAndRender();
}

async function refreshTorrents() {
  try {
    const resp = await send({ type: 'GET_TORRENTS' });
    if (!resp.success) return;
    allTorrents = (resp.data && resp.data.torrents) || [];
    lastUpdated = Date.now();
    applyFilterAndRender();
  } catch (_) {
    // Silent refresh — don't disrupt UI
  }
}

function scheduleListRefresh() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(async () => {
    await refreshTorrents();
    scheduleListRefresh();
  }, 3000);
}

/* ─────────────────────────────────────────────────────────────
   STATS REFRESH (top bar)
   ───────────────────────────────────────────────────────────── */

async function fetchStats() {
  try {
    const [statsResp, spaceResp] = await Promise.all([
      send({ type: 'GET_SESSION_STATS' }),
      defaultDownloadDir ? send({ type: 'GET_FREE_SPACE', path: defaultDownloadDir }) : Promise.resolve(null),
    ]);

    let dlSpeed = 0, ulSpeed = 0;
    if (statsResp && statsResp.success && statsResp.data) {
      dlSpeed = statsResp.data.downloadSpeed || 0;
      ulSpeed = statsResp.data.uploadSpeed || 0;
    }

    let freeSpace = null;
    if (spaceResp && spaceResp.success && spaceResp.data) {
      freeSpace = spaceResp.data['size-bytes'];
    }

    renderTopbarStats(dlSpeed, ulSpeed, freeSpace);
  } catch (_) {}
}

function scheduleStatsRefresh() {
  clearTimeout(statsRefreshTimer);
  fetchStats();
  statsRefreshTimer = setTimeout(() => {
    fetchStats();
    scheduleStatsRefresh();
  }, 3000);
}

function renderTopbarStats(dlSpeed, ulSpeed, freeSpace) {
  const count = allTorrents.length;
  const dlStr = formatSpeed(dlSpeed);
  const ulStr = formatSpeed(ulSpeed);
  const freeStr = freeSpace != null ? formatBytes(freeSpace) : null;

  let html = `
    <div class="topbar-stat">
      ${icon('download', 12)}
      <span class="val">${escHtml(dlStr)}</span>
    </div>
    <span class="topbar-sep">·</span>
    <div class="topbar-stat">
      ${icon('upload', 12)}
      <span class="val">${escHtml(ulStr)}</span>
    </div>
    <span class="topbar-sep">│</span>
    <div class="topbar-stat">
      <span class="val">${count}</span>&nbsp;torrent${count !== 1 ? 's' : ''}
    </div>
  `;
  if (freeStr) {
    html += `
      <span class="topbar-sep">│</span>
      <div class="topbar-stat">
        <span style="color:var(--text-tertiary)">Free:</span>
        <span class="val">${escHtml(freeStr)}</span>
      </div>
    `;
  }

  document.getElementById('topbar-stats').innerHTML = html;
}

/* ─────────────────────────────────────────────────────────────
   TURTLE MODE
   ───────────────────────────────────────────────────────────── */

async function fetchTurtleMode() {
  try {
    const resp = await send({ type: 'GET_TURTLE_MODE' });
    if (resp && resp.success && resp.data) {
      turtleEnabled = !!resp.data.enabled;
      updateTurtleBtn();
    }
  } catch (_) {}
}

async function toggleTurtleMode() {
  try {
    const resp = await send({ type: 'SET_TURTLE_MODE', enabled: !turtleEnabled });
    if (resp && resp.success) {
      turtleEnabled = !turtleEnabled;
      updateTurtleBtn();
      showToast(turtleEnabled ? 'Alt speed enabled' : 'Alt speed disabled', 'success');
    }
  } catch (err) {
    showToast('Failed to toggle alt speed', 'error');
  }
}

function updateTurtleBtn() {
  const btn = document.getElementById('btn-turtle');
  btn.classList.toggle('turtle-active', turtleEnabled);
  btn.title = turtleEnabled ? 'Disable Alt Speed (Turtle Mode)' : 'Enable Alt Speed (Turtle Mode)';
}

function scheduleTurtleRefresh() {
  clearTimeout(turtleRefreshTimer);
  turtleRefreshTimer = setTimeout(() => {
    fetchTurtleMode();
    scheduleTurtleRefresh();
  }, 10000);
}

/* ─────────────────────────────────────────────────────────────
   SESSION / SERVER INFO
   ───────────────────────────────────────────────────────────── */

function updateServerInfo(session) {
  const ver = session.version ? 'Transmission ' + session.version : '';
  const rpc = session['rpc-version'] ? ' · RPC r' + session['rpc-version'] : '';
  const el = document.getElementById('status-server-info');
  if (el) el.textContent = ver + rpc;
}

/* ─────────────────────────────────────────────────────────────
   FILTER / SEARCH / SORT
   ───────────────────────────────────────────────────────────── */

function applyFilterAndRender() {
  let list = allTorrents.slice();

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(t => (t.name || '').toLowerCase().includes(q));
  }

  // Status filter
  if (activeFilter !== 'all') {
    list = list.filter(t => matchesFilter(t, activeFilter));
  }

  // Sort
  list = sortTorrents(list);

  filteredTorrents = list;
  renderTorrentList();
}

function matchesFilter(t, filter) {
  if (filter === 'downloading') return t.status === 4;
  if (filter === 'seeding')     return t.status === 6;
  if (filter === 'stopped')     return t.status === 0;
  if (filter === 'active')      return (t.rateDownload > 0 || t.rateUpload > 0) && t.status !== 0;
  if (filter === 'error')       return t.error > 0;
  return true;
}

function sortTorrents(list) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    switch (sortBy) {
      case 'queue':    return ((a.queuePosition || 0) - (b.queuePosition || 0)) * dir;
      case 'name':     return (a.name || '').localeCompare(b.name || '') * dir;
      case 'added':    return ((a.addedDate || 0) - (b.addedDate || 0)) * dir;
      case 'size':     return ((a.totalSize || 0) - (b.totalSize || 0)) * dir;
      case 'progress': return ((a.percentDone || 0) - (b.percentDone || 0)) * dir;
      case 'speed':    return ((a.rateDownload || 0) - (b.rateDownload || 0)) * dir;
      case 'ratio':    return ((a.uploadRatio || 0) - (b.uploadRatio || 0)) * dir;
      case 'status':   return ((a.status || 0) - (b.status || 0)) * dir;
      default:         return 0;
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   TORRENT LIST RENDERING
   ───────────────────────────────────────────────────────────── */

function renderTorrentList() {
  const list = document.getElementById('torrent-list');
  const noTorrents = document.getElementById('empty-no-torrents');
  const noResults = document.getElementById('empty-no-results');

  if (allTorrents.length === 0) {
    list.innerHTML = '';
    noTorrents.classList.remove('hidden');
    noResults.classList.add('hidden');
    updateBulkBar();
    return;
  }
  noTorrents.classList.add('hidden');

  if (filteredTorrents.length === 0) {
    list.innerHTML = '';
    noResults.classList.remove('hidden');
    updateBulkBar();
    return;
  }
  noResults.classList.add('hidden');

  // Diff update: reuse existing <li> elements by id to avoid scroll jump
  const existingItems = {};
  list.querySelectorAll('.torrent-item').forEach(el => {
    existingItems[el.dataset.id] = el;
  });

  const fragment = document.createDocumentFragment();
  filteredTorrents.forEach(t => {
    let el = existingItems[t.id];
    if (el) {
      updateTorrentItem(el, t);
      delete existingItems[t.id];
    } else {
      el = createTorrentItem(t);
    }
    fragment.appendChild(el);
  });
  list.innerHTML = '';
  list.appendChild(fragment);

  updateBulkBar();
}

function createTorrentItem(t) {
  const li = document.createElement('li');
  li.className = 'torrent-item';
  li.dataset.id = t.id;
  li.setAttribute('tabindex', '0');
  li.innerHTML = torrentItemHTML(t);

  // Click: select + open sidebar
  li.addEventListener('click', (e) => {
    if (e.target.closest('.action-btn, .row-remove-dropdown')) return;
    handleItemClick(t.id, e);
  });

  // Double-click: open sidebar
  li.addEventListener('dblclick', (e) => {
    if (e.target.closest('.action-btn')) return;
    openSidebar(t.id);
  });

  // Right-click: context menu
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, t.id);
  });

  wireTorrentActions(li, t);
  return li;
}

function updateTorrentItem(el, t) {
  const isSelected = selectedIds.has(t.id);
  el.classList.toggle('selected', isSelected);

  const info = getStatusInfo(t.status, t.error);

  // Badge
  const badge = el.querySelector('.t-badge');
  if (badge) {
    badge.className = 'badge badge-' + info.class + ' t-badge';
    badge.innerHTML = icon(info.icon, 9) + escHtml(info.label);
  }

  // Name
  const nameEl = el.querySelector('.torrent-name');
  if (nameEl) {
    nameEl.textContent = t.name || 'Unknown';
    nameEl.title = t.name || '';
  }

  // Progress bar
  const fill = el.querySelector('.progress-bar-fill');
  if (fill) {
    const pct = Math.min(100, (t.percentDone || 0) * 100);
    fill.style.width = pct + '%';
    fill.className = 'progress-bar-fill ' + (t.error > 0 ? 'error' : info.class);
  }

  // Stats
  const stats = el.querySelector('.torrent-stats');
  if (stats) stats.innerHTML = torrentStatsHTML(t, info);
}

function torrentItemHTML(t) {
  const info = getStatusInfo(t.status, t.error);
  const pct = Math.min(100, (t.percentDone || 0) * 100);
  const isSelected = selectedIds.has(t.id);

  return `
    <div class="torrent-row1">
      <span class="badge badge-${info.class} t-badge">${icon(info.icon, 9)}${escHtml(info.label)}</span>
      <span class="torrent-name" title="${escAttr(t.name || '')}">${escHtml(t.name || 'Unknown')}</span>
      <div class="torrent-actions">
        <button class="action-btn" data-action="toggle-play" title="${t.status === 0 ? 'Start' : 'Stop'}">
          ${t.status === 0 ? icon('play', 12) : icon('pause', 12)}
        </button>
        <div class="remove-wrap">
          <button class="action-btn danger" data-action="remove-toggle" title="Remove">
            ${icon('trash', 12)}
          </button>
        </div>
        <button class="action-btn" data-action="open-detail" title="Open full detail view">
          ${icon('expand', 12)}
        </button>
      </div>
    </div>
    <div class="torrent-progress-row">
      <div class="progress-bar">
        <div class="progress-bar-fill ${t.error > 0 ? 'error' : info.class}" style="width:${pct}%"></div>
      </div>
    </div>
    <div class="torrent-stats">${torrentStatsHTML(t, info)}</div>
  `;
}

function torrentStatsHTML(t, info) {
  const pct = formatPercent(t.percentDone || 0);
  const size = formatBytes(t.totalSize || t.sizeWhenDone || 0);
  const dl = formatSpeed(t.rateDownload || 0);
  const ul = formatSpeed(t.rateUpload || 0);
  const eta = (t.status === 4 && t.eta > 0) ? formatEta(t.eta) : null;
  const peers = t.peersConnected != null ? t.peersConnected : null;
  const ratio = t.uploadRatio != null ? formatRatio(t.uploadRatio) : null;

  let html = `<span class="stat-piece">${escHtml(pct)} of ${escHtml(size)}</span>`;

  if (t.rateDownload > 0 || t.status === 4) {
    html += `<span class="stat-sep">·</span><span class="stat-piece">${icon('download', 10)}<span>${escHtml(dl)}</span></span>`;
  }
  if (t.rateUpload > 0 || t.status === 6) {
    html += `<span class="stat-sep">·</span><span class="stat-piece">${icon('upload', 10)}<span>${escHtml(ul)}</span></span>`;
  }
  if (eta) {
    html += `<span class="stat-sep">·</span><span class="stat-piece">${icon('clock', 10)}<span>ETA: ${escHtml(eta)}</span></span>`;
  }
  if (peers != null && (t.status === 4 || t.status === 6)) {
    html += `<span class="stat-sep hide-sm">·</span><span class="stat-piece hide-sm">${icon('server', 10)}<span>${peers} peer${peers !== 1 ? 's' : ''}</span></span>`;
  }
  if (ratio != null && t.status === 6) {
    html += `<span class="stat-sep hide-sm">·</span><span class="stat-piece hide-sm"><span style="color:var(--text-tertiary)">Ratio:</span><span>${escHtml(ratio)}</span></span>`;
  }

  // Error message
  if (t.error > 0 && t.errorString) {
    html += `<span class="stat-sep">·</span><span class="stat-piece" style="color:var(--red)">${icon('alert', 10)}${escHtml(t.errorString)}</span>`;
  }

  return html;
}

function wireTorrentActions(el, t) {
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();

    const action = btn.dataset.action;
    if (action === 'toggle-play') {
      doAction(t.status === 0 ? 'start' : 'stop', [t.id]);
    } else if (action === 'remove-toggle') {
      openRowRemoveDropdown(btn, t.id);
    } else if (action === 'open-detail') {
      openDetailPage(t.id);
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   SELECTION (click, ctrl+click, shift+click)
   ───────────────────────────────────────────────────────────── */

let lastClickedIndex = -1;

function handleItemClick(id, e) {
  const idx = filteredTorrents.findIndex(t => t.id === id);
  if (idx === -1) return;

  if (e.shiftKey && lastClickedIndex >= 0) {
    // Range select
    const lo = Math.min(idx, lastClickedIndex);
    const hi = Math.max(idx, lastClickedIndex);
    for (let i = lo; i <= hi; i++) {
      selectedIds.add(filteredTorrents[i].id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle select
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    lastClickedIndex = idx;
  } else {
    // Single select + open sidebar
    selectedIds.clear();
    selectedIds.add(id);
    lastClickedIndex = idx;
    openSidebar(id);
  }

  refreshSelectionUI();
  updateBulkBar();
}

function refreshSelectionUI() {
  document.querySelectorAll('.torrent-item').forEach(el => {
    const id = parseInt(el.dataset.id, 10);
    el.classList.toggle('selected', selectedIds.has(id));
  });
}

function selectAll() {
  filteredTorrents.forEach(t => selectedIds.add(t.id));
  refreshSelectionUI();
  updateBulkBar();
}

function deselectAll() {
  selectedIds.clear();
  refreshSelectionUI();
  updateBulkBar();
}

/* ─────────────────────────────────────────────────────────────
   BULK BAR
   ───────────────────────────────────────────────────────────── */

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const count = selectedIds.size;
  bar.classList.toggle('hidden', count === 0);
  if (count > 0) {
    document.getElementById('bulk-count').textContent = `${count} selected`;
  }
}

function setupBulkBar() {
  document.getElementById('bulk-start').addEventListener('click', () => {
    doAction('start', Array.from(selectedIds));
  });
  document.getElementById('bulk-stop').addEventListener('click', () => {
    doAction('stop', Array.from(selectedIds));
  });
  document.getElementById('bulk-verify').addEventListener('click', () => {
    doAction('verify', Array.from(selectedIds));
  });
  document.getElementById('bulk-remove').addEventListener('click', () => {
    if (confirm(`Remove ${selectedIds.size} torrent(s)? (Files will be kept)`)) {
      doAction('remove', Array.from(selectedIds), { deleteData: false });
      deselectAll();
    }
  });
  document.getElementById('bulk-close').addEventListener('click', deselectAll);
}

/* ─────────────────────────────────────────────────────────────
   TORRENT ACTIONS
   ───────────────────────────────────────────────────────────── */

async function doAction(action, ids, extra = {}) {
  try {
    const resp = await send({ type: 'TORRENT_ACTION', action, ids, extra });
    if (!resp.success) {
      showToast('Action failed: ' + (resp.error || 'Unknown'), 'error');
      return;
    }
    const labels = {
      start: 'Started', stop: 'Stopped', verify: 'Verify started',
      reannounce: 'Reannouncing…', remove: 'Removed'
    };
    showToast(labels[action] || 'Done', 'success');

    // If removed, close sidebar if needed, clear selection
    if (action === 'remove') {
      ids.forEach(id => {
        selectedIds.delete(id);
        if (sidebarTorrentId === id) closeSidebar();
      });
    }

    // Immediate refresh
    setTimeout(refreshTorrents, 400);
    if (sidebarTorrentId !== null && ids.includes(sidebarTorrentId)) {
      setTimeout(refreshSidebarDetail, 400);
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function openDetailPage(id) {
  const url = chrome.runtime.getURL('pages/detail.html') + '#' + id;
  window.open(url, '_blank');
}

/* ─────────────────────────────────────────────────────────────
   CONTEXT MENU
   ───────────────────────────────────────────────────────────── */

function setupContextMenu() {
  const menu = document.getElementById('ctx-menu');

  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      closeContextMenu();
      if (ctxTargetId == null) return;

      const id = ctxTargetId;
      const t = allTorrents.find(t => t.id === id);

      switch (action) {
        case 'start':        doAction('start', [id]); break;
        case 'stop':         doAction('stop', [id]); break;
        case 'verify':       doAction('verify', [id]); break;
        case 'reannounce':   doAction('reannounce', [id]); break;
        case 'copy-magnet':
          if (t && t.magnetLink) {
            copyToClipboard(t.magnetLink, 'Magnet link copied');
          } else {
            showToast('Magnet link not available', 'error');
          }
          break;
        case 'remove':
          if (confirm('Remove this torrent? (Files will be kept)')) {
            doAction('remove', [id], { deleteData: false });
          }
          break;
        case 'remove-data':
          if (confirm('Remove this torrent AND delete all data? This cannot be undone.')) {
            doAction('remove', [id], { deleteData: true });
          }
          break;
      }
    });
  });

  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
}

function openContextMenu(x, y, id) {
  ctxTargetId = id;

  // If not already selected, select just this one
  if (!selectedIds.has(id)) {
    selectedIds.clear();
    selectedIds.add(id);
    refreshSelectionUI();
    updateBulkBar();
  }

  const menu = document.getElementById('ctx-menu');
  menu.classList.add('open');

  // Position within viewport
  const mw = 200, mh = 280;
  const lx = Math.min(x, window.innerWidth - mw - 8);
  const ly = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = lx + 'px';
  menu.style.top  = ly + 'px';
}

function closeContextMenu() {
  document.getElementById('ctx-menu').classList.remove('open');
  ctxTargetId = null;
}

/* ─────────────────────────────────────────────────────────────
   ROW REMOVE DROPDOWN
   ───────────────────────────────────────────────────────────── */

function setupRowRemoveDropdown() {
  document.getElementById('row-remove-keep').addEventListener('click', () => {
    closeRowRemoveDropdown();
    if (rowRemoveTargetId == null) return;
    const id = rowRemoveTargetId;
    if (confirm('Remove this torrent? (Files will be kept)')) {
      doAction('remove', [id], { deleteData: false });
    }
  });

  document.getElementById('row-remove-delete').addEventListener('click', () => {
    closeRowRemoveDropdown();
    if (rowRemoveTargetId == null) return;
    const id = rowRemoveTargetId;
    if (confirm('Remove this torrent AND delete all data? This cannot be undone.')) {
      doAction('remove', [id], { deleteData: true });
    }
  });
}

function openRowRemoveDropdown(anchorBtn, id) {
  rowRemoveTargetId = id;
  const dd = document.getElementById('row-remove-dropdown');
  dd.classList.remove('hidden');
  const rect = anchorBtn.getBoundingClientRect();
  dd.style.position = 'fixed';
  dd.style.top = (rect.bottom + 2) + 'px';
  dd.style.right = (window.innerWidth - rect.right) + 'px';
  dd.style.left = 'auto';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeRowRemoveDropdown, { once: true });
  }, 0);
}

function closeRowRemoveDropdown() {
  document.getElementById('row-remove-dropdown').classList.add('hidden');
  rowRemoveTargetId = null;
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR
   ───────────────────────────────────────────────────────────── */

function openSidebar(id) {
  if (sidebarTorrentId === id && document.getElementById('sidebar').classList.contains('open')) {
    return; // Already open for this torrent
  }

  sidebarTorrentId = id;
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('list-area').classList.add('sidebar-open');

  // Reset tabs to info
  switchSidebarTab('info');

  // Show placeholder while loading
  const t = allTorrents.find(t => t.id === id);
  if (t) renderSidebarHeader(t);

  // Load full detail
  loadSidebarDetail();
  scheduleSidebarRefresh();
}

function closeSidebar() {
  sidebarTorrentId = null;
  sidebarDetail = null;
  clearTimeout(sidebarRefreshTimer);
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('list-area').classList.remove('sidebar-open');
}

function setupSidebar() {
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

  // Tab switching
  document.querySelectorAll('.stab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.stab;
      switchSidebarTab(tab);
    });
  });
}

function switchSidebarTab(tab) {
  if (activeSidebarTab === tab) return;
  activeSidebarTab = tab;

  document.querySelectorAll('.stab-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
  document.querySelectorAll('.stab-panel').forEach(p => p.classList.toggle('active', p.id === 'stab-' + tab));

  // Render the newly active tab
  if (sidebarDetail) {
    if (tab === 'peers')    renderSidebarPeers(sidebarDetail);
    if (tab === 'trackers') renderSidebarTrackers(sidebarDetail);
    if (tab === 'files')    renderSidebarFiles(sidebarDetail);
  }
}

async function loadSidebarDetail() {
  if (sidebarTorrentId == null) return;
  try {
    const resp = await send({ type: 'GET_TORRENT_DETAIL', ids: [sidebarTorrentId] });
    if (!resp.success) return;
    const list = resp.data && resp.data.torrents;
    if (!list || !list.length) return;
    sidebarDetail = list[0];
    renderSidebar(sidebarDetail);
  } catch (_) {}
}

async function refreshSidebarDetail() {
  if (sidebarTorrentId == null) return;
  try {
    const resp = await send({ type: 'GET_TORRENT_DETAIL', ids: [sidebarTorrentId] });
    if (!resp.success) return;
    const list = resp.data && resp.data.torrents;
    if (!list || !list.length) return;
    sidebarDetail = list[0];
    renderSidebarHeader(sidebarDetail);
    if (activeSidebarTab === 'info')     renderSidebarInfo(sidebarDetail);
    if (activeSidebarTab === 'peers')    renderSidebarPeers(sidebarDetail);
    if (activeSidebarTab === 'trackers') renderSidebarTrackers(sidebarDetail);
  } catch (_) {}
}

function scheduleSidebarRefresh() {
  clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(async () => {
    if (sidebarTorrentId !== null) {
      await refreshSidebarDetail();
      scheduleSidebarRefresh();
    }
  }, 3000);
}

function renderSidebar(t) {
  renderSidebarHeader(t);
  renderSidebarInfo(t);
  if (activeSidebarTab === 'peers')    renderSidebarPeers(t);
  if (activeSidebarTab === 'trackers') renderSidebarTrackers(t);
  if (activeSidebarTab === 'files')    renderSidebarFiles(t);
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR HEADER
   ───────────────────────────────────────────────────────────── */

function renderSidebarHeader(t) {
  const info = getStatusInfo(t.status, t.error);

  document.getElementById('sb-name').textContent = t.name || 'Unknown';

  const badge = document.getElementById('sb-badge');
  badge.className = 'badge badge-' + info.class;
  badge.innerHTML = icon(info.icon, 10) + escHtml(info.label);

  const pct = Math.min(100, (t.percentDone || 0) * 100);
  const fill = document.getElementById('sb-progress-fill');
  fill.style.width = pct + '%';
  fill.className = 'sidebar-progress-fill ' + (t.error > 0 ? 'error' : info.class);

  const pctStr = formatPercent(t.percentDone || 0);
  const sizeStr = formatBytes(t.sizeWhenDone || t.totalSize || 0);
  const dlStr = formatSpeed(t.rateDownload || 0);
  const ulStr = formatSpeed(t.rateUpload || 0);
  const etaStr = t.status === 4 ? formatEta(t.eta) : (t.status === 6 ? 'Seeding' : '—');

  document.getElementById('sb-quick-stats').innerHTML = `
    <span class="sq-stat"><strong style="color:var(--text-primary)">${escHtml(pctStr)}</strong>&nbsp;of ${escHtml(sizeStr)}</span>
    <span class="sq-sep">·</span>
    <span class="sq-stat">${icon('download', 11)}<span>${escHtml(dlStr)}</span></span>
    <span class="sq-sep">·</span>
    <span class="sq-stat">${icon('upload', 11)}<span>${escHtml(ulStr)}</span></span>
    <span class="sq-sep">·</span>
    <span class="sq-stat"><span style="color:var(--text-tertiary)">ETA:</span>&nbsp;${escHtml(etaStr)}</span>
  `;
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR INFO TAB
   ───────────────────────────────────────────────────────────── */

function renderSidebarInfo(t) {
  const container = document.getElementById('sb-info-content');
  container.innerHTML = buildSidebarInfoHTML(t);

  // Wire copy buttons
  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.getAttribute('data-copy'), 'Copied!');
    });
  });
}

function buildSidebarInfoHTML(t) {
  const info = getStatusInfo(t.status, t.error);

  // Activity
  const haveStr = formatBytes(t.haveValid || 0) + ' (' + formatPercent(t.percentDone || 0) + ')';
  let availPct = '—';
  if ((t.percentDone || 0) >= 1) {
    availPct = '100%';
  } else if (t.leftUntilDone > 0 && t.desiredAvailable >= 0) {
    const avail = Math.min(1, ((t.desiredAvailable || 0) + (t.haveValid || 0)) / (t.sizeWhenDone || 1));
    availPct = formatPercent(avail);
  }
  const uploadedStr = formatBytes(t.uploadedEver || 0) + ' (Ratio: ' + formatRatio(t.uploadRatio || 0) + ')';
  const runSeconds = (t.secondsDownloading || 0) + (t.secondsSeeding || 0);
  const errorStr = (t.error > 0 && t.errorString) ? t.errorString : 'None';

  // Details
  const pieceCount = t.pieceCount || 0;
  const pieceSize = formatBytes(t.pieceSize || 0);
  const sizeStr = formatBytes(t.totalSize || 0) + ' (' + pieceCount.toLocaleString() + ' × ' + pieceSize + ')';
  const hash = t.hashString || '—';
  let labelsHTML = '—';
  if (t.labels && t.labels.length) {
    labelsHTML = t.labels.map(l => `<span class="label-pill">${escHtml(l)}</span>`).join('');
  }

  // Limits
  const dlLimit = t.downloadLimited ? formatBytes((t.downloadLimit || 0) * 1024) + '/s' : 'Unlimited';
  const ulLimit = t.uploadLimited ? formatBytes((t.uploadLimit || 0) * 1024) + '/s' : 'Unlimited';
  let seedRatioLabel = 'Use global';
  if (t.seedRatioMode === 1) seedRatioLabel = 'Stop at ' + formatRatio(t.seedRatioLimit);
  if (t.seedRatioMode === 2) seedRatioLabel = 'No limit';
  const bwPriorityMap = { '-1': 'Low', '0': 'Normal', '1': 'High' };
  const bwPriority = bwPriorityMap[String(t.bandwidthPriority)] || 'Normal';

  return `
    ${sbSection('Activity', [
      sbRow('Have',          escHtml(haveStr)),
      sbRow('Availability',  escHtml(availPct)),
      sbRow('Uploaded',      escHtml(uploadedStr)),
      sbRow('Downloaded',    escHtml(formatBytes(t.downloadedEver || 0))),
      sbRow('State',         `<span class="badge badge-${info.class}" style="font-size:9px">${icon(info.icon,9)}${escHtml(info.label)}</span>`, true),
      sbRow('Running Time',  escHtml(formatEta(runSeconds))),
      sbRow('Remaining',     escHtml(t.status === 4 ? formatEta(t.eta) : '—')),
      sbRow('Last Activity', escHtml(formatDateRelative(t.activityDate))),
      t.error > 0 ? sbRow('Error', `<span class="info-value error-text" style="padding:0">${escHtml(errorStr)}</span>`, true) : '',
    ])}
    ${sbSection('Details', [
      sbRow('Size',         escHtml(sizeStr)),
      sbRow('Location',     escHtml(t.downloadDir || '—')),
      sbRowMono('Hash',     hash, hash),
      sbRow('Privacy',      t.isPrivate ? 'Private torrent' : 'Public torrent'),
      sbRow('Creator',      escHtml(t.creator || 'Unknown')),
      sbRow('Created',      escHtml(formatDate(t.dateCreated))),
      sbRow('Comment',      escHtml(t.comment || 'None')),
      sbRow('Labels',       labelsHTML, true),
    ])}
    ${sbSection('Limits', [
      sbRow('Download Limit',   escHtml(dlLimit)),
      sbRow('Upload Limit',     escHtml(ulLimit)),
      sbRow('Seed Ratio',       escHtml(seedRatioLabel)),
      sbRow('Bandwidth',        escHtml(bwPriority)),
    ])}
  `;
}

function sbSection(title, rows) {
  return `
    <div class="info-section">
      <div class="info-section-title">${title}</div>
      <div class="info-grid">${rows.filter(Boolean).join('')}</div>
    </div>
  `;
}

function sbRow(label, value, raw = false) {
  const inner = raw ? value : `<span>${value}</span>`;
  return `
    <div class="info-row">
      <div class="info-label">${escHtml(label)}</div>
      <div class="info-value">${inner}</div>
    </div>
  `;
}

function sbRowMono(label, display, copyVal) {
  return `
    <div class="info-row">
      <div class="info-label">${escHtml(label)}</div>
      <div class="info-value mono">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(display)}</span>
        <button class="copy-btn" data-copy="${escAttr(copyVal)}">Copy</button>
      </div>
    </div>
  `;
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR PEERS TAB
   ───────────────────────────────────────────────────────────── */

function renderSidebarPeers(t) {
  const peers = t.peers || [];
  const summary = document.getElementById('sb-peers-summary');
  summary.innerHTML = `Connected to <span>${t.peersConnected || 0}</span> &nbsp;·&nbsp; ↓ from <span>${t.peersSendingToUs || 0}</span> &nbsp;·&nbsp; ↑ to <span>${t.peersGettingFromUs || 0}</span>`;

  const tbody = document.getElementById('sb-peers-body');
  const empty = document.getElementById('sb-peers-empty');
  const tableWrap = document.querySelector('#stab-peers .sidebar-table-wrap');

  if (!peers.length) {
    tableWrap && tableWrap.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  tableWrap && tableWrap.classList.remove('hidden');
  empty.classList.add('hidden');

  const sorted = sbSortPeers(peers);
  tbody.innerHTML = sorted.map(p => sbPeerRow(p)).join('');

  // Update sort headers
  document.querySelectorAll('#sb-peers-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sbPeerSort.col) {
      th.classList.add(sbPeerSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function sbPeerRow(p) {
  const progress = ((p.progress || 0) * 100).toFixed(0);
  const enc = p.isEncrypted
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;color:var(--green)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;color:var(--text-muted)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
  return `<tr>
    <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary)">${escHtml(p.address || '—')}</td>
    <td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(p.clientName || '')}">${escHtml(p.clientName || '—')}</td>
    <td style="min-width:60px">
      <div style="display:flex;align-items:center;gap:4px">
        <div class="peer-mini-bar"><div class="peer-mini-fill" style="width:${progress}%"></div></div>
        <span style="font-size:9px;color:var(--text-tertiary);white-space:nowrap">${progress}%</span>
      </div>
    </td>
    <td style="color:var(--text-secondary);white-space:nowrap">${formatSpeed(p.rateToClient || 0)}</td>
    <td style="color:var(--text-secondary);white-space:nowrap">${formatSpeed(p.rateToPeer || 0)}</td>
    <td><span style="font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary)">${escHtml(p.flagStr || '—')}</span></td>
    <td style="text-align:center">${enc}</td>
  </tr>`;
}

function sbSortPeers(peers) {
  const col = sbPeerSort.col;
  const dir = sbPeerSort.dir === 'asc' ? 1 : -1;
  return [...peers].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (col === 'encrypted') { av = a.isEncrypted ? 1 : 0; bv = b.isEncrypted ? 1 : 0; }
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av || 0) - (bv || 0)) * dir;
  });
}

function setupSidebarPeersSort() {
  const thead = document.querySelector('#sb-peers-table thead');
  if (!thead) return;
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (sbPeerSort.col === col) {
      sbPeerSort.dir = sbPeerSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sbPeerSort.col = col;
      sbPeerSort.dir = 'asc';
    }
    if (sidebarDetail) renderSidebarPeers(sidebarDetail);
  });
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR TRACKERS TAB
   ───────────────────────────────────────────────────────────── */

function renderSidebarTrackers(t) {
  const stats = t.trackerStats || [];
  const container = document.getElementById('sb-trackers-content');
  const empty = document.getElementById('sb-trackers-empty');

  if (!stats.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Group by tier
  const tiers = {};
  stats.forEach(ts => {
    const tier = ts.tier != null ? ts.tier : 0;
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push(ts);
  });

  container.innerHTML = Object.keys(tiers).sort((a, b) => a - b).map(tier => {
    return `
      <div class="tracker-tier-group">
        <div class="tracker-tier-label">Tier ${tier}</div>
        ${tiers[tier].map(ts => sbTrackerCard(ts)).join('')}
      </div>
    `;
  }).join('');
}

function sbTrackerCard(ts) {
  const displayHost = ts.sitename || extractHost(ts.announce || '');
  const stateClass = ts.isBackup ? 'tracker-state-inactive'
    : (ts.announceState === 2 || ts.announceState === 3) ? 'tracker-state-active'
    : 'tracker-state-waiting';
  const stateLabel = ts.isBackup ? 'Backup' : sbAnnounceStateLabel(ts.announceState);

  const lastAnnTime = formatDateRelative(ts.lastAnnounceTime);
  const nextAnnTime = timeUntil(ts.nextAnnounceTime);
  const lastAnnClass = ts.lastAnnounceSucceeded ? 'tracker-result-success'
    : (ts.lastAnnounceTimedOut ? 'tracker-result-timeout' : 'tracker-result-fail');
  const lastAnnHtml = ts.hasAnnounced
    ? `<span class="${lastAnnClass}">${escHtml(ts.lastAnnounceResult) || (ts.lastAnnounceSucceeded ? 'OK' : 'Failed')}</span>
       <span class="tracker-stat-detail">· ${ts.lastAnnouncePeerCount || 0} peers · ${lastAnnTime}</span>`
    : `<span class="tracker-result-none">Not yet</span>`;

  const lastScrapeHtml = ts.hasScraped
    ? `<span class="${ts.lastScrapeSucceeded ? 'tracker-result-success' : 'tracker-result-fail'}">${ts.lastScrapeSucceeded ? 'OK' : (escHtml(ts.lastScrapeResult || 'Fail'))}</span>
       <span class="tracker-stat-detail">S:${ts.seederCount || 0} L:${ts.leecherCount || 0} DL:${ts.downloadCount || 0}</span>`
    : `<span class="tracker-result-none">Not yet</span>`;

  return `
    <div class="tracker-card">
      <div class="tracker-card-header">
        <span class="tracker-host">${escHtml(displayHost)}</span>
        <span class="tracker-announce-state ${stateClass}">${escHtml(stateLabel)}</span>
      </div>
      <div class="tracker-url">${escHtml(ts.announce || '')}</div>
      <div class="tracker-stats-grid">
        <div class="tracker-stat-block">
          <div class="tracker-stat-title">Last Announce</div>
          <div class="tracker-stat-row">${lastAnnHtml}</div>
          <div class="tracker-stat-row" style="margin-top:3px;color:var(--text-tertiary)">Next: ${nextAnnTime}</div>
        </div>
        <div class="tracker-stat-block">
          <div class="tracker-stat-title">Scrape</div>
          <div class="tracker-stat-row">${lastScrapeHtml}</div>
          <div class="tracker-stat-row" style="margin-top:3px;color:var(--text-tertiary)">Next: ${timeUntil(ts.nextScrapeTime)}</div>
        </div>
      </div>
    </div>
  `;
}

function sbAnnounceStateLabel(state) {
  return { 0: 'Inactive', 1: 'Waiting', 2: 'Queued', 3: 'Active' }[state] || 'Unknown';
}

function extractHost(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function timeUntil(unixTs) {
  if (!unixTs || unixTs === 0) return '—';
  const diff = unixTs - Date.now() / 1000;
  if (diff <= 0) return 'now';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

/* ─────────────────────────────────────────────────────────────
   SIDEBAR FILES TAB
   ───────────────────────────────────────────────────────────── */

function renderSidebarFiles(t) {
  const files = t.files || [];
  const fileStats = t.fileStats || [];
  const container = document.getElementById('sb-files-body');
  const empty = document.getElementById('sb-files-empty');

  if (!files.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const merged = files.map((f, i) => {
    const st = fileStats[i] || {};
    return {
      index: i,
      name: f.name,
      length: f.length || 0,
      bytesCompleted: f.bytesCompleted || st.bytesCompleted || 0,
      wanted: st.wanted !== undefined ? st.wanted : true,
      priority: st.priority !== undefined ? st.priority : 0,
    };
  });

  const tree = buildSbFileTree(merged);
  container.innerHTML = renderSbTree(tree, 0);

  // Wire checkboxes
  container.querySelectorAll('.wanted-checkbox-s').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const wanted = e.target.checked;
      setSbFileWanted(idx, wanted);
    });
  });

  // Wire folder toggles
  container.querySelectorAll('.tree-folder-row-s').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      const path = row.dataset.path;
      sbFolderOpenState[path] = !sbFolderOpenState[path];
      const childrenEl = document.getElementById('sbfc-' + path.replace(/[^a-zA-Z0-9]/g, '_'));
      if (childrenEl) {
        childrenEl.style.display = sbFolderOpenState[path] ? '' : 'none';
        row.classList.toggle('folder-row-open-s', sbFolderOpenState[path]);
      }
    });
  });

  // Setup file sort header
  setupSidebarFileSortHeader();
}

function buildSbFileTree(files) {
  const root = { children: {}, files: [] };
  files.forEach(f => {
    const parts = f.name.split('/');
    if (parts.length === 1) {
      root.files.push(f);
      return;
    }
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        node.children[part] = { path: parts.slice(0, i + 1).join('/'), name: part, children: {}, files: [] };
      }
      node = node.children[part];
    }
    node.files.push({ ...f, displayName: parts[parts.length - 1] });
  });
  return root;
}

function renderSbTree(node, depth) {
  let html = '';
  const indent = depth * 14;

  const folderKeys = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
  const fileList = sbSortFiles(node.files.map(f => ({ ...f, displayName: f.displayName || f.name })));

  folderKeys.forEach(key => {
    const child = node.children[key];
    const path = child.path;
    if (sbFolderOpenState[path] === undefined) sbFolderOpenState[path] = true;
    const isOpen = sbFolderOpenState[path];

    const allFiles = getSbAllFiles(child);
    const totalSize = allFiles.reduce((s, f) => s + (f.length || 0), 0);
    const totalDone = allFiles.reduce((s, f) => s + (f.bytesCompleted || 0), 0);
    const pct = totalSize > 0 ? ((totalDone / totalSize) * 100).toFixed(0) : '0';

    const safeId = path.replace(/[^a-zA-Z0-9]/g, '_');

    html += `
      <div class="tree-folder-row-s ${isOpen ? 'folder-row-open-s' : ''}" data-path="${escAttr(path)}">
        <div class="folder-name-s" style="padding-left:${indent}px">
          <span class="folder-chevron-s">${ICONS.arrowDown}</span>
          ${ICONS.folder}
          <span>${escHtml(child.name)}</span>
        </div>
        <div class="file-size-cell-s">${formatBytes(totalSize)}</div>
        <div class="file-progress-cell-s">
          <div class="file-progress-wrap-s">
            <div class="file-mini-bar-s">
              <div class="file-mini-fill-s ${totalDone >= totalSize && totalSize > 0 ? 'complete' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="file-pct-s">${pct}%</span>
          </div>
        </div>
        <div></div>
      </div>
      <div id="sbfc-${safeId}" style="display:${isOpen ? '' : 'none'}">
        ${renderSbTree(child, depth + 1)}
      </div>
    `;
  });

  fileList.forEach(f => {
    const pct = f.length > 0 ? ((f.bytesCompleted / f.length) * 100).toFixed(0) : '0';
    const complete = parseInt(pct) >= 100;
    const displayName = f.displayName || f.name.split('/').pop();

    html += `
      <div class="tree-file-row-s">
        <div class="file-name-cell-s">
          <span class="file-indent-s" style="width:${indent + 14}px;flex-shrink:0;display:inline-block"></span>
          <span class="file-name-text-s" title="${escAttr(f.name)}">${escHtml(displayName)}</span>
        </div>
        <div class="file-size-cell-s">${formatBytes(f.length)}</div>
        <div class="file-progress-cell-s">
          <div class="file-progress-wrap-s">
            <div class="file-mini-bar-s">
              <div class="file-mini-fill-s ${complete ? 'complete' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="file-pct-s">${pct}%</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:center">
          <input type="checkbox" class="wanted-checkbox-s" data-idx="${f.index}" ${f.wanted ? 'checked' : ''}>
        </div>
      </div>
    `;
  });

  return html;
}

function getSbAllFiles(node) {
  let files = [...node.files];
  Object.values(node.children).forEach(child => { files = files.concat(getSbAllFiles(child)); });
  return files;
}

function sbSortFiles(files) {
  const col = sbFileSort.col;
  const dir = sbFileSort.dir === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    if (col === 'name') return (a.displayName || a.name).localeCompare(b.displayName || b.name) * dir;
    if (col === 'size') return ((a.length || 0) - (b.length || 0)) * dir;
    if (col === 'progress') {
      const pa = a.length > 0 ? a.bytesCompleted / a.length : 0;
      const pb = b.length > 0 ? b.bytesCompleted / b.length : 0;
      return (pa - pb) * dir;
    }
    return 0;
  });
}

function setupSidebarFileSortHeader() {
  const header = document.querySelector('.file-tree-header-sidebar');
  if (!header) return;
  header.querySelectorAll('[data-col]').forEach(span => {
    span.addEventListener('click', () => {
      const col = span.dataset.col;
      if (col === 'wanted') return;
      if (sbFileSort.col === col) {
        sbFileSort.dir = sbFileSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sbFileSort.col = col;
        sbFileSort.dir = 'asc';
      }
      // Update header indicators
      header.querySelectorAll('[data-col]').forEach(s => {
        s.classList.remove('sort-asc', 'sort-desc');
        if (s.dataset.col === sbFileSort.col) {
          s.classList.add(sbFileSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
      });
      if (sidebarDetail) renderSidebarFiles(sidebarDetail);
    });
  });
}

async function setSbFileWanted(fileIndex, wanted) {
  if (sidebarTorrentId == null) return;
  const key = wanted ? 'files-wanted' : 'files-unwanted';
  try {
    await send({
      type: 'TORRENT_ACTION',
      action: 'set',
      ids: [sidebarTorrentId],
      extra: { [key]: [fileIndex] }
    });
  } catch (err) {
    showToast('Failed to update file: ' + err.message, 'error');
  }
}

/* ─────────────────────────────────────────────────────────────
   TOOLBAR SETUP
   ───────────────────────────────────────────────────────────── */

function setupToolbar() {
  // Search
  const searchInput = document.getElementById('search-input');
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      applyFilterAndRender();
    }, 150);
  });

  // Filter pills
  document.getElementById('filter-pills').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.dataset.filter;
    applyFilterAndRender();
  });

  // Sort select
  document.getElementById('sort-select').addEventListener('change', (e) => {
    sortBy = e.target.value;
    applyFilterAndRender();
  });

  // Sort direction
  document.getElementById('sort-dir-btn').addEventListener('click', () => {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    const dirIcon = document.getElementById('sort-dir-icon');
    if (dirIcon) {
      dirIcon.innerHTML = sortDir === 'asc'
        ? '<polyline points="6 9 12 15 18 9"/>'
        : '<polyline points="18 15 12 9 6 15"/>';
    }
    applyFilterAndRender();
  });
}

/* ─────────────────────────────────────────────────────────────
   TOP BAR BUTTONS
   ───────────────────────────────────────────────────────────── */

function setupTopbarButtons() {
  document.getElementById('btn-turtle').addEventListener('click', toggleTurtleMode);

  document.getElementById('btn-add').addEventListener('click', () => {
    const bar = document.getElementById('add-bar');
    const isOpen = bar.classList.toggle('open');
    if (isOpen) {
      document.getElementById('add-input').focus();
    }
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('btn-configure').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

/* ─────────────────────────────────────────────────────────────
   ADD TORRENT BAR
   ───────────────────────────────────────────────────────────── */

function setupAddBar() {
  const addInput = document.getElementById('add-input');
  const addSubmit = document.getElementById('add-submit');
  const addPaused = document.getElementById('add-paused');

  async function doAdd() {
    const val = addInput.value.trim();
    if (!val) {
      showToast('Enter a magnet link or URL', 'error');
      return;
    }
    addSubmit.disabled = true;
    addSubmit.textContent = 'Adding…';
    try {
      const resp = await send({
        type: 'ADD_TORRENT',
        options: {
          magnetUri: val,
          downloadDir: defaultDownloadDir || undefined,
          paused: addPaused.checked,
        }
      });
      if (!resp.success) {
        showToast('Failed to add: ' + (resp.error || 'Unknown error'), 'error');
      } else {
        showToast('Torrent added!', 'success');
        addInput.value = '';
        document.getElementById('add-bar').classList.remove('open');
        setTimeout(refreshTorrents, 800);
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      addSubmit.disabled = false;
      addSubmit.textContent = 'Add';
    }
  }

  addSubmit.addEventListener('click', doAdd);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
    if (e.key === 'Escape') {
      document.getElementById('add-bar').classList.remove('open');
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   KEYBOARD SHORTCUTS
   ───────────────────────────────────────────────────────────── */

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Skip if focus is on an input or textarea
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (e.key === 'Escape') {
        e.target.blur();
        // Close add bar if escape pressed while in add-input
        if (e.target.id === 'add-input') {
          document.getElementById('add-bar').classList.remove('open');
        }
      }
      return;
    }

    // Ctrl+A: select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      selectAll();
      return;
    }

    // Escape: close sidebar / deselect
    if (e.key === 'Escape') {
      if (document.getElementById('ctx-menu').classList.contains('open')) {
        closeContextMenu();
      } else if (sidebarTorrentId !== null) {
        closeSidebar();
      } else {
        deselectAll();
      }
      return;
    }

    // Delete / Backspace: remove selected
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
      e.preventDefault();
      if (confirm(`Remove ${selectedIds.size} torrent(s)? (Files will be kept)`)) {
        doAction('remove', Array.from(selectedIds), { deleteData: false });
        deselectAll();
        closeSidebar();
      }
      return;
    }

    // S: toggle start/stop on selected
    if (e.key === 's' || e.key === 'S') {
      if (selectedIds.size > 0) {
        const ids = Array.from(selectedIds);
        // If all selected are stopped, start; else stop
        const allStopped = ids.every(id => {
          const t = allTorrents.find(t => t.id === id);
          return t && t.status === 0;
        });
        doAction(allStopped ? 'start' : 'stop', ids);
      }
      return;
    }

    // Enter: open sidebar for first selected
    if (e.key === 'Enter') {
      if (selectedIds.size > 0) {
        const id = Array.from(selectedIds)[0];
        openSidebar(id);
      }
      return;
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   FOOTER / STATUS BAR
   ───────────────────────────────────────────────────────────── */

function updateFooter() {
  const el = document.getElementById('status-last-updated');
  if (!lastUpdated) { el.textContent = '—'; return; }
  const diff = Math.round((Date.now() - lastUpdated) / 1000);
  el.textContent = 'Updated: ' + (diff < 5 ? 'just now' : diff + 's ago');
}

function startFooterTick() {
  clearInterval(footerTickTimer);
  footerTickTimer = setInterval(() => { if (lastUpdated) updateFooter(); }, 1000);
}

/* ─────────────────────────────────────────────────────────────
   CLIPBOARD
   ───────────────────────────────────────────────────────────── */

function copyToClipboard(text, msg = 'Copied!') {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast(msg, 'success')).catch(() => fallbackCopy(text, msg));
  } else {
    fallbackCopy(text, msg);
  }
}

function fallbackCopy(text, msg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast(msg, 'success'); } catch { showToast('Copy failed', 'error'); }
  ta.remove();
}

/* ─────────────────────────────────────────────────────────────
   GLOBAL CLICK: close context menu / row dropdown
   ───────────────────────────────────────────────────────────── */

document.addEventListener('click', (e) => {
  // Close context menu
  const ctxMenu = document.getElementById('ctx-menu');
  if (!ctxMenu.contains(e.target)) {
    ctxMenu.classList.remove('open');
  }
});

/* ─────────────────────────────────────────────────────────────
   ENTRY POINT
   ───────────────────────────────────────────────────────────── */

// Wire sidebar peers sort after DOM ready (thead setup)
function postSetup() {
  setupSidebarPeersSort();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init();
    postSetup();
  });
} else {
  init();
  postSetup();
}
