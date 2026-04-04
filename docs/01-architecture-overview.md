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
The category import/export format is fully compatible with the YouTube Subscription Manager (PocketTube) browser extension, allowing bidirectional data migration. The parts of the PocketTube format that are not used by this app are persisted during import and re-used during export.

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
│   ├── manifest.json            # MV3 manifest (cookies permission)
│   ├── background.js            # Reads YouTube cookies via chrome.cookies API
│   └── content.js               # Bridges web app ↔ extension via postMessage
├── frontend/                    # React SPA (Vite + TypeScript)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
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
