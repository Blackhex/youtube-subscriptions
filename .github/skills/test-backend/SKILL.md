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
python manage.py test subscriptions --shuffle   # proves order-independence
```

## Testing Destructive Endpoints

### Seed pre-existing state or the test is vacuous
`POST /api/categories/import/` in `replace` mode wipes categories and assignments. Tests
that start from an empty database delete nothing, so replace and additive produce
identical counts and the whole behaviour goes unverified. Always seed rows that the
payload does **not** mention, then assert both what disappeared and what survived.

### Assert what must NOT be deleted
`Video.channel` and `QueueItem.video` cascade from `Subscription`. A regression that
prunes subscriptions would silently take the entire video library with it, so seed a
subscription absent from the payload plus a video and queue item for it, and assert all
three still exist.

### Patch module-level `settings`, not `override_settings(DATABASES=...)`
Overriding `DATABASES` or mutating `settings.DATABASES` mid-test risks disturbing the
connection the `TestCase` transaction is running on. When only one helper reads settings
at request time (`_snapshot_database` reads `settings.DATABASES`), patch the name inside
that module instead — Django's real connections are untouched:
```python
fake = SimpleNamespace(DATABASES={'default': {'ENGINE': ..., 'NAME': tmp_db_path}})
patch('subscriptions.views.settings', fake).start()
```
Note the SQLite test database is in-memory (`file:memorydb_default?...`), so
`os.path.exists(NAME)` is False and file-snapshot code skips by default.

### Redirect every filesystem path through `tempfile`
Patch module-level path constants (`POCKETTUBE_METADATA_PATH`, `DB_BACKUP_DIR`) per test
via a mixin with `addCleanup(shutil.rmtree, tmpdir, True)`. Never let a test write into
the developer's `data/`, `media/` or `db.sqlite3`.

### Testing `transaction.atomic()` rollback
Patch a manager method on the model to raise, and let the exception propagate out of the
test client (`raise_request_exception` is True by default; DRF only converts
`APIException`):
```python
with patch.object(Category.objects, 'get_or_create', side_effect=RuntimeError('boom')) as m:
    with self.assertRaises(RuntimeError):
        self._import(mode='replace')
self.assertTrue(m.called)  # proves the failure landed AFTER the wipe, not before
```
The `assertTrue(m.called)` guard matters: without it the test also passes against an
implementation that never deleted anything.

### Time-stamped file pruning
Snapshot names use per-second timestamps, so two imports in the same second collide.
Test retention by pre-creating dated files (`db-20200101-000001.sqlite3` ...) and running
a single import; names sort chronologically, so the new one always sorts last.

### Sentinel for "field omitted" vs "field empty"
Defaults that trigger on both a missing and an empty value need three distinct cases.
Use a module-level `_OMIT = object()` so a helper can tell "don't send the field" from
"send an empty string".
## Testing On-Demand ("Lazy") Sync

### Patch where the name lives, not where it is used, for function-local imports
`ChannelVideosView.get` does `from .sync import is_sync_running, sync_channel_videos_now`
*inside the method body*. The lookup happens on every request, so there is never a
`subscriptions.views.sync_channel_videos_now` attribute to patch — `patch` would raise
`AttributeError`. Patch the definition module instead:
```python
@patch('subscriptions.sync.is_sync_running', return_value=False)
@patch('subscriptions.sync.sync_channel_videos_now')
def test_triggers_sync_when_never_synced(self, mock_sync, mock_running):
```
This is the opposite of the usual "patch where it's used" rule, which only applies to
module-level `from x import y` bindings.

### Simulate the sync's side effect, not just its return value
A lazy-sync endpoint reads the DB *after* calling the sync, so a bare `MagicMock()` proves
nothing about the response. Give the mock a `side_effect` that creates the rows:
```python
mock_sync.side_effect = lambda channel_id: self._create_videos(channel_id, 'v1', 'v2')
```
Then assert the new videos appear in `items` — that is what actually verifies ordering.

### Always guard the "sync raised" path
The endpoint wraps the call in `try/except Exception`. Test it with
`side_effect=RuntimeError(...)` and assert **both** HTTP 200 and the full key set
(`{'items', 'total', 'page', 'per_page', 'has_more'}`). Asserting only the status code
lets a regression that returns a bare `{}` slip through. This is the highest-value test
in the group: without it the channel view 500s whenever YouTube is down or the OAuth
token has expired.

### Snapshot module-level mutable state with a mixin + addCleanup
`subscriptions.sync._sync_state` is a module-level dict shared by every test in the
process, so a test that bumps `processed` leaks into whatever runs next. Restore it:
```python
class SyncStateSnapshotMixin:
    def _snapshot_sync_state(self):
        with _sync_lock:
            original = dict(_sync_state)
        self.addCleanup(self._restore_sync_state, original)

    @staticmethod
    def _restore_sync_state(original):
        with _sync_lock:
            _sync_state.clear()
            _sync_state.update(original)
```
Call `self._snapshot_sync_state()` first in `setUp()`, then seed the counters the test
needs. `clear() + update()` rather than rebinding, because callers hold a reference to
the same dict object. Verify with `python manage.py test subscriptions --shuffle`.

### Assert "no state change" by comparing whole snapshots
For a function documented as *not* touching global state (`sync_channel_videos_now`),
seed non-zero, non-default counters first, then compare the entire dict:
```python
_sync_state.update({'processed': 7, 'skipped': 2, 'fetched_new': 11,
                    'current_channel': 'Untouched'})
before = get_sync_state()
sync_channel_videos_now("UC_x")
self.assertEqual(get_sync_state(), before)
```
Seeding non-zero values matters: against a zeroed dict an accidental `+= 0` is invisible,
and a full-dict comparison catches fields you did not think to assert individually.

### Table-drive outcome enums with one patch per outcome
For a dispatcher like `_sync_single_channel` that branches on a `(count, outcome)` tuple,
patch the collaborator to return each outcome in turn and assert the deltas separately.
Keep `missing` (no counters move at all) distinct from `no_uploads` (`processed` only) —
they are the pair most likely to be conflated by a refactor.


## Testing Import Ordering (`sort_order` from `ysc_meta`)

### The registry gate silently drops unlisted categories
`import_categories` builds `registry` from the keys of `ysc_collection` **and**
`ysc_meta`; once that set is non-empty, any list key whose base name is missing from it
is skipped entirely. So a test for "name absent from `ysc_meta`" must still list the name
under `ysc_collection`, or the category is never created and the assertion becomes an
error rather than the intended ordering check.

### Encounter order is payload key order
`category_channels` is built from `data.items()`, and `json.dumps`/`json.load` preserve
dict insertion order, so the order of category keys in the test payload *is* the encounter
order the unpositioned counter uses. Put the category keys first in the payload dict and
the `ysc_*` keys after, so the intent is obvious.

With `ysc_settings.sub_groups` present the encounter order changes: parents and their
children are created first in `sub_groups` order, then any leftover keys.

### Empty channel lists still create categories
`"Name": []` passes the `isinstance(value, list)` check, so ordering fixtures need no
`ysc_channel_metadata` entries at all. This keeps a 12-root regression payload readable.

### Prove a name tiebreak is not what passed
`Category.Meta.ordering = ['sort_order', 'name']`. A bug that gives several rows the same
`sort_order` still yields a deterministic, alphabetical order. Assert
`assertNotEqual(names, sorted(names))` alongside the expected sequence, and pick fixture
names whose expected order differs from both alphabetical and insertion order.

### Spread positioned fixtures far apart
A fallback that counts siblings produces small numbers (1, 2, 3 ...). If the positioned
fixtures use 0, 1, 2 the broken value lands in the same range and the test passes either
way. Use positions like `0, 12, 40` so the expected `max_position + 1 + k` is unmistakably
distinct from a sibling count.

### `bool` is an `int`
Any `isinstance(x, int)` validation needs an explicit `{'position': True}` case; without
`not isinstance(x, bool)` in the implementation, `True` is accepted as position 1.

