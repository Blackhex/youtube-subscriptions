import json
from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.utils import timezone
from googleapiclient.errors import HttpError
from httplib2 import Response

from subscriptions.models import Category, Feed, QueueItem, Subscription, SubscriptionCategory, Video
from subscriptions.sync import (
    _fetch_channel_videos,
    _get_channels_to_sync,
    _sync_single_channel,
    get_sync_state,
    is_sync_running,
    sync_channel_videos_now,
    sync_videos_phase,
    _sync_state,
    _sync_lock,
)


class GetSyncStateTest(TestCase):
    def test_returns_dict_copy(self):
        state = get_sync_state()
        self.assertIsInstance(state, dict)
        self.assertIn('running', state)
        # Mutating returned dict should not affect internal state
        state['running'] = 'MODIFIED'
        self.assertNotEqual(get_sync_state()['running'], 'MODIFIED')

    def test_initial_state_not_running(self):
        state = get_sync_state()
        self.assertFalse(state['running'])


class IsSyncRunningTest(TestCase):
    def setUp(self):
        with _sync_lock:
            _sync_state['running'] = False

    def test_returns_false_initially(self):
        self.assertFalse(is_sync_running())

    def test_returns_true_when_running(self):
        with _sync_lock:
            _sync_state['running'] = True
        self.assertTrue(is_sync_running())
        # Cleanup
        with _sync_lock:
            _sync_state['running'] = False


class GetChannelsToSyncTest(TestCase):
    def setUp(self):
        self.sub1 = Subscription.objects.create(
            channel_id="UC_sync1", channel_title="Sync Channel 1",
        )
        self.sub2 = Subscription.objects.create(
            channel_id="UC_sync2", channel_title="Sync Channel 2",
        )
        self.sub3 = Subscription.objects.create(
            channel_id="UC_sync3", channel_title="Sync Channel 3",
        )

    def test_fallback_to_all_channels_when_no_feeds(self):
        channels = _get_channels_to_sync()
        self.assertEqual(set(channels), {"UC_sync1", "UC_sync2", "UC_sync3"})

    def test_returns_channels_from_feed_categories(self):
        cat = Category.objects.create(name="SyncCat", sort_order=0)
        SubscriptionCategory.objects.create(subscription=self.sub1, category=cat)
        Feed.objects.create(
            name="Sync Feed",
            filter_category_ids=[cat.id],
        )
        channels = _get_channels_to_sync()
        self.assertIn("UC_sync1", channels)
        self.assertNotIn("UC_sync3", channels)

    def test_handles_nested_category_format(self):
        cat1 = Category.objects.create(name="Cat1", sort_order=0)
        cat2 = Category.objects.create(name="Cat2", sort_order=1)
        SubscriptionCategory.objects.create(subscription=self.sub1, category=cat1)
        SubscriptionCategory.objects.create(subscription=self.sub2, category=cat2)
        Feed.objects.create(
            name="Nested Feed",
            filter_category_ids=[[cat1.id, cat2.id], [cat1.id]],
        )
        channels = _get_channels_to_sync()
        self.assertIn("UC_sync1", channels)
        self.assertIn("UC_sync2", channels)

    def test_feeds_with_null_category_ids_ignored(self):
        Feed.objects.create(name="Null Feed", filter_category_ids=None)
        channels = _get_channels_to_sync()
        # Falls back to all channels
        self.assertEqual(set(channels), {"UC_sync1", "UC_sync2", "UC_sync3"})


class SyncVideosPhaseTest(TestCase):
    """Tests for sync_videos_phase without watch progress (now handled on-demand)."""

    def setUp(self):
        self.sub = Subscription.objects.create(
            channel_id="UC_progress", channel_title="Progress Channel",
        )

    @patch('subscriptions.sync._sync_single_channel', return_value=0)
    def test_sync_completes_without_progress_fetch(self, mock_channel_sync):
        """sync_videos_phase completes without fetching watch progress."""
        mock_yt = MagicMock()
        mock_yt.credentials = MagicMock()

        sync_videos_phase(mock_yt)

        # fetch_watch_history should NOT be called (removed)
        mock_yt.fetch_watch_history.assert_not_called()


class SyncStateSnapshotMixin:
    """_sync_state is a module-level mutable dict; restore it around every test."""

    def _snapshot_sync_state(self):
        with _sync_lock:
            original = dict(_sync_state)
        self.addCleanup(self._restore_sync_state, original)

    @staticmethod
    def _restore_sync_state(original):
        with _sync_lock:
            _sync_state.clear()
            _sync_state.update(original)


class SyncSingleChannelStateTest(SyncStateSnapshotMixin, TestCase):
    """_sync_single_channel applies the right _sync_state deltas per outcome."""

    def setUp(self):
        self._snapshot_sync_state()
        self.sub = Subscription.objects.create(
            channel_id="UC_single", channel_title="Single Channel",
        )
        with _sync_lock:
            _sync_state.update({
                'processed': 0,
                'skipped': 0,
                'fetched_new': 0,
                'current_channel': None,
            })

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(0, 'missing'))
    def test_missing_outcome_leaves_counters_untouched(self, mock_fetch):
        result = _sync_single_channel(MagicMock(), "UC_single", False)

        self.assertEqual(result, 0)
        state = get_sync_state()
        self.assertEqual(state['processed'], 0)
        self.assertEqual(state['skipped'], 0)
        self.assertEqual(state['fetched_new'], 0)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(0, 'skipped'))
    def test_skipped_outcome_increments_skipped_and_processed(self, mock_fetch):
        result = _sync_single_channel(MagicMock(), "UC_single", False)

        self.assertEqual(result, 0)
        state = get_sync_state()
        self.assertEqual(state['skipped'], 1)
        self.assertEqual(state['processed'], 1)
        self.assertEqual(state['fetched_new'], 0)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(0, 'no_uploads'))
    def test_no_uploads_outcome_increments_processed_only(self, mock_fetch):
        result = _sync_single_channel(MagicMock(), "UC_single", False)

        self.assertEqual(result, 0)
        state = get_sync_state()
        self.assertEqual(state['processed'], 1)
        self.assertEqual(state['skipped'], 0)
        self.assertEqual(state['fetched_new'], 0)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(3, 'synced'))
    def test_synced_outcome_adds_new_count_and_processed(self, mock_fetch):
        result = _sync_single_channel(MagicMock(), "UC_single", False)

        self.assertEqual(result, 3)
        state = get_sync_state()
        self.assertEqual(state['fetched_new'], 3)
        self.assertEqual(state['processed'], 1)
        self.assertEqual(state['skipped'], 0)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(1, 'synced'))
    def test_sets_current_channel_to_channel_title(self, mock_fetch):
        _sync_single_channel(MagicMock(), "UC_single", False)

        self.assertEqual(get_sync_state()['current_channel'], "Single Channel")


class SyncChannelVideosNowTest(SyncStateSnapshotMixin, TestCase):
    """sync_channel_videos_now is the on-demand path and must not touch _sync_state."""

    def setUp(self):
        self._snapshot_sync_state()
        self.sub = Subscription.objects.create(
            channel_id="UC_ondemand", channel_title="On Demand Channel",
        )

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(4, 'synced'))
    @patch('subscriptions.sync.YouTubeService')
    def test_returns_new_video_count(self, mock_service, mock_fetch):
        self.assertEqual(sync_channel_videos_now("UC_ondemand"), 4)
        mock_fetch.assert_called_once_with(
            mock_service.return_value.credentials, "UC_ondemand", False
        )

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(4, 'synced'))
    @patch('subscriptions.sync.YouTubeService')
    def test_leaves_sync_state_unchanged(self, mock_service, mock_fetch):
        with _sync_lock:
            _sync_state.update({
                'processed': 7,
                'skipped': 2,
                'fetched_new': 11,
                'current_channel': 'Untouched',
            })
        before = get_sync_state()

        sync_channel_videos_now("UC_ondemand")

        self.assertEqual(get_sync_state(), before)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(0, 'skipped'))
    @patch('subscriptions.sync.YouTubeService')
    def test_skipped_outcome_also_leaves_sync_state_unchanged(self, mock_service, mock_fetch):
        before = get_sync_state()

        self.assertEqual(sync_channel_videos_now("UC_ondemand"), 0)

        self.assertEqual(get_sync_state(), before)

    @patch('subscriptions.sync._fetch_channel_videos', return_value=(0, 'synced'))
    @patch('subscriptions.sync.YouTubeService')
    def test_force_flag_is_forwarded(self, mock_service, mock_fetch):
        sync_channel_videos_now("UC_ondemand", force=True)

        self.assertEqual(mock_fetch.call_args[0][2], True)


class FetchChannelVideosTest(SyncStateSnapshotMixin, TestCase):
    def setUp(self):
        self._snapshot_sync_state()
        self.sub = Subscription.objects.create(
            channel_id="UC_fetch", channel_title="Fetch Channel",
        )

    @patch('subscriptions.sync.YouTubeService')
    def test_unknown_channel_returns_missing_without_raising(self, mock_service):
        count, outcome = _fetch_channel_videos(MagicMock(), "UC_does_not_exist", False)

        self.assertEqual(count, 0)
        self.assertEqual(outcome, 'missing')
        # No YouTube calls should have been made for an unknown channel
        mock_service.from_credentials.return_value.fetch_channel_details.assert_not_called()

    @patch('subscriptions.sync.YouTubeService')
    def test_recently_synced_channel_returns_skipped(self, mock_service):
        self.sub.videos_synced_at = timezone.now() - timedelta(minutes=1)
        self.sub.save(update_fields=['videos_synced_at'])

        count, outcome = _fetch_channel_videos(MagicMock(), "UC_fetch", False)

        self.assertEqual(count, 0)
        self.assertEqual(outcome, 'skipped')

    @patch('subscriptions.sync.YouTubeService')
    def test_channel_without_uploads_playlist_returns_no_uploads(self, mock_service):
        mock_service.from_credentials.return_value.fetch_channel_details.return_value = {}

        count, outcome = _fetch_channel_videos(MagicMock(), "UC_fetch", False)

        self.assertEqual(count, 0)
        self.assertEqual(outcome, 'no_uploads')
        self.sub.refresh_from_db()
        self.assertIsNotNone(self.sub.videos_synced_at)

    @patch('subscriptions.sync.YouTubeService')
    def test_missing_uploads_playlist_preserves_data_and_throttles_next_attempt(self, mock_service):
        service = mock_service.from_credentials.return_value
        service.fetch_channel_details.return_value = {
            'UC_fetch': {'uploads_playlist_id': 'UU_fetch'},
        }
        service.fetch_uploads.side_effect = HttpError(
            Response({'status': 404}),
            json.dumps({'error': {'message': 'Not found', 'errors': [
                {'reason': 'playlistNotFound'},
            ]}}).encode(),
        )
        video = Video.objects.create(
            video_id='existing', channel=self.sub, title='Existing video',
            published_at=timezone.now(),
        )
        queue_item = QueueItem.objects.create(video=video, sort_order=0)
        attempted_at = timezone.now()

        with patch('subscriptions.sync.timezone.now', return_value=attempted_at):
            with self.assertLogs('subscriptions.sync', level='WARNING') as logs:
                result = _fetch_channel_videos(MagicMock(), 'UC_fetch', False)

        self.assertEqual(result, (0, 'no_uploads'))
        self.assertEqual(len(logs.records), 1)
        self.assertIsNone(logs.records[0].exc_info)
        self.assertIn('Uploads playlist unavailable', logs.output[0])
        self.sub.refresh_from_db()
        self.assertEqual(self.sub.videos_synced_at, attempted_at)
        video.refresh_from_db()
        self.assertEqual(video.title, 'Existing video')
        self.assertTrue(QueueItem.objects.filter(pk=queue_item.pk).exists())
        service.fetch_video_details.assert_not_called()
        self.assertEqual(_fetch_channel_videos(MagicMock(), 'UC_fetch', False), (0, 'skipped'))
        service.fetch_uploads.assert_called_once()
        service.fetch_channel_details.assert_called_once()

    @patch('subscriptions.sync.YouTubeService')
    def test_missing_uploads_playlist_counts_as_processed_without_error(self, mock_service):
        service = mock_service.from_credentials.return_value
        service.fetch_channel_details.return_value = {
            'UC_fetch': {'uploads_playlist_id': 'UU_fetch'},
        }
        service.fetch_uploads.side_effect = HttpError(
            Response({'status': 404}),
            b'{"error":{"message":"Not found","errors":[{"reason":"playlistNotFound"}]}}',
        )
        before = get_sync_state()

        with self.assertLogs('subscriptions.sync', level='WARNING'):
            self.assertEqual(_sync_single_channel(MagicMock(), 'UC_fetch', False), 0)

        after = get_sync_state()
        self.assertEqual(after['processed'], before['processed'] + 1)
        for counter in ('errors', 'skipped', 'fetched_new'):
            self.assertEqual(after[counter], before[counter])

    @patch('subscriptions.sync.YouTubeService')
    def test_on_demand_missing_playlist_does_not_change_background_state(self, mock_service):
        service = mock_service.from_credentials.return_value
        service.fetch_channel_details.return_value = {
            'UC_fetch': {'uploads_playlist_id': 'UU_fetch'},
        }
        service.fetch_uploads.side_effect = HttpError(
            Response({'status': 404}),
            b'{"error":{"message":"Not found","errors":[{"reason":"playlistNotFound"}]}}',
        )
        before = get_sync_state()

        with self.assertLogs('subscriptions.sync', level='WARNING'):
            self.assertEqual(sync_channel_videos_now('UC_fetch'), 0)

        self.assertEqual(get_sync_state(), before)
        self.sub.refresh_from_db()
        self.assertIsNotNone(self.sub.videos_synced_at)

    @patch('subscriptions.sync.YouTubeService')
    def test_missing_playlist_can_recover_after_cooldown_or_on_forced_sync(self, mock_service):
        service = mock_service.from_credentials.return_value
        service.fetch_channel_details.return_value = {
            'UC_fetch': {'uploads_playlist_id': 'UU_fetch'},
        }
        for force in (False, True):
            with self.subTest(force=force):
                self.sub.videos_synced_at = None
                self.sub.save(update_fields=['videos_synced_at'])
                service.fetch_uploads.side_effect = HttpError(
                    Response({'status': 404}),
                    b'{"error":{"message":"Not found","errors":[{"reason":"playlistNotFound"}]}}',
                )
                with self.assertLogs('subscriptions.sync', level='WARNING'):
                    self.assertEqual(
                        _fetch_channel_videos(MagicMock(), 'UC_fetch', False), (0, 'no_uploads')
                    )
                self.sub.refresh_from_db()
                if not force:
                    self.sub.videos_synced_at -= timedelta(minutes=16)
                    self.sub.save(update_fields=['videos_synced_at'])
                service.fetch_uploads.side_effect = None
                service.fetch_uploads.return_value = []

                self.assertEqual(
                    _fetch_channel_videos(MagicMock(), 'UC_fetch', force), (0, 'synced')
                )

    @patch('subscriptions.sync.YouTubeService')
    def test_unrelated_upload_errors_propagate_without_stamping_attempt(self, mock_service):
        service = mock_service.from_credentials.return_value
        service.fetch_channel_details.return_value = {
            'UC_fetch': {'uploads_playlist_id': 'UU_fetch'},
        }
        cases = [
            (404, {'errors': [{'reason': 'notFound'}]}),
            (403, {'errors': [{'reason': 'quotaExceeded'}]}),
            (401, {'errors': [{'reason': 'authError'}]}),
            (500, {'errors': [{'reason': 'backendError'}]}),
            (403, {'errors': [{'reason': 'playlistNotFound'}]}),
            (404, {'message': 'playlistNotFound'}),
            (404, {'errors': ['playlistNotFound']}),
        ]
        for status, details in cases:
            with self.subTest(status=status, details=details):
                error = HttpError(
                    Response({'status': status}),
                    json.dumps({'error': {'message': 'API failure', **details}}).encode(),
                )
                service.fetch_uploads.side_effect = error
                with self.assertRaises(HttpError) as caught:
                    _fetch_channel_videos(MagicMock(), 'UC_fetch', False)
                self.assertIs(caught.exception, error)
                self.sub.refresh_from_db()
                self.assertIsNone(self.sub.videos_synced_at)

    @patch('subscriptions.sync.YouTubeService')
    def test_synced_outcome_creates_videos_and_stamps_subscription(self, mock_service):
        yt = mock_service.from_credentials.return_value
        yt.fetch_channel_details.return_value = {
            "UC_fetch": {'uploads_playlist_id': 'UU_fetch'},
        }
        yt.fetch_uploads.return_value = [
            {
                'video_id': 'vid_new1',
                'title': 'New Video 1',
                'published_at': timezone.now(),
                'thumbnail_url': 'https://example.com/1.jpg',
            },
        ]
        yt.fetch_video_details.return_value = {
            'vid_new1': {'duration_seconds': 120, 'video_type': 'video'},
        }

        count, outcome = _fetch_channel_videos(MagicMock(), "UC_fetch", False)

        self.assertEqual(count, 1)
        self.assertEqual(outcome, 'synced')
        self.assertTrue(Video.objects.filter(video_id='vid_new1').exists())
        self.sub.refresh_from_db()
        self.assertIsNotNone(self.sub.videos_synced_at)

