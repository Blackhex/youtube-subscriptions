import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import requests
from django.test import TestCase


# ═════════════════════════════════════════════════════════════════════════════
# YouTubePublicAPI Tests
# ═════════════════════════════════════════════════════════════════════════════

class YouTubePublicAPIVideoDetailsTest(TestCase):
    @staticmethod
    def _video(video_id, duration, published_at, width, height, live='none'):
        return {
            'id': video_id,
            'contentDetails': {'duration': duration},
            'snippet': {
                'liveBroadcastContent': live,
                'publishedAt': published_at,
                'title': video_id,
            },
            'liveStreamingDetails': {},
            'player': {
                'embedWidth': str(width),
                'embedHeight': str(height),
            },
        }

    def test_classifies_shorts_by_duration_date_and_aspect_ratio(self):
        from subscriptions.youtube_service import YouTubePublicAPI

        api = YouTubePublicAPI.__new__(YouTubePublicAPI)
        api.youtube = MagicMock()
        request = api.youtube.videos.return_value.list.return_value
        api._execute_with_retry = MagicMock(return_value={'items': [
            self._video('modern_vertical', 'PT1M11S', '2026-08-02T07:00:35Z', 1000, 1778),
            self._video('modern_landscape', 'PT1M11S', '2026-08-02T07:00:35Z', 1000, 563),
            self._video('legacy_vertical_long', 'PT1M11S', '2024-10-14T23:59:59Z', 1000, 1778),
            self._video('legacy_vertical_short', 'PT59S', '2024-10-14T23:59:59Z', 1000, 1778),
            self._video('too_long', 'PT3M1S', '2026-08-02T07:00:35Z', 1000, 1778),
            self._video('live', 'PT1M11S', '2026-08-02T07:00:35Z', 1000, 1778, 'live'),
        ]})

        details = api.fetch_video_details([
            'modern_vertical', 'modern_landscape', 'legacy_vertical_long',
            'legacy_vertical_short', 'too_long', 'live',
        ])

        self.assertEqual(details['modern_vertical']['video_type'], 'short')
        self.assertEqual(details['modern_landscape']['video_type'], 'video')
        self.assertEqual(details['legacy_vertical_long']['video_type'], 'video')
        self.assertEqual(details['legacy_vertical_short']['video_type'], 'short')
        self.assertEqual(details['too_long']['video_type'], 'video')
        self.assertEqual(details['live']['video_type'], 'live')
        api.youtube.videos.return_value.list.assert_called_once_with(
            id=(
                'modern_vertical,modern_landscape,legacy_vertical_long,'
                'legacy_vertical_short,too_long,live'
            ),
            part='contentDetails,snippet,liveStreamingDetails,player',
            maxWidth=1000,
        )
        api._execute_with_retry.assert_called_once_with(request)


# ═════════════════════════════════════════════════════════════════════════════
# YouTubeInnerTubeAPI Cast Tests
# ═════════════════════════════════════════════════════════════════════════════

class YouTubeInnerTubeCastTest(TestCase):
    def setUp(self):
        from subscriptions.youtube_service import YouTubeInnerTubeAPI
        self.api = YouTubeInnerTubeAPI(MagicMock())

    def test_cast_starts_first_video_and_queues_the_rest(self):
        session = MagicMock()
        session._lounge_token = 'token'
        session._sid = 'sid'
        session._gsession_id = 'gsession'

        with tempfile.TemporaryDirectory() as temp_dir:
            session_path = os.path.join(temp_dir, 'lounge_session.json')
            with (
                patch.object(self.api, '_create_youtube_session', return_value=session),
                patch.object(self.api, '_LOUNGE_SESSION_FILE', session_path),
            ):
                result = self.api.cast_to_receiver('screen-id', ['first', 'second', 'third'])

            session.play_video.assert_called_once_with('first')
            self.assertEqual(
                [call.args[0] for call in session.add_to_queue.call_args_list],
                ['second', 'third'],
            )
            self.assertEqual(result, {
                'screen_id': 'screen-id',
                'lounge_token': 'token',
                'sid': 'sid',
                'gsession_id': 'gsession',
                'video_ids': ['first', 'second', 'third'],
            })
            with open(session_path) as session_file:
                self.assertEqual(json.load(session_file), result)

    def test_get_now_playing_restores_lounge_session(self):
        session = MagicMock()
        session.get_session_data.return_value = [
            ['nowPlaying', {
                'videoId': 'video-id',
                'state': '1',
                'currentTime': '42',
                'mdxExpandedReceiverVideoIdList': 'previous,video-id,next',
            }],
            ['onStateChange', {
                'state': '1',
                'currentTime': '84',
            }],
        ]
        saved_session = {
            'screen_id': 'screen-id',
            'lounge_token': 'token',
            'sid': 'sid',
            'gsession_id': 'gsession',
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            session_path = os.path.join(temp_dir, 'lounge_session.json')
            with (
                patch.object(self.api, '_create_youtube_session', return_value=session),
                patch.object(self.api, '_LOUNGE_SESSION_FILE', session_path),
            ):
                result = self.api.get_now_playing(saved_session)

        self.assertEqual(result, {
            'video_id': 'video-id',
            'state': '1',
            'current_time': 84.0,
            'video_ids': ['previous', 'video-id', 'next'],
        })
        self.assertEqual(session._lounge_token, 'token')
        self.assertEqual(session._sid, 'sid')
        self.assertEqual(session._gsession_id, 'gsession')

    def test_get_now_playing_advances_between_sparse_state_events(self):
        session = MagicMock()
        session.get_session_data.return_value = [
            ['nowPlaying', {
                'videoId': 'video-id',
                'state': '1',
                'currentTime': '84',
            }],
        ]
        saved_session = {
            'screen_id': 'screen-id',
            'lounge_token': 'token',
            'sid': 'sid',
            'gsession_id': 'gsession',
            'playback': {
                'video_id': 'video-id',
                'state': '1',
                'reported_time': 84,
                'current_time': 84,
                'observed_at': 100,
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            session_path = os.path.join(temp_dir, 'lounge_session.json')
            with (
                patch.object(self.api, '_create_youtube_session', return_value=session),
                patch.object(self.api, '_LOUNGE_SESSION_FILE', session_path),
                patch('subscriptions.youtube_service.time.time', return_value=130),
            ):
                result = self.api.get_now_playing(saved_session)

        self.assertEqual(result['current_time'], 114)
        self.assertEqual(saved_session['playback']['current_time'], 114)

    def test_get_now_playing_retries_and_persists_after_expired_sid(self):
        session = MagicMock()
        response = MagicMock(status_code=400)

        calls = 0

        def expired_then_rebound():
            nonlocal calls
            calls += 1
            if calls == 1:
                session._sid = 'new-sid'
                session._gsession_id = 'new-gsession'
                raise requests.HTTPError(response=response)
            return [['nowPlaying', {'videoId': 'video-id', 'currentTime': '30'}]]

        session.get_session_data.side_effect = expired_then_rebound
        saved_session = {
            'screen_id': 'screen-id',
            'lounge_token': 'token',
            'sid': 'old-sid',
            'gsession_id': 'old-gsession',
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            session_path = os.path.join(temp_dir, 'lounge_session.json')
            with (
                patch.object(self.api, '_create_youtube_session', return_value=session),
                patch.object(self.api, '_LOUNGE_SESSION_FILE', session_path),
            ):
                result = self.api.get_now_playing(saved_session)

            self.assertEqual(result['video_id'], 'video-id')
            self.assertEqual(session.get_session_data.call_count, 2)
            self.assertEqual(saved_session['sid'], 'new-sid')
            self.assertEqual(saved_session['gsession_id'], 'new-gsession')
            with open(session_path) as session_file:
                self.assertEqual(json.load(session_file), saved_session)


# ═════════════════════════════════════════════════════════════════════════════
# YouTubeCookieAPI Tests
# ═════════════════════════════════════════════════════════════════════════════

class YouTubeCookieAPITest(TestCase):
    def test_launch_browser_prefers_installed_chrome(self):
        from subscriptions.youtube_service import YouTubeCookieAPI

        playwright = MagicMock()
        browser = playwright.chromium.launch.return_value

        result = YouTubeCookieAPI._launch_browser(playwright)

        self.assertIs(result, browser)
        playwright.chromium.launch.assert_called_once_with(channel='chrome', headless=True)

    def test_launch_browser_falls_back_to_bundled_chromium(self):
        from subscriptions.youtube_service import YouTubeCookieAPI

        playwright = MagicMock()
        bundled_browser = MagicMock()
        playwright.chromium.launch.side_effect = [RuntimeError('Chrome missing'), bundled_browser]

        result = YouTubeCookieAPI._launch_browser(playwright)

        self.assertIs(result, bundled_browser)
        self.assertEqual(playwright.chromium.launch.call_count, 2)
        playwright.chromium.launch.assert_any_call(channel='chrome', headless=True)
        playwright.chromium.launch.assert_any_call(headless=True)

    @patch('subscriptions.youtube_service.os.path.exists', return_value=True)
    def test_report_watch_rejects_invalid_video_id(self, mock_exists):
        from subscriptions.youtube_service import YouTubeCookieAPI
        api = YouTubeCookieAPI()
        result = api.report_watch('"><script>')
        self.assertFalse(result)

    @patch('subscriptions.youtube_service.os.path.exists', return_value=False)
    def test_report_watch_returns_false_without_state(self, mock_exists):
        from subscriptions.youtube_service import YouTubeCookieAPI
        api = YouTubeCookieAPI()
        # _has_state is False, and re-check also returns False
        result = api.report_watch('dQw4w9WgXcQ')
        self.assertFalse(result)


# ═════════════════════════════════════════════════════════════════════════════
# Report Watch Facade Tests
# ═════════════════════════════════════════════════════════════════════════════

class ReportWatchFallbackTest(TestCase):
    def _make_facade(self):
        from subscriptions.youtube_service import YouTubeService
        svc = YouTubeService.__new__(YouTubeService)
        svc.credentials = MagicMock()
        svc.credentials.token = 'FAKE_TOKEN'
        svc.youtube = MagicMock()
        svc.innertube = MagicMock()
        svc._cookie = MagicMock()
        return svc

    def test_cookie_report_watch_delegates(self):
        svc = self._make_facade()
        svc._cookie.report_watch.return_value = True

        result = svc.report_watch('VID123abcde')
        self.assertTrue(result)
        svc._cookie.report_watch.assert_called_once_with('VID123abcde')
        svc.innertube.report_watch.assert_not_called()
