// Content script — injected into the app page
// Bridges between the web page and the extension's background service worker

// Listen for messages from the web page
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'YT_SUBS_GET_COOKIES') return;

  chrome.runtime.sendMessage(
    { type: 'GET_YOUTUBE_COOKIES', appOrigin: window.location.origin },
    (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'YT_SUBS_COOKIES_RESPONSE',
          error: chrome.runtime.lastError.message,
        }, '*');
        return;
      }
      window.postMessage({
        type: 'YT_SUBS_COOKIES_RESPONSE',
        ...response,
      }, '*');
    }
  );
});

// Announce extension presence so the app knows it's installed
window.postMessage({ type: 'YT_SUBS_EXTENSION_READY' }, '*');
