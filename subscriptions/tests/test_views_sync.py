from unittest.mock import patch, MagicMock

from django.test import TestCase
from rest_framework.test import APIClient

from subscriptions import sync as sync_module


class SyncStatusTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_status_returns_state(self):
        resp = self.client.get('/api/sync/status/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('running', data)
        self.assertFalse(data['running'])


class SyncAllTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        # Reset sync state before each test
        with sync_module._sync_lock:
            sync_module._sync_state['running'] = False

    @patch('subscriptions.views.threading.Thread')
    def test_start_sync_returns_202(self, mock_thread_cls):
        mock_thread_cls.return_value.start = MagicMock()
        resp = self.client.post('/api/sync/all/')
        self.assertEqual(resp.status_code, 202)
        data = resp.json()
        self.assertIn('message', data)

    def test_concurrent_sync_returns_409(self):
        with sync_module._sync_lock:
            sync_module._sync_state['running'] = True
        try:
            resp = self.client.post('/api/sync/all/')
            self.assertEqual(resp.status_code, 409)
            data = resp.json()
            self.assertIn('error', data)
        finally:
            with sync_module._sync_lock:
                sync_module._sync_state['running'] = False


class SyncVideosTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        with sync_module._sync_lock:
            sync_module._sync_state['running'] = False

    @patch('subscriptions.views.threading.Thread')
    def test_start_video_sync_returns_202(self, mock_thread_cls):
        mock_thread_cls.return_value.start = MagicMock()
        resp = self.client.post('/api/sync/videos/')
        self.assertEqual(resp.status_code, 202)
        data = resp.json()
        self.assertIn('message', data)
