---
name: youtube-api-integration
description: "YouTube API integration for YouTube Subscriptions Organizer. Use when: implementing YouTube Data API v3 calls, InnerTube API (FEchannels, channel browse for progress), YouTube Lounge API for Cast, OAuth 2.0 flow, Playwright cookie-based auth, Google Gemini API for AI suggestions."
---

# YouTube API Integration

## When to Use
- Implementing `subscriptions/youtube_service.py`
- Implementing OAuth 2.0 credential management
- Working with InnerTube (TVHTML5 client) for supplemental data
- Implementing Lounge API for Google Cast playback
- Implementing Gemini API calls in `subscriptions/suggestions.py`
- Implementing Cast SDK integration in `frontend/src/hooks/useCast.ts`

## Design References
- **Architecture**: See [Architecture Overview](../../../docs/01-architecture-overview.md) §4.5 (Three-Tier YouTube API Strategy), §8 (External API Dependencies)
- **API Spec**: See [API Reference](../../../docs/03-api-reference.md) for Cast and sync endpoints
- **User Scenarios**: See [User Scenarios](../../../docs/05-user-scenarios.md) Scenarios 1, 5, 8, 13

## YouTube Data API v3

### Authentication
- `google-auth-oauthlib` `InstalledAppFlow` from `client_secret.json`
- Scope: `https://www.googleapis.com/auth/youtube`
- Token cached in `token.json`, auto-refresh on expiry
- If refresh fails, delete token and re-run OAuth flow
- Desktop-client redirect remains exactly `http://localhost:8085/`
- Callbacks use a loopback-only listener or extension 2.6 relay to `POST /api/auth/oauth/callback/` at an explicitly configured remote HTTPS or HTTP loopback app origin (exact `localhost` or `127.0.0.1`, any port)
- The callback URL, decoded parameters and OAuth state are strictly bounded and validated against the original in-memory Flow
- Callback exchange, refresh and logout use generation checks; token persistence is atomic and logout holds the lock through token deletion
- Pending Flow state is process-local, so start and completion must reach one Django process
- The YouTube grant authorizes the server account and must never be treated as browser/API authentication

### Key Endpoints
- `youtube.subscriptions().list(mine=True)` — paginated with pageToken
- `youtube.channels().list(id=..., part='contentDetails')` — get uploads playlist ID
- `youtube.playlistItems().list(playlistId=..., part='snippet')` — channel uploads
- `youtube.videos().list(id=..., part='contentDetails,snippet,liveStreamingDetails')` — video details
- `youtube.playlists().list(mine=True)` — owned playlists
- `youtube.subscriptions().delete(id=...)` — unsubscribe

### Retry Logic
- Wrap API calls in `_execute_with_retry(request, max_retries=3)`
- Retry on `HttpError` 500, 503; raise on 403 (quota), 404

## InnerTube API (TVHTML5 Client)

### FEchannels (Supplemental Subscriptions)
```python
# POST https://www.youtube.com/youtubei/v1/browse
{
    "browseId": "FEchannels",
    "context": { "client": { "clientName": "TVHTML5", "clientVersion": "7.20250101" } }
}
# Auth: Authorization: Bearer {access_token}
```
- Catches channels the public API misses
- Contains only channel IDs and titles (supplement, not replace)

## YouTube Lounge API (Cast Playback)

### Flow
1. **Get lounge token**: `POST https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch` with `screen_ids={screenId}`
2. **Bind session**: `POST https://www.youtube.com/api/lounge/bc/bind` with lounge token, get SID/gsessionid
3. **Set playlist**: `POST .../bind` with `setPlaylist` command containing video IDs
4. **Poll now playing**: `GET .../bind` with SID to get current playback state

### Session Persistence
- Save lounge session data to `media/lounge_session.json`
- Reuse session on subsequent casts if valid

## Google Gemini API (AI Suggestions)

### Request
```python
# POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}
{
    "contents": [{ "parts": [{ "text": prompt }] }],
    "generationConfig": { "temperature": 0.1 }
}
```
- Prompt includes: channel title, description, all category names
- Parse response for category IDs
- Fallback to heuristic keyword matching if Gemini fails

## Browser-Side Cast SDK (`useCast()` Hook)

### Initialization
- Load `https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1` in index.html
- `window.__onGCastApiAvailable` callback → `cast.framework.CastContext.getInstance().setOptions()`
- Receiver app ID: YouTube default receiver

### Session Flow
1. `requestSession()` → shows device picker
2. `getMdxSessionStatus()` via Cast message → extract `screenId`
3. Send `screenId` to `POST /api/queue/cast/`
4. Start polling `/api/queue/refresh-progress/` every 10s

## Chrome Extension for Cookie-Based Auth

### Purpose
YouTube watch history recording requires browser session cookies (SAPISIDHASH), not OAuth.
A companion Chrome extension (`extension/` directory) provides these cookies.

### Extension Architecture (MV3)
- `manifest.json`: permanent YouTube/loopback access, optional remote HTTPS host access, `scripting`, and `webNavigation`
- `background.js`: reads YouTube cookies via `chrome.cookies.getAll()`, converts to Playwright format
- `content.js`: dynamically registered bridge for the exact configured app origin

### OAuth Callback Relay
1. Google redirects the Desktop client to `http://localhost:8085/`
2. For an explicitly saved remote HTTPS or HTTP loopback app origin, `webNavigation.onBeforeNavigate` accepts only the exact top-level callback shape; unsaved defaults bypass relaying
3. The worker scrubs the callback tab (or closes it) before transmitting callback data
4. It re-checks configured origin and Chrome host permission, then POSTs only to `{origin}/api/auth/oauth/callback/` with redirects disabled and bounded I/O
5. Only an authenticated, terminal, error-free backend response is success; concurrent listener/relay callbacks use the backend's single-use and idempotent completion safeguards

Never log, store, badge, or place the callback URL, code, state, or query in a destination URL. If tab scrubbing and closing both fail, abort the relay.

### Cookie Sync Flow
1. Frontend sends `YT_SUBS_GET_COOKIES` message via `window.postMessage`
2. Content script relays to background via `chrome.runtime.sendMessage`
3. Background reads cookies, validates SAPISID presence, responds
4. Content script posts `YT_SUBS_COOKIES_RESPONSE` back to the page
5. Frontend POSTs cookies to `POST /api/auth/youtube-session/cookies/`
6. Backend saves as `media/browser_state.json` (Playwright storage state format)

### Mark-as-Watched via Playwright Headless
After cookies are imported, `YouTubeCookieAPI.report_watch()`:
1. Launches headless Chromium with saved `browser_state.json`
2. Navigates to `/watch?v={video_id}`
3. Extracts tracking URL from `ytInitialPlayerResponse` via `page.evaluate()`
4. Sends tracking ping via `fetch()` inside browser context (cookies auto-sent)
5. Saves refreshed cookies back to `browser_state.json`
6. On failure, `_refresh_session()` visits youtube.com headlessly to refresh, retries once

### Persistence
- `sessionStorage`: cast session ID, screen ID
- `tryResumeCastSession()` on hook mount
