# Implementation Plan — Building from Scratch

This document provides a step-by-step implementation plan to rebuild the application using Copilot. Each phase is self-contained and results in a testable milestone.

---

## Phase 0: Project Setup

### 0.1 Initialize Django Project
```bash
mkdir youtube-subscriptions && cd youtube-subscriptions
python -m venv .venv && source .venv/bin/activate
pip install django djangorestframework django-cors-headers google-api-python-client google-auth-oauthlib requests
django-admin startproject config .
python manage.py startapp subscriptions
```

### 0.2 Create `requirements.txt`
```
Django>=5.0
djangorestframework>=3.15
django-cors-headers>=4.0
google-api-python-client>=2.170.0
google-auth-oauthlib>=1.2.0
google-auth-httplib2>=0.2.0
requests>=2.32.3
```

### 0.3 Configure `config/settings.py`
```python
INSTALLED_APPS = [
    ...,
    'rest_framework',
    'corsheaders',
    'subscriptions',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    ...,
]

CORS_ALLOW_ALL_ORIGINS = True  # Local development

REST_FRAMEWORK = {
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.AllowAny'],
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
}

MEDIA_ROOT = BASE_DIR / 'media'
MEDIA_URL = '/media/'
```

### 0.4 Initialize React Frontend
```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install axios bootstrap @mui/icons-material @mui/material @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### 0.5 Configure Vite Proxy (`frontend/vite.config.ts`)
```typescript
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/media': 'http://localhost:8000',
    },
  },
});
```

### 0.6 Google Cloud Setup
1. Create project in Google Cloud Console
2. Enable YouTube Data API v3
3. Create OAuth 2.0 credentials (Desktop application)
4. Download `client_secret.json` to project root
5. (Optional) Create Gemini API key, save to `gemini_api_key.txt`

**Milestone:** Django serves API at `:8000`, Vite dev server at `:8001` with proxy.

---

## Phase 1: Core Backend — Django Models

### 1.1 Create `subscriptions/models.py`
Define all Django models:

1. **`Category`** model:
   - Fields: name (CharField), description (TextField), parent (ForeignKey to self, on_delete=CASCADE), sort_order (IntegerField), created_at (DateTimeField auto_now_add), updated_at (DateTimeField auto_now)
   - `class Meta: ordering = ['sort_order', 'name']`

2. **`Subscription`** model:
   - Fields: subscription_id (CharField unique), channel_id (CharField unique), channel_title, channel_description (TextField), thumbnail_url, thumbnail_path, subscription_date, subscriber_count, topics (JSONField), topic_in_topic_cache (BooleanField), last_published_at, synced_at, videos_synced_at, created_at
   - `categories = ManyToManyField(Category, through='SubscriptionCategory')`

3. **`SubscriptionCategory`** through model:
   - Fields: subscription (FK), category (FK), position (IntegerField)
   - `class Meta: unique_together = ('subscription', 'category')`

4. **`Video`** model:
   - Fields: video_id (CharField unique), channel (ForeignKey to Subscription, to_field='channel_id'), title, description, thumbnail_url, thumbnail_path, published_at, duration_seconds, video_type, playback_progress, fetched_at

5. **`QueueItem`** model:
   - Fields: video (OneToOneField to Video, to_field='video_id'), sort_order, added_at

6. **`Feed`** model:
   - Fields: name, sort_order, filter_category_ids (JSONField), filter_video_type, filter_min_duration, filter_max_duration, filter_max_age_days, filter_play_state, created_at, updated_at

### 1.2 Create and Run Migrations
```bash
python manage.py makemigrations subscriptions
python manage.py migrate
```

### 1.3 Create `subscriptions/serializers.py`
DRF serializers for all models:
- `CategorySerializer` with recursive children
- `SubscriptionSerializer` with nested categories
- `VideoSerializer` with computed `channel_title`
- `QueueItemSerializer` with nested video
- `FeedSerializer` with JSONField for category groups

### 1.4 Basic URL Configuration
- `config/urls.py`: Include subscriptions URLs under `/api/`
- `subscriptions/urls.py`: DRF router + custom view paths
- Health check: `GET /api/health/`

**Milestone:** `python manage.py runserver` works, database created, health check returns 200.

---

## Phase 2: YouTube Service

### 2.1 Create `subscriptions/youtube_service.py`
Implement `YouTubeService` class (identical logic to original):

1. **OAuth authentication**: `_get_credentials()`, `from_credentials()` factory, state-bound local/extension callback completion, atomic credential persistence and logout generation control
2. **Data API v3 methods**: fetch subscriptions, uploads, video details, channel details, playlists, playlist items, create/delete playlists
3. **InnerTube API methods**: FEchannels (subscriptions)
4. **YouTube Lounge API**: cast_to_receiver, get_now_playing
5. **Retry logic**: `_execute_with_retry()` for transient errors
6. **Helper**: `_parse_iso8601_duration()`

**Milestone:** YouTube API calls work, OAuth flow completes successfully.

---

## Phase 3: Category API

### 3.1 `CategoryViewSet(ModelViewSet)`
- `list()`: Return tree with counts (total, uncategorized)
- `create()`: Auto-assign next `sort_order`
- `update()`: Validate no circular parent references
- `destroy()`: Django cascade handles children
- `@action reorder`: Persist drag-and-drop order
- `@action export_categories`: PocketTube JSON format
- `@action import_categories`: Parse PocketTube JSON, create categories/subscriptions/assignments

**Milestone:** Category CRUD and PocketTube interop works.

---

## Phase 4: Subscription API

### 4.1 `SubscriptionViewSet`
- `list()`: Paginated with optional `category_id` or `uncategorized` filter
- `retrieve()`: Single with categories
- `destroy()`: Delete + YouTube unsubscribe
- `@action sync`: Synchronous sync
- `@action assign`: Add subscription-category association
- `@action unassign`: Remove association
- `@action suggestions`: AI-powered category suggestions

### 4.2 Create `subscriptions/suggestions.py`
- `gemini_suggestions()`: Gemini API call
- `heuristic_suggestions()`: Keyword matching fallback

### 4.3 Thumbnail Views
- `VideoThumbnailView(APIView)`: Download-cache-serve pattern with `FileResponse`
- `ChannelThumbnailView(APIView)`: Same for channel thumbnails

**Milestone:** Subscriptions viewable, assignable to categories, AI suggestions work.

---

## Phase 5: Background Sync

### 5.1 Create `subscriptions/sync.py`
- Module-level `_sync_state` dict with `threading.Lock`
- `sync_subscriptions_phase()`: Data API v3 + InnerTube upsert
- `run_video_sync()`: ThreadPoolExecutor parallel fetch, incremental, feed-aware
- `run_full_sync(force)`: Combined 2-phase sync

### 5.2 Sync Views
- `SyncAllView(APIView)`: POST → start daemon thread, return 202
- `SyncVideosView(APIView)`: POST → video-only sync
- `SyncStatusView(APIView)`: GET → return `_sync_state`

**Milestone:** Background sync efficiently updates subscriptions and videos.

---

## Phase 6: Feed System

### 6.1 `FeedViewSet(ModelViewSet)`
- Standard CRUD via ModelSerializer
- `@action videos`: Filtered video query using Django ORM:
  - `Q` objects for AND/OR category groups
  - `.filter()` chains for type, duration, age, play state
  - `.order_by('-published_at')` + pagination

**Milestone:** Customizable feeds filter and display videos correctly.

---

## Phase 7: Queue & Cast

### 7.1 Queue Views
- `QueueListCreateView`: GET (list) + POST (add, deduplicated)
- `QueueDetailView`: DELETE (remove item)
- `QueueReorderView`: POST (reorder)
- `QueueClearView`: POST (clear all)
- `QueueCreatePlaylistView`: POST (create YouTube playlist from queue)
- `QueueCastView`: POST (Lounge API with screenId)
- `QueueRefreshProgressView`: POST (Lounge nowPlaying)

**Milestone:** Queue management and Cast playback fully functional.

---

## Phase 8: Playlist Management

### 8.1 Playlist Views (pass-through to YouTube API)
- `PlaylistListView`: GET → fetch from YouTube
- `PlaylistDetailView`: DELETE → delete on YouTube
- `PlaylistItemsView`: GET (paginated) + POST (add video)
- `PlaylistItemsReorderView`: POST → reorder on YouTube
- `PlaylistItemDetailView`: DELETE → remove from YouTube
- `PlaylistCastView`: POST → Lounge API

**Milestone:** Complete YouTube playlist management.

---

## Phase 9: React Frontend — Foundation

### 9.1 Entry Point and Routing
- `main.tsx`: Render `<App>` into root, import Bootstrap CSS + `app.css`
- `App.tsx`: `<AppProvider>` wrapping `<Navbar>`, section components, modals, `<Toast>`, `<Spinner>`, `<ConfirmDialog>`

### 9.2 TypeScript Types (`types/index.ts`)
- Define interfaces: `Category`, `Subscription`, `Video`, `QueueItem`, `Feed`, `SyncState`, `Playlist`

### 9.3 API Client (`api/client.ts`)
- axios instance with baseURL `/api`
- Typed functions for every API endpoint

### 9.4 Context and State (`context/AppContext.tsx`)
- `useReducer` with actions for: categories, subscriptions, selection, sync state, queue, active section
- `AppProvider` component wrapping children

### 9.5 Layout Components
- `<Navbar>`: Section tabs, context-sensitive action buttons
- `<Spinner>`: Fixed centered overlay
- `<Toast>`: Bootstrap toast container with `useToast()` hook
- `<ConfirmDialog>`: Modal with `useConfirm()` hook returning Promise

**Milestone:** React app renders with navigation, global state, and feedback components.

---

## Phase 10: React — CSS & Design System

### 10.1 Create `frontend/src/styles/app.css`
Implement in order:
1. CSS variables (color palette)
2. Base layout (full-height, flex containers)
3. Bootstrap overrides (primary color, card, scrollbar)
4. Action button styles (btn-icon, btn-action, variants)
5. List item base (shared subscription/video card)
6. Video-specific styles (thumbnail, duration badge, progress bar, watched state)
7. Category tree styles (node, drag, collapse, selection, suggestion highlighting)
8. Column layout (fixed-width columns, horizontal scroll)
9. Special filters, navigation, sidebar resizer
10. Utilities (spinner, dialog, toast, filter groups)

**Milestone:** Application looks polished with Material Design aesthetic.

---

## Phase 11: React — Subscriptions Section

### 11.1 Custom Hooks
- `useCategories()`: Fetch tree, CRUD, reorder, import/export
- `useSubscriptions()`: Paginated fetch, infinite scroll integration

### 11.2 Components
- `<SubscriptionsSection>`: Two-panel layout with resizable sidebar
- `<CategoryTree>`: Recursive rendering, `@dnd-kit` for reorder/nesting
- `<CategoryNode>`: Toggle/checkbox, actions, drag handle, suggestion highlighting
- `<CategoryModal>`: Create/edit form
- `<SubscriptionList>`: Virtual scroll with `IntersectionObserver`
- `<SubscriptionItem>`: Checkbox, thumbnail, info, category badges

### 11.3 Selection & Assignment
- `selectedSubscriptionIds` in context
- `<CategoryNode>` switches to checkbox mode when selection active
- Batch assign/unassign via parallel API calls

### 11.4 AI Suggestions
- Fetch via `GET /api/subscriptions/{id}/suggestions/`
- `suggestedCategoryIds` in context → `<CategoryNode>` highlighted

### 11.5 Search
- Controlled input → `useMemo` filtered list

**Milestone:** Core subscription management UI is interactive.

---

## Phase 12: React — Feeds & Queue

### 12.1 Custom Hooks
- `useFeeds()`: Fetch feeds, load videos per feed with pagination
- `useQueue()`: Add/remove/reorder queue items
- `useCast()`: Cast SDK initialization, session, MDX, Lounge playback

### 12.2 Components
- `<FeedsSection>`: Horizontal column layout
- `<FeedColumn>`: Header + filter tags + `<VideoItem>` list with infinite scroll
- `<FeedModal>`: AND/OR category group builder, type/duration/age/play-state filters
- `<VideoItem>`: Shared video card (thumbnail, duration, progress, actions)
- `<QueueColumn>`: Header toolbar + sortable `<QueueItem>` list
- `<QueueItem>`: Video card with drag handle, remove action

### 12.3 Cast Integration
- `useCast()` hook wrapping Google Cast SDK
- Session persistence in `sessionStorage`
- MDX listener for screenId
- Queue polling via `useEffect` + `setInterval`

**Milestone:** Feeds display videos, queue works with Cast playback.

---

## Phase 13: React — Playlists

### 13.1 Custom Hook
- `usePlaylists()`: Fetch playlists, items per playlist, infinite scroll

### 13.2 Components
- `<PlaylistsSection>`: Horizontal column layout
- `<PlaylistColumn>`: Header (title, count, Cast, Delete) + sortable `<VideoItem>` list
- `<AddToPlaylistModal>`: Playlist picker + confirm

**Milestone:** Playlist management fully functional.

---

## Phase 14: React — Sync UI

### 14.1 `useSync()` Hook
- `startFullSync(force)`: POST → start polling
- `useEffect` with `setInterval` polling every 2s
- Return `syncState` for UI consumption

### 14.2 Navbar Integration
- Sync button icon spins when `syncState.running`
- Toast on completion with summary

**Milestone:** Sync button triggers background sync with visual feedback.

---

## Phase 15: Production Build

### 15.1 React Build
```bash
cd frontend && npm run build
```

### 15.2 Django Static Files
Configure Django to serve the Vite build output:
```python
# settings.py
STATICFILES_DIRS = [BASE_DIR / 'frontend' / 'dist' / 'assets']
STATIC_URL = '/assets/'
```

Add a catch-all view to serve `index.html` for client-side routing:
```python
# config/urls.py
urlpatterns += [re_path(r'^(?!api/|admin/|media/).*$', serve_react_index)]
```

### 15.3 Collect Static
```bash
python manage.py collectstatic
```

**Milestone:** Full application served from Django in production mode.

---

## Phase 16: Remote Browser and Extension Compatibility

### 16.1 Exact App-Origin Permission
- Keep loopback origins as built-in development targets
- Require an exact user-approved HTTPS origin for a remote app
- Request only that Chrome host permission and dynamically register `content.js`
- Re-check the configured origin, port and permission before cookies or imports leave the extension

### 16.2 Installed-App OAuth Relay
- Keep the Desktop OAuth redirect exactly `http://localhost:8085/`
- Bind the same-machine callback server to loopback only
- Observe only exact top-level callbacks in extension `webNavigation`
- Scrub or close the callback tab before relaying its one-time URL
- Complete the original in-memory Flow through `POST /api/auth/oauth/callback/`
- Serialize callback exchange, refresh and logout with generation checks and atomic token writes

### 16.3 Validation and Limits
- Run backend OAuth service/API race tests and the extension harness
- Keep OAuth start/completion on one Django process
- Require trusted HTTPS for remote origins
- Treat API caller authentication as a separate deployment phase; the YouTube OAuth grant is not an app login

**Milestone:** A browser and extension on another machine can complete fresh YouTube OAuth against a single-process backend without changing the registered Desktop OAuth redirect.

---

## Phase 17: Feed Column Ordering

**Backend** (`subscriptions/views.py`)
- `FeedViewSet.perform_create`: append new feeds (`sort_order = Max + 1`) instead of leaving them at the default `0`
- `FeedViewSet.reorder` → `POST /api/feeds/reorder/` with `{ ordered_ids }`, validated (list / ≤1000 / int-coercible) and atomic
- No migration — `Feed.sort_order` and `Meta.ordering` already existed

**Frontend**
- `api/client.ts`: `reorderFeeds()`
- `useFeeds()`: `reorderFeeds()` with optimistic reorder, exact-id-set guard, re-fetch recovery; `feedVideos` untouched so no videos are refetched
- `<FeedColumn>`: `useSortable`, drag activator is the title span inside the `<h3>`
- `<FeedsSection>`: horizontal `DndContext` / `SortableContext` around feed columns only; custom a11y announcements
- `app.css`: `.feed-title-handle` (24px-tall hit target, inset focus ring, `touch-action: none`) and `.column.is-drag-source`

**Testing**
- Playwright introduced for E2E (`frontend/playwright.config.ts`, `frontend/e2e/`); Vitest config excludes `e2e/**`

**Milestone:** Feed columns reorder by dragging their title (mouse and keyboard), the order persists, and new feeds appear last.

---

## Testing Strategy

For each phase, verify:
1. **API endpoints**: Use DRF browsable API, `curl`, or Postman to test JSON responses
2. **React components**: Verify in browser via Vite HMR
3. **Error handling**: Test invalid inputs, missing data, network errors
4. **TypeScript**: Ensure no type errors (`npm run type-check`)
5. **Edge cases**: Empty states, large datasets, concurrent operations

## Key Implementation Notes

### Python/Django
- All view methods and service functions must have type hints
- Use Python `logging` module (DEBUG level) for all views and critical functions
- DRF serializers handle all validation and serialization
- Use `@action` decorators for non-CRUD operations on ViewSets
- Django migrations handle all schema changes — no manual ALTER TABLE

### React/TypeScript
- TypeScript strict mode — all props and state typed via interfaces
- `const` by default, `let` only when reassignment needed
- Custom hooks encapsulate all data fetching and state logic
- Components are functional with hooks (no class components)
- No native `alert()`/`confirm()` — use `<ConfirmDialog>` / `<Toast>`
- No inline styles — all styling via `app.css` with semantic class names
- Material Design Icons only via `@mui/icons-material` — no Unicode emojis
- `@dnd-kit` for all drag-and-drop — no native HTML5 DnD API
- `React.memo()` for expensive list item components
