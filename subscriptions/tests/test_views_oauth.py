import json
import os
import tempfile
import threading
from unittest.mock import MagicMock, patch

from django.test import TestCase
from django.urls import resolve, reverse
from rest_framework.test import APIClient

from subscriptions.views import OAuthCallbackView


class OAuthLogoutViewTests(TestCase):
    def setUp(self):
        from subscriptions import youtube_service

        self.oauth_module = youtube_service
        self.service = youtube_service.YouTubeService
        self.client = APIClient()
        self.url = reverse('oauth')
        self.callback_url = (
            'http://localhost:8085/?state=private-state&code=private-code'
        )
        self.temp_dir = tempfile.TemporaryDirectory()
        self.token_path = os.path.join(self.temp_dir.name, 'token.json')
        self.token_patcher = patch.object(self.service, 'TOKEN_FILE', self.token_path)
        self.token_patcher.start()
        self._reset_oauth_state()

    def tearDown(self):
        self._reset_oauth_state()
        self.token_patcher.stop()
        self.temp_dir.cleanup()

    def _reset_oauth_state(self):
        with self.oauth_module._oauth_lock:
            self.oauth_module._oauth_state.update({
                'in_progress': False,
                'auth_url': None,
                'error': None,
                'flow': None,
                'expected_state': None,
                'phase': 'idle',
                'generation': 0,
                'completion_event': threading.Event(),
            })

    def _set_pending_flow(self):
        flow = MagicMock()
        flow.credentials.to_json.return_value = '{"token":"new-token"}'
        completion_event = threading.Event()
        with self.oauth_module._oauth_lock:
            self.oauth_module._oauth_state.update({
                'in_progress': True,
                'auth_url': 'https://accounts.example/?state=private-state',
                'error': None,
                'flow': flow,
                'expected_state': 'private-state',
                'phase': 'awaiting_callback',
                'generation': 1,
                'completion_event': completion_event,
            })
        return flow, completion_event

    def test_delete_logs_out_once_and_returns_safe_state(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"existing-token"}')
        _, completion_event = self._set_pending_flow()

        with patch.object(
            self.service, 'logout_oauth', wraps=self.service.logout_oauth
        ) as logout_oauth:
            response = self.client.delete(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {
            'status': 'ok',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth authorization cancelled.',
        })
        logout_oauth.assert_called_once_with()
        self.assertTrue(completion_event.is_set())
        serialized = json.dumps(response.data)
        self.assertNotIn('private-state', serialized)
        self.assertNotIn('existing-token', serialized)

    def test_callback_after_logout_cannot_recreate_token(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"existing-token"}')
        flow, _ = self._set_pending_flow()

        logout_response = self.client.delete(self.url)
        callback_response = self.client.post(
            reverse('oauth-callback'),
            {'callback_url': self.callback_url},
            format='json',
        )

        self.assertEqual(logout_response.status_code, 200)
        self.assertFalse(logout_response.data['authenticated'])
        self.assertFalse(logout_response.data['in_progress'])
        self.assertIsNone(logout_response.data['auth_url'])
        self.assertEqual(callback_response.status_code, 400)
        self.assertFalse(callback_response.data['authenticated'])
        self.assertFalse(callback_response.data['in_progress'])
        self.assertIsNone(callback_response.data['auth_url'])
        self.assertFalse(os.path.exists(self.token_path))
        flow.fetch_token.assert_not_called()


class OAuthCallbackViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.url = reverse('oauth-callback')
        self.callback_url = (
            'http://localhost:8085/?state=private-state&code=private-code'
        )

    def assert_failed_response(self, response, error, *secrets):
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': error,
        })
        serialized = json.dumps(response.data)
        for secret in secrets:
            self.assertNotIn(secret, serialized)

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_success_and_idempotent_success_return_safe_oauth_state(self, complete_oauth):
        complete_oauth.return_value = {
            'authenticated': True,
            'in_progress': False,
            'auth_url': None,
            'error': None,
        }

        for attempt in ('genuine', 'idempotent'):
            with self.subTest(attempt=attempt):
                response = self.client.post(
                    self.url, {'callback_url': self.callback_url}, format='json'
                )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, {
                    'status': 'completed',
                    'authenticated': True,
                    'in_progress': False,
                    'auth_url': None,
                    'error': None,
                })
        self.assertEqual(complete_oauth.call_count, 2)
        complete_oauth.assert_called_with(self.callback_url)

    def test_rejects_missing_non_string_and_empty_callback_url(self):
        invalid_cases = [
            ('missing', {}, 'callback_url must be a string.', ()),
            (
                'non-string',
                {'callback_url': {'private-value': 'private-non-string-secret'}},
                'callback_url must be a string.',
                ('private-value', 'private-non-string-secret'),
            ),
            ('null', {'callback_url': None}, 'callback_url must be a string.', ()),
            ('empty', {'callback_url': ''}, 'callback_url must not be empty.', ()),
        ]

        for name, payload, error, secrets in invalid_cases:
            with self.subTest(name=name):
                response = self.client.post(self.url, payload, format='json')
                self.assert_failed_response(response, error, *secrets)

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_rejects_non_object_json_body_without_echoing_it(self, complete_oauth):
        secret_body = 'private-non-object-body-secret'

        response = self.client.generic(
            'POST', self.url, json.dumps(secret_body), content_type='application/json'
        )

        self.assert_failed_response(
            response, 'callback_url must be a string.', secret_body
        )
        complete_oauth.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_rejects_too_long_callback_url_without_calling_service(self, complete_oauth):
        secret = 'private-oversized-value'
        callback_url = secret + 'x' * OAuthCallbackView.MAX_CALLBACK_URL_LENGTH
        response = self.client.post(
            self.url,
            {'callback_url': callback_url},
            format='json',
        )

        self.assert_failed_response(
            response, 'callback_url is too long.', secret, callback_url
        )
        complete_oauth.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_rejects_oversized_request_without_calling_service(self, complete_oauth):
        secret = 'private-oversized-body-secret'
        body = json.dumps({
            'callback_url': 'http://localhost:8085/?state=s&code=c',
            'padding': secret + 'x' * 2_621_440,
        })

        response = self.client.generic(
            'POST', self.url, body, content_type='application/json'
        )

        self.assert_failed_response(
            response, 'OAuth callback request is too large.', secret, body
        )
        complete_oauth.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_rejects_malformed_json_with_safe_terminal_schema(self, complete_oauth):
        malformed_body = '{"callback_url":"private-code"'

        response = self.client.generic(
            'POST', self.url, malformed_body, content_type='application/json'
        )

        self.assert_failed_response(
            response,
            'OAuth callback request contains invalid JSON.',
            'private-code',
            malformed_body,
        )
        complete_oauth.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_rejects_unsupported_media_type_with_safe_terminal_schema(
        self, complete_oauth
    ):
        secret_body = 'private-code=secret-value'

        response = self.client.generic(
            'POST', self.url, secret_body, content_type='text/plain'
        )

        self.assert_failed_response(
            response,
            'OAuth callback request has an unsupported media type.',
            'private-code',
            'secret-value',
            secret_body,
        )
        complete_oauth.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_service_exception_returns_safe_terminal_schema(self, complete_oauth):
        secret = 'private-service-secret'
        complete_oauth.side_effect = RuntimeError(f'exchange failed: {secret}')

        response = self.client.post(
            self.url, {'callback_url': self.callback_url}, format='json'
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth completion failed.',
        })
        self.assertNotIn(secret, json.dumps(response.data))
        complete_oauth.assert_called_once_with(self.callback_url)

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_failure_returns_400_and_failed_state(self, complete_oauth):
        complete_oauth.return_value = {
            'authenticated': False,
            'in_progress': False,
            'auth_url': 'https://accounts.example/?state=private-state',
            'error': 'OAuth callback state did not match.',
        }

        response = self.client.post(
            self.url, {'callback_url': self.callback_url}, format='json'
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth callback state did not match.',
        })

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_untrusted_service_errors_are_replaced_with_generic_error(
        self, complete_oauth
    ):
        unknown_secret = 'private-service-result-secret'
        error_cases = [
            f'Exchange rejected: {unknown_secret}',
            ' OAuth callback state did not match.',
            123,
            'x' * 1025,
        ]

        for service_error in error_cases:
            with self.subTest(service_error=service_error):
                complete_oauth.return_value = {
                    'authenticated': False,
                    'in_progress': False,
                    'auth_url': None,
                    'error': service_error,
                }

                response = self.client.post(
                    self.url, {'callback_url': self.callback_url}, format='json'
                )

                secrets = (unknown_secret,) if unknown_secret in str(service_error) else ()
                self.assert_failed_response(
                    response, OAuthCallbackView.GENERIC_ERROR, *secrets
                )

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_failed_callback_normalization_does_not_mutate_oauth_state(
        self, complete_oauth
    ):
        from subscriptions.youtube_service import YouTubeService

        complete_oauth.return_value = {
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth callback state did not match.',
        }

        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            YouTubeService, 'TOKEN_FILE', os.path.join(temp_dir, 'token.json')
        ):
            state_before = self.client.get(reverse('oauth')).data
            callback_response = self.client.post(
                self.url, {'callback_url': self.callback_url}, format='json'
            )
            state_after = self.client.get(reverse('oauth')).data

        self.assertEqual(callback_response.status_code, 400)
        self.assertEqual(callback_response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth callback state did not match.',
        })
        self.assertEqual(state_after, state_before)
        complete_oauth.assert_called_once_with(self.callback_url)

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_error_with_pre_existing_authentication_returns_failed(self, complete_oauth):
        complete_oauth.return_value = {
            'authenticated': True,
            'in_progress': False,
            'auth_url': None,
            'error': 'Invalid OAuth callback URL.',
        }

        response = self.client.post(
            self.url, {'callback_url': self.callback_url}, format='json'
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'Invalid OAuth callback URL.',
        })

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_authenticated_nonterminal_result_returns_failed(self, complete_oauth):
        complete_oauth.return_value = {
            'authenticated': True,
            'in_progress': True,
            'auth_url': None,
            'error': None,
        }

        response = self.client.post(
            self.url, {'callback_url': self.callback_url}, format='json'
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {
            'status': 'failed',
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth completion failed.',
        })

    @patch('subscriptions.youtube_service.YouTubeService.complete_oauth')
    def test_response_does_not_echo_callback_secrets(self, complete_oauth):
        complete_oauth.return_value = {
            'authenticated': False,
            'in_progress': True,
            'auth_url': None,
            'error': 'Invalid OAuth callback URL.',
        }

        response = self.client.post(
            self.url, {'callback_url': self.callback_url}, format='json'
        )

        serialized = json.dumps(response.data)
        self.assertNotIn(self.callback_url, serialized)
        self.assertNotIn('private-code', serialized)
        self.assertNotIn('private-state', serialized)
        self.assertNotIn('callback_url', serialized)

    def test_get_is_not_allowed(self):
        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 405)

    def test_callback_route_resolves_before_oauth_route(self):
        match = resolve('/api/auth/oauth/callback/')

        self.assertIs(match.func.view_class, OAuthCallbackView)
        self.assertEqual(match.url_name, 'oauth-callback')