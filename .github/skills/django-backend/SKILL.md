---
name: django-backend
description: "Django backend implementation for YouTube Subscriptions Organizer. Use when: creating Django models, writing migrations, configuring settings, implementing sync logic, YouTube service integration, background threading, thumbnail caching, PocketTube import/export."
---

# Django Backend Implementation

## When to Use
- Creating or modifying Django models in `subscriptions/models.py`
- Writing `subscriptions/sync.py` background sync logic
- Implementing `subscriptions/youtube_service.py` API wrappers
- Implementing `subscriptions/suggestions.py` AI suggestions
- Configuring `config/settings.py`, `config/urls.py`
- Writing Django migrations or management commands

## Design References
- **Models**: See [Data Model](../../../docs/02-data-model.md) for all 6 models with field types, constraints, and relationships
- **Architecture**: See [Architecture Overview](../../../docs/01-architecture-overview.md) for file structure and concurrency model
- **Implementation Plan**: See [Implementation Plan](../../../docs/06-implementation-plan.md) Phases 0-2, 5

## Procedure

### Models (`subscriptions/models.py`)
1. Implement models in this order: `Category`, `Subscription`, `SubscriptionCategory`, `Video`, `QueueItem`, `Feed`
2. Use exact field types from the data model doc (CharField lengths, JSONField for topics/filter_category_ids, etc.)
3. `Category.parent` uses `on_delete=CASCADE` with `related_name='children'`
4. `Subscription.categories` uses `ManyToManyField` through `SubscriptionCategory`
5. `Video.channel` is `ForeignKey(Subscription, to_field='channel_id')`
6. `QueueItem.video` is `OneToOneField(Video, to_field='video_id')`
7. Run `makemigrations` and `migrate` after model changes

### YouTube Service (`subscriptions/youtube_service.py`)
1. Three API client classes composed behind `YouTubeService` facade:
   - `YouTubePublicAPI`: OAuth + Data API v3 (subscriptions, channels, playlists, videos)
   - `YouTubeInnerTubeAPI`: OAuth + InnerTube TVHTML5 (FEchannels, channel browse for progress, Lounge/Cast)
   - `YouTubeCookieAPI`: Playwright headless browser for mark-as-watched (cookie-based SAPISIDHASH auth)
2. `fetch_channel_video_progress(channel_id)`: browse channel Videos tab for per-video watch progress
3. Lounge API: cast_to_receiver (token → bind → setPlaylist), get_now_playing
4. Use `_execute_with_retry()` for transient API errors

### Background Sync (`subscriptions/sync.py`)
1. Module-level `_sync_state` dict protected by `threading.Lock`
2. Two phases: subscriptions (Data API + InnerTube upsert), videos (ThreadPoolExecutor(3))
3. Video sync is incremental: only fetch newer than last stored video per channel
4. Only sync channels referenced by at least one Feed's category filters
5. Skip channels synced within 15 minutes (staleness check) unless force=True
6. Watch progress is NOT fetched during sync — it's fetched on-demand when feed videos are loaded via `fetch_channel_video_progress()`

### Settings (`config/settings.py`)
- INSTALLED_APPS: rest_framework, corsheaders, subscriptions
- CORS_ALLOW_ALL_ORIGINS = True
- DRF: AllowAny permission, JSONRenderer only
- MEDIA_ROOT and MEDIA_URL for thumbnail cache

## Constraints
- SQLite only — serialize writes during sync
- No Celery required — use threading for background tasks
- OAuth credentials from `client_secret.json` / `token.json` in project root
- Gemini API key from `gemini_api_key.txt` in project root
