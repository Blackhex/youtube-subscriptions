// Background service worker — handles cookie extraction and delivery
// Listens for messages from the content script injected into the app page

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'GET_YOUTUBE_COOKIES') return false;

  const appOrigin = message.appOrigin;
  if (!appOrigin) {
    sendResponse({ error: 'No appOrigin provided' });
    return false;
  }

  chrome.cookies.getAll({ domain: '.youtube.com' }, (cookies) => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }

    // Convert Chrome cookie format to Playwright state format
    const playwrightCookies = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expirationDate || -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite === 'no_restriction' ? 'None' :
                c.sameSite === 'lax' ? 'Lax' :
                c.sameSite === 'strict' ? 'Strict' : 'Lax',
    }));

    // Check if SAPISID is present
    const hasSapisid = playwrightCookies.some(
      (c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID'
    );

    if (!hasSapisid) {
      sendResponse({ error: 'Not signed in to YouTube. Please sign in to youtube.com first.' });
      return;
    }

    sendResponse({ cookies: playwrightCookies });
  });

  return true; // Keep the message channel open for async response
});
