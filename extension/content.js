// Content script — injected into the app page
// Bridges between the web page and the extension's background service worker
//
// The cookie response carries the full YouTube session (SAPISID and friends),
// so it is never broadcast: every postMessage targets this page's own origin,
// and a request that did not come from this page's own origin (a cross-origin
// iframe on it) is ignored. Chrome's match patterns do not reliably constrain
// ports, so the origin allow-list is re-checked here instead of being trusted
// from the manifest.

(() => {
const PAGE_ORIGIN = window.location.origin;

function configuredOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.username || parsed.password || parsed.origin === 'null') return '';
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return '';
    return parsed.origin;
  } catch (error) {
    return '';
  }
}

async function initialize() {
  let stored;
  try {
    stored = await chrome.storage.local.get('appOrigin');
  } catch (error) {
    return;
  }
  const appOrigin = configuredOrigin(stored.appOrigin || 'http://127.0.0.1:8001');
  if (!appOrigin || PAGE_ORIGIN !== appOrigin) return;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== PAGE_ORIGIN) return;
    if (event.data?.type !== 'YT_SUBS_GET_COOKIES') return;

    chrome.runtime.sendMessage(
      { type: 'GET_YOUTUBE_COOKIES', appOrigin: PAGE_ORIGIN },
      (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: 'YT_SUBS_COOKIES_RESPONSE',
            error: chrome.runtime.lastError.message,
          }, PAGE_ORIGIN);
          return;
        }
        window.postMessage({
          type: 'YT_SUBS_COOKIES_RESPONSE',
          ...response,
        }, PAGE_ORIGIN);
      }
    );
  });

  window.postMessage({ type: 'YT_SUBS_EXTENSION_READY' }, PAGE_ORIGIN);
}

initialize();
})();
