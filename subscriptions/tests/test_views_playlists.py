from unittest.mock import MagicMock, patch, call

from django.test import TestCase
from rest_framework.test import APIClient

from googleapiclient.errors import HttpError


class ExecuteWithRetryTest(TestCase):
    """Test YouTubeService._execute_with_retry retries on 409."""

    @patch('subscriptions.youtube_service.time.sleep')
    @patch.object(
        __import__('subscriptions.youtube_service', fromlist=['YouTubeService']).YouTubeService,
        '__init__', lambda self: None,
    )
    def test_retries_on_409_then_succeeds(self, mock_sleep):
        from subscriptions.youtube_service import YouTubeService, YouTubePublicAPI

        yt = YouTubeService()
        yt.public = YouTubePublicAPI.__new__(YouTubePublicAPI)

        # Build a mock request whose execute() raises 409 twice, then succeeds
        mock_request = MagicMock()
        resp_409 = MagicMock()
        resp_409.status = 409
        error_409 = HttpError(resp_409, b'conflict')

        mock_request.execute.side_effect = [error_409, error_409, {'id': 'ok'}]

        result = yt._execute_with_retry(mock_request, max_retries=3)

        self.assertEqual(result, {'id': 'ok'})
        self.assertEqual(mock_request.execute.call_count, 3)
        # Verify exponential backoff sleeps: 2^0=1, 2^1=2
        mock_sleep.assert_has_calls([call(1), call(2)])

    @patch('subscriptions.youtube_service.time.sleep')
    @patch.object(
        __import__('subscriptions.youtube_service', fromlist=['YouTubeService']).YouTubeService,
        '__init__', lambda self: None,
    )
    def test_raises_409_after_max_retries_exhausted(self, mock_sleep):
        from subscriptions.youtube_service import YouTubeService, YouTubePublicAPI

        yt = YouTubeService()
        yt.public = YouTubePublicAPI.__new__(YouTubePublicAPI)

        mock_request = MagicMock()
        resp_409 = MagicMock()
        resp_409.status = 409
        error_409 = HttpError(resp_409, b'conflict')

        mock_request.execute.side_effect = [error_409, error_409, error_409]

        with self.assertRaises(HttpError):
            yt._execute_with_retry(mock_request, max_retries=3)

        self.assertEqual(mock_request.execute.call_count, 3)

    @patch('subscriptions.youtube_service.time.sleep')
    @patch.object(
        __import__('subscriptions.youtube_service', fromlist=['YouTubeService']).YouTubeService,
        '__init__', lambda self: None,
    )
    def test_does_not_retry_on_404(self, mock_sleep):
        from subscriptions.youtube_service import YouTubeService, YouTubePublicAPI

        yt = YouTubeService()
        yt.public = YouTubePublicAPI.__new__(YouTubePublicAPI)

        mock_request = MagicMock()
        resp_404 = MagicMock()
        resp_404.status = 404
        error_404 = HttpError(resp_404, b'not found')

        mock_request.execute.side_effect = error_404

        with self.assertRaises(HttpError):
            yt._execute_with_retry(mock_request, max_retries=3)

        self.assertEqual(mock_request.execute.call_count, 1)
        mock_sleep.assert_not_called()


class PlaylistItemsReorderValidationTest(TestCase):
    """Test PlaylistItemsReorderView input validation."""

    def setUp(self):
        self.client = APIClient()
        self.url = '/api/playlists/PLtest123/items/reorder/'

    def test_missing_item_ids_returns_400(self):
        resp = self.client.post(self.url, {
            'video_ids': ['v1', 'v2'],
        }, format='json')
        self.assertEqual(resp.status_code, 400)

    def test_missing_video_ids_returns_400(self):
        resp = self.client.post(self.url, {
            'item_ids': ['i1', 'i2'],
        }, format='json')
        self.assertEqual(resp.status_code, 400)

    def test_empty_item_ids_returns_400(self):
        resp = self.client.post(self.url, {
            'item_ids': [],
            'video_ids': ['v1'],
        }, format='json')
        self.assertEqual(resp.status_code, 400)

    def test_mismatched_lengths_returns_400(self):
        resp = self.client.post(self.url, {
            'item_ids': ['i1', 'i2'],
            'video_ids': ['v1'],
        }, format='json')
        self.assertEqual(resp.status_code, 400)

    def test_empty_body_returns_400(self):
        resp = self.client.post(self.url, {}, format='json')
        self.assertEqual(resp.status_code, 400)


class PlaylistItemsReorderSuccessTest(TestCase):
    """Test PlaylistItemsReorderView happy path."""

    def setUp(self):
        self.client = APIClient()
        self.url = '/api/playlists/PLtest123/items/reorder/'

    @patch('subscriptions.views.time.sleep')
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_calls_reorder_for_each_item(self, MockYTService, mock_sleep):
        mock_yt = MockYTService.return_value
        mock_yt.reorder_playlist_item.return_value = {'id': 'ok'}

        resp = self.client.post(self.url, {
            'item_ids': ['itemA', 'itemB', 'itemC'],
            'video_ids': ['vidA', 'vidB', 'vidC'],
        }, format='json')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'status': 'ok'})

        # Verify reorder_playlist_item called with correct args in order
        self.assertEqual(mock_yt.reorder_playlist_item.call_count, 3)
        mock_yt.reorder_playlist_item.assert_has_calls([
            call('PLtest123', 'itemA', 'vidA', 0),
            call('PLtest123', 'itemB', 'vidB', 1),
            call('PLtest123', 'itemC', 'vidC', 2),
        ])

    @patch('subscriptions.views.time.sleep')
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_sleeps_between_calls(self, MockYTService, mock_sleep):
        mock_yt = MockYTService.return_value
        mock_yt.reorder_playlist_item.return_value = {'id': 'ok'}

        self.client.post(self.url, {
            'item_ids': ['itemA', 'itemB', 'itemC'],
            'video_ids': ['vidA', 'vidB', 'vidC'],
        }, format='json')

        # sleep(0.5) should be called for position > 0 (i.e., twice for 3 items)
        self.assertEqual(mock_sleep.call_count, 2)
        mock_sleep.assert_called_with(0.5)

    @patch('subscriptions.views.time.sleep')
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_no_sleep_for_single_item(self, MockYTService, mock_sleep):
        mock_yt = MockYTService.return_value
        mock_yt.reorder_playlist_item.return_value = {'id': 'ok'}

        self.client.post(self.url, {
            'item_ids': ['itemA'],
            'video_ids': ['vidA'],
        }, format='json')

        mock_sleep.assert_not_called()


class PlaylistItemsReorderFailureTest(TestCase):
    """Test PlaylistItemsReorderView error handling."""

    def setUp(self):
        self.client = APIClient()
        self.url = '/api/playlists/PLtest123/items/reorder/'

    @patch('subscriptions.views.time.sleep')
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_youtube_error_returns_502(self, MockYTService, mock_sleep):
        mock_yt = MockYTService.return_value
        mock_yt.reorder_playlist_item.side_effect = Exception("YouTube API error")

        resp = self.client.post(self.url, {
            'item_ids': ['itemA', 'itemB'],
            'video_ids': ['vidA', 'vidB'],
        }, format='json')

        self.assertEqual(resp.status_code, 502)
        self.assertIn('error', resp.json())

    @patch('subscriptions.views.time.sleep')
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_partial_failure_returns_502(self, MockYTService, mock_sleep):
        """If reorder fails mid-way, endpoint returns 502."""
        mock_yt = MockYTService.return_value
        mock_yt.reorder_playlist_item.side_effect = [
            {'id': 'ok'},  # first call succeeds
            Exception("conflict"),  # second call fails
        ]

        resp = self.client.post(self.url, {
            'item_ids': ['itemA', 'itemB'],
            'video_ids': ['vidA', 'vidB'],
        }, format='json')

        self.assertEqual(resp.status_code, 502)
