---
name: drf-api-design
description: "Django REST Framework API implementation for YouTube Subscriptions Organizer. Use when: creating ViewSets, serializers, URL routing, custom actions, pagination, filtering, thumbnail serving, sync endpoints, queue/cast endpoints, playlist pass-through views."
---

# DRF API Design & Implementation

## When to Use
- Creating or modifying `subscriptions/serializers.py`
- Creating or modifying `subscriptions/views.py`
- Configuring `subscriptions/urls.py` routing
- Implementing any of the ~40 API endpoints

## Design References
- **API Spec**: See [API Reference](../../../docs/03-api-reference.md) for all endpoints, request/response formats, and error handling
- **Data Model**: See [Data Model](../../../docs/02-data-model.md) for serialization requirements
- **Implementation Plan**: See [Implementation Plan](../../../docs/06-implementation-plan.md) Phases 3-4, 6-8

## Procedure

### Serializers (`subscriptions/serializers.py`)
1. `CategorySerializer`: Recursive `children` field, computed `subscription_count`
2. `SubscriptionSerializer`: Nested `categories` list, computed thumbnail URL as `/api/subscriptions/{channel_id}/thumbnail/`
3. `VideoSerializer`: Include `channel_title` from relationship, thumbnail URL as `/api/videos/{video_id}/thumbnail/`
4. `QueueItemSerializer`: Nested `VideoSerializer` for the `video` field
5. `FeedSerializer`: `filter_category_ids` as native JSONField

### ViewSets and Views (`subscriptions/views.py`)

#### Category (`CategoryViewSet(ModelViewSet)`)
- `list()` → tree with `total_count`, `uncategorized_count`
- `create()` → auto-assign next `sort_order`
- `update()` → validate no circular parent references
- `@action reorder` → `POST /api/categories/reorder/` with `{ parent_id, ordered_ids }`
- `@action export_categories` → PocketTube JSON download
- `@action import_categories` → multipart file upload, parse PocketTube format

#### Subscription (`SubscriptionViewSet`)
- `list()` → paginated (page/per_page), filter by `category_id` or `uncategorized=true`
- `destroy()` → delete local + YouTube unsubscribe
- `@action assign` → `POST .../assign/{cat_id}/`
- `@action unassign` → `DELETE .../unassign/{cat_id}/`
- `@action suggestions` → AI category suggestions

#### Feed (`FeedViewSet(ModelViewSet)`)
- Standard CRUD
- `perform_create` appends: `sort_order = Max('sort_order') + 1` (0 when empty), unless `serializer.validated_data` already carries a non-null `sort_order`. Check *validated* data, not `request.data` — `sort_order` is writable via `fields = '__all__'`, so a client round-tripping a full object would otherwise stack every new feed at 0
- `@action reorder` → `POST /api/feeds/reorder/` with `{ ordered_ids }`; index-based `.update()` in `transaction.atomic()`
- `@action videos` → filtered query with AND/OR category groups, type, duration, age, play state

#### Reorder endpoint validation (applies to every `reorder` action)
Validate list-ness, length, **and element type**. `Model.objects.filter(id="abc")` raises a bare `ValueError` (and `id=[1,2]` a `TypeError`), neither of which DRF converts — the client gets a 500 instead of a 400:
```python
raw_ids = request.data.get('ordered_ids', [])
if not isinstance(raw_ids, list):
    return Response({'error': 'ordered_ids must be a list.'}, status=400)
if len(raw_ids) > 1000:
    return Response({'error': 'ordered_ids must contain at most 1000 items.'}, status=400)
try:
    ordered_ids = [int(i) for i in raw_ids]
except (TypeError, ValueError):
    return Response({'error': 'ordered_ids must contain integers.'}, status=400)
```
The cap matters because each element is a separate `UPDATE` inside one atomic block, holding the SQLite write lock. `CategoryViewSet.reorder` predates this and still lacks element validation.

#### Sync Views (APIView)
- `SyncAllView` → POST starts daemon thread, returns 202
- `SyncVideosView` → POST for video-only sync
- `SyncStatusView` → GET returns sync state dict

#### Queue Views (APIView)
- List/create, delete item, reorder, clear, create playlist, cast, refresh progress

#### Playlist Views (APIView pass-through)
- List playlists, delete playlist, items CRUD, reorder items, cast

#### Thumbnail Views (APIView)
- Download-cache-serve pattern with `FileResponse`
- Separate views for video and channel thumbnails

### URL Routing (`subscriptions/urls.py`)
- DRF `DefaultRouter` for ViewSets
- Manual `path()` entries for APIViews
- All under `/api/` prefix in `config/urls.py`

## Feed Video Filtering Logic
```python
# AND of OR groups for categories
for group in filter_category_ids:
    channel_ids = SubscriptionCategory.objects.filter(category_id__in=group).values('subscription__channel_id')
    queryset = queryset.filter(channel_id__in=Subquery(channel_ids))

# Additional filters
if filter_video_type:
    types = [t.strip() for t in filter_video_type.split(',')]
    queryset = queryset.filter(video_type__in=types)  # multi-select (comma-separated)
if filter_min_duration: queryset = queryset.filter(duration_seconds__gte=filter_min_duration)
if filter_max_duration: queryset = queryset.filter(duration_seconds__lte=filter_max_duration)
if filter_max_age_days: queryset = queryset.filter(published_at__gte=cutoff)
if filter_play_state == 'played': queryset = queryset.filter(playback_progress__gte=95)
if filter_play_state == 'unplayed': queryset = queryset.filter(Q(playback_progress__isnull=True) | Q(playback_progress__lt=95))

# After pagination, fetch on-demand watch progress per channel
for channel_id in page_channel_ids:
    progress = yt.fetch_channel_video_progress(channel_id)  # InnerTube channel browse
    # Update DB for page videos, reset for videos not in response
```

### Video Types
- `video` — Regular video (duration > 60s)
- `short` — YouTube Short (duration ≤ 60s)
- `live` — Active livestream
- `upcoming` — Scheduled/upcoming livestream

## Constraints
- All views use `AllowAny` permission (local app)
- JSON responses only (`JSONRenderer`)
- Paginated responses follow format: `{ items, total, page, per_page, has_more }`
- Error format: `{ "error": "message" }` with appropriate HTTP status
