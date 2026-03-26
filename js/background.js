/**
 * Background Service Worker
 * Handles magnet link interception, context menus, and message routing.
 */

importScripts('transmission-client.js');

const client = new TransmissionClient();

// ─── Magnet Link Interception ────────────────────────────────

// Listen for messages from content scripts about magnet links
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MAGNET_CLICKED') {
    handleMagnetLink(message.magnetUri, sender.tab);
    sendResponse({ received: true });
    return false;
  }

  if (message.type === 'ADD_TORRENT') {
    handleAddTorrent(message.options)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.type === 'GET_TORRENTS') {
    client.getTorrents()
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TORRENT_ACTION') {
    handleTorrentAction(message.action, message.ids, message.extra)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SESSION') {
    client.getSession()
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_SESSION') {
    client.setSession(message.settings)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_TURTLE_MODE') {
    client.getTurtleMode()
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_TURTLE_MODE') {
    client.setTurtleMode(message.enabled)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_TURTLE_SETTINGS') {
    client.setTurtleSettings(message.settings)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_SPEED_LIMITS') {
    client.setSpeedLimits(message.settings)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SESSION_STATS') {
    client.getSessionStats()
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_FREE_SPACE') {
    client.getFreeSpace(message.path)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TEST_CONNECTION') {
    client.testConnection()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SAVE_CONFIG') {
    client.saveConfig(message.config)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_CONFIG') {
    client.loadConfig()
      .then(config => sendResponse({ success: true, config }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});

async function handleMagnetLink(magnetUri, tab) {
  // Store magnet URI and open the add-torrent dialog
  await chrome.storage.local.set({ 
    pendingMagnet: magnetUri,
    pendingMagnetTab: tab?.id 
  });
  
  // Open a popup window for the magnet dialog
  chrome.windows.create({
    url: chrome.runtime.getURL('pages/magnet-dialog.html'),
    type: 'popup',
    width: 520,
    height: 480,
    focused: true
  });
}

async function handleAddTorrent(options) {
  try {
    const result = await client.addTorrent(options);
    const added = result['torrent-added'] || result['torrent-duplicate'];
    
    if (result['torrent-duplicate']) {
      return { success: true, duplicate: true, name: added?.name || 'Unknown' };
    }
    
    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Torrent Added',
      message: added?.name || 'Torrent added successfully'
    });
    
    return { success: true, name: added?.name || 'Unknown', id: added?.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleTorrentAction(action, ids, extra = {}) {
  try {
    switch (action) {
      case 'start':
        await client.startTorrents(ids);
        break;
      case 'start-now':
        await client.startTorrentsNow(ids);
        break;
      case 'stop':
        await client.stopTorrents(ids);
        break;
      case 'remove':
        await client.removeTorrents(ids, extra.deleteData || false);
        break;
      case 'verify':
        await client.verifyTorrents(ids);
        break;
      case 'reannounce':
        await client.reannounceTorrents(ids);
        break;
      case 'set':
        await client.setTorrents(ids, extra.settings || {});
        break;
      case 'move':
        await client.moveTorrents(ids, extra.location, extra.move);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Context Menu ────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-torrent-link',
    title: 'Add to Transmission',
    contexts: ['link'],
    targetUrlPatterns: ['magnet:*']
  });
  
  chrome.contextMenus.create({
    id: 'add-torrent-file-link',
    title: 'Add .torrent to Transmission',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.torrent', '*://*/*.torrent?*']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'add-torrent-link' || info.menuItemId === 'add-torrent-file-link') {
    handleMagnetLink(info.linkUrl, tab);
  }
});

// ─── Badge Update ────────────────────────────────────────────

async function updateBadge() {
  try {
    const result = await client.getTorrents(['id', 'status', 'rateDownload']);
    const torrents = result.torrents || [];
    const downloading = torrents.filter(t => t.status === 4).length;
    
    if (downloading > 0) {
      chrome.action.setBadgeText({ text: String(downloading) });
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // Connection issue — clear badge
    chrome.action.setBadgeText({ text: '' });
  }
}

// Update badge every 5 seconds
setInterval(updateBadge, 5000);

// Also update on install
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});
