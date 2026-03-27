/**
 * detail.js — Full-page torrent detail view for Transmission Remote extension.
 * Reads torrent ID from URL hash: detail.html#42
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS & STATE
   ───────────────────────────────────────────────────────────── */

const torrentId = parseInt(location.hash.slice(1), 10);

let torrent = null;
let refreshTimer = null;
let lastUpdated = null;

// Tab state
let activeTab = 'info';

// Peers sort state
let peerSort = { col: 'address', dir: 'asc' };

// Files sort state
let fileSort = { col: 'name', dir: 'asc' };
// Which folders are open (keyed by folder path)
const folderOpenState = {};

/* ─────────────────────────────────────────────────────────────
   MESSAGING — with timeout
   ───────────────────────────────────────────────────────────── */

function send(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('No response from background'));
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (resp === undefined) {
          reject(new Error('No response'));
        } else {
          resolve(resp);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   DATA FETCHING
   ───────────────────────────────────────────────────────────── */

async function fetchTorrent() {
  const resp = await send({ type: 'GET_TORRENT_DETAIL', ids: [torrentId] });
  if (!resp.success) throw new Error(resp.error || 'Request failed');
  const list = resp.data && resp.data.torrents;
  if (!list || !list.length) throw new Error('Torrent not found');
  return list[0];
}

async function loadInitial() {
  showLoading(true);
  try {
    torrent = await fetchTorrent();
    showLoading(false);
    showContent(true);
    renderAll(torrent);
    scheduleRefresh();
  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

async function refreshData() {
  try {
    const fresh = await fetchTorrent();
    torrent = fresh;
    lastUpdated = Date.now();
    updateDynamic(torrent);
    updateFooter();
    // Re-render peers and trackers (they change often)
    if (activeTab === 'peers') renderPeers(torrent);
    if (activeTab === 'trackers') renderTrackers(torrent);
  } catch (_) {
    // Silent refresh failure — don't disrupt the UI
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshData();
    scheduleRefresh();
  }, 3000);
}

/* ─────────────────────────────────────────────────────────────
   SHOW / HIDE STATES
   ───────────────────────────────────────────────────────────── */

function showLoading(yes) {
  document.getElementById('loadingWrap').classList.toggle('hidden', !yes);
}
function showContent(yes) {
  document.getElementById('detailContent').classList.toggle('hidden', !yes);
}
function showError(msg) {
  document.getElementById('errorWrap').classList.remove('hidden');
  document.getElementById('errorMsg').textContent = msg || 'Unknown error';
}

/* ─────────────────────────────────────────────────────────────
   RENDER ALL
   ───────────────────────────────────────────────────────────── */

function renderAll(t) {
  document.title = (t.name || 'Torrent') + ' — Transmission Remote';
  renderTopbar(t);
  renderHeader(t);
  renderInfo(t);
  renderPeers(t);
  renderTrackers(t);
  renderFiles(t);
  lastUpdated = Date.now();
  updateFooter();
}

/* ─────────────────────────────────────────────────────────────
   DYNAMIC UPDATE (incremental, no full re-render)
   ───────────────────────────────────────────────────────────── */

function updateDynamic(t) {
  // Top bar action buttons
  renderTopbar(t);
  // Header stats
  updateHeader(t);
  // Info tab activity section
  updateInfoActivity(t);
  // If peers/trackers tab active, re-rendered in refreshData
}

/* ─────────────────────────────────────────────────────────────
   TOP BAR
   ───────────────────────────────────────────────────────────── */

function renderTopbar(t) {
  const info = getStatusInfo(t.status, t.error);
  const isRunning = t.status !== 0;
  const container = document.getElementById('topbarActions');

  // Only rebuild if status changed to avoid losing dropdown state
  const prev = container.getAttribute('data-status');
  const cur = String(t.status) + ':' + String(t.error);
  if (prev === cur) return;
  container.setAttribute('data-status', cur);

  const magnetTitle = t.magnetLink ? 'Copy Magnet Link' : '';

  container.innerHTML = `
    <button class="btn btn-primary btn-toggle-play" id="btnPlayStop" title="${isRunning ? 'Stop' : 'Start'}">
      ${isRunning ? icon('pause', 13) + '<span class="btn-label">Stop</span>' : icon('play', 13) + '<span class="btn-label">Start</span>'}
    </button>
    <button class="btn" id="btnVerify" title="Verify local data">
      ${icon('check', 13)}<span class="btn-label">Verify</span>
    </button>
    <button class="btn" id="btnReannounce" title="Reannounce to trackers">
      ${icon('refresh', 13)}<span class="btn-label">Reannounce</span>
    </button>
    ${t.magnetLink ? `<button class="btn" id="btnMagnet" title="${magnetTitle}">
      ${icon('magnet', 13)}<span class="btn-label">Magnet</span>
    </button>` : ''}
    <div class="remove-wrapper" id="removeWrapper">
      <button class="btn btn-danger" id="btnRemove" title="Remove torrent">
        ${icon('trash', 13)}<span class="btn-label">Remove</span>
      </button>
    </div>
  `;

  // Wire up events
  document.getElementById('btnPlayStop').addEventListener('click', () => {
    const action = (torrent.status !== 0) ? 'stop' : 'start';
    doAction(action);
  });

  document.getElementById('btnVerify').addEventListener('click', () => doAction('verify'));
  document.getElementById('btnReannounce').addEventListener('click', () => doAction('reannounce'));

  const btnMagnet = document.getElementById('btnMagnet');
  if (btnMagnet) {
    btnMagnet.addEventListener('click', () => {
      copyToClipboard(t.magnetLink, 'Magnet link copied');
    });
  }

  const btnRemove = document.getElementById('btnRemove');
  btnRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    positionAndOpenDropdown(btnRemove);
  });

  document.getElementById('removeKeepBtn').onclick = () => {
    closeDropdown();
    if (confirm('Remove this torrent? (Files will be kept)')) {
      doAction('remove', { deleteData: false });
    }
  };
  document.getElementById('removeDeleteBtn').onclick = () => {
    closeDropdown();
    if (confirm('Remove this torrent AND delete all data? This cannot be undone.')) {
      doAction('remove', { deleteData: true });
    }
  };
}

function positionAndOpenDropdown(anchor) {
  const dd = document.getElementById('removeDropdown');
  const rect = anchor.getBoundingClientRect();
  dd.style.top  = (rect.bottom + 4) + 'px';
  dd.style.left = 'auto';
  dd.style.right = (window.innerWidth - rect.right) + 'px';
  dd.classList.add('open');
}

function closeDropdown() {
  document.getElementById('removeDropdown').classList.remove('open');
}

/* ─────────────────────────────────────────────────────────────
   ACTIONS
   ───────────────────────────────────────────────────────────── */

async function doAction(action, extra = {}) {
  try {
    const resp = await send({ type: 'TORRENT_ACTION', action, ids: [torrentId], extra });
    if (!resp.success) {
      showToast('Action failed: ' + (resp.error || 'Unknown error'), 'error');
      return;
    }
    const labels = { start: 'Started', stop: 'Stopped', verify: 'Verify started', reannounce: 'Reannouncing…', remove: 'Torrent removed' };
    showToast(labels[action] || 'Done', 'success');
    if (action === 'remove') {
      clearTimeout(refreshTimer);
      setTimeout(() => window.close(), 1200);
    } else {
      // Immediate refresh
      setTimeout(async () => {
        torrent = await fetchTorrent().catch(() => torrent);
        updateDynamic(torrent);
      }, 600);
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

/* ─────────────────────────────────────────────────────────────
   HEADER RENDER + UPDATE
   ───────────────────────────────────────────────────────────── */

function renderHeader(t) {
  const info = getStatusInfo(t.status, t.error);

  const nameEl = document.getElementById('torrentName');
  nameEl.textContent = t.name || 'Unknown';
  nameEl.title = t.name || '';

  const badge = document.getElementById('statusBadge');
  badge.className = 'badge badge-' + info.class;
  badge.innerHTML = icon(info.icon, 10) + info.label;

  updateHeader(t);
}

function updateHeader(t) {
  const info = getStatusInfo(t.status, t.error);

  // Badge
  const badge = document.getElementById('statusBadge');
  badge.className = 'badge badge-' + info.class;
  badge.innerHTML = icon(info.icon, 10) + info.label;

  // Progress bar
  const pct = Math.min(100, (t.percentDone || 0) * 100);
  const fill = document.getElementById('progressFill');
  fill.style.width = pct + '%';
  fill.className = 'progress-bar-detail-fill ' + (t.error > 0 ? 'error' : info.class);

  // Quick stats
  const qs = document.getElementById('quickStats');
  const pctStr = formatPercent(t.percentDone || 0);
  const sizeStr = formatBytes(t.sizeWhenDone || t.totalSize || 0);
  const dlStr   = formatSpeed(t.rateDownload || 0);
  const ulStr   = formatSpeed(t.rateUpload || 0);
  const ratio   = formatRatio(t.uploadRatio || 0);
  const etaStr  = t.status === 4 ? formatEta(t.eta) : (t.status === 6 ? 'Seeding' : '—');

  qs.innerHTML = `
    <span class="quick-stat"><span class="quick-stat-val">${pctStr} of ${sizeStr}</span></span>
    <span class="quick-sep">·</span>
    <span class="quick-stat">${icon('download', 12)}<span class="quick-stat-val">${dlStr}</span></span>
    <span class="quick-sep">·</span>
    <span class="quick-stat">${icon('upload', 12)}<span class="quick-stat-val">${ulStr}</span></span>
    <span class="quick-sep">·</span>
    <span class="quick-stat"><span style="color:var(--text-tertiary)">Ratio:</span> <span class="quick-stat-val">${ratio}</span></span>
    <span class="quick-sep">·</span>
    <span class="quick-stat"><span style="color:var(--text-tertiary)">ETA:</span> <span class="quick-stat-val">${etaStr}</span></span>
  `;
}

/* ─────────────────────────────────────────────────────────────
   INFO TAB
   ───────────────────────────────────────────────────────────── */

function renderInfo(t) {
  const container = document.getElementById('infoContent');
  container.innerHTML = buildInfoHTML(t);
  // Wire copy buttons
  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-copy');
      copyToClipboard(val, 'Copied!');
    });
  });
}

function buildInfoHTML(t) {
  // ── Activity ──
  const haveStr = formatBytes(t.haveValid || 0) + ' (' + formatPercent(t.percentDone || 0) + ')';

  let availPct = '—';
  if ((t.percentDone || 0) >= 1) {
    availPct = '100%';
  } else if (t.leftUntilDone > 0 && t.desiredAvailable >= 0) {
    const avail = Math.min(1, (t.desiredAvailable + (t.haveValid || 0)) / (t.sizeWhenDone || 1));
    availPct = formatPercent(avail);
  }

  const uploadedStr = formatBytes(t.uploadedEver || 0) + ' (Ratio: ' + formatRatio(t.uploadRatio || 0) + ')';
  const downloadedStr = formatBytes(t.downloadedEver || 0);
  const info = getStatusInfo(t.status, t.error);

  // Running time = secondsDownloading + secondsSeeding
  const runSeconds = (t.secondsDownloading || 0) + (t.secondsSeeding || 0);
  const runTime = formatEta(runSeconds);

  const remainTime = t.status === 4 ? formatEta(t.eta) : '—';
  const lastActivity = formatDateRelative(t.activityDate);
  const errorStr = (t.error > 0 && t.errorString) ? t.errorString : 'None';

  // ── Details ──
  const pieceCount = t.pieceCount || 0;
  const pieceSize = formatBytes(t.pieceSize || 0);
  const sizeStr = formatBytes(t.totalSize || 0) + ' (' + pieceCount.toLocaleString() + ' pieces @ ' + pieceSize + ')';
  const location = t.downloadDir || '—';
  const hash = t.hashString || '—';
  const privacy = t.isPrivate ? 'Private torrent' : 'Public torrent';
  const origin = t.creator || '—';
  const dateCreated = formatDate(t.dateCreated);
  const comment = t.comment || '—';
  const addedDate = formatDate(t.addedDate);
  const doneDate = t.doneDate ? formatDate(t.doneDate) : '—';

  // Labels
  let labelsHTML = '—';
  if (t.labels && t.labels.length) {
    labelsHTML = t.labels.map(l => `<span class="label-pill">${escHtml(l)}</span>`).join('');
  }

  // ── Limits ──
  const dlLimit = t.downloadLimited ? formatBytes(t.downloadLimit * 1024) + '/s' : 'Unlimited';
  const ulLimit = t.uploadLimited ? formatBytes(t.uploadLimit * 1024) + '/s' : 'Unlimited';

  let seedRatioLabel = 'Use global';
  if (t.seedRatioMode === 1) seedRatioLabel = 'Stop at ' + formatRatio(t.seedRatioLimit);
  if (t.seedRatioMode === 2) seedRatioLabel = 'No limit';

  let seedIdleLabel = 'Use global';
  if (t.seedIdleMode === 1) seedIdleLabel = 'Stop after ' + t.seedIdleLimit + 'm idle';
  if (t.seedIdleMode === 2) seedIdleLabel = 'No limit';

  const honorSession = t.honorsSessionLimits ? 'Yes' : 'No';

  const bwPriorityMap = { '-1': 'Low', '0': 'Normal', '1': 'High' };
  const bwPriority = bwPriorityMap[String(t.bandwidthPriority)] || 'Normal';

  const magnetLink = t.magnetLink || '';

  return `
    ${section('Activity', [
      row('Have',          haveStr),
      row('Availability',  availPct),
      row('Uploaded',      uploadedStr),
      row('Downloaded',    downloadedStr),
      row('State',         `<span class="badge badge-${info.class}" style="font-size:10px">${icon(info.icon,10)}${info.label}</span>`),
      row('Running Time',  runTime),
      row('Remaining',     remainTime),
      row('Added',         addedDate),
      row('Completed',     doneDate),
      row('Last Activity', lastActivity),
      row('Error',         t.error > 0 ? `<span class="info-value error-text">${escHtml(errorStr)}</span>` : 'None', t.error > 0),
    ])}

    ${section('Details', [
      row('Size',          escHtml(sizeStr)),
      row('Location',      escHtml(location)),
      rowMono('Hash', hash, hash),
      row('Privacy',       privacy),
      row('Origin',        escHtml(origin)),
      row('Date Created',  dateCreated),
      row('Comment',       comment !== '—' ? escHtml(comment) : '—'),
      row('Labels',        labelsHTML, false, true),
      ...(magnetLink ? [rowMono('Magnet', magnetLink.slice(0, 48) + '…', magnetLink)] : []),
    ])}

    ${section('Limits', [
      row('Download Limit',      dlLimit),
      row('Upload Limit',        ulLimit),
      row('Seed Ratio Limit',    seedRatioLabel),
      row('Seed Idle Limit',     seedIdleLabel),
      row('Honor Session Limits',honorSession),
      row('Bandwidth Priority',  bwPriority),
    ])}
  `;
}

function section(title, rows) {
  return `
    <div class="info-section">
      <div class="info-section-title">${title}</div>
      <div class="info-grid">
        ${rows.join('')}
      </div>
    </div>
  `;
}

function row(label, value, isError = false, rawValue = false) {
  const cls = isError ? 'info-value error-text' : 'info-value';
  const inner = rawValue ? value : `<span>${value}</span>`;
  return `
    <div class="info-row">
      <div class="info-label">${label}</div>
      <div class="${cls}">${inner}</div>
    </div>
  `;
}

function rowMono(label, display, copyVal) {
  return `
    <div class="info-row">
      <div class="info-label">${label}</div>
      <div class="info-value mono">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(display)}</span>
        <button class="copy-btn" data-copy="${escAttr(copyVal)}">Copy</button>
      </div>
    </div>
  `;
}

/* Update only the dynamic fields in the Info Activity section */
function updateInfoActivity(t) {
  // Just re-render the whole info tab — it's fast and avoids stale cells
  if (activeTab === 'info') {
    renderInfo(t);
  }
}

/* ─────────────────────────────────────────────────────────────
   PEERS TAB
   ───────────────────────────────────────────────────────────── */

function renderPeers(t) {
  const peers = t.peers || [];

  // Summary
  const summary = document.getElementById('peersSummary');
  summary.innerHTML = `Connected to <span>${t.peersConnected || 0}</span> peers &nbsp;·&nbsp; Downloading from <span>${t.peersSendingToUs || 0}</span> &nbsp;·&nbsp; Uploading to <span>${t.peersGettingFromUs || 0}</span>`;

  const tbody = document.getElementById('peersBody');
  const empty = document.getElementById('peersEmpty');
  const tableWrap = document.querySelector('.table-wrap');

  if (!peers.length) {
    tableWrap.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  tableWrap.classList.remove('hidden');
  empty.classList.add('hidden');

  // Sort
  const sorted = sortPeers(peers);
  tbody.innerHTML = sorted.map(p => peerRow(p)).join('');

  // Update sort headers
  document.querySelectorAll('#peersTable thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === peerSort.col) {
      th.classList.add(peerSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function peerRow(p) {
  const progress = ((p.progress || 0) * 100).toFixed(1);
  const enc = p.isEncrypted
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;color:var(--green)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;color:var(--text-muted)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

  return `<tr>
    <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">${escHtml(p.address || '—')}</td>
    <td style="color:var(--text-secondary)">${escHtml(p.clientName || '—')}</td>
    <td class="peer-progress-cell">
      <div class="peer-progress-wrap">
        <div class="peer-mini-bar"><div class="peer-mini-fill" style="width:${progress}%"></div></div>
        <span style="font-size:10px;color:var(--text-tertiary);min-width:32px;text-align:right">${progress}%</span>
      </div>
    </td>
    <td style="color:var(--text-secondary)">${formatSpeed(p.rateToClient || 0)}</td>
    <td style="color:var(--text-secondary)">${formatSpeed(p.rateToPeer || 0)}</td>
    <td><span class="peer-flag">${escHtml(p.flagStr || '—')}</span></td>
    <td style="text-align:center">${enc}</td>
  </tr>`;
}

function sortPeers(peers) {
  const col = peerSort.col;
  const dir = peerSort.dir === 'asc' ? 1 : -1;
  return [...peers].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (col === 'encrypted') { av = a.isEncrypted ? 1 : 0; bv = b.isEncrypted ? 1 : 0; }
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av || 0) - (bv || 0)) * dir;
  });
}

/* ─────────────────────────────────────────────────────────────
   TRACKERS TAB
   ───────────────────────────────────────────────────────────── */

function renderTrackers(t) {
  const stats = t.trackerStats || [];
  const container = document.getElementById('trackersContent');
  const empty = document.getElementById('trackersEmpty');

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
    const tierTrackers = tiers[tier];
    return `
      <div class="tracker-tier-group">
        <div class="tracker-tier-label">Tier ${tier}</div>
        ${tierTrackers.map(ts => trackerCard(ts)).join('')}
      </div>
    `;
  }).join('');
}

function trackerCard(ts) {
  const host = ts.host || ts.sitename || ts.announce || '—';
  const displayHost = ts.sitename || extractHost(ts.announce || '');

  // Announce state class
  const stateClass = ts.isBackup ? 'tracker-state-inactive'
    : (ts.announceState === 2 || ts.announceState === 3) ? 'tracker-state-active'
    : 'tracker-state-waiting';
  const stateLabel = ts.isBackup ? 'Backup'
    : announceStateLabel(ts.announceState);

  // Last announce
  const lastAnnTime = formatDateRelative(ts.lastAnnounceTime);
  const nextAnnTime = timeUntil(ts.nextAnnounceTime);
  const lastAnnResult = ts.lastAnnounceResult || '';
  const lastAnnClass = ts.lastAnnounceSucceeded ? 'tracker-result-success'
    : (ts.lastAnnounceTimedOut ? 'tracker-result-timeout' : 'tracker-result-fail');
  const lastAnnHtml = ts.hasAnnounced
    ? `<span class="${lastAnnClass}">${escHtml(lastAnnResult) || (ts.lastAnnounceSucceeded ? 'Success' : 'Failed')}</span>
       <span class="tracker-stat-detail">· ${ts.lastAnnouncePeerCount} peers · ${lastAnnTime}</span>`
    : `<span class="tracker-result-none">Not yet announced</span>`;

  // Last scrape
  const lastScrapeTime = formatDateRelative(ts.lastScrapeTime);
  const nextScrapeTime = timeUntil(ts.nextScrapeTime);
  const lastScrapeHtml = ts.hasScraped
    ? `<span class="${ts.lastScrapeSucceeded ? 'tracker-result-success' : 'tracker-result-fail'}">${ts.lastScrapeSucceeded ? 'Success' : escHtml(ts.lastScrapeResult || 'Failed')}</span>
       <span class="tracker-stat-detail">· Seeds: ${ts.seederCount} · Leeches: ${ts.leecherCount} · DL: ${ts.downloadCount} · ${lastScrapeTime}</span>`
    : `<span class="tracker-result-none">Not yet scraped</span>`;

  return `
    <div class="tracker-card">
      <div class="tracker-card-header">
        <span class="tracker-host">${escHtml(displayHost)}</span>
        <span class="tracker-announce-state ${stateClass}">${stateLabel}</span>
      </div>
      <div class="tracker-url">${escHtml(ts.announce || '')}</div>
      <div class="tracker-stats-grid">
        <div class="tracker-stat-block">
          <div class="tracker-stat-title">Last Announce</div>
          <div class="tracker-stat-row">${lastAnnHtml}</div>
          <div class="tracker-stat-row" style="margin-top:4px;color:var(--text-tertiary)">
            Next: ${nextAnnTime}
          </div>
        </div>
        <div class="tracker-stat-block">
          <div class="tracker-stat-title">Last Scrape</div>
          <div class="tracker-stat-row">${lastScrapeHtml}</div>
          <div class="tracker-stat-row" style="margin-top:4px;color:var(--text-tertiary)">
            Next: ${nextScrapeTime}
          </div>
        </div>
      </div>
    </div>
  `;
}

function announceStateLabel(state) {
  const map = { 0: 'Inactive', 1: 'Waiting', 2: 'Queued', 3: 'Active' };
  return map[state] || 'Unknown';
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
   FILES TAB
   ───────────────────────────────────────────────────────────── */

function renderFiles(t) {
  const files = t.files || [];
  const fileStats = t.fileStats || [];
  const container = document.getElementById('filesBody');
  const empty = document.getElementById('filesEmpty');
  const treeEl = document.querySelector('.files-tree');

  if (!files.length) {
    treeEl.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  treeEl.classList.remove('hidden');
  empty.classList.add('hidden');

  // Merge files with their stats
  const merged = files.map((f, i) => {
    const st = fileStats[i] || {};
    return {
      index: i,
      name: f.name,
      length: f.length,
      bytesCompleted: f.bytesCompleted || st.bytesCompleted || 0,
      wanted: st.wanted !== undefined ? st.wanted : true,
      priority: st.priority !== undefined ? st.priority : 0,
    };
  });

  // Build tree from paths
  const tree = buildFileTree(merged);
  container.innerHTML = renderTree(tree, 0);

  // Wire checkbox events
  container.querySelectorAll('.wanted-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const wanted = e.target.checked;
      setFileWanted(idx, wanted);
    });
  });

  // Wire folder toggles
  container.querySelectorAll('.tree-folder-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't toggle if clicking inside a checkbox or copy button
      if (e.target.closest('input, button')) return;
      const path = row.dataset.path;
      folderOpenState[path] = !folderOpenState[path];
      const childrenEl = document.getElementById('folder-children-' + CSS.escape(path));
      if (childrenEl) {
        childrenEl.style.display = folderOpenState[path] ? '' : 'none';
        row.classList.toggle('folder-row-open', folderOpenState[path]);
      }
    });
  });
}

function buildFileTree(files) {
  const root = { children: {}, files: [] };

  files.forEach(f => {
    const parts = f.name.split('/');
    if (parts.length === 1) {
      root.files.push(f);
      return;
    }
    // Navigate/create tree nodes
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        node.children[part] = { path: parts.slice(0, i + 1).join('/'), name: part, children: {}, files: [] };
      }
      node = node.children[part];
    }
    // Last part is the filename
    node.files.push({ ...f, displayName: parts[parts.length - 1] });
  });

  return root;
}

function renderTree(node, depth) {
  let html = '';
  const indent = depth * 18;

  // Sorted folders first, then files
  const folderKeys = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
  const fileList = sortFiles(node.files.map(f => ({ ...f, displayName: f.displayName || f.name })));

  folderKeys.forEach(key => {
    const child = node.children[key];
    const path = child.path;
    if (folderOpenState[path] === undefined) folderOpenState[path] = true; // open by default
    const isOpen = folderOpenState[path];

    // Folder summary stats
    const allFiles = getAllFilesInNode(child);
    const totalSize = allFiles.reduce((s, f) => s + (f.length || 0), 0);
    const totalDone = allFiles.reduce((s, f) => s + (f.bytesCompleted || 0), 0);
    const pct = totalSize > 0 ? ((totalDone / totalSize) * 100).toFixed(1) : '0.0';

    html += `
      <div class="tree-folder-row ${isOpen ? 'folder-row-open' : ''}" data-path="${escAttr(path)}">
        <div class="folder-name" style="padding-left:${indent}px">
          <span class="folder-chevron">${ICONS.arrowDown}</span>
          ${ICONS.folder}
          <span>${escHtml(child.name)}</span>
        </div>
        <div class="file-size-cell">${formatBytes(totalSize)}</div>
        <div class="file-progress-cell">
          <div class="file-progress-wrap">
            <div class="file-mini-bar"><div class="file-mini-fill ${totalDone >= totalSize && totalSize > 0 ? 'complete' : ''}" style="width:${pct}%"></div></div>
            <span class="file-pct">${pct}%</span>
          </div>
        </div>
        <div></div>
        <div></div>
      </div>
      <div id="folder-children-${CSS.escape(path)}" style="display:${isOpen ? '' : 'none'}">
        ${renderTree(child, depth + 1)}
      </div>
    `;
  });

  fileList.forEach(f => {
    const pct = f.length > 0 ? ((f.bytesCompleted / f.length) * 100).toFixed(1) : '0.0';
    const complete = parseFloat(pct) >= 100;
    html += fileRow(f, indent, pct, complete);
  });

  return html;
}

function getAllFilesInNode(node) {
  let files = [...node.files];
  Object.values(node.children).forEach(child => {
    files = files.concat(getAllFilesInNode(child));
  });
  return files;
}

function fileRow(f, indent, pct, complete) {
  const priorityLabels = { '-1': 'Low', '0': 'Normal', '1': 'High' };
  const priorityClasses = { '-1': 'priority-low', '0': 'priority-normal', '1': 'priority-high' };
  const pri = String(f.priority || 0);
  const displayName = f.displayName || f.name.split('/').pop();

  return `
    <div class="tree-file-row">
      <div class="file-name-cell">
        <span class="file-indent" style="width:${indent + 18}px;flex-shrink:0;display:inline-block"></span>
        <span class="file-name-text" title="${escAttr(f.name)}">${escHtml(displayName)}</span>
      </div>
      <div class="file-size-cell">${formatBytes(f.length || 0)}</div>
      <div class="file-progress-cell">
        <div class="file-progress-wrap">
          <div class="file-mini-bar"><div class="file-mini-fill ${complete ? 'complete' : ''}" style="width:${pct}%"></div></div>
          <span class="file-pct">${pct}%</span>
        </div>
      </div>
      <div style="text-align:center">
        <span class="priority-badge ${priorityClasses[pri] || 'priority-normal'}">${priorityLabels[pri] || 'Normal'}</span>
      </div>
      <div style="text-align:center">
        <input type="checkbox" class="wanted-checkbox" data-idx="${f.index}" ${f.wanted ? 'checked' : ''}>
      </div>
    </div>
  `;
}

function sortFiles(files) {
  const col = fileSort.col;
  const dir = fileSort.dir === 'asc' ? 1 : -1;
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

/* ─────────────────────────────────────────────────────────────
   FILE WANTED — send torrent-set
   ───────────────────────────────────────────────────────────── */

async function setFileWanted(fileIndex, wanted) {
  const key = wanted ? 'files-wanted' : 'files-unwanted';
  try {
    await send({
      type: 'TORRENT_ACTION',
      action: 'set',
      ids: [torrentId],
      extra: { [key]: [fileIndex] }
    });
  } catch (err) {
    showToast('Failed to update file: ' + err.message, 'error');
  }
}

/* ─────────────────────────────────────────────────────────────
   FILE SORT BUTTONS
   ───────────────────────────────────────────────────────────── */

function setupFileSortButtons() {
  const buttons = {
    fileSortName:     'name',
    fileSortSize:     'size',
    fileSortProgress: 'progress',
  };
  Object.entries(buttons).forEach(([id, col]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (fileSort.col === col) {
        fileSort.dir = fileSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        fileSort.col = col;
        fileSort.dir = 'asc';
      }
      updateFileSortBtnLabels();
      if (torrent) renderFiles(torrent);
    });
  });
  updateFileSortBtnLabels();
}

function updateFileSortBtnLabels() {
  const buttons = { fileSortName: 'name', fileSortSize: 'size', fileSortProgress: 'progress' };
  const labels = { name: 'Name', size: 'Size', progress: 'Progress' };
  Object.entries(buttons).forEach(([id, col]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (fileSort.col === col) {
      btn.setAttribute('data-active', 'true');
      btn.textContent = labels[col] + (fileSort.dir === 'asc' ? ' ↑' : ' ↓');
    } else {
      btn.removeAttribute('data-active');
      btn.textContent = labels[col];
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   TAB SWITCHING
   ───────────────────────────────────────────────────────────── */

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === activeTab) return;
      activeTab = tab;

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));

      // Render tab content if needed
      if (tab === 'peers' && torrent) renderPeers(torrent);
      if (tab === 'trackers' && torrent) renderTrackers(torrent);
      if (tab === 'files' && torrent) renderFiles(torrent);
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   PEERS TABLE — sortable headers
   ───────────────────────────────────────────────────────────── */

function setupPeersSort() {
  document.getElementById('peersTable').querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (peerSort.col === col) {
      peerSort.dir = peerSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      peerSort.col = col;
      peerSort.dir = 'asc';
    }
    if (torrent) renderPeers(torrent);
  });
}

/* ─────────────────────────────────────────────────────────────
   FOOTER
   ───────────────────────────────────────────────────────────── */

function updateFooter() {
  const el = document.getElementById('footerLastUpdated');
  if (!lastUpdated) { el.textContent = '—'; return; }
  const diff = Math.round((Date.now() - lastUpdated) / 1000);
  el.textContent = 'Updated: ' + (diff < 5 ? 'just now' : diff + 's ago');
}

// Keep footer updated every second
setInterval(() => { if (lastUpdated) updateFooter(); }, 1000);

/* ─────────────────────────────────────────────────────────────
   BACK BUTTON
   ───────────────────────────────────────────────────────────── */

function setupBackBtn() {
  document.getElementById('backBtn').addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   COPY TO CLIPBOARD
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
   HELPERS
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
   CLOSE DROPDOWN ON OUTSIDE CLICK
   ───────────────────────────────────────────────────────────── */

document.addEventListener('click', (e) => {
  const dd = document.getElementById('removeDropdown');
  const wrapper = document.getElementById('removeWrapper');
  if (!wrapper || !wrapper.contains(e.target)) {
    dd.classList.remove('open');
  }
});

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */

function init() {
  if (isNaN(torrentId)) {
    showLoading(false);
    showError('No torrent ID specified in URL hash. Use detail.html#<id>');
    return;
  }

  setupBackBtn();
  setupTabs();
  setupPeersSort();
  setupFileSortButtons();

  document.getElementById('retryBtn').addEventListener('click', () => {
    document.getElementById('errorWrap').classList.add('hidden');
    loadInitial();
  });

  loadInitial();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
