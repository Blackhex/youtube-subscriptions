# Data Model Reference

## Entity Relationship Diagram

```
┌──────────────────────┐         ┌──────────────────────────┐
│     Category         │         │    Subscription          │
├──────────────────────┤    M:N  ├──────────────────────────┤
│ id (PK)              │◄───────►│ id (PK)                  │
│ name                 │         │ subscription_id (unique)  │
│ description          │         │ channel_id (unique)       │
│ parent_id (FK→self)  │         │ channel_title             │
│ sort_order           │         │ channel_description       │
│ created_at           │         │ thumbnail_url             │
│ updated_at           │         │ thumbnail_path            │
└──────────────────────┘         │ subscription_date         │
        │ 1:N (self)             │ subscriber_count          │
        ↓                        │ topics (JSON)             │
  ┌─────────────┐                │ topic_in_topic_cache      │
  │ (children)  │                │ last_published_at         │
  └─────────────┘                │ synced_at                 │
                                 │ videos_synced_at          │
         ┌───────────────────┐   │ created_at                │
         │SubscriptionCategory│   └───────────┬──────────────┘
         │(through model M:N)│                │ 1:N
         ├───────────────────┤                ↓
         │subscription (FK)  │   ┌──────────────────────────┐
         │category (FK)      │   │       Video              │
         │position           │   ├──────────────────────────┤
         └───────────────────┘   │ id (PK)                  │
                                 │ video_id (unique)         │
                                 │ channel_id (FK→Subscr.)   │
                                 │ title                     │
┌──────────────────────────┐     │ description               │
│       Feed               │     │ thumbnail_url             │
├──────────────────────────┤     │ thumbnail_path            │
│ id (PK)                  │     │ published_at              │
│ name                     │     │ duration_seconds          │
│ sort_order               │     │ video_type                │
│ filter_category_ids(JSON)│     │ playback_progress (0-100) │
│ filter_video_type        │     │ fetched_at                │
│ filter_min_duration      │     └───────────┬──────────────┘
│ filter_max_duration      │                 │ 1:1
│ filter_max_age_days      │                 ↓
│ filter_play_state        │     ┌──────────────────────────┐
│ created_at               │     │     QueueItem            │
│ updated_at               │     ├──────────────────────────┤
└──────────────────────────┘     │ id (PK)                  │
                                 │ video_id (FK→Video,uniq)  │
                                 │ sort_order                │
                                 │ added_at                  │
                                 └──────────────────────────┘
```

## Django Model Definitions

### `Category`

```python
class Category(models.Model):
    name = models.CharField(max_length=256)
    description = models.TextField(blank=True, null=True)
    parent = models.ForeignKey('self', on_delete=models.CASCADE, null=True, blank=True, related_name='children')
    sort_order = models.IntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'categories'
        ordering = ['sort_order', 'name']
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | AutoField | PK | Unique identifier |
| `name` | CharField(256) | NOT NULL | Category display name |
| `description` | TextField | nullable | Optional description |
| `parent` | ForeignKey(self) | on_delete=CASCADE, nullable | Self-referential for nesting |
| `sort_order` | IntegerField | nullable | Order within parent group |
| `created_at` | DateTimeField | auto_now_add=True | Creation timestamp |
| `updated_at` | DateTimeField | auto_now=True | Last modification |

**Relationships:**
- Self-referential one-to-many (`children`/`parent`) with `on_delete=CASCADE`
- Many-to-many with `Subscription` via `SubscriptionCategory` through model

### `Subscription`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | AutoField | PK | Local identifier |
| `subscription_id` | CharField(256) | unique, nullable | YouTube subscription ID (for unsubscribing) |
| `channel_id` | CharField(256) | NOT NULL, unique | YouTube channel ID (UCxxxxxxxx) |
| `channel_title` | CharField(256) | NOT NULL | Channel display name |
| `channel_description` | TextField | nullable | Channel description |
| `thumbnail_url` | URLField(512) | nullable | Original thumbnail URL |
| `thumbnail_path` | CharField(512) | nullable | Local cached thumbnail path |
| `subscription_date` | DateTimeField | nullable | When user subscribed |
| `subscriber_count` | CharField(32) | nullable | Subscriber count (from PocketTube) |
| `topics` | JSONField | nullable | Array of topic strings |
| `topic_in_topic_cache` | BooleanField | default=False | True if topics from PocketTube topicCache |
| `last_published_at` | CharField(64) | nullable | Last video published ISO timestamp |
| `synced_at` | DateTimeField | nullable | Last YouTube sync timestamp |
| `videos_synced_at` | DateTimeField | nullable | Last video fetch timestamp |
| `uploads_page_token` | CharField(256) | nullable | Resume token for the older-uploads backfill walk |
| `uploads_backfilled` | BooleanField | default=False | True once the uploads playlist has been walked to the end |
| `created_at` | DateTimeField | auto_now_add=True | Creation timestamp |
| `categories` | ManyToManyField(Category) | through=SubscriptionCategory | Category assignments |

### `SubscriptionCategory` (through model)

```python
class SubscriptionCategory(models.Model):
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE)
    category = models.ForeignKey(Category, on_delete=models.CASCADE)
    position = models.IntegerField(null=True, blank=True)

    class Meta:
        db_table = 'subscription_category'
        unique_together = ('subscription', 'category')
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `subscription` | ForeignKey | PK (composite), on_delete=CASCADE | |
| `category` | ForeignKey | PK (composite), on_delete=CASCADE | |
| `position` | IntegerField | nullable | Sort order within category |

### `Video`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | AutoField | PK | Local identifier |
| `video_id` | CharField(32) | NOT NULL, unique | YouTube video ID |
| `channel` | ForeignKey(Subscription) | to_field='channel_id', on_delete=CASCADE | Source channel |
| `title` | CharField(512) | NOT NULL | Video title |
| `description` | TextField | nullable | Video description |
| `thumbnail_url` | URLField(512) | nullable | Original thumbnail URL |
| `thumbnail_path` | CharField(512) | nullable | Cached thumbnail path |
| `published_at` | DateTimeField | nullable | Publication timestamp |
| `duration_seconds` | IntegerField | nullable | Video length in seconds |
| `video_type` | CharField(32) | nullable | "video", "short", or "live" |
| `playback_progress` | IntegerField | nullable | Percentage watched (0–100) |
| `fetched_at` | DateTimeField | auto_now_add=True | When metadata was fetched |

**Video type classification:**
- `live`: `liveBroadcastContent` is "live" or "upcoming"
- `short`: duration ≤ 60 seconds
- `video`: everything else

### `QueueItem`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | AutoField | PK | Queue entry identifier |
| `video` | OneToOneField(Video) | to_field='video_id', on_delete=CASCADE | Video reference |
| `sort_order` | IntegerField | NOT NULL | Playback order |
| `added_at` | DateTimeField | auto_now_add=True | When added to queue |

### `Feed`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | AutoField | PK | Feed identifier |
| `name` | CharField(256) | NOT NULL | Display name |
| `sort_order` | IntegerField | default=0 | Column order in UI |
| `filter_category_ids` | JSONField | nullable | Array of arrays (AND of OR groups) |
| `filter_video_type` | CharField(32) | nullable | "video", "short", "live", or null (all) |
| `filter_min_duration` | IntegerField | nullable | Min duration (seconds) |
| `filter_max_duration` | IntegerField | nullable | Max duration (seconds) |
| `filter_max_age_days` | IntegerField | nullable | Only videos from last N days |
| `filter_play_state` | CharField(16) | nullable | "played", "unplayed", or "both" |
| `created_at` | DateTimeField | auto_now_add=True | Creation timestamp |
| `updated_at` | DateTimeField | auto_now=True | Last modification |

**Category filter format:**
```json
// AND of OR groups: [[1, 2], [3]] means (cat 1 OR cat 2) AND (cat 3)
// Legacy flat array [1, 2, 3] is auto-migrated to [[1, 2, 3]]
```

## Schema Migration Strategy

Django's built-in migration framework handles all schema changes:

1. **`python manage.py makemigrations`**: Auto-generates migration files when models change
2. **`python manage.py migrate`**: Applies pending migrations to the database
3. **Data migrations**: Custom migration files for backfilling data (e.g., converting legacy `filter_played_only` to `filter_play_state`)

Migrations are version-controlled in `subscriptions/migrations/` and applied automatically on deployment.

## Serialization

Django REST Framework serializers handle all JSON serialization:

- **`CategorySerializer`**: Recursive `children` field via `RecursiveField` or explicit nesting. Includes computed `subscription_count`.
- **`SubscriptionSerializer`**: Nested `categories` list. Thumbnail URL computed as `/api/subscriptions/{channel_id}/thumbnail`.
- **`VideoSerializer`**: Includes `channel_title` from relationship. Thumbnail URL computed as `/api/videos/{video_id}/thumbnail`.
- **`QueueItemSerializer`**: Nested `VideoSerializer` for the `video` field.
- **`FeedSerializer`**: `filter_category_ids` stored as native JSONField, serialized directly.
