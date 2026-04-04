---
name: test-backend
description: "Backend testing for YouTube Subscriptions Organizer. Use when: writing Django unit tests, DRF API tests, testing models, testing serializers, testing views, testing sync logic, mocking YouTube API calls, testing feed filtering, testing queue operations."
---

# Backend Testing

## When to Use
- Writing tests for Django models
- Writing tests for DRF serializers
- Writing tests for DRF ViewSet/APIView endpoints
- Writing tests for sync logic
- Writing tests for YouTube service (mocked)
- Writing tests for feed video filtering
- Writing tests for category import/export

## Test Setup

### Directory Structure
```
subscriptions/
└── tests/
    ├── __init__.py
    ├── test_models.py
    ├── test_serializers.py
    ├── test_views_categories.py
    ├── test_views_subscriptions.py
    ├── test_views_feeds.py
    ├── test_views_queue.py
    ├── test_views_sync.py
    ├── test_sync.py
    ├── test_suggestions.py
    └── test_youtube_service.py
```

### Base Test Class
```python
from django.test import TestCase
from rest_framework.test import APITestCase, APIClient

class BaseAPITestCase(APITestCase):
    def setUp(self):
        self.client = APIClient()
        # Create common test data
        self.cat_root = Category.objects.create(name="Root", sort_order=0)
        self.cat_child = Category.objects.create(name="Child", parent=self.cat_root, sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_test",
            channel_title="Test Channel",
        )
```

## Test Categories

### Model Tests (`test_models.py`)
1. Category self-referential: create parent → child → verify `children` queryset
2. Category cascade delete: delete parent → verify children deleted
3. Subscription M:N through model: assign categories, verify positions
4. Video ForeignKey to_field: create via `channel_id` lookup
5. QueueItem OneToOne uniqueness: prevent duplicate video in queue
6. Feed JSONField: store/retrieve `filter_category_ids` as nested arrays
7. Model `ordering`: verify Category orders by `sort_order, name`

### Serializer Tests (`test_serializers.py`)
1. CategorySerializer: recursive children nesting, subscription_count computed
2. SubscriptionSerializer: nested category list, thumbnail URL format
3. VideoSerializer: channel_title included from relationship
4. QueueItemSerializer: nested video data
5. FeedSerializer: JSONField roundtrip for category groups

### Category View Tests (`test_views_categories.py`)
1. `GET /api/categories/` returns tree with counts
2. `POST /api/categories/` creates with auto sort_order
3. `PUT /api/categories/{id}/` prevents circular parent
4. `DELETE /api/categories/{id}/` cascades to children
5. `POST /api/categories/reorder/` updates sort_order
6. `GET /api/categories/export/` returns PocketTube-compatible JSON
7. `POST /api/categories/import/` creates categories and assignments

### Subscription View Tests (`test_views_subscriptions.py`)
1. `GET /api/subscriptions/` paginates correctly (page, per_page, has_more)
2. `GET /api/subscriptions/?category_id=1` filters by category
3. `GET /api/subscriptions/?uncategorized=true` shows only uncategorized
4. `POST .../assign/{cat_id}/` creates SubscriptionCategory
5. `DELETE .../unassign/{cat_id}/` removes SubscriptionCategory
6. `GET .../suggestions/` returns category IDs (mock Gemini)

### Feed View Tests (`test_views_feeds.py`)
1. Feed CRUD: create, list, update, delete
2. Feed videos: AND of OR category groups filtering
3. Feed videos: video_type filter
4. Feed videos: duration range filter
5. Feed videos: max_age_days filter
6. Feed videos: play_state filter (played/unplayed/both)
7. Feed videos: pagination (page, per_page)
8. Feed videos: combined filters

### Queue View Tests (`test_views_queue.py`)
1. Add to queue (deduplicated)
2. Remove from queue
3. Reorder queue items
4. Clear queue
5. Queue duplicate prevention

### Sync Tests (`test_sync.py`)
1. Sync state transitions (not running → running → complete)
2. Concurrent sync prevention (409 if already running)
3. Mock YouTube API responses for subscription sync
4. Video sync incremental behavior (only newer videos)
5. Video sync skips stale channels (< 15 min since last sync)

## Mocking Strategy
```python
from unittest.mock import patch, MagicMock

# Mock YouTube API
@patch('subscriptions.youtube_service.YouTubeService._get_credentials')
@patch('subscriptions.youtube_service.build')
def test_fetch_subscriptions(self, mock_build, mock_creds):
    mock_yt = MagicMock()
    mock_build.return_value = mock_yt
    mock_yt.subscriptions().list().execute.return_value = {
        'items': [...], 'nextPageToken': None
    }

# Mock Gemini API
@patch('subscriptions.suggestions.requests.post')
def test_gemini_suggestions(self, mock_post):
    mock_post.return_value.json.return_value = { ... }
```

## Running Tests
```bash
python manage.py test subscriptions
python manage.py test subscriptions.tests.test_models
python manage.py test subscriptions.tests.test_views_feeds -v 2
```
