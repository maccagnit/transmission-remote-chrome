/**
 * Content Script
 * Intercepts magnet link clicks on any webpage and routes them
 * to the background service worker for handling.
 *
 * A single document-level capturing listener is enough — it uses
 * `closest()` so it catches clicks on statically AND dynamically
 * inserted magnet links without needing per-link listeners.
 */

(function() {
  'use strict';

  function sendMagnet(magnetUri) {
    try {
      chrome.runtime.sendMessage({ type: 'MAGNET_CLICKED', magnetUri });
    } catch {
      // Extension context invalidated — nothing to do
    }
  }

  // Left-click on any magnet link
  document.addEventListener('click', (e) => {
    // Honour modifier-clicks (user may Ctrl/Cmd-click to open in new tab)
    if (e.defaultPrevented) return;
    const link = e.target.closest('a[href^="magnet:"]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();
    sendMagnet(link.href);
  }, true);

  // Middle-click
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const link = e.target.closest('a[href^="magnet:"]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();
    sendMagnet(link.href);
  }, true);
})();
