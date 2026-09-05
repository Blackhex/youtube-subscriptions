# User Scenarios & Feature Specification

## Feature Matrix

| Feature | Section | Backend (Django) | Frontend (React) |
|---------|---------|-----------------|-----------------|
| Subscription sync from YouTube | Subscriptions | `SyncAllView`, YouTube Data API v3 + InnerTube | `useSync()` hook, polling UI |
| Hierarchical category management | Subscriptions | `CategoryViewSet` CRUD | `<CategoryTree>` with `@dnd-kit` |
| Category assignment (multi-select) | Subscriptions | Assign/unassign actions on `SubscriptionViewSet` | Checkbox toggle on `<CategoryNode>` |
| AI category suggestions | Subscriptions | Gemini API + heuristic fallback in `suggestions.py` | Highlight + badge via `suggestedCategoryIds` state |
| Subscription search | Subscriptions | Server-side pagination via DRF | Client-side `useMemo` filter |
| PocketTube import/export | Subscriptions | Export/import actions on `CategoryViewSet` | File download/upload handlers |
| PocketTube direct sync | Subscriptions | Reuses `import_categories` action | Chrome extension popup + context menu |
| Customizable video feeds | Feeds | `FeedViewSet` CRUD + filtered video query | `<FeedColumn>` + `<FeedModal>` |
| Video play queue | Feeds | Queue views + Lounge API | `<QueueColumn>` with `@dnd-kit` + `useCast()` |
| Google Cast playback | Feeds | Lounge bind/setPlaylist/nowPlaying | Cast SDK + MDX via `useCast()` hook |
| Mark as watched | Feeds | `MarkWatchedView` + `YouTubeCookieAPI` (Playwright) | Eye icon on `<VideoItem>` |
| OAuth sign-in | All | `OAuthView` + state-bound callback completion | Smart Sync button + extension relay for a remote browser |
| YouTube session (cookies) | Feeds | `YouTubeSessionCookiesView` + Chrome extension | Automatic via mark-as-watched |
| Playlist management | Playlists | YouTube playlist API views | `<PlaylistColumn>` with `@dnd-kit` |
| Thumbnail caching | All | `FileResponse` serving cached thumbnails | `<img>` tags with API proxy URLs |
| Background sync with progress | All | Threading/Celery + status endpoint | `useSync()` polling + spinning icon |
| Unsubscribe from YouTube | Subscriptions | YouTube API delete in `SubscriptionViewSet.destroy()` | `<ConfirmDialog>` + toast |
| Playback progress tracking | Feeds/Queue | InnerTube channel browse (on-demand) | Progress bar overlay on `<VideoItem>` |

---

## Detailed User Scenarios

### Scenario 1: First-Time Setup

**Precondition:** Fresh installation, no database, `client_secret.json` placed in project root.

**Steps:**
1. User runs `python manage.py migrate` then `python manage.py runserver`
2. Django creates SQLite database (`db.sqlite3`) and applies migrations
3. In a separate terminal, user runs `cd frontend && npm install && npm run dev`
4. User opens `http://localhost:8001` (Vite dev server) → React app loads, Feeds section shown (empty)
5. User clicks Sync button (top-right)
6. React calls `POST /api/sync/all/` → Django backend detects no `token.json` → starts OAuth flow
7. Browser opens Google consent screen → user authorizes YouTube access. Extension 2.6 can relay Google's loopback callback to an explicitly configured remote HTTPS or HTTP loopback app origin, including a container forwarded to `http://127.0.0.1:8098`.
8. `token.json` is saved
9. Background sync begins:
   - Phase 1: Fetches all subscriptions via Data API v3 + InnerTube supplement
   - Phase 2: (No feeds configured, so no videos fetched)
10. `useSync()` hook polls `/api/sync/status/` every 2s; Sync icon spins
11. Completion toast: "Sync complete: 1739 subscriptions"
12. User clicks Subscriptions tab → `<SubscriptionsSection>` renders with all channels

**Expected Result:** All YouTube subscriptions are synced and visible.

---

### Scenario 2: Importing Categories from PocketTube

**Precondition:** User has a PocketTube export JSON file.

**Steps:**
1. User navigates to Subscriptions section
2. Clicks Import button (`FileDownload` icon) in `<Navbar>` action buttons
3. Hidden `<input type="file">` triggered, user selects PocketTube JSON file
4. `<ConfirmDialog>` ("Replace Categories") spells out the consequences: every category and assignment is deleted and rebuilt from the file, subscriptions/videos/queue are kept, feed filters are remapped, the database is snapshotted first
5. User confirms
6. React sends `POST /api/categories/import/` with `FormData` carrying `file` and an explicit `mode=replace`
7. Django backend processes file:
   - Snapshots the database into `data/db-backups/`, then deletes every `Category` and `SubscriptionCategory`
   - Creates categories from JSON keys (auto-detects hierarchy from `ysc_settings.sub_groups`)
   - Creates missing subscriptions from `ysc_channel_metadata`
   - Assigns subscriptions to matching categories by channel ID
   - Remaps `Feed.filter_category_ids` old id → name → new id
   - Saves PocketTube metadata (subscriber counts, topics, channel health)
8. Toast: "Import complete — 43 categories and 2325 assignments deleted, 43 categories and 2325 assignments created"
9. `useCategories()` hook refetches → `<CategoryTree>` re-renders with new structure

**Expected Result:** The app's categorization mirrors the file exactly, including hierarchy, assignments, and metadata. Categories that are not in the file are gone.

---

### Scenario 2b: Syncing Categories Directly from PocketTube (Chrome Extension)

**Precondition:** The "YouTube Subscriptions Helper" extension and PocketTube's YouTube Subscription Manager are loaded. Live needs a reachable youtube.com tab and no paid plan; Cloud needs a **paid** PocketTube subscription (Patreon or Paddle), saved credentials and at least one snapshot. No file export is needed.

**Steps:**
1. Once: user reads their PocketTube credentials (PocketTube options page → DevTools → `chrome.storage.local.get(["patreon","yu"], console.log)`) and saves them on the extension's **options page** (popup → "Settings", or chrome://extensions → Details → Extension options), together with the app origin, the import source and the import mode
2. User clicks the extension's toolbar icon (or right-clicks it → "Preview categories from PocketTube backup")
3. The popup **previews automatically as it opens**, using the stored settings — there is no first click
4. Service worker POSTs the credential form to `https://p.yousub.info/backup/list` and picks the newest backup id (ids are unix timestamps)
5. Worker POSTs the same form plus that `id` to `https://p.yousub.info/backup/download` and parses `data` — the full PocketTube storage dump, in the same flat format the backend already imports
6. Worker also `GET`s `{appOrigin}/api/categories/` and compares it with the backup, so the preview can quantify the removals
7. Popup shows the preview: source, the snapshot's date/time, category / channel / assignment counts, the first category names, the removal forecast and any warnings. A cloud run also gets a snapshot picker; changing it re-previews and re-arms the button with the new one-shot token
8. A successful cloud preview labels the first choice "newest cloud snapshot", explains that cloud is scheduled and may be up to a day old, and offers **Use current live data**. That action persists Live, discards the cloud token and performs a fresh Live preview; it does not import
9. The single primary button says what it would do ("Import 48 categories (replace)"). One click commits the previewed payload — unless the preview is destructive or suspicious (`existing.removed > 0`, `existing.ok !== true`, or a zero-assignment / oversized / stale-backup warning), in which case a confirmation panel naming the reason has to be accepted first. The note under the button always says which case applies
10. Worker POSTs the *cached* preview JSON plus an explicit `mode` field as `multipart/form-data` to `POST /api/categories/import/`
11. Popup shows the backend result: mode, deleted categories/assignments, created categories, created subscriptions, assignments added, unmatched channels

**Expected Result:** The app's categorization mirrors the source the user previewed and explicitly imported: current PocketTube state for Live, or the chosen cloud snapshot for Cloud. In additive mode nothing is deleted.

**Failure modes** (each reports a specific message, never a generic failure):
- No credentials stored, or incomplete → message explains exactly how to extract them
- HTTP 401/403 from the backup API → "credentials rejected or expired, re-extract them"
- No cloud backups on the account, or a non-JSON reply (free plan) → nothing is imported
- Downloaded JSON is not a PocketTube storage dump → refused before any import
- Backup older than 7 days → preview warns, and that warning alone forces the extra confirmation click
- App origin outside the allow-list → refused on the options page as it is typed, and again by the worker before any request
- `GET /api/categories/` unreachable → the preview and the import still work; the preview says the removal count could not be determined instead of implying zero, and that alone forces the extra confirmation click

**Notes:**
- Google Drive is not involved, and neither is PocketTube's youtube.com page message bus — Architecture Overview §4.8 documents why every other route is closed.
- The downloaded dump carries PocketTube's own secrets (`patreon`, `yu`, `ysc_token_google`, nested token-like fields). These are silently stripped before anything is sent to the app; dynamic category/channel names remain intact even when they resemble credential field names.
- PocketTube may leave the exact malformed value `https://www.youtube.com/` in category arrays. The worker removes only that exact entry from recognized categories before counting, previewing or importing it; similarly shaped values and non-category data remain untouched.
- The context-menu entry deliberately runs a **preview only**; because replace mode deletes every category and assignment and the import is irreversible, a right-click cannot commit data. Its result is handed to the popup without a token, so the popup shows it but still re-reads before it sends anything.
- The **live** source is the one that cannot always auto-preview: reading it opens a youtube.com tab when none is open. With no such tab the popup shows a ready state saying so, and the single click does preview-then-commit in one go, still applying the confirmation gate.
- A successful cloud preview never claims to be current PocketTube state. The explicit Live alternative is a preview-only source change, and late responses from the discarded source cannot re-arm its token or overwrite the newer preview.
- The confirm step commits the exact previewed payload via a one-shot token, so what is imported is what was shown.

---

### Scenario 3: Organizing Subscriptions into Categories

**Precondition:** Subscriptions are synced, categories exist.

**Steps:**
1. User navigates to Subscriptions section
2. User clicks a `<SubscriptionItem>` (e.g., "3Blue1Brown") → `dispatch({ type: 'TOGGLE_SELECTION', id })` → item highlighted
3. `<CategoryTree>` re-renders in assignment mode:
   - `<CategoryNode>` shows checkbox instead of expand toggle
   - Selection help banner: "1 subscription selected — Check categories below to assign"
4. User clicks AI Suggestions button (`AutoAwesome`)
5. `useSubscriptions()` calls `GET /api/subscriptions/{id}/suggestions/`
6. Django calls Gemini API with channel title/description + all categories
7. `suggestedCategoryIds` state updated → `<CategoryNode>` renders with `suggested-category` class
8. User clicks "Mathematics" checkbox → `POST /api/subscriptions/{id}/assign/{catId}/`
9. User clicks another subscription (multi-select, shift-click or individual toggle)
10. User clicks "STEM" checkbox → parallel API calls for all selected subscriptions

**Expected Result:** Subscriptions are organized into categories with AI assistance.

---

### Scenario 4: Creating and Using Video Feeds

**Precondition:** Subscriptions organized, videos synced.

**Steps:**
1. User navigates to Feeds section
2. Clicks "New Feed" button (`NoteAdd` icon) → `<FeedModal>` opens
3. React controlled form:
   - Name: "Recent Programming"
   - Categories: Adds AND group via `<CategoryGroupSelector>`, checks "Programming"
   - Video Type: "Regular Videos" (excludes shorts + live)
   - Min Duration: 5 (minutes)
   - Max Age: 14 (days)
   - Play State: "Unplayed" radio button
4. `onSubmit` → `POST /api/feeds/` → modal closes
5. New `<FeedColumn>` appears in Feeds section
6. `<FilterTags>` shows active filters as pills
7. `useFeeds()` hook fetches `GET /api/feeds/{id}/videos/` → `<VideoItem>` list renders with infinite scroll

**Expected Result:** A customized video feed column showing only matching videos.

---

### Scenario 5: Building and Casting a Play Queue

**Precondition:** Feeds with videos exist, Google Cast device on network.

**Steps:**
1. User browses feed videos in `<FeedColumn>`
2. Clicks `PlaylistAdd` button on a `<VideoItem>` → `useQueue().addToQueue(videoId)` → toast: "Video added to queue"
3. Repeats for several videos
4. `<QueueColumn>` renders added `<QueueItem>` components with `@dnd-kit` drag handles
5. User drags items to reorder → `onDragEnd` → `POST /api/queue/reorder/`
6. User clicks Cast button in `<QueueColumn>` header
7. `useCast().castQueue()`:
   - `initializeCastFramework()` (idempotent)
   - `requestCastSession()` → browser shows Cast device picker
   - `getYouTubeScreenId(session)` → MDX status message
   - `POST /api/queue/cast/` with `screen_id`
8. Django backend: Lounge API sequence (token → bind → setPlaylist)
9. TV starts playing first video
10. `useSync()` starts 10-second polling (`POST /api/queue/refresh-progress/`)
11. As videos are watched, `queueItems` state updates → `<QueueItem>` components unmount
12. Toast: "Queue playback completed" when queue is empty

**Alternative path:** "Create YouTube playlist" button → `POST /api/queue/create-playlist/` → opens playlist URL in new tab.

**Expected Result:** Videos play on Cast device with automatic queue management.

---

### Scenario 6: Managing YouTube Playlists

**Precondition:** User has YouTube playlists.

**Steps:**
1. User clicks Playlists tab → `<PlaylistsSection>` mounts
2. `usePlaylists()` fetches `GET /api/playlists/` → `<PlaylistColumn>` per playlist
3. Each column shows: title, item count, privacy status via header props
4. `<VideoItem>` components with infinite scroll (20 per page)
5. User drags items to reorder → `@dnd-kit` `onDragEnd` → `POST /api/playlists/{id}/items/reorder/`
6. User clicks remove (`Close` icon) on item → `DELETE /api/playlists/{id}/items/{itemId}/` → re-render
7. User clicks Cast button → `useCast()` → `POST /api/playlists/{id}/cast/`
8. User clicks Delete (`Delete` icon) → `<ConfirmDialog>` → `DELETE /api/playlists/{id}/` → column removed

**Expected Result:** Full CRUD operations on YouTube playlists.

---

### Scenario 7: Adding Feed Videos to Playlists

**Precondition:** Feeds with videos, at least one YouTube playlist.

**Steps:**
1. User browsing feed videos in `<FeedColumn>`
2. Hover reveals `PlaylistAddCheck` button on `<VideoItem>`
3. User clicks → `<AddToPlaylistModal>` opens
4. Modal shows: video title, `<select>` dropdown of all owned playlists (fetched via `usePlaylists()`)
5. User selects target playlist → clicks "Add"
6. `POST /api/playlists/{playlistId}/items/` with `{ video_id }`
7. Modal closes, toast: "Added to [playlist name]"

**Expected Result:** Video added to selected YouTube playlist.

---

### Scenario 8: Background Sync with Progress Tracking

**Precondition:** Application configured with subscriptions.

**Steps:**
1. User clicks Sync button → `useSync().startFullSync()`
2. `POST /api/sync/all/` returns 202 → `useSync()` begins polling
3. Django starts 2-phase sync in background thread:
   - **Phase 1 (Subscriptions)**: Data API v3 + InnerTube. Upserts all subscriptions.
   - **Phase 2 (Videos)**: `ThreadPoolExecutor(3)` fetches uploads for channels used in feeds.
     - Skips channels synced within 15 minutes (staleness check)
     - Incremental: only fetches videos newer than last stored video
     - Bulk-fetches video details (duration/type) and watch progress
4. `useSync()` polls `GET /api/sync/status/` every 2 seconds → `syncState` updates
5. `<Navbar>` Sync button has `spin-icon` class while `syncState.running`
6. When complete, toast: "Sync complete: 1739 subscriptions, 15 new videos"
7. `useFeeds()` refetches feed videos if new videos found

**Expected Result:** All data synced efficiently with minimal API calls.

---

### Scenario 9: Category Tree Management

**Steps:**
1. **Create**: Click "New Category" → `<CategoryModal>` → fill name/description/parent → Save → `POST /api/categories/`
2. **Edit**: Click `Edit` icon on `<CategoryNode>` → `<CategoryModal>` pre-filled → Save → `PUT /api/categories/{id}/`
3. **Delete**: Click `Delete` icon → `<ConfirmDialog>` → `DELETE /api/categories/{id}/` → cascade deletes children
4. **Reorder**: Drag `<CategoryNode>` via `@dnd-kit` → `onDragEnd` → `POST /api/categories/reorder/`
5. **Nest**: Drag category sideways (detected via pointer position) to nest under target
6. **Collapse/Expand**: Click `ExpandMore` icon → local `collapsedIds` state toggle
7. **Filter subscriptions**: Click category name → `dispatch({ type: 'SELECT_CATEGORY', id })`

**Expected Result:** Full hierarchical category management with drag-and-drop.

---

### Scenario 10: Exporting Categories for Backup

**Steps:**
1. User clicks Export button (`FileDownload` icon) in `<Navbar>`
2. React fetches `GET /api/categories/export/` as blob
3. Django generates comprehensive JSON (PocketTube format)
4. Browser downloads `categories_export_YYYY-MM-DD-HH_MM.json` via `URL.createObjectURL`

**Expected Result:** Complete backup in PocketTube-compatible format.

---

### Scenario 11: Searching and Filtering Subscriptions

**Steps:**
1. User types in Search `<input>` → `setSearchQuery(value)`
2. `useMemo` filters `allSubscriptions` by title/description
3. Infinite scroll pagination disabled during search
4. User clears search → full list restored with pagination

**Expected Result:** Instant client-side filtering of subscription list.

---

### Scenario 12: Unsubscribing from a Channel

**Steps:**
1. User hovers over `<SubscriptionItem>` → `Delete` button appears (CSS `btn-action-reveal`)
2. User clicks → `<ConfirmDialog>`: "Are you sure you want to unsubscribe from [channel]?"
3. `DELETE /api/subscriptions/{id}/` → Django attempts YouTube unsubscribe, then deletes locally
4. `allSubscriptions` state updated → `<SubscriptionItem>` unmounted
5. Toast with result message

**Expected Result:** Channel removed from YouTube and local database.

---

### Scenario 13: Playback Progress Tracking

**How it works:**
1. When feed videos are loaded (`GET /api/feeds/{id}/videos/`), the backend fetches watch progress **on-demand** from YouTube
2. For each unique channel on the current page, calls InnerTube channel browse (`/browse` with `browseId: {channelId}`, Videos tab)
3. Extracts `percentDurationWatched` from TVHTML5 tile renderer overlays for all videos on that channel
4. Updates `playback_progress` (0-100) on Video records in DB
5. Videos not appearing in the channel browse response have their progress reset to `None` (YouTube is the source of truth)
6. React `<VideoItem>` renders:
   - Red progress bar at bottom of thumbnail (`<div className="progress-bar-fill" style={{ width: `${progress}%` }}>`)
   - `.watched` class (50% opacity) for videos ≥95% progress
7. "Unplayed" feed filter: Django filters `Video.objects.filter(Q(playback_progress__isnull=True) | Q(playback_progress__lt=95))`
8. "Played" feed filter: `Video.objects.filter(playback_progress__gte=95)`

**Why channel browse instead of FEhistory?**
- FEhistory (`/browse` with `browseId: FEhistory`) only returns the ~15 most recent videos — too limited
- Channel browse returns ALL videos for a channel with their full progress — much more accurate
- Progress is fetched on-demand (only for displayed videos), not during sync — more efficient

**Mark as Watched (manual):**
1. User clicks the eye icon on a `<VideoItem>` → `POST /api/videos/{id}/mark-watched/`
2. Backend sets `playback_progress=100` and `watched_locally=True` (optimistic local state)
3. Backend attempts YouTube propagation via `YouTubeCookieAPI.report_watch()`:
   - Launches headless Playwright with saved YouTube session
   - Navigates to watch page, extracts tracking URL, sends ping via `fetch()` in browser context
   - On failure, tries session refresh and retries once
4. On next feed load, channel browse is checked — if the video appears watched on YouTube, progress is preserved; if not, the locally-set progress is reset (YouTube is source of truth)

**YouTube session requirement:**
- Mark-as-watched YouTube propagation requires a browser session (`media/browser_state.json`)
- Session cookies are provided by the "YouTube Subscriptions Helper" Chrome extension
- First mark-as-watched auto-triggers extension cookie sync: frontend sends `YT_SUBS_GET_COOKIES` message, extension reads YouTube cookies, POSTs to `/api/auth/youtube-session/cookies/`, then retries
- Session cookies auto-refresh on each `report_watch` call (Playwright headless visits save updated cookies)
- Without the extension, mark-as-watched shows "Install the YouTube Subscriptions Helper extension"

---

### Scenario 14: OAuth Sign-In Flow

**Precondition:** `client_secret.json` exists, `token.json` does not (first use or token deleted). If the listener is unreachable from the browser, extension 2.6 is loaded and explicitly configured with the app's remote HTTPS or HTTP loopback origin (`localhost` or `127.0.0.1`, including custom ports).

**Steps:**
1. User clicks Sync button in Navbar
2. Backend detects missing OAuth credentials, auto-starts OAuth flow in background
3. Sync fails with error toast
4. Frontend detects OAuth `in_progress` with `auth_url` → auto-opens Google sign-in in new tab
5. User signs in to Google, approves YouTube access
6. Google redirects to the Desktop client's exact `http://localhost:8085/` callback
7. With a supported origin explicitly saved, the extension validates and scrubs the callback tab, then relays the callback to `POST /api/auth/oauth/callback/` on that exact origin. Without relay configuration, the direct listener must be reachable. If both paths receive the callback, backend single-use completion prevents duplicate token exchange.
8. Backend validates state against the original in-memory Flow, exchanges the code and atomically saves `token.json`
9. Frontend polls `GET /api/auth/oauth/` → detects `authenticated=true`
10. Frontend auto-starts sync

**Token expiry:**
- Token auto-refreshes via `creds.refresh()` on each use
- If refresh fails, `token.json` is deleted and the OAuth flow restarts automatically on next sync
- Logout invalidates the active Flow and deletes the token under one lock; a concurrent callback or refresh cannot recreate it
- User sees the sign-in tab open again

**Remote constraints:**
- The app origin must be explicitly saved and have Chrome host permission. Remote hosts require HTTPS; HTTP is allowed only for exact `localhost` or `127.0.0.1` hosts. A loopback app port can forward to a container without exposing container port 8085. See the [extension reload guide](../extension/README.md).
- Start and callback must reach the same Django process. Restarting the process cancels the pending sign-in.
- This sign-in authorizes the server's YouTube account. It does not authenticate app/API users.

**Expected Result:** Seamless OAuth flow integrated into the sync button — no separate auth UI needed.

---

### Scenario 15: Sidebar Resize

**Steps:**
1. User hovers over `<SidebarResizer>` between `<CategoryTree>` and `<SubscriptionList>`
2. Cursor changes to `col-resize`
3. User drags to resize sidebar (120px min, 50% max) — handled via `onMouseDown` + `onMouseMove` + `onMouseUp`
4. Width persisted to `localStorage` key `categoriesSidebarWidth`
5. On mount, `<SubscriptionsSection>` reads saved width from `localStorage`

**Expected Result:** User can customize sidebar width, persisted across sessions.
