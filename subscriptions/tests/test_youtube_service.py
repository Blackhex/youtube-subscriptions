import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import requests
from django.test import TestCase


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
