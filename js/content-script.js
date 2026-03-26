/**
 * Content Script
 * Intercepts magnet link clicks on any webpage and routes them
 * to the background service worker for handling.
 */

(function() {
  'use strict';

  // Listen for clicks on magnet links
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="magnet:"]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    const magnetUri = link.href;
    
    chrome.runtime.sendMessage({
      type: 'MAGNET_CLICKED',
      magnetUri: magnetUri
    });
  }, true);

  // Also handle middle-clicks
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return; // middle click only
    const link = e.target.closest('a[href^="magnet:"]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    chrome.runtime.sendMessage({
      type: 'MAGNET_CLICKED',
      magnetUri: link.href
    });
  }, true);

  // Observe DOM changes to catch dynamically added magnet links
  // and prevent the browser from navigating to them
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const links = node.querySelectorAll?.('a[href^="magnet:"]') || [];
        links.forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            chrome.runtime.sendMessage({
              type: 'MAGNET_CLICKED',
              magnetUri: link.href
            });
          }, true);
        });
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
