from unittest.mock import MagicMock, mock_open, patch

from django.test import TestCase
from rest_framework.test import APIClient

from subscriptions.models import QueueItem, Subscription, Video


class QueueListTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_empty_queue(self):
        resp = self.client.get('/api/queue/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['items'], [])


class QueueAddTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_add", channel_title="Queue Add Channel",
        )
        self.video1 = Video.objects.create(
            video_id="v_qadd1", channel_id="UC_q_add", title="Video 1",
        )
        self.video2 = Video.objects.create(
            video_id="v_qadd2", channel_id="UC_q_add", title="Video 2",
        )

    def test_add_single_video(self):
        resp = self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        self.assertEqual(resp.status_code, 201)
        data = resp.json()
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['video']['video_id'], 'v_qadd1')

    def test_add_multiple_videos(self):
        resp = self.client.post('/api/queue/', {
            'video_ids': ['v_qadd1', 'v_qadd2'],
        }, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 2)

    def test_duplicate_is_skipped(self):
        self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        resp = self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 1)

    def test_add_nonexistent_video_ignored(self):
        resp = self.client.post('/api/queue/', {'video_id': 'v_nonexist'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 0)

    def test_no_video_id_returns_400(self):
        resp = self.client.post('/api/queue/', {}, format='json')
        self.assertEqual(resp.status_code, 400)


class QueueDeleteTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_del", channel_title="Queue Del Channel",
        )
        self.video = Video.objects.create(
            video_id="v_qdel1", channel_id="UC_q_del", title="Del Video",
        )
        self.qi = QueueItem.objects.create(video=self.video, sort_order=0)

    def test_delete_item(self):
        resp = self.client.delete(f'/api/queue/{self.qi.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(QueueItem.objects.filter(pk=self.qi.pk).exists())

    def test_delete_nonexistent_returns_404(self):
        resp = self.client.delete('/api/queue/99999/')
        self.assertEqual(resp.status_code, 404)


class QueueReorderTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_reorder", channel_title="Reorder Channel",
        )
        self.v1 = Video.objects.create(
            video_id="v_qr1", channel_id="UC_q_reorder", title="V1",
        )
        self.v2 = Video.objects.create(
            video_id="v_qr2", channel_id="UC_q_reorder", title="V2",
        )
        self.v3 = Video.objects.create(
            video_id="v_qr3", channel_id="UC_q_reorder", title="V3",
        )
        self.qi1 = QueueItem.objects.create(video=self.v1, sort_order=0)
        self.qi2 = QueueItem.objects.create(video=self.v2, sort_order=1)
        self.qi3 = QueueItem.objects.create(video=self.v3, sort_order=2)

    def test_reorder(self):
        resp = self.client.post('/api/queue/reorder/', {
            'queue_item_ids': [self.qi3.id, self.qi1.id, self.qi2.id],
        }, format='json')
        self.assertEqual(resp.status_code, 200)
        self.qi1.refresh_from_db()
        self.qi2.refresh_from_db()
        self.qi3.refresh_from_db()
        self.assertEqual(self.qi3.sort_order, 0)
        self.assertEqual(self.qi1.sort_order, 1)
        self.assertEqual(self.qi2.sort_order, 2)

    def test_reorder_empty_returns_400(self):
        resp = self.client.post('/api/queue/reorder/', {}, format='json')
        self.assertEqual(resp.status_code, 400)


class QueueClearTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        sub = Subscription.objects.create(
            channel_id="UC_q_clear", channel_title="Clear Channel",
        )
        v1 = Video.objects.create(
            video_id="v_qclr1", channel_id="UC_q_clear", title="C1",
        )
        v2 = Video.objects.create(
            video_id="v_qclr2", channel_id="UC_q_clear", title="C2",
        )
        QueueItem.objects.create(video=v1, sort_order=0)
        QueueItem.objects.create(video=v2, sort_order=1)

    def test_clear_removes_all(self):
        resp = self.client.post('/api/queue/clear/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['items'], [])
        self.assertEqual(QueueItem.objects.count(), 0)


class QueueCastTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        sub = Subscription.objects.create(
            channel_id="UC_q_cast", channel_title="Cast Channel",
        )
        first = Video.objects.create(
            video_id="v_qcast1", channel_id=sub.channel_id, title="First",
        )
        second = Video.objects.create(
            video_id="v_qcast2", channel_id=sub.channel_id, title="Second",
        )
        QueueItem.objects.create(video=second, sort_order=2)
        QueueItem.objects.create(video=first, sort_order=1)

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_cast_passes_screen_id_and_ordered_queue(self, MockYTService):
        mock_yt = MagicMock()
        mock_yt.cast_to_receiver.return_value = {
            'screen_id': 'real-mdx-screen-id',
            'sid': 'sid',
        }
        MockYTService.return_value = mock_yt

        response = self.client.post(
            '/api/queue/cast/',
            {'screen_id': 'real-mdx-screen-id'},
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['screen_id'], 'real-mdx-screen-id')
        mock_yt.cast_to_receiver.assert_called_once_with(
            'real-mdx-screen-id',
            ['v_qcast1', 'v_qcast2'],
        )


class QueueCastStatusTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_inactive_without_lounge_session(self):
        with patch('subscriptions.views.os.path.exists', return_value=False):
            response = self.client.get('/api/queue/cast/status/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'active': False, 'now_playing': None})

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_detects_active_lounge_session(self, MockYTService):
        MockYTService.return_value.get_now_playing.return_value = {
            'video_id': 'playing-video',
            'state': '1',
            'current_time': 30,
        }
        with (
            patch('subscriptions.views.os.path.exists', return_value=True),
            patch('builtins.open', mock_open(read_data='{"screen_id": "screen-id"}')),
        ):
            response = self.client.get('/api/queue/cast/status/')

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['active'])
        self.assertEqual(response.json()['now_playing']['video_id'], 'playing-video')


class QueueRefreshProgressTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_refresh", channel_title="Refresh Channel",
        )
        self.v1 = Video.objects.create(
            video_id="v_qref1", channel_id="UC_q_refresh",
            title="Refresh V1", playback_progress=50,
        )
        self.v2 = Video.objects.create(
            video_id="v_qref2", channel_id="UC_q_refresh",
            title="Refresh V2", playback_progress=70,
        )
        self.qi1 = QueueItem.objects.create(video=self.v1, sort_order=0)
        self.qi2 = QueueItem.objects.create(video=self.v2, sort_order=1)

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_preserves_progress_for_videos_not_in_history(self, MockYTService):
        """Missing history entries must not erase progress measured from Lounge."""
        mock_yt = MagicMock()
        MockYTService.return_value = mock_yt
        # Channel browse does NOT include v_qref1 or v_qref2
        mock_yt.fetch_channel_video_progress.return_value = {}
        mock_yt.get_now_playing.return_value = None

        resp = self.client.post('/api/queue/refresh-progress/')
        self.assertEqual(resp.status_code, 200)

        self.v1.refresh_from_db()
        self.v2.refresh_from_db()
        self.assertEqual(self.v1.playback_progress, 50)
        self.assertEqual(self.v2.playback_progress, 70)

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_preserves_progress_for_videos_in_history(self, MockYTService):
        """Queue videos in channel browse get updated to browse values."""
        mock_yt = MagicMock()
        MockYTService.return_value = mock_yt
        mock_yt.fetch_channel_video_progress.return_value = {
            "v_qref1": 90,
            "v_qref2": 40,
        }
        mock_yt.get_now_playing.return_value = None

        resp = self.client.post('/api/queue/refresh-progress/')
        self.assertEqual(resp.status_code, 200)

        self.v1.refresh_from_db()
        self.v2.refresh_from_db()
        self.assertEqual(self.v1.playback_progress, 90)
        self.assertEqual(self.v2.playback_progress, 40)

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_live_lounge_progress_is_not_cleared_by_stale_history(self, MockYTService):
        self.v1.duration_seconds = 200
        self.v1.save(update_fields=['duration_seconds'])
        mock_yt = MagicMock()
        mock_yt.get_now_playing.return_value = {
            'video_id': 'v_qref1',
            'state': '1',
            'current_time': '50',
        }
        mock_yt.fetch_channel_video_progress.return_value = {}
        MockYTService.return_value = mock_yt

        with (
            patch('subscriptions.views.os.path.exists', return_value=True),
            patch(
                'builtins.open',
                mock_open(read_data='{"screen_id": "screen-id"}'),
            ),
        ):
            resp = self.client.post('/api/queue/refresh-progress/')

        self.assertEqual(resp.status_code, 200)
        self.v1.refresh_from_db()
        self.v2.refresh_from_db()
        self.assertEqual(self.v1.playback_progress, 25)
        self.assertEqual(self.v2.playback_progress, 70)
        response_progress = {
            item['video']['video_id']: item['video']['playback_progress']
            for item in resp.json()['items']
        }
        self.assertEqual(response_progress['v_qref1'], 25)

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_removes_consumed_item_when_receiver_advances(self, MockYTService):
        self.v2.duration_seconds = 200
        self.v2.save(update_fields=['duration_seconds'])
        mock_yt = MagicMock()
        mock_yt.get_now_playing.return_value = {
            'video_id': 'v_qref2',
            'state': '1',
            'current_time': '20',
        }
        mock_yt.fetch_channel_video_progress.return_value = {}
        MockYTService.return_value = mock_yt

        with (
            patch('subscriptions.views.os.path.exists', return_value=True),
            patch('builtins.open', mock_open(read_data='{"screen_id": "screen-id"}')),
        ):
            resp = self.client.post('/api/queue/refresh-progress/')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['removed_count'], 1)
        self.assertEqual(resp.json()['removed_video_ids'], ['v_qref1'])
        self.assertFalse(QueueItem.objects.filter(pk=self.qi1.pk).exists())
        self.v1.refresh_from_db()
        self.assertEqual(self.v1.playback_progress, 100)
        self.assertTrue(self.v1.watched_locally)
        self.assertEqual(
            [item['video']['video_id'] for item in resp.json()['items']],
            ['v_qref2'],
        )

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_removes_current_item_when_receiver_reports_ended(self, MockYTService):
        mock_yt = MagicMock()
        mock_yt.get_now_playing.return_value = {
            'video_id': 'v_qref1',
            'state': '0',
            'current_time': '200',
        }
        mock_yt.fetch_channel_video_progress.return_value = {}
        MockYTService.return_value = mock_yt

        with (
            patch('subscriptions.views.os.path.exists', return_value=True),
            patch('builtins.open', mock_open(read_data='{"screen_id": "screen-id"}')),
        ):
            resp = self.client.post('/api/queue/refresh-progress/')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['removed_count'], 1)
        self.assertEqual(resp.json()['removed_video_ids'], ['v_qref1'])
        self.assertFalse(QueueItem.objects.filter(pk=self.qi1.pk).exists())

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_repairs_consumed_video_after_queue_row_was_already_removed(self, MockYTService):
        self.qi1.delete()
        mock_yt = MagicMock()
        mock_yt.get_now_playing.return_value = {
            'video_id': 'v_qref2',
            'video_ids': ['v_qref1', 'v_qref2'],
            'state': '1',
            'current_time': '20',
        }
        mock_yt.fetch_channel_video_progress.return_value = {}
        MockYTService.return_value = mock_yt

        with (
            patch('subscriptions.views.os.path.exists', return_value=True),
            patch('builtins.open', mock_open(read_data='{"screen_id": "screen-id"}')),
        ):
            resp = self.client.post('/api/queue/refresh-progress/')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['removed_count'], 0)
        self.assertEqual(resp.json()['removed_video_ids'], ['v_qref1'])
        self.v1.refresh_from_db()
        self.assertEqual(self.v1.playback_progress, 100)
        self.assertTrue(self.v1.watched_locally)
