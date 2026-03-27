/**
 * Transmission Remote — Popup UI Logic
 * Communicates with background service worker via chrome.runtime.sendMessage.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  torrents: [],          // raw torrent list from daemon
  stats: null,           // session stats
  freeSpace: null,       // bytes free on download dir
  turtleEnabled: false,  // alt-speed mode
  downloadDir: null,     // default download dir

  filter: 'all',         // current status filter
  search: '',            // current search string
  sortBy: 'queue',       // sort field
  sortAsc: true,         // sort direction

  selected: new Set(),   // Set of torrent IDs
  lastClickedIdx: null,  // for shift-click range

  ctxTorrentId: null,    // torrent targeted by right-click
  refreshTimer: null,    // interval handle
  isConnected: false,    // whether we have a valid connection
  initialLoad: true,     // still on first load
};

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const $q = sel => document.querySelector(sel);

const els = {
  statsBar:          $('stats-bar'),
  filterSelect:      $('filter-select'),
  sortSelect:        $('sort-select'),
  sortDirBtn:        $('sort-dir-btn'),
  sortDirIcon:       $('sort-dir-icon'),
  searchInput:       $('search-input'),
  torrentList:       $('torrent-list'),
  torrentListWrap:   $('torrent-list-wrap'),
  loadingState:      $('loading-state'),
  connectionError:   $('connection-error'),
  errDesc:           $('err-desc'),
  emptyNoTorrents:   $('empty-no-torrents'),
  emptyNoResults:    $('empty-no-results'),
  bulkBar:           $('bulk-bar'),
  bulkCount:         $('bulk-count'),
  bulkStart:         $('bulk-start'),
  bulkStop:          $('bulk-stop'),
  bulkVerify:        $('bulk-verify'),
  bulkRemove:        $('bulk-remove'),
  bulkClose:         $('bulk-close'),
  btnTurtle:         $('btn-turtle'),
  btnSettings:       $('btn-settings'),
  btnRefresh:        $('btn-refresh'),
  btnConfigure:      $('btn-configure'),
  addInput:          $('add-input'),
  addSubmitBtn:      $('add-submit-btn'),
  addDialogBtn:      $('add-dialog-btn'),
  ctxMenu:           $('ctx-menu'),
};

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendMsg(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('No response from background — try reloading the extension'));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(msg, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response === undefined) {
          reject(new Error('No response — background service worker may not be running'));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  bindEvents();
  await loadInitialData();
  startAutoRefresh();
}

async function loadInitialData() {
  showLoading();
  try {
    // Load session for download dir, then refresh everything in parallel
    const [sessionRes] = await Promise.all([
      sendMsg({ type: 'GET_SESSION' }),
    ]);

    if (sessionRes && sessionRes.success) {
      state.downloadDir = sessionRes.data?.['download-dir'] || '/';
    }

    await refreshAll();
  } catch (err) {
    showConnectionError(err.message);
  }
}

async function refreshAll() {
  try {
    const [torrentsRes, statsRes, turtleRes] = await Promise.all([
      sendMsg({ type: 'GET_TORRENTS' }),
      sendMsg({ type: 'GET_SESSION_STATS' }),
      sendMsg({ type: 'GET_TURTLE_MODE' }),
    ]);

    // Parallel: also fetch free space if we have a dir
    let freeSpaceRes = null;
    if (state.downloadDir) {
      try {
        freeSpaceRes = await sendMsg({ type: 'GET_FREE_SPACE', path: state.downloadDir });
      } catch (_) { /* non-critical */ }
    }

    if (!torrentsRes || !torrentsRes.success) {
      throw new Error(torrentsRes?.error || 'Failed to get torrents');
    }

    state.isConnected = true;
    state.initialLoad = false;

    // Update torrents
    state.torrents = (torrentsRes.data?.torrents) || [];

    // Update stats
    if (statsRes?.success) {
      state.stats = statsRes.data;
    }

    // Update free space
    if (freeSpaceRes?.success) {
      state.freeSpace = freeSpaceRes.data?.['size-bytes'] ?? null;
    }

    // Update turtle mode
    if (turtleRes?.success) {
      state.turtleEnabled = turtleRes.data?.enabled ?? false;
    }

    renderStatsBar();
    renderTorrentList();
    updateTurtleButton();
    stopRefreshSpinner();

  } catch (err) {
    if (state.initialLoad) {
      showConnectionError(err.message);
    } else {
      // Non-fatal on refresh — just update UI quietly
      stopRefreshSpinner();
    }
  }
}

// ─── Auto Refresh ─────────────────────────────────────────────────────────────

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => refreshAll(), 3000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

// ─── Visibility: show/hide main panels ───────────────────────────────────────

function showLoading() {
  els.loadingState.classList.remove('hidden');
  els.connectionError.classList.add('hidden');
  els.torrentListWrap.classList.add('hidden');
}

function showConnectionError(msg) {
  state.isConnected = false;
  els.loadingState.classList.add('hidden');
  els.torrentListWrap.classList.add('hidden');
  els.connectionError.classList.remove('hidden');
  if (msg) {
    els.errDesc.textContent = msg;
  }
  stopRefreshSpinner();
}

function showTorrentList() {
  els.loadingState.classList.add('hidden');
  els.connectionError.classList.add('hidden');
  els.torrentListWrap.classList.remove('hidden');
}

function stopRefreshSpinner() {
  els.btnRefresh.classList.remove('spinning');
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function renderStatsBar() {
  const stats = state.stats;
  if (!stats) {
    els.statsBar.innerHTML = '<span style="color:var(--text-muted);font-size:11px">—</span>';
    return;
  }

  const dlSpeed = stats['downloadSpeed'] ?? stats['download-speed'] ?? 0;
  const ulSpeed = stats['uploadSpeed']   ?? stats['upload-speed']   ?? 0;
  const count   = state.torrents.length;
  const free    = state.freeSpace;

  const dlStr = formatSpeed(dlSpeed);
  const ulStr = formatSpeed(ulSpeed);

  let html = `
    <span class="stat">
      <span style="color:var(--accent);display:inline-flex;width:11px;height:11px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </span>
      <span class="stat-val">${dlStr}</span>
    </span>
    <span class="sep">·</span>
    <span class="stat">
      <span style="color:var(--green);display:inline-flex;width:11px;height:11px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      </span>
      <span class="stat-val">${ulStr}</span>
    </span>
    <span class="sep">│</span>
    <span class="stat">
      <span class="stat-val">${count}</span>&nbsp;<span style="color:var(--text-tertiary)">torrent${count !== 1 ? 's' : ''}</span>
    </span>
  `;

  if (free !== null && free > 0) {
    html += `
      <span class="sep">│</span>
      <span class="stat">
        <span style="color:var(--text-tertiary)">Free:</span>&nbsp;<span class="stat-val">${formatBytes(free)}</span>
      </span>
    `;
  }

  els.statsBar.innerHTML = html;
}

// ─── Filtering & Sorting ──────────────────────────────────────────────────────

const FILTER_STATUS_CLASSES = {
  all:         null,
  downloading: 'downloading',
  seeding:     'seeding',
  stopped:     'stopped',
  queued:      'queued',
  checking:    'checking',
  error:       'error',
};

function getFilteredSortedTorrents() {
  let list = [...state.torrents];

  // Filter by search
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(t => (t.name || '').toLowerCase().includes(q));
  }

  // Filter by status
  const filterClass = FILTER_STATUS_CLASSES[state.filter];
  if (filterClass) {
    list = list.filter(t => {
      const si = getStatusInfo(t.status, t.error || 0);
      return si.class === filterClass;
    });
  }

  // Sort
  list.sort((a, b) => {
    let va, vb;
    switch (state.sortBy) {
      case 'name':
        va = (a.name || '').toLowerCase();
        vb = (b.name || '').toLowerCase();
        break;
      case 'added':
        va = a.addedDate || 0;
        vb = b.addedDate || 0;
        break;
      case 'size':
        va = a.totalSize || 0;
        vb = b.totalSize || 0;
        break;
      case 'progress':
        va = a.percentDone || 0;
        vb = b.percentDone || 0;
        break;
      case 'speed':
        va = (a.rateDownload || 0) + (a.rateUpload || 0);
        vb = (b.rateDownload || 0) + (b.rateUpload || 0);
        break;
      case 'ratio':
        va = a.uploadRatio || 0;
        vb = b.uploadRatio || 0;
        break;
      case 'queue':
      default:
        va = a.queuePosition ?? a.id ?? 0;
        vb = b.queuePosition ?? b.id ?? 0;
        break;
    }
    if (va < vb) return state.sortAsc ? -1 : 1;
    if (va > vb) return state.sortAsc ? 1 : -1;
    return 0;
  });

  return list;
}

// ─── Torrent List Rendering ───────────────────────────────────────────────────

function renderTorrentList() {
  showTorrentList();

  const list = getFilteredSortedTorrents();

  // Empty states
  if (state.torrents.length === 0) {
    els.torrentList.innerHTML = '';
    els.emptyNoTorrents.classList.remove('hidden');
    els.emptyNoResults.classList.add('hidden');
    updateBulkBar();
    return;
  }

  if (list.length === 0) {
    els.torrentList.innerHTML = '';
    els.emptyNoTorrents.classList.add('hidden');
    els.emptyNoResults.classList.remove('hidden');
    updateBulkBar();
    return;
  }

  els.emptyNoTorrents.classList.add('hidden');
  els.emptyNoResults.classList.add('hidden');

  // Incremental DOM update — preserve existing nodes when possible
  const existing = [...els.torrentList.querySelectorAll('.torrent-item')];
  const existingMap = {};
  existing.forEach(el => {
    existingMap[el.dataset.id] = el;
  });

  const fragment = document.createDocumentFragment();

  list.forEach((torrent, idx) => {
    const tid = String(torrent.id);
    let item = existingMap[tid];
    if (!item) {
      item = buildTorrentItem(torrent, idx);
    } else {
      updateTorrentItem(item, torrent, idx);
      delete existingMap[tid];
    }
    fragment.appendChild(item);
  });

  // Remove stale items
  Object.values(existingMap).forEach(el => el.remove());

  els.torrentList.innerHTML = '';
  els.torrentList.appendChild(fragment);

  updateBulkBar();
}

function buildTorrentItem(torrent, idx) {
  const li = document.createElement('li');
  li.className = 'torrent-item';
  li.dataset.id = String(torrent.id);
  li.dataset.idx = String(idx);

  if (state.selected.has(torrent.id)) {
    li.classList.add('selected');
  }

  li.innerHTML = renderTorrentHTML(torrent);
  bindTorrentItemEvents(li, torrent);
  return li;
}

function updateTorrentItem(li, torrent, idx) {
  li.dataset.idx = String(idx);
  li.dataset.id = String(torrent.id);

  // Toggle selected class
  if (state.selected.has(torrent.id)) {
    li.classList.add('selected');
  } else {
    li.classList.remove('selected');
  }

  li.innerHTML = renderTorrentHTML(torrent);
  bindTorrentItemEvents(li, torrent);
}

function renderTorrentHTML(torrent) {
  const si = getStatusInfo(torrent.status, torrent.error || 0);
  const pct = torrent.percentDone || 0;
  const pctDisplay = formatPercent(pct);
  const size = torrent.totalSize || 0;
  const dlSpeed = torrent.rateDownload || 0;
  const ulSpeed = torrent.rateUpload  || 0;
  const eta = torrent.eta || -1;
  const peersConnected = torrent.peersConnected || 0;
  const peersSendingToUs = torrent.peersSendingToUs || 0;
  const peersGettingFromUs = torrent.peersGettingFromUs || 0;
  const ratio = torrent.uploadRatio != null ? torrent.uploadRatio : -1;
  const isDownloading = torrent.status === 4;

  // Progress bar color
  let fillClass = '';
  if (si.class === 'seeding')  fillClass = 'seeding';
  else if (si.class === 'stopped') fillClass = 'stopped';
  else if (si.class === 'error')   fillClass = 'error';
  else if (si.class === 'checking') fillClass = 'checking';
  else if (si.class === 'queued')   fillClass = 'queued';

  // Stats line parts
  const statParts = [];
  statParts.push(`<span class="stat-piece">${pctDisplay} of ${formatBytes(size)}</span>`);

  if (dlSpeed > 0) {
    statParts.push(`<span class="stat-piece" style="color:var(--accent)">
      <span style="display:inline-flex;width:10px;height:10px;color:var(--accent)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </span>
      ${formatSpeed(dlSpeed)}
    </span>`);
  }
  if (ulSpeed > 0) {
    statParts.push(`<span class="stat-piece" style="color:var(--green)">
      <span style="display:inline-flex;width:10px;height:10px;color:var(--green)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </span>
      ${formatSpeed(ulSpeed)}
    </span>`);
  }
  if (isDownloading && eta !== 0) {
    statParts.push(`<span class="stat-piece"><span style="color:var(--text-tertiary)">ETA:</span> ${formatEta(eta)}</span>`);
  }

  // Peers line
  const peersHtml = `Peers: ${peersConnected} ` +
    `<span style="color:var(--accent)">↓ ${peersSendingToUs}</span> ` +
    `<span style="color:var(--green)">↑ ${peersGettingFromUs}</span>` +
    (ratio >= 0 ? ` &nbsp;Ratio: ${formatRatio(ratio)}` : '');

  // Error message
  const errorMsg = (torrent.error > 0 && torrent.errorString)
    ? `<div style="font-size:10.5px;color:var(--red);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(torrent.errorString)}">${escapeHtml(torrent.errorString)}</div>`
    : '';

  // Added date
  const addedRelative = torrent.addedDate ? formatDateRelative(torrent.addedDate) : '';

  // Whether paused or running (for play/pause button)
  const isStopped = torrent.status === 0;

  return `
    <div class="torrent-row1">
      <span class="badge badge-${si.class}">${si.label}</span>
      <span class="torrent-name" title="${escapeHtml(torrent.name || '')}">${escapeHtml(torrent.name || 'Unknown')}</span>
      <div class="torrent-actions">
        <button class="action-btn" data-torrent-action="${isStopped ? 'start' : 'stop'}" title="${isStopped ? 'Start' : 'Pause'}">
          ${isStopped
            ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
          }
        </button>
        <div class="remove-wrap">
          <button class="action-btn danger" data-torrent-action="remove" title="Remove">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
          <div class="remove-dropdown" id="remove-dd-${torrent.id}">
            <button class="dropdown-item" data-torrent-action="remove-confirm">Remove torrent</button>
            <button class="dropdown-item danger" data-torrent-action="remove-data-confirm">Remove + delete data</button>
          </div>
        </div>
        <button class="action-btn" data-torrent-action="more" title="More options">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
        </button>
      </div>
    </div>
    <div class="torrent-progress-row">
      <div class="progress-bar">
        <div class="progress-bar-fill ${fillClass}" style="width:${Math.min(100, pct * 100).toFixed(2)}%"></div>
      </div>
    </div>
    <div class="torrent-stats">${statParts.join('<span style="color:var(--border-default)">·</span>')}</div>
    <div class="torrent-peers">${peersHtml}${addedRelative ? `<span style="margin-left:auto;color:var(--text-muted)">${addedRelative}</span>` : ''}</div>
    ${errorMsg}
  `;
}

function bindTorrentItemEvents(li, torrent) {
  // Left click — selection
  li.addEventListener('click', (e) => {
    if (e.target.closest('[data-torrent-action]')) return; // handled separately
    handleTorrentClick(e, torrent.id);
  });

  // Right click — context menu
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.ctxTorrentId = torrent.id;
    openContextMenu(e.clientX, e.clientY);
  });

  // Action buttons
  li.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-torrent-action]');
    if (!btn) return;
    e.stopPropagation();

    const act = btn.dataset.torrentAction;

    if (act === 'remove') {
      // Toggle the remove dropdown
      const dd = li.querySelector(`#remove-dd-${torrent.id}`);
      if (dd) {
        const isOpen = dd.classList.contains('open');
        closeAllRemoveDropdowns();
        if (!isOpen) dd.classList.add('open');
      }
      return;
    }

    closeAllRemoveDropdowns();

    if (act === 'start') {
      torrentAction('start', [torrent.id]);
    } else if (act === 'stop') {
      torrentAction('stop', [torrent.id]);
    } else if (act === 'remove-confirm') {
      torrentAction('remove', [torrent.id], { deleteData: false });
    } else if (act === 'remove-data-confirm') {
      torrentAction('remove', [torrent.id], { deleteData: true });
    } else if (act === 'more') {
      state.ctxTorrentId = torrent.id;
      const rect = btn.getBoundingClientRect();
      openContextMenu(rect.left, rect.bottom + 2);
    }
  });
}

function closeAllRemoveDropdowns() {
  document.querySelectorAll('.remove-dropdown.open').forEach(dd => dd.classList.remove('open'));
}

// ─── Selection ────────────────────────────────────────────────────────────────

function handleTorrentClick(e, torrentId) {
  const list = getFilteredSortedTorrents();
  const idx = list.findIndex(t => t.id === torrentId);

  if (e.shiftKey && state.lastClickedIdx !== null) {
    // Range select
    const start = Math.min(state.lastClickedIdx, idx);
    const end   = Math.max(state.lastClickedIdx, idx);
    for (let i = start; i <= end; i++) {
      if (list[i]) state.selected.add(list[i].id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle
    if (state.selected.has(torrentId)) {
      state.selected.delete(torrentId);
    } else {
      state.selected.add(torrentId);
    }
    state.lastClickedIdx = idx;
  } else {
    // Single select (deselect if already solo-selected)
    if (state.selected.size === 1 && state.selected.has(torrentId)) {
      state.selected.clear();
      state.lastClickedIdx = null;
    } else {
      state.selected.clear();
      state.selected.add(torrentId);
      state.lastClickedIdx = idx;
    }
  }

  updateSelectionUI();
  updateBulkBar();
}

function updateSelectionUI() {
  document.querySelectorAll('.torrent-item').forEach(li => {
    const id = Number(li.dataset.id);
    if (state.selected.has(id)) {
      li.classList.add('selected');
    } else {
      li.classList.remove('selected');
    }
  });
}

function updateBulkBar() {
  const count = state.selected.size;
  if (count > 1) {
    els.bulkBar.classList.remove('hidden');
    els.bulkCount.textContent = `${count} selected`;
  } else {
    els.bulkBar.classList.add('hidden');
  }
}

// ─── Torrent Actions ──────────────────────────────────────────────────────────

async function torrentAction(action, ids, extra = {}) {
  try {
    const res = await sendMsg({
      type: 'TORRENT_ACTION',
      action,
      ids,
      extra,
    });

    if (res && res.success) {
      const actionLabels = {
        start: 'Started',
        stop: 'Stopped',
        remove: extra.deleteData ? 'Removed & data deleted' : 'Removed',
        verify: 'Verification started',
        reannounce: 'Reannounced',
      };
      showToast(actionLabels[action] || 'Done', 'success');
      await refreshAll();
    } else {
      showToast(res?.error || 'Action failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Action failed', 'error');
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

function openContextMenu(x, y) {
  const menu = els.ctxMenu;

  // Position
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  // Show
  menu.classList.add('open');

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth  || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    if (rect.right > vw)  menu.style.left = (x - rect.width)  + 'px';
    if (rect.bottom > vh) menu.style.top  = (y - rect.height) + 'px';
  });
}

function closeContextMenu() {
  els.ctxMenu.classList.remove('open');
  state.ctxTorrentId = null;
}

els.ctxMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = state.ctxTorrentId;
  closeContextMenu();

  if (!id && id !== 0) return;

  switch (action) {
    case 'start':
      await torrentAction('start', [id]);
      break;
    case 'stop':
      await torrentAction('stop', [id]);
      break;
    case 'verify':
      await torrentAction('verify', [id]);
      break;
    case 'reannounce':
      await torrentAction('reannounce', [id]);
      break;
    case 'remove':
      await torrentAction('remove', [id], { deleteData: false });
      break;
    case 'remove-data':
      await torrentAction('remove', [id], { deleteData: true });
      break;
    case 'copy-magnet': {
      const torrent = state.torrents.find(t => t.id === id);
      if (torrent) {
        const magnet = torrent.magnetLink || buildMagnetLink(torrent);
        if (magnet) {
          try {
            await navigator.clipboard.writeText(magnet);
            showToast('Magnet link copied', 'success');
          } catch (_) {
            showToast('Could not copy to clipboard', 'error');
          }
        } else {
          showToast('No magnet link available', 'error');
        }
      }
      break;
    }
  }
});

function buildMagnetLink(torrent) {
  if (!torrent.hashString) return null;
  let uri = `magnet:?xt=urn:btih:${torrent.hashString}`;
  if (torrent.name) uri += `&dn=${encodeURIComponent(torrent.name)}`;
  if (Array.isArray(torrent.trackers)) {
    torrent.trackers.slice(0, 3).forEach(tr => {
      if (tr.announce) uri += `&tr=${encodeURIComponent(tr.announce)}`;
    });
  }
  return uri;
}

// ─── Turtle Mode ──────────────────────────────────────────────────────────────

function updateTurtleButton() {
  if (state.turtleEnabled) {
    els.btnTurtle.classList.add('turtle-active');
    els.btnTurtle.title = 'Alt Speed ON — click to disable';
  } else {
    els.btnTurtle.classList.remove('turtle-active');
    els.btnTurtle.title = 'Alt Speed OFF — click to enable';
  }
}

async function toggleTurtleMode() {
  const newState = !state.turtleEnabled;
  try {
    const res = await sendMsg({ type: 'SET_TURTLE_MODE', enabled: newState });
    if (res && res.success) {
      state.turtleEnabled = newState;
      updateTurtleButton();
      showToast(newState ? 'Turtle mode enabled' : 'Turtle mode disabled', 'success');
    } else {
      showToast(res?.error || 'Failed to toggle turtle mode', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Failed', 'error');
  }
}

// ─── Sort Direction Button ────────────────────────────────────────────────────

function updateSortDirIcon() {
  const icon = els.sortDirIcon;
  if (state.sortAsc) {
    icon.innerHTML = '<polyline points="6 9 12 15 18 9"/>';
  } else {
    icon.innerHTML = '<polyline points="18 15 12 9 6 15"/>';
  }
}

// ─── Add Torrent ──────────────────────────────────────────────────────────────

async function addTorrent(uri) {
  uri = uri.trim();
  if (!uri) return;

  const isMagnet = uri.startsWith('magnet:');
  const isTorrentUrl = uri.startsWith('http://') || uri.startsWith('https://');

  if (!isMagnet && !isTorrentUrl) {
    showToast('Please paste a magnet link or torrent URL', 'error');
    return;
  }

  els.addSubmitBtn.disabled = true;
  els.addSubmitBtn.textContent = '…';

  try {
    const res = await sendMsg({
      type: 'ADD_TORRENT',
      options: {
        magnetUri: uri,
        paused: false,
        downloadDir: state.downloadDir || undefined,
      },
    });

    if (res && res.success) {
      if (res.duplicate) {
        showToast(`Already exists: ${res.name}`, 'info');
      } else {
        showToast(`Added: ${res.name || 'Torrent'}`, 'success');
      }
      els.addInput.value = '';
      await refreshAll();
    } else {
      showToast(res?.error || 'Failed to add torrent', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Failed to add torrent', 'error');
  } finally {
    els.addSubmitBtn.disabled = false;
    els.addSubmitBtn.textContent = 'Add';
  }
}

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // Header buttons
  els.btnTurtle.addEventListener('click', toggleTurtleMode);

  els.btnSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  els.btnRefresh.addEventListener('click', () => {
    els.btnRefresh.classList.add('spinning');
    refreshAll();
  });

  els.btnConfigure.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Search
  let searchDebounce = null;
  els.searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = e.target.value;
      renderTorrentList();
    }, 150);
  });

  // Filter
  els.filterSelect.addEventListener('change', (e) => {
    state.filter = e.target.value;
    renderTorrentList();
  });

  // Sort field
  els.sortSelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderTorrentList();
  });

  // Sort direction toggle
  els.sortDirBtn.addEventListener('click', () => {
    state.sortAsc = !state.sortAsc;
    updateSortDirIcon();
    renderTorrentList();
  });

  // Add bar
  els.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addTorrent(els.addInput.value);
    }
  });

  els.addSubmitBtn.addEventListener('click', () => {
    addTorrent(els.addInput.value);
  });

  els.addDialogBtn.addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('pages/magnet-dialog.html'),
      type: 'popup',
      width: 520,
      height: 480,
      focused: true,
    });
  });

  // Bulk bar
  els.bulkStart.addEventListener('click', () => {
    const ids = [...state.selected];
    torrentAction('start', ids);
  });

  els.bulkStop.addEventListener('click', () => {
    const ids = [...state.selected];
    torrentAction('stop', ids);
  });

  els.bulkVerify.addEventListener('click', () => {
    const ids = [...state.selected];
    torrentAction('verify', ids);
  });

  els.bulkRemove.addEventListener('click', () => {
    const ids = [...state.selected];
    if (confirm(`Remove ${ids.length} torrent${ids.length !== 1 ? 's' : ''}?`)) {
      torrentAction('remove', ids, { deleteData: false });
      state.selected.clear();
      updateBulkBar();
    }
  });

  els.bulkClose.addEventListener('click', () => {
    state.selected.clear();
    updateBulkBar();
    updateSelectionUI();
  });

  // Close context menu & dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!els.ctxMenu.contains(e.target)) {
      closeContextMenu();
    }
    if (!e.target.closest('.remove-wrap')) {
      closeAllRemoveDropdowns();
    }
  });

  document.addEventListener('contextmenu', (e) => {
    // If right-clicking outside a torrent item, just close
    if (!e.target.closest('.torrent-item')) {
      e.preventDefault();
      closeContextMenu();
    }
  });

  // Paste handler for add input (auto-fill when user pastes magnet link anywhere)
  document.addEventListener('paste', (e) => {
    const active = document.activeElement;
    // If not focused on search or add input, capture to add input
    if (active !== els.searchInput && active !== els.addInput) {
      const text = e.clipboardData?.getData('text') || '';
      if (text.startsWith('magnet:') || text.match(/\.torrent(\?|$)/)) {
        e.preventDefault();
        els.addInput.value = text;
        els.addInput.focus();
      }
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContextMenu();
      closeAllRemoveDropdowns();
      if (state.selected.size > 0) {
        state.selected.clear();
        updateSelectionUI();
        updateBulkBar();
      }
      return;
    }

    // Don't intercept while typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    // Ctrl+A = select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const list = getFilteredSortedTorrents();
      list.forEach(t => state.selected.add(t.id));
      updateSelectionUI();
      updateBulkBar();
    }

    // Delete / Backspace = remove selected
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size > 0) {
      e.preventDefault();
      const ids = [...state.selected];
      if (confirm(`Remove ${ids.length} torrent${ids.length !== 1 ? 's' : ''}?`)) {
        torrentAction('remove', ids, { deleteData: false });
        state.selected.clear();
        updateBulkBar();
      }
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Script loads deferred (after helpers.js), so DOMContentLoaded may have already
// fired by the time this runs. Guard against double-init.

let _inited = false;
function safeInit() {
  if (_inited) return;
  _inited = true;
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeInit);
} else {
  safeInit();
}
