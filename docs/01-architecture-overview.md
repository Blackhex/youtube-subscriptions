# Architecture Overview

## 1. System Summary

YouTube Subscriptions Organizer is a **Django + React single-page application** for managing YouTube subscriptions with hierarchical categories, customizable video feeds, playlist management, a video play queue with Google Cast support, and AI-powered category suggestions. Data is persisted in a **SQLite** database via the **Django ORM**.

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 Browser (React SPA)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Feeds   │  │ Playlists│  │Subscript. │  │  Queue  │ │
│  │  Section │  │  Section │  │  Section  │  │  Panel  │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └────┬────┘ │
│       │              │              │              │      │
│       └──────────────┴──────────────┴──────────────┘      │
│                          │                                │
│                   apiClient (axios)                       │
│                   (async/await + JSON)                    │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP JSON API
┌──────────────────────────┴───────────────────────────────┐
│               Django Backend (DRF)                       │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ ViewSets │  │  Background  │  │   Thumbnail        │ │
│  │ & Views  │  │   Sync       │  │   Cache            │ │
│  └────┬─────┘  │  (Celery /   │  │ (media/            │ │
│       │        │   Thread)    │  │  thumbnails/)      │ │
│       │        └──────┬───────┘  └────────────────────┘ │
│  ┌────┴──────────────┐│                                  │
│  │   Django ORM      ││                                  │
│  │  (models.py)      ││                                  │
│  └────┬──────────────┘│                                  │
│       │               │                                  │
│  ┌────┴───────────────┴───────┐  ┌──────────────────┐   │
│  │     SQLite Database        │  │  YouTube Service  │   │
│  │  db.sqlite3                │  │  (youtube_service │   │
│  └────────────────────────────┘  │   .py)            │   │
│                                  └────────┬──────────┘   │
└───────────────────────────────────────────┴──────────────┘
                                            │
                    ┌───────────────────────┐│┌────────────────┐
                    │ YouTube Data API v3   │││ YouTube         │
                    │ (subscriptions,       │││ InnerTube API   │
                    │  channels, playlists, │││ (FEchannels,    │
                    │  playlistItems,       │││  channel browse)│
                    │  videos)              │││                 │
                    └───────────────────────┘│└────────────────┘
                                            │
                    ┌───────────────────────┐│┌────────────────┐
                    │ YouTube Lounge API    │││ Google Gemini   │
                    │ (Cast playback via    │││ API (category   │
                    │  lounge/pairing/bind) │││  suggestions)   │
                    └───────────────────────┘│└────────────────┘
                                            │
                    ┌───────────────────────┐│
                    │ Google Cast SDK       ││
                    │ (browser-side, for    ││
                    │  device discovery +   ││
                    │  MDX screen ID)       ││
                    └───────────────────────┘│
```

## 3. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Backend Framework** | Django | ≥ 5.0 |
| **REST API** | Django REST Framework (DRF) | ≥ 3.15 |
| **ORM** | Django ORM | (built-in) |
| **Database** | SQLite | (bundled) |
| **CORS** | django-cors-headers | ≥ 4.0 |
| **Background Tasks** | Threading / Celery (optional) | — |
| **YouTube API Client** | google-api-python-client | ≥ 2.170 |
| **OAuth** | google-auth-oauthlib | ≥ 1.2 |
| **HTTP Client** | requests | ≥ 2.32 |
| **Browser Automation** | Playwright | ≥ 1.40 |
| **Frontend Framework** | React | ≥ 18 |
| **Frontend Build** | Vite | ≥ 5 |
| **Frontend Language** | TypeScript | ≥ 5 |
| **State Management** | React Context + useReducer | (built-in) |
| **HTTP Client (FE)** | axios | ≥ 1.6 |
| **CSS Framework** | Bootstrap 5 | 5.3 (npm) |
| **Icons** | @mui/icons-material | ≥ 5 |
| **Drag-and-Drop** | @dnd-kit/core + @dnd-kit/sortable | ≥ 6 |
| **Cast SDK** | Google Cast Sender | v1 (CDN) |
| **AI Suggestions** | Google Gemini 1.5 Flash | REST API |

## 4. Key Architecture Decisions

### 4.1 Django App Structure
The backend is organized as a Django project (`config/`) with a single `subscriptions` app containing models, serializers, views, and URL routing. Django REST Framework provides ViewSets and Serializers for clean API implementation.

### 4.2 React SPA with Vite + TypeScript
The frontend is a standalone React app in the `frontend/` directory built with Vite and TypeScript. During development, Vite's dev server proxies API requests to Django. In production, the React build output is served by Django as static files. Components are organized by feature section with shared custom hooks and a centralized API client.

### 4.3 Django REST Framework Serializers
All API responses are serialized through DRF serializers, providing automatic validation, nested serialization, and consistent JSON output. `ModelSerializer` handles CRUD, with custom serializers for complex nested data.

### 4.4 Background Sync with Threading (or Celery)
Video synchronization runs in a daemon thread with an internal `ThreadPoolExecutor(max_workers=3)` for parallel YouTube API calls. A module-level dict (protected by `threading.Lock`) tracks progress and is polled by the frontend. For production, Celery with Redis can replace threading.

### 4.5 Three-Tier YouTube API Strategy

The backend uses three separate YouTube API clients, each with a different authentication mechanism:

| Client | Class | Auth Method | Purpose |
|--------|-------|-------------|----------|
| **YouTube Data API v3** | `YouTubePublicAPI` | OAuth 2.0 (user consent) | Primary: subscriptions, channels, playlists, videos |
| **InnerTube API** | `YouTubeInnerTubeAPI` | OAuth Bearer token (TVHTML5 client) | Fallback: supplemental subscriptions (FEchannels), per-channel watch progress (channel browse), Lounge/Cast API |
| **Cookie-based API** | `YouTubeCookieAPI` | SAPISIDHASH (browser session cookies via Chrome extension) | Last resort: mark-as-watched (requires browser-session auth that only works with cookies, not OAuth) |

These are composed behind a `YouTubeService` facade that preserves a single interface for all callers.

**Why three clients?**
- YouTube's Data API v3 doesn't expose watch history or mark-as-watched functionality
- InnerTube's TVHTML5 client works with OAuth for reading data (FEchannels, channel browse for progress) but its tracking pings don't record to youtube.com watch history
- Only cookie-based authentication (SAPISIDHASH from browser session) can mark videos as watched on youtube.com — cookies are obtained via a companion Chrome extension

### 4.6 Local Thumbnail Caching
All video and channel thumbnails are downloaded and cached to `media/thumbnails/`. Served via Django's `MEDIA_URL` configuration. Provides faster load times, offline access, and avoids external image hotlinking.

### 4.7 PocketTube Import/Export Compatibility
The category import/export format is fully compatible with the YouTube Subscription Manager (PocketTube) browser extension, allowing bidirectional data migration. The parts of the PocketTube format that are not used by this app are persisted during import and re-used during export. Preserved metadata is merged key-wise on each import, so a partial upload never destroys keys it does not carry.

Import runs in one of two modes, selected by a `mode` form field:
- **`replace` (default)** — every `Category` and `SubscriptionCategory` is deleted and rebuilt from the payload, so the app mirrors PocketTube exactly. Categories and assignments removed in PocketTube disappear here too.
- **`additive`** — creates only; nothing is ever deleted.

Replace deliberately never touches `Subscription`, `Video`, `QueueItem` or `Feed` rows. `Video.channel` and `QueueItem.video` cascade from `Subscription`, so pruning subscriptions absent from a backup would silently destroy thousands of synced videos that the payload cannot restore. Because rebuilding categories assigns new primary keys, `Feed.filter_category_ids` is remapped old-id → name → new-id (supporting both a flat id list and the nested AND-of-OR form), dropping ids whose category no longer exists. A SQLite snapshot is written to `data/db-backups/` before every replace, keeping the newest five, and the whole delete-and-rebuild runs in a single transaction.

### 4.8 PocketTube Direct Sync (Chrome Extension)
Beyond manual file import, the companion Chrome extension pulls the categorization straight from PocketTube, with no file handling. Two sources are supported and are kept **fully detached** — choosing one never silently falls back to the other:

| Source | Reads | Needs |
|---|---|---|
| **Live** (default) | YSM's current `chrome.storage`, via the youtube.com page bus | An open (or briefly opened) youtube.com tab |
| **Cloud backup** | A snapshot from PocketTube's own backup service | A Patreon/Paddle credential and a paid plan |

Live is current and free; the cloud backup is up to a day stale but works without a YouTube tab and can restore an older state. A live failure reports the reason and offers an explicit button to try the cloud source — it never switches by itself.

Every successful cloud preview labels its first choice as the newest **cloud snapshot**, states that snapshots are scheduled and may be up to a day old, and offers **Use current live data**. Choosing it discards the cloud preview token, persists the Live source and performs a new Live preview; it never imports or switches sources without that explicit action.

**PocketTube is two separate extensions.** This distinction is the single most important fact here — conflating them cost a long misdiagnosis:

| Product | Extension ID | Backup `version` | Holds |
|---|---|---|---|
| PocketTube: Youtube **Subscription** Manager (YSM) | `kdmnjgijlmjgmimahnillepgcgeemffb` | `subscriptions` | **The subscription categories** — this is the one we want |
| PocketTube: Youtube **PlayList** Manager (YPM) | `bplnofkhjdphoihfkfcddikgmecfehdd` | `playlists` | Playlist groups only |

Both are installed side by side, share the vendor's `p.yousub.info` backup service, and use the same Patreon/Paddle credential — but the `version` form field partitions the backup sets. Querying with `playlists` returns the playlist manager's data (a few hundred bytes for a user whose real dataset is 700 KB of subscriptions), which is easy to mistake for "the backup is empty".

**Routes that are closed** (each verified against the installed sources, not assumed):
- **Google Drive** — PocketTube's "Sync data with Google Drive" writes to the `drive.appdata` folder of its own OAuth client. That folder is readable only by the client that wrote it, with any scope. The only theoretical way in is YSM's stored `ysc_token_google`, i.e. presenting PocketTube's Google credential as PocketTube — deliberately not done. Drive is a transport for the same `chrome.storage` the live source already reads, so it carries no data the live source lacks.
- **Cross-extension messaging** — neither declares `externally_connectable`. YPM's `onMessageExternal` allow-lists three specific extension IDs for one unrelated command; YSM's requires `sender.origin === "https://pockettube.io"`, which no extension can present.
- **`chrome.storage`** — isolated per extension.
- **Scripting PocketTube's own UI** — its export button lives on a `chrome-extension://` page; no extension can inject into another extension's pages, and a cross-origin iframe cannot be scripted or clicked.

**Live source — YSM's page message bus.** A content script on `https://*.youtube.com/*` posts `{ type: 'get_channel_data' }` at `location.origin`; YSM's own content script answers with its live data. **Only this read-only type is ever sent** — `add_group`, `remove_group`, `update_group`, `update_tree`, `set_groups_channels`, `remove_channels`, `share_group`, `mark_watched` and `ysm_unsubscribe` all mutate PocketTube.

```
reply : { channelList, groupTree, settings, metaList, finish, selectedGroups, unSelectedGroups, videoTypes }
groupTree : ARRAY of { titleGroup, channelsList, child, newVideoInGroup, countSubInGroup, positionGroup }
channelsList entry : { channelId, title, img, newVideoCount, subscriberCount, styleCount, position }
channelList : { "<UC…>": { img, title, count } }   ← CHANNEL metadata
metaList    : { "<category name>": { img, position } }  ← GROUP metadata, NOT channel metadata
settings.sub_groups : { parent: { child: {} } }
```

`finish` is `false` and is **not** a completion signal. `metaList` is keyed by category name — feeding it into channel metadata is a bug. `settings` carries `patreon` and `yu`, so only `sub_groups` is extracted from it. The transform flattens this into the same storage-dump shape the cloud source yields, so both converge on one preview/confirm/import path.

**Cloud source — PocketTube's backup service (paid feature):**

```
POST https://p.yousub.info/backup/list      version=subscriptions, type=patreon, access_token=<token>
                                            (or type=paddle, email=<…>, repeated t[]=<token>)  → { keys: [unix ts, …] }
POST https://p.yousub.info/backup/download  … + id=<chosen key>                                → { data: "<JSON string>" }
```

A backup is created from `chrome.storage.get(null)`, so `data` has the PocketTube storage-dump shape that `POST /api/categories/import/` consumes. Before preview and upload, the worker removes secrets and the exact malformed category entry `https://www.youtube.com/`; no new backend endpoint is needed. The flow is: read credentials → list → let the user pick a backup (newest preselected) → download → sanitize → validate → preview → explicit confirm → POST as multipart.

The credential lives in YSM's own `chrome.storage.local` under `ysc_settings.patreon` (a JSON **string** containing `access_token`) or `ysc_settings.yu` (`email` + `tokens[]`) — not as top-level storage keys.

**Trust model:**
- The credential is stored in `chrome.storage.local` and the API host is a hardcoded constant, so it can only ever be transmitted to `p.yousub.info`.
- The dump comes *back* carrying PocketTube's own secrets, so `patreon`, `yu`, `ysc_token_google` and nested `token`/`secret`/`auth`/`credential`/`password`/`session` fields are silently stripped before anything is sent to the app. Category and channel names are dynamic data keys and remain intact even when their text resembles a credential field.
- The exact malformed value `https://www.youtube.com/` is removed only from recognized category arrays, including chunks; similarly shaped values and non-category arrays are preserved. The raw downloaded object is never mutated.
- The user always sees a preview (backup timestamp, category/channel/assignment counts, first category names and removal forecast) and must explicitly confirm. The confirmed payload is cached under a one-shot token, so the committed bytes are exactly the previewed bytes.
- Switching between Cloud and Live always invalidates the previous one-shot token. Late preview responses are ignored, so an older cloud request cannot overwrite or commit a newer Live preview.
- The destination origin is allow-listed against loopback and Codespaces hosts and re-checked at commit time.
- Diagnostic logs are redacted and emitted as text (a structure summary plus JSON), never as objects — console copy renders a logged object as `[object Object]`.

> The cloud API is undocumented and gated behind PocketTube's paid plan. HTTP 402 is reported as "needs an active paid plan", 401/403 as expired credentials.

## 5. Project File Structure

```
youtube-subscriptions/
├── manage.py                    # Django management script
├── requirements.txt             # Python dependencies
├── client_secret.json           # Google OAuth client credentials (not committed)
├── token.json                   # Cached OAuth token (auto-generated)
├── gemini_api_key.txt           # Gemini API key for AI suggestions (optional)
├── config/                      # Django project settings
│   ├── __init__.py
│   ├── settings.py              # Django settings (DB, CORS, DRF config)
│   ├── urls.py                  # Root URL configuration
│   └── wsgi.py
├── subscriptions/               # Django app
│   ├── __init__.py
│   ├── models.py                # Django models: Category, Subscription, Video, Feed, QueueItem
│   ├── serializers.py           # DRF serializers for all models
│   ├── views.py                 # DRF ViewSets and APIViews
│   ├── urls.py                  # App-level URL routing
│   ├── admin.py                 # Django admin registration
│   ├── youtube_service.py       # YouTube API clients (3 tiers + facade)
│   ├── sync.py                  # Background sync logic
│   ├── suggestions.py           # AI suggestion logic (Gemini + heuristic)
│   └── migrations/              # Django auto-generated migrations
│   └── management/
│       └── commands/
│           └── youtube_login.py # Extension install instructions
├── extension/                   # Chrome extension companion
│   ├── manifest.json            # MV3 manifest (cookies, contextMenus, storage)
│   ├── background.js            # Cookie reads; PocketTube live + cloud-backup sync
│   ├── content.js               # Bridges web app ↔ extension via postMessage
│   ├── pockettube-bridge.js     # youtube.com content script; asks YSM for live data
│   ├── pockettube-live.js       # Live reply → PocketTube storage-dump format
│   ├── popup.html               # Toolbar popup UI (a run only, no settings)
│   ├── popup.js                 # Popup logic: auto-preview on open, one-click commit
│   ├── options.html             # Options page UI (open_in_tab)
│   └── options.js               # Settings: app origin, credentials, source, mode
│   └── tests/harness.mjs        # Stubbed chrome/fetch tests (node, no deps)
├── data/                        # App state (never served)
│   └── pockettube_metadata.json # Preserved PocketTube keys for export round-trip
├── scripts/                     # Developer tooling
│   └── chrome_extension.py      # Detects a stale registered service worker
├── frontend/                    # React SPA (Vite + TypeScript)
│   ├── package.json
│   ├── vite.config.ts
│   ├── vitest.config.ts         # Unit tests; excludes e2e/ so Playwright specs aren't collected
│   ├── playwright.config.ts     # E2E; reuses the running Vite/Django dev servers
│   ├── tsconfig.json
│   ├── index.html
│   ├── e2e/                     # Playwright specs + helpers (type-checked via tsconfig.node.json)
│   └── src/
│       ├── main.tsx             # React entry point
│       ├── App.tsx              # Root component with section routing
│       ├── api/
│       │   └── client.ts        # axios instance + typed API functions
│       ├── hooks/               # Custom React hooks per feature
│       │   ├── useCategories.ts
│       │   ├── useSubscriptions.ts
│       │   ├── useFeeds.ts
│       │   ├── useQueue.ts
│       │   ├── usePlaylists.ts
│       │   ├── useSync.ts
│       │   └── useCast.ts
│       ├── components/          # React components by section
│       │   ├── layout/          # Navbar, Spinner, Toast, ConfirmDialog
│       │   ├── feeds/           # FeedsSection, FeedColumn, FeedModal, VideoItem
│       │   ├── subscriptions/   # SubscriptionsSection, CategoryTree, SubscriptionList
│       │   ├── playlists/       # PlaylistsSection, PlaylistColumn, AddToPlaylistModal
│       │   └── queue/           # QueueColumn, QueueItem
│       ├── context/
│       │   └── AppContext.tsx    # Global state provider (categories, sync, etc.)
│       ├── types/
│       │   └── index.ts         # TypeScript interfaces for all entities
│       └── styles/
│           └── app.css          # Global CSS (Bootstrap overrides + custom)
├── media/                       # Cached files (thumbnails, sessions)
│   ├── thumbnails/
│   ├── browser_state.json       # YouTube session cookies (from extension, auto-generated)
│   └── lounge_session.json      # Cast lounge session (auto-generated)
└── db.sqlite3                   # SQLite database (auto-created)
```

## 6. Authentication Flows

The application uses two separate authentication mechanisms:

### 6.1 Google OAuth 2.0 (for YouTube Data API + InnerTube)

```
User clicks Sync → Backend checks token.json
                       ↓
               token.json exists?
              ┌──── Yes ────┐
              ↓              ↓
       Load credentials    No → client_secret.json exists?
              ↓                    ↓ Yes
       Credentials valid?      Auto-start OAuth flow:
              ↓                 1. Generate auth URL
       Yes → Use               2. Start callback server on port 8085
              ↓                 3. Frontend opens auth URL in new tab
       No (expired) →          4. User signs in, Google redirects
       Refresh token              to localhost:8085
              ↓                 5. Backend captures token, saves
       Refresh failed?             token.json
              ↓ Yes             6. Frontend auto-starts sync
       Delete token.json
       Auto-start OAuth flow
```

**OAuth flow implementation details:**
- Backend uses `InstalledAppFlow` from `google-auth-oauthlib`
- Auth URL is generated with `flow.authorization_url(prompt='consent')`
- A custom `http.server.HTTPServer` on port 8085 handles the callback
- `OAUTHLIB_INSECURE_TRANSPORT=1` is set to allow `http://localhost` callback
- The callback handler loops until it receives a request with `?code=` or `?error=`
- Frontend polls `GET /api/auth/oauth/` every 2s to detect completion
- On completion, frontend automatically triggers sync

**API endpoints:**
- `GET /api/auth/oauth/` — status: `{authenticated, in_progress, auth_url, error}`
- `POST /api/auth/oauth/` — start OAuth flow, returns auth URL
- `DELETE /api/auth/oauth/` — delete token.json

### 6.2 YouTube Browser Session (for mark-as-watched via Chrome Extension)

YouTube's watch history recording requires browser session cookies (SAPISIDHASH), not OAuth tokens. A companion Chrome extension provides these cookies.

**Session setup flow:**
1. User installs the "YouTube Subscriptions Helper" Chrome extension (`extension/` directory)
2. User is signed in to YouTube in Chrome
3. When user clicks mark-as-watched, the app detects no session exists
4. Frontend sends `YT_SUBS_GET_COOKIES` message to the page
5. Extension's content script relays to background script
6. Background script reads YouTube cookies via `chrome.cookies.getAll()`
7. Content script posts cookies back to the page
8. Frontend POSTs cookies to `POST /api/auth/youtube-session/cookies/`
9. Backend saves as `media/browser_state.json` (Playwright storage state format)
10. Frontend retries mark-as-watched — now succeeds

**Mark-as-watched flow (after session setup):**
```
User clicks mark-as-watched
    ↓
YouTubeCookieAPI.report_watch(video_id)
    ↓
browser_state.json exists?
    ↓ Yes                        ↓ No
Launch headless Playwright    Return False (frontend
with saved session cookies    triggers extension flow)
    ↓
Navigate to youtube.com/watch?v={id}
    ↓
Extract videostatsPlaybackUrl from
ytInitialPlayerResponse (via page.evaluate)
    ↓
Send tracking ping via fetch() inside
browser context (cookies auto-sent)
    ↓
Save refreshed cookies to browser_state.json
```

**Auto-refresh:** On each `report_watch` call, cookies are saved from the page visit. On failure, `_refresh_session()` headlessly visits youtube.com to refresh cookies and retries once.

**API endpoints:**
- `GET /api/auth/youtube-session/` — status: `{authenticated}`
- `POST /api/auth/youtube-session/cookies/` — import cookies from extension
- `DELETE /api/auth/youtube-session/` — delete browser_state.json

## 7. Concurrency Model

| Component | Threading Strategy |
|-----------|-------------------|
| Django request handlers | WSGI workers (runserver: single-threaded; gunicorn: multi-process) |
| Background sync | Dedicated daemon thread per sync job (or Celery task) |
| YouTube API calls (during sync) | `ThreadPoolExecutor(max_workers=3)` |
| YouTube service instances | Thread-local via `threading.local()` |
| DB writes during sync | Serialized (single thread writes to SQLite) |
| Sync state | Protected by `threading.Lock` (or Django cache/Celery result backend) |
| Lounge session state | File-based persistence in media directory |

## 8. External API Dependencies

| API | Purpose | Auth Method | Client Class |
|-----|---------|-------------|-------------|
| YouTube Data API v3 | Subscriptions, channels, videos, playlists | OAuth 2.0 (user consent) | `YouTubePublicAPI` |
| YouTube InnerTube (TVHTML5) | Supplemental subscriptions (FEchannels), per-channel watch progress (channel browse) | OAuth Bearer token | `YouTubeInnerTubeAPI` |
| YouTube Stats Tracking | Mark video as watched (videostatsPlaybackUrl ping) | Cookie-based (SAPISIDHASH via Chrome extension + Playwright headless) | `YouTubeCookieAPI` |
| YouTube Lounge API | Cast playback control (bind, setPlaylist, nowPlaying) | Lounge token (per screen) | `YouTubeInnerTubeAPI` |
| Google Gemini 1.5 Flash | AI-powered category suggestions | API key (file-based) | `suggestions.py` |

### Why Cookie-Based Auth for Mark-as-Watched?

YouTube's watch history recording is tied to browser-session cookies (SAPISIDHASH), not OAuth tokens. This is a platform limitation:

- **Data API v3**: No endpoint to mark videos as watched (History playlist `HL` is read-only)
- **InnerTube stats tracking with OAuth**: Pings return 200/204 but silently don't record to youtube.com history (records to TV-specific bucket only)
- **WEB/ANDROID InnerTube client with OAuth**: Returns 400 on `/player` endpoint
- **Cookie-based tracking**: The only method that works — Chrome extensions (PocketTube, Watchmaker) use the same approach

The `YouTubeCookieAPI` uses Playwright headless browser with saved session state to:
1. Navigate to the watch page (real browser, bypasses bot detection)
2. Extract `videostatsPlaybackUrl` from embedded `ytInitialPlayerResponse`
3. Send tracking ping via `fetch()` inside the browser context (cookies auto-sent same-origin)
