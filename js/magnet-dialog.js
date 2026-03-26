/**
 * Magnet Dialog — Add Torrent popup window logic.
 * Loaded by pages/magnet-dialog.html (non-module context).
 * Depends on helpers.js loaded first (ICONS, icon(), extractTorrentName, showToast).
 */

(function () {
  'use strict';

  // ── DOM References ─────────────────────────────────────────────
  const headerIcon    = document.getElementById('header-icon');
  const torrentName   = document.getElementById('torrent-name');
  const uriDisplay    = document.getElementById('uri-display');
  const inputDir      = document.getElementById('input-dir');
  const inputPaused   = document.getElementById('input-paused');
  const inputPriority = document.getElementById('input-priority');
  const inputLabels   = document.getElementById('input-labels');
  const errorBanner   = document.getElementById('error-banner');
  const errorIcon     = document.getElementById('error-icon');
  const errorText     = document.getElementById('error-text');
  const btnAdd        = document.getElementById('btn-add');
  const btnAddIcon    = document.getElementById('btn-add-icon');
  const btnCancel     = document.getElementById('btn-cancel');
  const btnClose      = document.getElementById('btn-close');
  const dirIcon       = document.getElementById('dir-icon');
  const loadingOverlay = document.getElementById('loading-overlay');

  // ── Inject icons ───────────────────────────────────────────────
  headerIcon.innerHTML  = ICONS.magnet;
  headerIcon.style.width  = '16px';
  headerIcon.style.height = '16px';

  dirIcon.innerHTML = ICONS.folder;
  dirIcon.style.width  = '14px';
  dirIcon.style.height = '14px';

  errorIcon.innerHTML = ICONS.alert;
  errorIcon.style.width  = '14px';
  errorIcon.style.height = '14px';

  btnAddIcon.innerHTML = ICONS.download;
  btnAddIcon.style.width  = '13px';
  btnAddIcon.style.height = '13px';

  // ── State ──────────────────────────────────────────────────────
  let magnetUri = '';

  // ── Helpers ────────────────────────────────────────────────────
  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  function setLoading(on) {
    if (on) {
      loadingOverlay.classList.remove('hidden');
      btnAdd.disabled = true;
      btnCancel.disabled = true;
    } else {
      loadingOverlay.classList.add('hidden');
      btnAdd.disabled = false;
      btnCancel.disabled = false;
    }
  }

  function closeWindow() {
    window.close();
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    // 1. Read the pending magnet from storage
    let storedData;
    try {
      storedData = await chrome.storage.local.get(['pendingMagnet']);
    } catch (err) {
      showError('Could not read pending magnet: ' + err.message);
      return;
    }

    magnetUri = storedData.pendingMagnet || '';

    if (!magnetUri) {
      torrentName.textContent = 'No torrent pending';
      uriDisplay.value = '';
      showError('No pending torrent found. This window may have been opened by mistake.');
      return;
    }

    // Display name and URI
    const name = extractTorrentName(magnetUri);
    torrentName.textContent = name;
    uriDisplay.value = magnetUri;

    // 2. Fetch session for default download dir
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
      if (resp && resp.success && resp.data && resp.data['download-dir']) {
        inputDir.value = resp.data['download-dir'];
        inputDir.placeholder = resp.data['download-dir'];
      }
    } catch {
      // Non-fatal — user can type the path manually
    }
  }

  // ── Add Torrent ────────────────────────────────────────────────
  async function addTorrent() {
    hideError();

    const downloadDir = inputDir.value.trim();
    const paused = inputPaused.checked;
    const bandwidthPriority = parseInt(inputPriority.value, 10);
    const labelsRaw = inputLabels.value.trim();
    const labels = labelsRaw
      ? labelsRaw.split(',').map(l => l.trim()).filter(Boolean)
      : [];

    if (!magnetUri) {
      showError('No magnet URI available.');
      return;
    }

    setLoading(true);

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'ADD_TORRENT',
        options: {
          magnetUri,
          downloadDir: downloadDir || undefined,
          paused,
          bandwidthPriority,
          labels: labels.length ? labels : undefined
        }
      });
    } catch (err) {
      setLoading(false);
      showError('Message error: ' + err.message);
      return;
    }

    setLoading(false);

    if (!result || !result.success) {
      showError(result?.error || 'Failed to add torrent. Check your connection.');
      return;
    }

    // Clear the pending magnet from storage
    try {
      await chrome.storage.local.remove(['pendingMagnet', 'pendingMagnetTab']);
    } catch {
      // Ignore
    }

    if (result.duplicate) {
      showToast(`Already in queue: ${result.name}`, 'info');
    } else {
      showToast(`Added: ${result.name || 'Torrent'}`, 'success');
    }

    // Close after a short delay so the toast is visible
    setTimeout(closeWindow, 1000);
  }

  // ── Event Listeners ────────────────────────────────────────────
  btnAdd.addEventListener('click', addTorrent);
  btnCancel.addEventListener('click', closeWindow);
  btnClose.addEventListener('click', closeWindow);

  // Allow Enter key in the directory field to trigger add
  inputDir.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addTorrent();
  });

  // ── Start ──────────────────────────────────────────────────────
  init();
})();
