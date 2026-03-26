/**
 * Transmission RPC Client
 * Handles all communication with the Transmission daemon via its JSON-RPC API.
 * No Python needed — talks directly over HTTP.
 */

const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 9091,
  path: '/transmission/rpc',
  useHttps: false,
  username: '',
  password: ''
};

class TransmissionClient {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.sessionId = '';
  }

  get baseUrl() {
    const protocol = this.config.useHttps ? 'https' : 'http';
    return `${protocol}://${this.config.host}:${this.config.port}${this.config.path}`;
  }

  async loadConfig() {
    const stored = await chrome.storage.sync.get('serverConfig');
    if (stored.serverConfig) {
      this.config = { ...DEFAULT_CONFIG, ...stored.serverConfig };
    }
    return this.config;
  }

  async saveConfig(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    await chrome.storage.sync.set({ serverConfig: this.config });
  }

  /**
   * Core RPC request handler with automatic CSRF token management.
   * On 409, captures X-Transmission-Session-Id and retries.
   */
  async request(method, args = {}) {
    await this.loadConfig();

    const body = JSON.stringify({ method, arguments: args });
    const headers = {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': this.sessionId
    };

    if (this.config.username) {
      headers['Authorization'] = 'Basic ' + btoa(`${this.config.username}:${this.config.password}`);
    }

    let response;
    try {
      response = await fetch(this.baseUrl, { method: 'POST', headers, body });
    } catch (err) {
      throw new Error(`Connection failed: ${err.message}`);
    }

    // Handle CSRF 409 — grab the new session ID and retry once
    if (response.status === 409) {
      this.sessionId = response.headers.get('X-Transmission-Session-Id') || '';
      headers['X-Transmission-Session-Id'] = this.sessionId;
      try {
        response = await fetch(this.baseUrl, { method: 'POST', headers, body });
      } catch (err) {
        throw new Error(`Connection failed on retry: ${err.message}`);
      }
    }

    if (response.status === 401) {
      throw new Error('Authentication failed — check username/password');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.result !== 'success') {
      throw new Error(`RPC error: ${data.result}`);
    }

    return data.arguments;
  }

  // ─── Torrent Operations ────────────────────────────────────

  async getTorrents(fields = null) {
    const defaultFields = [
      'id', 'name', 'status', 'percentDone', 'rateDownload', 'rateUpload',
      'totalSize', 'eta', 'error', 'errorString', 'addedDate', 'doneDate',
      'uploadRatio', 'uploadedEver', 'downloadedEver', 'sizeWhenDone',
      'leftUntilDone', 'peersConnected', 'peersSendingToUs', 'peersGettingFromUs',
      'queuePosition', 'labels', 'downloadDir', 'isFinished', 'isStalled',
      'metadataPercentComplete', 'recheckProgress', 'bandwidthPriority',
      'seedRatioLimit', 'seedRatioMode', 'activityDate', 'hashString'
    ];
    return this.request('torrent-get', { fields: fields || defaultFields });
  }

  async addTorrent(options) {
    // options.filename = magnet URI or .torrent URL
    // options.metainfo = base64 encoded .torrent file
    const args = {};
    if (options.magnetUri || options.filename) {
      args.filename = options.magnetUri || options.filename;
    } else if (options.metainfo) {
      args.metainfo = options.metainfo;
    }
    if (options.downloadDir) args['download-dir'] = options.downloadDir;
    if (options.paused !== undefined) args.paused = options.paused;
    if (options.labels) args.labels = options.labels;
    if (options.bandwidthPriority !== undefined) args.bandwidthPriority = options.bandwidthPriority;
    return this.request('torrent-add', args);
  }

  async startTorrents(ids) {
    return this.request('torrent-start', { ids });
  }

  async startTorrentsNow(ids) {
    return this.request('torrent-start-now', { ids });
  }

  async stopTorrents(ids) {
    return this.request('torrent-stop', { ids });
  }

  async removeTorrents(ids, deleteLocalData = false) {
    return this.request('torrent-remove', { ids, 'delete-local-data': deleteLocalData });
  }

  async verifyTorrents(ids) {
    return this.request('torrent-verify', { ids });
  }

  async reannounceTorrents(ids) {
    return this.request('torrent-reannounce', { ids });
  }

  async setTorrents(ids, settings) {
    return this.request('torrent-set', { ids, ...settings });
  }

  async moveTorrents(ids, location, move = true) {
    return this.request('torrent-set-location', { ids, location, move });
  }

  // ─── Session / Server Operations ───────────────────────────

  async getSession() {
    return this.request('session-get');
  }

  async setSession(settings) {
    return this.request('session-set', settings);
  }

  async getSessionStats() {
    return this.request('session-stats');
  }

  async getFreeSpace(path) {
    return this.request('free-space', { path });
  }

  // ─── Turtle Mode (Alt Speed) ──────────────────────────────

  async getTurtleMode() {
    const session = await this.getSession();
    return {
      enabled: session['alt-speed-enabled'],
      downLimit: session['alt-speed-down'],
      upLimit: session['alt-speed-up'],
      scheduledEnabled: session['alt-speed-time-enabled'],
      scheduleBegin: session['alt-speed-time-begin'],
      scheduleEnd: session['alt-speed-time-end'],
      scheduleDays: session['alt-speed-time-day'],
      speedLimitDown: session['speed-limit-down'],
      speedLimitDownEnabled: session['speed-limit-down-enabled'],
      speedLimitUp: session['speed-limit-up'],
      speedLimitUpEnabled: session['speed-limit-up-enabled'],
      downloadDir: session['download-dir']
    };
  }

  async setTurtleMode(enabled) {
    return this.setSession({ 'alt-speed-enabled': enabled });
  }

  async setTurtleSettings(settings) {
    const mapped = {};
    if (settings.downLimit !== undefined) mapped['alt-speed-down'] = settings.downLimit;
    if (settings.upLimit !== undefined) mapped['alt-speed-up'] = settings.upLimit;
    if (settings.enabled !== undefined) mapped['alt-speed-enabled'] = settings.enabled;
    if (settings.scheduledEnabled !== undefined) mapped['alt-speed-time-enabled'] = settings.scheduledEnabled;
    if (settings.scheduleBegin !== undefined) mapped['alt-speed-time-begin'] = settings.scheduleBegin;
    if (settings.scheduleEnd !== undefined) mapped['alt-speed-time-end'] = settings.scheduleEnd;
    if (settings.scheduleDays !== undefined) mapped['alt-speed-time-day'] = settings.scheduleDays;
    return this.setSession(mapped);
  }

  async setSpeedLimits(settings) {
    const mapped = {};
    if (settings.downLimit !== undefined) mapped['speed-limit-down'] = settings.downLimit;
    if (settings.downEnabled !== undefined) mapped['speed-limit-down-enabled'] = settings.downEnabled;
    if (settings.upLimit !== undefined) mapped['speed-limit-up'] = settings.upLimit;
    if (settings.upEnabled !== undefined) mapped['speed-limit-up-enabled'] = settings.upEnabled;
    return this.setSession(mapped);
  }

  // ─── Helpers ───────────────────────────────────────────────

  async testConnection() {
    try {
      const session = await this.getSession();
      return { 
        success: true, 
        version: session['version'],
        rpcVersion: session['rpc-version'],
        downloadDir: session['download-dir']
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Export for both module and non-module contexts
if (typeof globalThis !== 'undefined') {
  globalThis.TransmissionClient = TransmissionClient;
}
