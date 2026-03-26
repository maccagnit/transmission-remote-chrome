/**
 * Options Page — Transmission Remote Extension settings.
 * Loaded by pages/options.html (non-module context).
 * Depends on helpers.js loaded first.
 */

(function () {
  'use strict';

  // ── Inject static icons ────────────────────────────────────────

  function injectIcon(id, iconName, size) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = ICONS[iconName] || '';
    if (size) {
      el.style.width = size + 'px';
      el.style.height = size + 'px';
    }
  }

  // Page header
  const phIcon = document.getElementById('ph-icon');
  if (phIcon) {
    phIcon.innerHTML = ICONS.settings;
    const svg = phIcon.querySelector('svg');
    if (svg) { svg.style.width = '18px'; svg.style.height = '18px'; }
  }

  injectIcon('icon-server',      'server',   14);
  injectIcon('icon-turtle-hdr',  'turtle',   14);
  injectIcon('icon-speed-hdr',   'download', 14);
  injectIcon('icon-about-hdr',   'alert',    14);

  // Button icons (set after DOM ready)
  function setButtonIcons() {
    injectIcon('icon-test-conn',  'refresh',  13);
    injectIcon('icon-save-conn',  'check',    13);
    injectIcon('icon-save-turtle','check',    13);
    injectIcon('icon-save-speed', 'check',    13);
  }
  setButtonIcons();

  // ── DOM refs — Connection ──────────────────────────────────────
  const cfgHost        = document.getElementById('cfg-host');
  const cfgPort        = document.getElementById('cfg-port');
  const cfgPath        = document.getElementById('cfg-path');
  const cfgHttps       = document.getElementById('cfg-https');
  const cfgUsername    = document.getElementById('cfg-username');
  const cfgPassword    = document.getElementById('cfg-password');
  const btnTogglePw    = document.getElementById('btn-toggle-pw');
  const btnTestConn    = document.getElementById('btn-test-conn');
  const btnSaveConn    = document.getElementById('btn-save-conn');
  const connResultWrap = document.getElementById('conn-result-wrap');
  const connResult     = document.getElementById('conn-result');
  const connResultIcon = document.getElementById('conn-result-icon');
  const connResultText = document.getElementById('conn-result-text');

  // ── DOM refs — Turtle ──────────────────────────────────────────
  const turtleEnabled      = document.getElementById('turtle-enabled');
  const turtleDown         = document.getElementById('turtle-down');
  const turtleUp           = document.getElementById('turtle-up');
  const turtleSchedEnabled = document.getElementById('turtle-sched-enabled');
  const turtleSchedFields  = document.getElementById('turtle-sched-fields');
  const turtleSchedStart   = document.getElementById('turtle-sched-start');
  const turtleSchedEnd     = document.getElementById('turtle-sched-end');
  const daysGrid           = document.getElementById('days-grid');
  const daysWeekdays       = document.getElementById('days-weekdays');
  const daysWeekends       = document.getElementById('days-weekends');
  const daysAll            = document.getElementById('days-all');
  const btnSaveTurtle      = document.getElementById('btn-save-turtle');

  // ── DOM refs — Speed ───────────────────────────────────────────
  const speedDownEnabled = document.getElementById('speed-down-enabled');
  const speedDownLimit   = document.getElementById('speed-down-limit');
  const speedUpEnabled   = document.getElementById('speed-up-enabled');
  const speedUpLimit     = document.getElementById('speed-up-limit');
  const btnSaveSpeed     = document.getElementById('btn-save-speed');

  // ── DOM refs — About ───────────────────────────────────────────
  const aboutVersion = document.getElementById('about-version');

  // ── Helper: send a message and get a response ──────────────────
  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Helper: show connection result banner ──────────────────────
  function showConnResult(ok, text) {
    connResultWrap.classList.remove('hidden');
    connResult.className = 'conn-result ' + (ok ? 'success' : 'error');
    connResultIcon.style.cssText = 'display:inline-flex;width:14px;height:14px;flex-shrink:0';
    connResultIcon.innerHTML = ok ? ICONS.check : ICONS.alert;
    connResultText.textContent = text;
  }

  function hideConnResult() {
    connResultWrap.classList.add('hidden');
  }

  // ── Toggle schedule fields ─────────────────────────────────────
  function syncScheduleVisibility() {
    if (turtleSchedEnabled.checked) {
      turtleSchedFields.classList.remove('hidden');
      turtleSchedFields.style.display = 'flex';
    } else {
      turtleSchedFields.classList.add('hidden');
      turtleSchedFields.style.display = 'none';
    }
  }
  turtleSchedEnabled.addEventListener('change', syncScheduleVisibility);
  syncScheduleVisibility();

  // ── Days bitmask helpers ───────────────────────────────────────
  // Bits: SUN=1, MON=2, TUE=4, WED=8, THU=16, FRI=32, SAT=64
  const dayChips = daysGrid ? Array.from(daysGrid.querySelectorAll('.day-chip')) : [];

  function getDaysBitmask() {
    let mask = 0;
    dayChips.forEach(chip => {
      if (chip.classList.contains('active')) {
        mask |= parseInt(chip.dataset.bit, 10);
      }
    });
    return mask;
  }

  function setDaysBitmask(mask) {
    dayChips.forEach(chip => {
      const bit = parseInt(chip.dataset.bit, 10);
      if (mask & bit) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  // Toggle individual chips
  dayChips.forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  // Quick toggles
  if (daysWeekdays) daysWeekdays.addEventListener('click', () => setDaysBitmask(SCHEDULE_DAYS.WEEKDAYS));
  if (daysWeekends) daysWeekends.addEventListener('click', () => setDaysBitmask(SCHEDULE_DAYS.WEEKENDS));
  if (daysAll)      daysAll.addEventListener('click',      () => setDaysBitmask(SCHEDULE_DAYS.ALL));

  // ── Password show/hide ─────────────────────────────────────────
  if (btnTogglePw) {
    btnTogglePw.addEventListener('click', () => {
      const isText = cfgPassword.type === 'text';
      cfgPassword.type = isText ? 'password' : 'text';
      // Swap eye icon
      const eyeIcon = document.getElementById('pw-eye-icon');
      if (eyeIcon) {
        if (!isText) {
          // Now showing text — show "eye-off"
          eyeIcon.innerHTML = `
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          `;
        } else {
          // Now hidden — show normal eye
          eyeIcon.innerHTML = `
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          `;
        }
      }
    });
  }

  // ── Load and populate config ───────────────────────────────────
  async function loadConfig() {
    try {
      const resp = await send({ type: 'GET_CONFIG' });
      if (resp && resp.success && resp.config) {
        const c = resp.config;
        cfgHost.value     = c.host     ?? 'localhost';
        cfgPort.value     = c.port     ?? 9091;
        cfgPath.value     = c.path     ?? '/transmission/rpc';
        cfgHttps.checked  = !!c.useHttps;
        cfgUsername.value = c.username ?? '';
        cfgPassword.value = c.password ?? '';
      }
    } catch (err) {
      showToast('Could not load config: ' + err.message, 'error');
    }
  }

  // ── Load turtle / speed settings ──────────────────────────────
  async function loadTurtleSettings() {
    try {
      const resp = await send({ type: 'GET_TURTLE_MODE' });
      if (resp && resp.success && resp.data) {
        const d = resp.data;

        turtleEnabled.checked      = !!d.enabled;
        turtleDown.value           = d.downLimit     ?? '';
        turtleUp.value             = d.upLimit       ?? '';
        turtleSchedEnabled.checked = !!d.scheduledEnabled;
        syncScheduleVisibility();

        // Times: stored as minutes since midnight
        if (d.scheduleBegin !== undefined) {
          turtleSchedStart.value = minutesToTime(d.scheduleBegin);
        }
        if (d.scheduleEnd !== undefined) {
          turtleSchedEnd.value = minutesToTime(d.scheduleEnd);
        }
        if (d.scheduleDays !== undefined) {
          setDaysBitmask(d.scheduleDays);
        }

        // Speed limits
        speedDownEnabled.checked = !!d.speedLimitDownEnabled;
        speedUpEnabled.checked   = !!d.speedLimitUpEnabled;
        speedDownLimit.value     = d.speedLimitDown ?? '';
        speedUpLimit.value       = d.speedLimitUp   ?? '';
      }
    } catch {
      // Non-fatal — server may not be reachable on load
    }
  }

  // ── Save config ────────────────────────────────────────────────
  async function saveConfig() {
    hideConnResult();
    const config = {
      host:     cfgHost.value.trim()     || 'localhost',
      port:     parseInt(cfgPort.value, 10) || 9091,
      path:     cfgPath.value.trim()     || '/transmission/rpc',
      useHttps: cfgHttps.checked,
      username: cfgUsername.value.trim(),
      password: cfgPassword.value
    };

    btnSaveConn.disabled = true;
    try {
      const resp = await send({ type: 'SAVE_CONFIG', config });
      if (resp && resp.success) {
        showToast('Connection settings saved', 'success');
      } else {
        showToast((resp && resp.error) || 'Failed to save config', 'error');
      }
    } catch (err) {
      showToast('Save error: ' + err.message, 'error');
    } finally {
      btnSaveConn.disabled = false;
    }
  }

  // ── Test connection ────────────────────────────────────────────
  async function testConnection() {
    hideConnResult();
    btnTestConn.disabled = true;

    // Save config first so the background worker uses the current form values
    const config = {
      host:     cfgHost.value.trim()     || 'localhost',
      port:     parseInt(cfgPort.value, 10) || 9091,
      path:     cfgPath.value.trim()     || '/transmission/rpc',
      useHttps: cfgHttps.checked,
      username: cfgUsername.value.trim(),
      password: cfgPassword.value
    };

    try {
      await send({ type: 'SAVE_CONFIG', config });
      const resp = await send({ type: 'TEST_CONNECTION' });
      if (resp && resp.success) {
        const detail = [
          'Connected',
          resp.version       ? `v${resp.version}`            : null,
          resp.rpcVersion    ? `RPC r${resp.rpcVersion}`      : null,
          resp.downloadDir   ? `→ ${resp.downloadDir}`        : null
        ].filter(Boolean).join('  ·  ');
        showConnResult(true, detail);
      } else {
        showConnResult(false, (resp && resp.error) || 'Connection failed');
      }
    } catch (err) {
      showConnResult(false, 'Error: ' + err.message);
    } finally {
      btnTestConn.disabled = false;
    }
  }

  // ── Save turtle settings ───────────────────────────────────────
  async function saveTurtleSettings() {
    btnSaveTurtle.disabled = true;

    const settings = {
      enabled:          turtleEnabled.checked,
      downLimit:        parseInt(turtleDown.value, 10) || 0,
      upLimit:          parseInt(turtleUp.value, 10) || 0,
      scheduledEnabled: turtleSchedEnabled.checked,
      scheduleBegin:    turtleSchedEnabled.checked
                          ? timeToMinutes(turtleSchedStart.value || '00:00')
                          : undefined,
      scheduleEnd:      turtleSchedEnabled.checked
                          ? timeToMinutes(turtleSchedEnd.value || '00:00')
                          : undefined,
      scheduleDays:     turtleSchedEnabled.checked ? getDaysBitmask() : undefined
    };

    try {
      const resp = await send({ type: 'SET_TURTLE_SETTINGS', settings });
      if (resp && resp.success) {
        showToast('Turtle settings saved', 'success');
      } else {
        showToast((resp && resp.error) || 'Failed to save turtle settings', 'error');
      }
    } catch (err) {
      showToast('Save error: ' + err.message, 'error');
    } finally {
      btnSaveTurtle.disabled = false;
    }
  }

  // ── Save speed limits ──────────────────────────────────────────
  async function saveSpeedLimits() {
    btnSaveSpeed.disabled = true;

    const settings = {
      downEnabled: speedDownEnabled.checked,
      downLimit:   parseInt(speedDownLimit.value, 10) || 0,
      upEnabled:   speedUpEnabled.checked,
      upLimit:     parseInt(speedUpLimit.value, 10) || 0
    };

    try {
      const resp = await send({ type: 'SET_SPEED_LIMITS', settings });
      if (resp && resp.success) {
        showToast('Speed limits saved', 'success');
      } else {
        showToast((resp && resp.error) || 'Failed to save speed limits', 'error');
      }
    } catch (err) {
      showToast('Save error: ' + err.message, 'error');
    } finally {
      btnSaveSpeed.disabled = false;
    }
  }

  // ── Speed limit inputs: disable when unchecked ─────────────────
  function syncSpeedInputs() {
    speedDownLimit.disabled = !speedDownEnabled.checked;
    speedUpLimit.disabled   = !speedUpEnabled.checked;
  }
  speedDownEnabled.addEventListener('change', syncSpeedInputs);
  speedUpEnabled.addEventListener('change', syncSpeedInputs);
  syncSpeedInputs();

  // ── Button event listeners ─────────────────────────────────────
  btnTestConn.addEventListener('click',  testConnection);
  btnSaveConn.addEventListener('click',  saveConfig);
  btnSaveTurtle.addEventListener('click', saveTurtleSettings);
  btnSaveSpeed.addEventListener('click',  saveSpeedLimits);

  // Hide connection result whenever form fields change
  [cfgHost, cfgPort, cfgPath, cfgUsername, cfgPassword, cfgHttps].forEach(el => {
    el.addEventListener('input',  hideConnResult);
    el.addEventListener('change', hideConnResult);
  });

  // ── Populate version from manifest ────────────────────────────
  function loadVersion() {
    try {
      const manifest = chrome.runtime.getManifest();
      if (aboutVersion && manifest.version) {
        aboutVersion.textContent = manifest.version;
      }
    } catch {
      if (aboutVersion) aboutVersion.textContent = '—';
    }
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    loadVersion();
    await loadConfig();
    await loadTurtleSettings();
  }

  init();
})();
