# API Reference

## Base URL
All endpoints are prefixed with `/api/`.

## Implementation
All endpoints are implemented using **Django REST Framework** (DRF). ViewSets handle standard CRUD operations; custom `@action` decorators and `APIView` subclasses handle non-CRUD actions (sync, reorder, cast, etc.).

## Authentication
All YouTube operations require OAuth 2.0 credentials. The server manages credentials via `client_secret.json` and `token.json` files. No API authentication is required for the local API itself (DRF's `AllowAny` permission).

Mark-as-watched additionally requires a YouTube browser session (cookie-based auth via Playwright), managed via the YouTube Session endpoints.

---

## OAuth Endpoints

### `GET /api/auth/oauth/`
Check Google OAuth authentication status.

**View:** `OAuthView(APIView)`

**Response (200):**
```json
{
  "authenticated": true,
  "in_progress": false,
  "auth_url": null,
  "error": null
}
```

### `POST /api/auth/oauth/`
Start Google OAuth flow. Backend starts a callback listener on port 8085 and returns the auth URL for the frontend to open in a new tab.

**Response (200):**
```json
{
  "status": "started",
  "auth_url": "https://accounts.google.com/o/oauth2/auth?...",
  "authenticated": false,
  "in_progress": true,
  "error": null
}
```

**Status values:** `started`, `already_authenticated`, `already_in_progress`

**Flow:**
1. Backend generates auth URL with `InstalledAppFlow.authorization_url()`
2. Starts `HTTPServer` on port 8085 waiting for Google's callback
3. Frontend opens `auth_url` in new tab → user signs in → Google redirects to `localhost:8085`
4. Backend captures auth code, exchanges for token, saves `token.json`
5. Frontend polls `GET /api/auth/oauth/` until `authenticated=true`

### `DELETE /api/auth/oauth/`
Delete OAuth token (logout).

**Response (200):**
```json
{
  "status": "ok",
  "authenticated": false,
  "in_progress": false,
  "auth_url": null,
  "error": null
}
```

---

## YouTube Session Endpoints

Manage the YouTube browser session used for cookie-authenticated operations (mark-as-watched). Cookies are provided by the companion Chrome extension.

### `GET /api/auth/youtube-session/`
Check YouTube browser session status.

**View:** `YouTubeSessionView(APIView)`

**Response (200):**
```json
{
  "authenticated": true
}
```

### `POST /api/auth/youtube-session/cookies/`
Import YouTube cookies from the Chrome extension to create a browser session.

**View:** `YouTubeSessionCookiesView(APIView)`

**Request Body (JSON):**
```json
{
  "cookies": [
    { "name": "SAPISID", "value": "...", "domain": ".youtube.com", "path": "/", "expires": -1, "httpOnly": false, "secure": false, "sameSite": "Lax" },
    { "name": "__Secure-3PAPISID", "value": "...", "domain": ".youtube.com", "path": "/", "expires": -1, "httpOnly": true, "secure": true, "sameSite": "None" }
  ]
}
```

**Response (200):**
```json
{
  "status": "ok",
  "authenticated": true
}
```

**Error (400):** Missing `cookies` array or no SAPISID cookie found.

### `DELETE /api/auth/youtube-session/`
Delete YouTube browser session.

**Response (200):**
```json
{
  "status": "ok",
  "authenticated": false
}
```

---

## Mark Watched Endpoint

### `POST /api/videos/{video_id}/mark-watched/`
Mark a video as fully watched. Propagates to YouTube first — only sets local `playback_progress=100` if YouTube propagation succeeds.

**View:** `MarkWatchedView(APIView)`

**Response (200) — success:**
```json
{
  "status": "ok",
  "video_id": "68HTfzrC8LM",
  "playback_progress": 100,
  "watched_locally": true,
  "youtube_propagated": true,
  "youtube_session_needed": false
}
```

**Response (200) — no session:**
```json
{
  "status": "not_propagated",
  "video_id": "68HTfzrC8LM",
  "playback_progress": null,
  "youtube_propagated": false,
  "youtube_session_needed": true
}
```
When `youtube_session_needed` is true, the frontend automatically requests cookies from the Chrome extension, imports them via `POST /api/auth/youtube-session/cookies/`, and retries.

**Response (200) — propagation failed:**
```json
{
  "status": "not_propagated",
  "video_id": "68HTfzrC8LM",
  "playback_progress": null,
  "youtube_propagated": false,
  "youtube_session_needed": false
}
```

**YouTube propagation:**
1. `YouTubeCookieAPI.report_watch()` launches headless Playwright with saved session cookies
2. Navigates to the watch page, extracts tracking URL from `ytInitialPlayerResponse`
3. Sends tracking ping via `fetch()` inside browser context
4. On failure, attempts session refresh (headless youtube.com visit) and retries once

**Error (404):** Video not found in local database.

---

## Sync Endpoints

### `POST /api/sync/all/`
Start a full background sync: subscriptions then videos.

**View:** `SyncAllView(APIView)`

**Request Body (JSON, optional):**
```json
{ "force": false }
```
- `force` (bool): Skip staleness check and re-sync all channels

**Response (202):**
```json
{
  "message": "Sync started",
  "state": {
    "running": true,
    "phase": "subscriptions",
    "total": 0,
    "processed": 0,
    "fetched_new": 0,
    "errors": 0,
    "skipped": 0,
    "subs_synced": 0,
    "started_at": "2026-03-29T22:00:00",
    "finished_at": null,
    "current_channel": null
  }
}
```

**Error (409):** Sync already in progress.

**Sync Phases:**
1. **"subscriptions"**: Fetches subscription list via Data API v3 + InnerTube, upserts into DB
2. **"videos"**: Incrementally fetches new uploads for channels referenced by feeds

### `POST /api/sync/videos/`
Start video-only background sync.

**Request Body (JSON, optional):**
```json
{ "force": false, "channel_ids": ["UCxxxxxx"] }
```

**Response (202):** Same as `/sync/all/`

### `GET /api/sync/status/`
Get current background sync progress.

**Response (200):**
```json
{
  "running": false,
  "phase": null,
  "total": 100,
  "processed": 100,
  "fetched_new": 15,
  "errors": 2,
  "skipped": 50,
  "subs_synced": 1739,
  "started_at": "2026-03-29T22:00:00",
  "finished_at": "2026-03-29T22:05:00",
  "current_channel": null
}
```

---

## Category Endpoints

**ViewSet:** `CategoryViewSet(ModelViewSet)`

### `GET /api/categories/`
Get all root-level categories with nested children and global counts.

**Response (200):**
```json
{
  "categories": [
    {
      "id": 1,
      "name": "Programming",
      "description": null,
      "parent_id": null,
      "sort_order": 1,
      "subscription_count": 45,
      "children": [
        { "id": 2, "name": "Python", ... }
      ],
      "created_at": "2026-01-01T00:00:00",
      "updated_at": "2026-01-01T00:00:00"
    }
  ],
  "total_count": 1739,
  "uncategorized_count": 821
}
```

### `GET /api/categories/<category_id>/`
Get a single category with children.

### `POST /api/categories/`
Create a new category.

**Request Body:**
```json
{
  "name": "New Category",
  "description": "Optional description",
  "parent_id": 1
}
```

**Response (201):** Category dict

### `PUT /api/categories/<category_id>/`
Update a category. Supports renaming, re-description, and re-parenting.

**Request Body:** Any subset of `{ "name", "description", "parent_id" }`

**Validation:** Custom `validate()` prevents circular parent-child references by walking the ancestor chain.

### `DELETE /api/categories/<category_id>/`
Delete a category and all its children (cascade via Django's `on_delete=CASCADE`).

**Response (204):** No content

### `POST /api/categories/reorder/`
Persist drag-and-drop order. Custom `@action(detail=False)`.

**Request Body:**
```json
{
  "parent_id": null,
  "ordered_ids": [3, 1, 2]
}
```

### `GET /api/categories/export/`
Export all categories in PocketTube-compatible JSON format. Custom `@action(detail=False)`.

**Response:** JSON file download with headers:
- `Content-Disposition: attachment; filename="categories_export_YYYY-MM-DD-HH_MM.json"`

**Export includes:**
- Category → channel ID mappings (split into 250-item chunks for large categories)
- `channelsHealth`: channel ID → last publish timestamp
- `topicCache`: channel ID → topic list
- `ysc_channel_metadata`: all subscriptions with title/thumbnail/timestamp
- `ysc_collection`, `ysc_meta`, `ysc_settings`, `ysc_subs_count`, `ysc_title_id`

### `POST /api/categories/import/`
Import categories from PocketTube JSON file. Custom `@action(detail=False)`.

**Request:** `multipart/form-data` with `file` field

**Response (200):**
```json
{
  "message": "Import complete",
  "created_categories": 5,
  "created_subscriptions": 120,
  "assignments_added": 850,
  "unmatched_channels": 3
}
```

---

## Subscription Endpoints

**ViewSet:** `SubscriptionViewSet(ModelViewSet)`

### `GET /api/subscriptions/`
Paginated subscription list with optional category filter.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `category_id` | int | - | Filter by category |
| `uncategorized` | "true" | - | Show only uncategorized |
| `page` | int | 1 | Page number |
| `per_page` | int | 50 | Items per page (max 200) |

**Response (200):**
```json
{
  "items": [
    {
      "id": 1,
      "channel_id": "UC...",
      "channel_title": "Channel Name",
      "channel_description": "...",
      "thumbnail_url": "/api/subscriptions/UC.../thumbnail/",
      "subscription_date": "2020-01-01T00:00:00",
      "categories": [{ "id": 1, "name": "Category" }]
    }
  ],
  "total": 1739,
  "page": 1,
  "per_page": 50,
  "has_more": true
}
```

### `GET /api/subscriptions/<sub_id>/`
Get a single subscription with categories.

### `POST /api/subscriptions/sync/`
Synchronous subscription sync from YouTube (legacy). Custom `@action`.

### `POST /api/subscriptions/<sub_id>/assign/<cat_id>/`
Assign a subscription to a category. Custom `@action(detail=True)`.

### `DELETE /api/subscriptions/<sub_id>/unassign/<cat_id>/`
Unassign a subscription from a category. Custom `@action(detail=True)`.

### `DELETE /api/subscriptions/<sub_id>/`
Delete subscription from local DB and unsubscribe from YouTube.

### `GET /api/subscriptions/<sub_id>/suggestions/`
Get AI-powered category suggestions. Custom `@action(detail=True)`.

**Response (200):**
```json
{
  "subscription_id": 42,
  "suggested_category_ids": [3, 7, 12]
}
```

**Strategy:** Tries Gemini API first, falls back to heuristic keyword matching.

### `GET /api/subscriptions/<channel_id>/thumbnail/`
Serve cached channel thumbnail image. Downloads and caches on first request.

---

## Feed Endpoints

**ViewSet:** `FeedViewSet(ModelViewSet)`

### `GET /api/feeds/`
Get all feeds ordered by `sort_order`.

**Response (200):** Array of Feed dicts

### `POST /api/feeds/`
Create a new feed.

**Request Body:**
```json
{
  "name": "Recent Videos",
  "filter_category_ids": [[1, 2], [3]],
  "filter_video_type": "video,live",
  "filter_min_duration": 300,
  "filter_max_duration": 3600,
  "filter_max_age_days": 7,
  "filter_play_state": "unplayed"
}
```

### `PUT /api/feeds/<feed_id>/`
Update a feed's name and filters.

### `DELETE /api/feeds/<feed_id>/`
Delete a feed.

### `GET /api/feeds/<feed_id>/videos/`
Get filtered, paginated videos for a feed. Custom `@action(detail=True)`.

**Query Parameters:** `page` (default 1), `per_page` (default 20, max 100)

**Filter Logic (applied as Django QuerySet chains):**
1. **Categories**: AND of OR groups. Each group requires the video's channel to belong to at least one category in the group (`Q` objects + `Subquery`).
2. **Video type**: Comma-separated multi-select — `.filter(video_type__in=['video', 'live'])`. Valid types: `video`, `short`, `live`, `upcoming`.
3. **Duration**: `.filter(duration_seconds__gte=..., duration_seconds__lte=...)`
4. **Max age**: `.filter(published_at__gte=cutoff)`
5. **Play state**: "played" (≥ 95%), "unplayed" (< 95% or null), "both"
6. **On-demand watch progress**: After pagination, fetches `playback_progress` from YouTube via InnerTube channel browse for each unique channel on the current page. Updates video records in DB before returning.

**Response (200):**
```json
{
  "items": [{ "video_id": "...", "title": "...", ... }],
  "total": 150,
  "page": 1,
  "per_page": 20,
  "has_more": true
}
```

---

## Queue Endpoints

**ViewSet/Views:** `QueueViewSet` or individual `APIView` subclasses

### `GET /api/queue/`
Get current play queue.

### `POST /api/queue/`
Add videos to the queue.

**Request Body:**
```json
{ "video_id": "dQw4w9WgXcQ" }
// or
{ "video_ids": ["id1", "id2"] }
```

**Response (201):** Updated queue with items array, deduplicates existing entries.

### `DELETE /api/queue/<queue_item_id>/`
Remove a queued video.

### `POST /api/queue/reorder/`
Reorder queue items.

**Request Body:**
```json
{ "queue_item_ids": [3, 1, 2] }
```

### `POST /api/queue/clear/`
Clear the entire queue.

### `POST /api/queue/create-playlist/`
Create a YouTube playlist from the queue and clear it.

**Response (201):**
```json
{
  "playlist_id": "PLxxxxx",
  "playlist_url": "https://www.youtube.com/playlist?list=PLxxxxx",
  "playlist_title": "Queue 2026-03-29 22:00",
  "added_count": 5,
  "cleared": true,
  "items": []
}
```

### `POST /api/queue/cast/`
Start Cast playback via YouTube Lounge API.

**Request Body:**
```json
{ "screen_id": "..." }
```

### `POST /api/queue/refresh-progress/`
Refresh queue playback progress. Queries Lounge nowPlaying or YouTube watch history. Auto-removes watched items (≥ 95%).

---

## Playlist Endpoints

**Views:** Individual `APIView` subclasses (data fetched live from YouTube, not stored locally)

### `GET /api/playlists/`
Get all playlists owned by the authenticated user (fetched live from YouTube).

### `GET /api/playlists/<playlist_id>/items/`
Get paginated items for a playlist (fetched live, enriched with local video data).

**Query Parameters:** `page`, `per_page`

### `POST /api/playlists/<playlist_id>/items/`
Add videos to a playlist.

### `POST /api/playlists/<playlist_id>/items/reorder/`
Reorder items in a playlist.

### `DELETE /api/playlists/<playlist_id>/items/<playlist_item_id>/`
Remove an item from a playlist.

### `DELETE /api/playlists/<playlist_id>/`
Delete an entire playlist from YouTube.

### `POST /api/playlists/<playlist_id>/cast/`
Start Cast playback for a playlist.

---

## Video Endpoints

### `GET /api/videos/<video_id>/thumbnail/`
Serve cached video thumbnail. Downloads and caches on first request. Served via Django's `FileResponse`.

### `POST /api/videos/fetch/`
Legacy endpoint: triggers background video sync.

---

## Health Check

### `GET /api/health/`
**Response (200):** `{ "status": "ok" }`

---

## URL Configuration

```python
# config/urls.py
urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('subscriptions.urls')),
]

# subscriptions/urls.py
router = DefaultRouter()
router.register(r'categories', CategoryViewSet)
router.register(r'feeds', FeedViewSet)
router.register(r'subscriptions', SubscriptionViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('sync/all/', SyncAllView.as_view()),
    path('sync/videos/', SyncVideosView.as_view()),
    path('sync/status/', SyncStatusView.as_view()),
    path('queue/', QueueListCreateView.as_view()),
    path('queue/<int:pk>/', QueueDetailView.as_view()),
    path('queue/reorder/', QueueReorderView.as_view()),
    path('queue/clear/', QueueClearView.as_view()),
    path('queue/create-playlist/', QueueCreatePlaylistView.as_view()),
    path('queue/cast/', QueueCastView.as_view()),
    path('queue/refresh-progress/', QueueRefreshProgressView.as_view()),
    path('playlists/', PlaylistListView.as_view()),
    path('playlists/<str:playlist_id>/', PlaylistDetailView.as_view()),
    path('playlists/<str:playlist_id>/items/', PlaylistItemsView.as_view()),
    path('playlists/<str:playlist_id>/items/reorder/', PlaylistItemsReorderView.as_view()),
    path('playlists/<str:playlist_id>/items/<str:item_id>/', PlaylistItemDetailView.as_view()),
    path('playlists/<str:playlist_id>/cast/', PlaylistCastView.as_view()),
    path('videos/<str:video_id>/thumbnail/', VideoThumbnailView.as_view()),
    path('videos/<str:video_id>/mark-watched/', MarkWatchedView.as_view()),
    path('auth/oauth/', OAuthView.as_view()),
    path('auth/youtube-session/', YouTubeSessionView.as_view()),
    path('auth/youtube-session/cookies/', YouTubeSessionCookiesView.as_view()),
    path('health/', HealthCheckView.as_view()),
]
```

## Error Response Format
All errors follow DRF convention:
```json
{ "detail": "Human-readable error message" }
// or for validation errors:
{ "field_name": ["Error message"] }
```
With appropriate HTTP status codes: 400, 404, 409, 500.
