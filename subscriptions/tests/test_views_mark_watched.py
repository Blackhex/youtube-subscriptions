from unittest.mock import MagicMock, patch

from django.test import TestCase
from rest_framework.test import APIClient

from subscriptions.models import Subscription, Video


class MarkWatchedViewTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_mw", channel_title="Mark Watched Channel",
        )
        self.video = Video.objects.create(
            video_id="v_mw1", channel_id="UC_mw", title="Watch Me",
            playback_progress=None,
        )

    @patch('subscriptions.youtube_service.YouTubeCookieAPI.report_watch', return_value=True)
    @patch('subscriptions.youtube_service.YouTubeCookieAPI.get_login_state',
           return_value={'authenticated': True, 'in_progress': False, 'error': None})
    def test_mark_watched_sets_progress_and_propagates(self, mock_login_state, mock_report):
        resp = self.client.post(f'/api/videos/{self.video.video_id}/mark-watched/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['status'], 'ok')
        self.assertEqual(data['video_id'], 'v_mw1')
        self.assertEqual(data['playback_progress'], 100)
        self.assertTrue(data['youtube_propagated'])

        self.video.refresh_from_db()
        self.assertEqual(self.video.playback_progress, 100)

        mock_report.assert_called_once_with('v_mw1')

    def test_mark_watched_video_not_found(self):
        resp = self.client.post('/api/videos/nonexistent/mark-watched/')
        self.assertEqual(resp.status_code, 404)

    @patch('subscriptions.youtube_service.YouTubeCookieAPI.get_login_state',
           return_value={'authenticated': False, 'in_progress': False, 'error': None})
    def test_mark_watched_no_session_does_not_set_progress(self, mock_login_state):
        """When no YouTube session, returns not_propagated without setting progress."""
        resp = self.client.post(f'/api/videos/{self.video.video_id}/mark-watched/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['status'], 'not_propagated')
        self.assertTrue(resp.json()['youtube_session_needed'])
        self.assertIsNone(resp.json()['playback_progress'])

        self.video.refresh_from_db()
        self.assertIsNone(self.video.playback_progress)

    @patch('subscriptions.youtube_service.YouTubeCookieAPI.report_watch', return_value=False)
    @patch('subscriptions.youtube_service.YouTubeCookieAPI.get_login_state',
           return_value={'authenticated': True, 'in_progress': False, 'error': None})
    def test_mark_watched_propagation_fails_returns_200(self, mock_login_state, mock_report):
        """When YouTube propagation fails, returns 200 with not_propagated."""
        resp = self.client.post(f'/api/videos/{self.video.video_id}/mark-watched/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['status'], 'not_propagated')
        self.assertFalse(resp.json()['youtube_propagated'])

        self.video.refresh_from_db()
        self.assertIsNone(self.video.playback_progress)

    @patch('subscriptions.youtube_service.YouTubeCookieAPI.report_watch', return_value=True)
    @patch('subscriptions.youtube_service.YouTubeCookieAPI.get_login_state',
           return_value={'authenticated': True, 'in_progress': False, 'error': None})
    def test_mark_watched_already_watched(self, mock_login_state, mock_report):
        """Marking an already-watched video should still succeed."""
        self.video.playback_progress = 100
        self.video.save()

        resp = self.client.post(f'/api/videos/{self.video.video_id}/mark-watched/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['playback_progress'], 100)
