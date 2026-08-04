import json
import io
import os
import tempfile
import threading
from unittest.mock import MagicMock, patch

import requests
from django.test import TestCase


class YouTubeServiceOAuthTest(TestCase):
    def setUp(self):
        from subscriptions import youtube_service

        self.module = youtube_service
        self.service = youtube_service.YouTubeService
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
        with self.module._oauth_lock:
            self.module._oauth_state.update({
                'in_progress': False,
                'auth_url': None,
                'error': None,
                'flow': None,
                'expected_state': None,
                'phase': 'idle',
                'generation': 0,
                'completion_event': threading.Event(),
            })

    def _awaiting_flow(self, state='expected-state'):
        flow = MagicMock()
        flow.credentials.to_json.return_value = '{"token":"saved-token"}'
        with self.module._oauth_lock:
            self.module._oauth_state.update({
                'in_progress': True,
                'auth_url': f'https://accounts.example/authorize?state={state}',
                'error': None,
                'flow': flow,
                'expected_state': state,
                'phase': 'awaiting_callback',
                'generation': 1,
                'completion_event': threading.Event(),
            })
        return flow

    def test_rejects_non_exact_callback_base_and_oversized_url(self):
        flow = self._awaiting_flow()
        invalid_urls = [
            'https://localhost:8085/?state=expected-state&code=secret',
            'http://127.0.0.1:8085/?state=expected-state&code=secret',
            'http://user@localhost:8085/?state=expected-state&code=secret',
            'http://localhost:8086/?state=expected-state&code=secret',
            'http://localhost:8085/callback?state=expected-state&code=secret',
            'http://localhost:8085/?state=expected-state&code=secret#fragment',
            'http://LOCALHOST:8085/?state=expected-state&code=secret',
            'http://localhost:8085/?state=expected-state&code=' + ('x' * 9000),
        ]

        for callback_url in invalid_urls:
            with self.subTest(callback_url=callback_url[:80]):
                result = self.service.complete_oauth(callback_url)
                self.assertEqual(result['error'], 'Invalid OAuth callback URL.')
        flow.fetch_token.assert_not_called()

    def test_rejects_malformed_duplicate_and_missing_parameters(self):
        flow = self._awaiting_flow()
        invalid_queries = [
            'state=expected-state&state=other&code=secret',
            'state=expected-state&code=one&code=two',
            'state=expected-state&code=secret&error=access_denied',
            'state=expected-state',
            'code=secret',
            'state=&code=secret',
            'state=expected-state&code=',
            'state=expected-state&code=secret&broken',
            'state=expected%ZZstate&code=secret',
        ]

        for query in invalid_queries:
            with self.subTest(query=query):
                result = self.service.complete_oauth(f'http://localhost:8085/?{query}')
                self.assertTrue(result['error'])
        flow.fetch_token.assert_not_called()

    def test_callback_query_length_boundary(self):
        base_query = 'state=expected-state&code=secret&padding='
        exact_query = base_query + ('x' * (self.service.MAX_CALLBACK_QUERY_LENGTH - len(base_query)))

        params = self.service._parse_oauth_callback(
            f'http://localhost:8085/?{exact_query}'
        )

        self.assertEqual(params['state'], 'expected-state')
        self.assertEqual(params['code'], 'secret')
        self.assertEqual(len(exact_query), 4096)
        with self.assertRaisesRegex(ValueError, 'Invalid OAuth callback URL'):
            self.service._parse_oauth_callback(
                f'http://localhost:8085/?{exact_query}x'
            )

    def test_callback_total_url_length_boundary(self):
        prefix = 'http://localhost:8085/?'
        base_query = 'state=expected-state&code=secret&padding='
        exact_query = base_query + (
            'x' * (self.service.MAX_CALLBACK_URL_LENGTH - len(prefix) - len(base_query))
        )

        with patch.object(
            self.service,
            'MAX_CALLBACK_QUERY_LENGTH',
            self.service.MAX_CALLBACK_URL_LENGTH,
        ):
            params = self.service._parse_oauth_callback(f'{prefix}{exact_query}')
            self.assertEqual(params['state'], 'expected-state')
            self.assertEqual(len(f'{prefix}{exact_query}'), 8192)
            with self.assertRaisesRegex(ValueError, 'Invalid OAuth callback URL'):
                self.service._parse_oauth_callback(f'{prefix}{exact_query}x')

    def test_rejects_unsolicited_and_stale_callback(self):
        callback_url = 'http://localhost:8085/?state=stale&code=secret'

        result = self.service.complete_oauth(callback_url)

        self.assertEqual(result['error'], 'No OAuth flow is awaiting this callback.')
        self.assertFalse(result['in_progress'])

    def test_state_mismatch_is_rejected_before_exchange(self):
        flow = self._awaiting_flow()
        callback_url = 'http://localhost:8085/?state=wrong&code=super-secret-code'

        result = self.service.complete_oauth(callback_url)

        self.assertEqual(result['error'], 'OAuth callback state did not match.')
        flow.fetch_token.assert_not_called()

    def test_token_exchange_error_is_sanitized(self):
        flow = self._awaiting_flow()
        flow.fetch_token.side_effect = RuntimeError('failure with code super-secret-code')
        callback_url = 'http://localhost:8085/?state=expected-state&code=super-secret-code'

        with self.assertLogs('subscriptions.youtube_service', level='ERROR') as logs:
            result = self.service.complete_oauth(callback_url)

        flow.fetch_token.assert_called_once_with(authorization_response=callback_url)
        self.assertEqual(result['error'], 'OAuth token exchange failed.')
        self.assertNotIn('super-secret-code', '\n'.join(logs.output))

    def test_access_denied_is_readable_and_skips_exchange(self):
        flow = self._awaiting_flow()

        result = self.service.complete_oauth(
            'http://localhost:8085/?state=expected-state&error=access_denied'
        )

        self.assertEqual(result['error'], 'OAuth authorization was denied by the user.')
        self.assertFalse(result['in_progress'])
        flow.fetch_token.assert_not_called()

    def test_success_saves_atomically_and_cleans_runtime_state(self):
        flow = self._awaiting_flow()
        callback_url = 'http://localhost:8085/?state=expected-state&code=secret-code'

        with patch('subscriptions.youtube_service.os.replace', wraps=os.replace) as replace:
            result = self.service.complete_oauth(callback_url)

        self.assertTrue(result['authenticated'])
        self.assertFalse(result['in_progress'])
        self.assertIsNone(result['auth_url'])
        self.assertIsNone(result['error'])
        replace.assert_called_once()
        self.assertNotEqual(replace.call_args.args[0], self.token_path)
        self.assertEqual(replace.call_args.args[1], os.path.abspath(self.token_path))
        with open(self.token_path) as token_file:
            self.assertEqual(json.load(token_file), {'token': 'saved-token'})
        with self.module._oauth_lock:
            self.assertIsNone(self.module._oauth_state['flow'])

    def test_get_state_is_json_safe_and_exposes_only_public_fields(self):
        self._awaiting_flow(state='private-state')

        with patch('subscriptions.youtube_service.logger') as logger:
            result = self.service.get_oauth_state()

        self.assertEqual(set(result), {'authenticated', 'in_progress', 'auth_url', 'error'})
        serialized = json.dumps(result)
        self.assertIn('state=private-state', result['auth_url'])
        self.assertNotIn('saved-token', serialized)
        self.assertNotIn('secret-code', serialized)
        self.assertNotIn('callback_url', serialized)
        logger.assert_not_called()

    def test_cancel_clears_runtime_state_and_signals_listener(self):
        self._awaiting_flow()
        with self.module._oauth_lock:
            completion_event = self.module._oauth_state['completion_event']

        result = self.service.cancel_oauth()

        self.assertFalse(result['in_progress'])
        self.assertIsNone(result['auth_url'])
        self.assertEqual(result['error'], 'OAuth authorization cancelled.')
        self.assertTrue(completion_event.is_set())
        with self.module._oauth_lock:
            self.assertIsNone(self.module._oauth_state['flow'])
            self.assertIsNone(self.module._oauth_state['expected_state'])
            self.assertEqual(self.module._oauth_state['phase'], 'cancelled')
            self.assertEqual(self.module._oauth_state['generation'], 2)

    def test_cancel_during_exchange_prevents_callback_token_recreation(self):
        flow = self._awaiting_flow()
        exchange_started = threading.Event()
        release_exchange = threading.Event()

        def blocked_exchange(**kwargs):
            exchange_started.set()
            release_exchange.wait(2)

        flow.fetch_token.side_effect = blocked_exchange
        callback_url = 'http://localhost:8085/?state=expected-state&code=secret-code'
        callback_result = {}
        thread = threading.Thread(
            target=lambda: callback_result.update(self.service.complete_oauth(callback_url))
        )

        with patch.object(self.service, '_save_credentials') as save_credentials:
            thread.start()
            self.assertTrue(exchange_started.wait(1))
            self.service.cancel_oauth()
            with open(self.token_path, 'w') as token_file:
                token_file.write('{"token":"logged-out-token"}')
            os.remove(self.token_path)
            release_exchange.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertFalse(os.path.exists(self.token_path))
        self.assertFalse(callback_result['authenticated'])
        self.assertEqual(callback_result['error'], 'OAuth authorization cancelled.')
        save_credentials.assert_not_called()

    def test_cancel_after_completed_save_preserves_token(self):
        self._awaiting_flow()
        self.service.complete_oauth(
            'http://localhost:8085/?state=expected-state&code=secret-code'
        )

        result = self.service.cancel_oauth()

        self.assertTrue(result['authenticated'])
        self.assertTrue(os.path.exists(self.token_path))
        with open(self.token_path) as token_file:
            self.assertEqual(json.load(token_file), {'token': 'saved-token'})

    def test_logout_blocks_new_refresh_until_old_token_is_deleted(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"old-token"}')
        delete_started = threading.Event()
        release_delete = threading.Event()
        refresh_started = threading.Event()
        token_load_started = threading.Event()
        result = {}
        original_remove = os.remove

        def blocked_remove(path):
            delete_started.set()
            release_delete.wait(2)
            original_remove(path)

        def load_credentials():
            refresh_started.set()
            try:
                result['credentials'] = self.service.__new__(self.service)._get_credentials()
            except Exception as exc:
                result['error'] = exc

        def observe_token_load(*args, **kwargs):
            token_load_started.set()
            return MagicMock(valid=True)

        logout_thread = threading.Thread(target=self.service.logout_oauth)
        refresh_thread = threading.Thread(target=load_credentials)

        with (
            patch('subscriptions.youtube_service.os.remove', side_effect=blocked_remove),
            patch(
                'subscriptions.youtube_service.Credentials.from_authorized_user_file',
                side_effect=observe_token_load,
            ) as load_token,
            patch.object(
                self.service,
                'CLIENT_SECRETS_FILE',
                os.path.join(self.temp_dir.name, 'missing-client-secret.json'),
            ),
            patch.object(self.service, '_save_credentials') as save_credentials,
        ):
            logout_thread.start()
            self.assertTrue(delete_started.wait(1))
            refresh_thread.start()
            self.assertTrue(refresh_started.wait(1))
            self.assertFalse(token_load_started.wait(0.1))
            release_delete.set()
            logout_thread.join(2)
            refresh_thread.join(2)

        self.assertFalse(logout_thread.is_alive())
        self.assertFalse(refresh_thread.is_alive())
        self.assertFalse(os.path.exists(self.token_path))
        self.assertIsInstance(result.get('error'), FileNotFoundError)
        self.assertNotIn('credentials', result)
        load_token.assert_not_called()
        save_credentials.assert_not_called()

    def test_logout_is_idempotent_when_token_is_missing(self):
        first_result = self.service.logout_oauth()
        second_result = self.service.logout_oauth()

        self.assertFalse(first_result['authenticated'])
        self.assertFalse(second_result['authenticated'])
        with self.module._oauth_lock:
            self.assertEqual(self.module._oauth_state['generation'], 2)

    def test_refresh_completing_after_cancel_does_not_recreate_token(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"expired-token"}')
        credentials = MagicMock(valid=False, expired=True, refresh_token='refresh-token')
        refresh_started = threading.Event()
        release_refresh = threading.Event()
        result = {}

        def blocked_refresh(request):
            refresh_started.set()
            release_refresh.wait(2)
            credentials.valid = True

        def load_credentials():
            try:
                result['credentials'] = self.service.__new__(self.service)._get_credentials()
            except Exception as exc:
                result['error'] = exc

        credentials.refresh.side_effect = blocked_refresh
        thread = threading.Thread(target=load_credentials)

        with (
            patch(
                'subscriptions.youtube_service.Credentials.from_authorized_user_file',
                return_value=credentials,
            ),
            patch('subscriptions.youtube_service.Request'),
            patch.object(self.service, '_save_credentials') as save_credentials,
        ):
            thread.start()
            self.assertTrue(refresh_started.wait(1))
            self.service.cancel_oauth()
            os.remove(self.token_path)
            release_refresh.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get('error'), PermissionError)
        self.assertNotIn('credentials', result)
        self.assertFalse(os.path.exists(self.token_path))
        save_credentials.assert_not_called()

    def test_refresh_failure_tolerates_token_deleted_by_logout(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"expired-token"}')
        client_secrets_path = os.path.join(self.temp_dir.name, 'client_secret.json')
        with open(client_secrets_path, 'w') as client_secrets_file:
            client_secrets_file.write('{}')
        credentials = MagicMock(valid=False, expired=True, refresh_token='refresh-token')
        refresh_started = threading.Event()
        release_refresh = threading.Event()
        result = {}

        def failed_refresh(request):
            refresh_started.set()
            release_refresh.wait(2)
            raise RuntimeError('refresh failed')

        def load_credentials():
            try:
                self.service.__new__(self.service)._get_credentials()
            except Exception as exc:
                result['error'] = exc

        credentials.refresh.side_effect = failed_refresh
        thread = threading.Thread(target=load_credentials)

        with (
            patch(
                'subscriptions.youtube_service.Credentials.from_authorized_user_file',
                return_value=credentials,
            ),
            patch('subscriptions.youtube_service.Request'),
            patch.object(self.service, 'CLIENT_SECRETS_FILE', client_secrets_path),
            patch.object(self.service, 'start_oauth') as start_oauth,
        ):
            thread.start()
            self.assertTrue(refresh_started.wait(1))
            os.remove(self.token_path)
            release_refresh.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get('error'), PermissionError)
        self.assertNotIsInstance(result.get('error'), FileNotFoundError)
        start_oauth.assert_called_once_with()

    def test_refresh_success_persists_credentials_atomically(self):
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"expired-token"}')
        credentials = MagicMock(valid=False, expired=True, refresh_token='refresh-token')
        credentials.to_json.return_value = '{"token":"refreshed-token"}'

        def successful_refresh(request):
            credentials.valid = True

        credentials.refresh.side_effect = successful_refresh
        with (
            patch(
                'subscriptions.youtube_service.Credentials.from_authorized_user_file',
                return_value=credentials,
            ),
            patch('subscriptions.youtube_service.Request') as request,
            patch('subscriptions.youtube_service.os.replace', wraps=os.replace) as replace,
        ):
            result = self.service.__new__(self.service)._get_credentials()

        self.assertIs(result, credentials)
        credentials.refresh.assert_called_once_with(request.return_value)
        replace.assert_called_once()
        with open(self.token_path) as token_file:
            self.assertEqual(json.load(token_file), {'token': 'refreshed-token'})

    def test_callback_exchange_waits_for_refresh_persistence(self):
        flow = self._awaiting_flow()
        with open(self.token_path, 'w') as token_file:
            token_file.write('{"token":"expired-token"}')
        credentials = MagicMock(valid=False, expired=True, refresh_token='refresh-token')
        credentials.to_json.return_value = '{"token":"refreshed-token"}'
        refresh_save_started = threading.Event()
        release_refresh_save = threading.Event()
        callback_exchange_started = threading.Event()
        original_save = self.service._save_credentials

        def successful_refresh(request):
            credentials.valid = True

        def serialized_save(saved_credentials):
            if saved_credentials is credentials:
                refresh_save_started.set()
                release_refresh_save.wait(2)
            original_save(saved_credentials)

        flow.fetch_token.side_effect = lambda **kwargs: callback_exchange_started.set()
        credentials.refresh.side_effect = successful_refresh
        refresh_thread = threading.Thread(
            target=self.service.__new__(self.service)._get_credentials
        )
        callback_thread = threading.Thread(
            target=lambda: self.service.complete_oauth(
                'http://localhost:8085/?state=expected-state&code=secret-code'
            )
        )

        with (
            patch(
                'subscriptions.youtube_service.Credentials.from_authorized_user_file',
                return_value=credentials,
            ),
            patch('subscriptions.youtube_service.Request'),
            patch.object(self.service, '_save_credentials', side_effect=serialized_save),
        ):
            refresh_thread.start()
            self.assertTrue(refresh_save_started.wait(1))
            callback_thread.start()
            self.assertFalse(callback_exchange_started.wait(0.1))
            release_refresh_save.set()
            refresh_thread.join(2)
            callback_thread.join(2)

        self.assertFalse(refresh_thread.is_alive())
        self.assertFalse(callback_thread.is_alive())
        self.assertTrue(callback_exchange_started.is_set())
        with open(self.token_path) as token_file:
            self.assertEqual(json.load(token_file), {'token': 'saved-token'})

    def test_concurrent_duplicate_runs_only_one_exchange(self):
        flow = self._awaiting_flow()
        exchange_started = threading.Event()
        release_exchange = threading.Event()

        def blocked_exchange(**kwargs):
            exchange_started.set()
            release_exchange.wait(2)

        flow.fetch_token.side_effect = blocked_exchange
        callback_url = 'http://localhost:8085/?state=expected-state&code=secret-code'
        winner_result = {}

        thread = threading.Thread(
            target=lambda: winner_result.update(self.service.complete_oauth(callback_url))
        )
        thread.start()
        self.assertTrue(exchange_started.wait(1))

        duplicate_result = self.service.complete_oauth(callback_url)
        release_exchange.set()
        thread.join(2)

        self.assertEqual(
            duplicate_result['error'],
            'OAuth completion is already in progress.',
        )
        self.assertTrue(winner_result['authenticated'])
        self.assertEqual(flow.fetch_token.call_count, 1)

    def test_duplicate_after_success_is_idempotent(self):
        flow = self._awaiting_flow()
        callback_url = 'http://localhost:8085/?state=expected-state&code=secret-code'

        first_result = self.service.complete_oauth(callback_url)
        duplicate_result = self.service.complete_oauth(callback_url)

        self.assertTrue(first_result['authenticated'])
        self.assertEqual(duplicate_result, first_result)
        self.assertEqual(flow.fetch_token.call_count, 1)

    def test_relay_completion_wakes_listener_and_preserves_redirect_uri(self):
        flow = MagicMock()
        flow.credentials.to_json.return_value = '{"token":"saved-token"}'
        server_closed = threading.Event()
        server_addresses = []
        lifecycle = []
        server_active = threading.Event()

        def assert_starting_unpublished():
            with self.module._oauth_lock:
                self.assertTrue(self.module._oauth_state['in_progress'])
                self.assertEqual(self.module._oauth_state['phase'], 'starting')
                self.assertIsNone(self.module._oauth_state['auth_url'])
                self.assertIsNone(self.module._oauth_state['flow'])
                self.assertIsNone(self.module._oauth_state['expected_state'])

        def authorization_url(**kwargs):
            self.assertTrue(server_active.is_set())
            assert_starting_unpublished()
            lifecycle.append('authorization_url')
            return 'https://accounts.example/authorize', 'expected-state'

        flow.authorization_url.side_effect = authorization_url

        class FakeServer:
            def __init__(self, address, handler):
                assert_starting_unpublished()
                server_addresses.append(address)
                lifecycle.append('server_constructed')
                self.socket = MagicMock()
                self.timeout = None

            def __enter__(self):
                assert_starting_unpublished()
                server_active.set()
                lifecycle.append('server_entered')
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                server_active.clear()
                server_closed.set()

            def handle_request(self):
                self.module_event.wait(0.01)

        FakeServer.module_event = self.module._oauth_state['completion_event']

        with (
            patch(
                'subscriptions.youtube_service.InstalledAppFlow.from_client_secrets_file',
                return_value=flow,
            ),
            patch('http.server.HTTPServer', FakeServer),
        ):
            auth_url = self.service.start_oauth()
            with self.module._oauth_lock:
                self.assertEqual(
                    self.module._oauth_state['phase'],
                    'awaiting_callback',
                )
                self.assertEqual(self.module._oauth_state['auth_url'], auth_url)
                self.assertIs(self.module._oauth_state['flow'], flow)
                self.assertEqual(
                    self.module._oauth_state['expected_state'],
                    'expected-state',
                )
            self.assertTrue(server_active.is_set())
            self.assertFalse(server_closed.is_set())
            with self.module._oauth_lock:
                FakeServer.module_event = self.module._oauth_state['completion_event']
            result = self.service.complete_oauth(
                'http://localhost:8085/?state=expected-state&code=secret-code'
            )
            self.assertTrue(server_closed.wait(1))

        self.assertEqual(auth_url, 'https://accounts.example/authorize')
        self.assertEqual(flow.redirect_uri, 'http://localhost:8085/')
        self.assertEqual(server_addresses, [('localhost', 8085)])
        self.assertEqual(
            lifecycle,
            ['server_constructed', 'server_entered', 'authorization_url'],
        )
        self.assertTrue(result['authenticated'])
        self.assertIsNone(self.service.get_oauth_state()['error'])

    def test_listener_bind_failure_never_exposes_authorization(self):
        flow = MagicMock()
        bind_state = {}

        def fail_bind(address, handler):
            with self.module._oauth_lock:
                bind_state.update(self.module._oauth_state)
            raise OSError('bind failed code=secret-code state=expected-state')

        with (
            patch(
                'subscriptions.youtube_service.InstalledAppFlow.from_client_secrets_file',
                return_value=flow,
            ),
            patch('http.server.HTTPServer', side_effect=fail_bind),
            self.assertLogs('subscriptions.youtube_service', level='ERROR') as logs,
        ):
            auth_url = self.service.start_oauth()

        state = self.service.get_oauth_state()
        self.assertIsNone(auth_url)
        self.assertIsNone(state['auth_url'])
        self.assertFalse(state['in_progress'])
        self.assertEqual(state['error'], 'OAuth flow failed.')
        self.assertEqual(bind_state['phase'], 'starting')
        self.assertIsNone(bind_state['auth_url'])
        self.assertIsNone(bind_state['flow'])
        self.assertIsNone(bind_state['expected_state'])
        with self.module._oauth_lock:
            self.assertEqual(self.module._oauth_state['phase'], 'failed')
            self.assertIsNone(self.module._oauth_state['flow'])
            self.assertIsNone(self.module._oauth_state['expected_state'])
        flow.authorization_url.assert_not_called()
        self.assertFalse(os.path.exists(self.token_path))
        self.assertNotIn('secret-code', logs.output[0])
        self.assertNotIn('expected-state', logs.output[0])

    def test_listener_timeout_clears_published_flow_and_signals_completion(self):
        flow = MagicMock()
        flow.authorization_url.return_value = (
            'https://accounts.example/authorize',
            'expected-state',
        )
        server_closed = threading.Event()
        awaiting_snapshot = {}

        class FakeServer:
            def __init__(server_self, address, handler):
                server_self.socket = MagicMock()
                server_self.timeout = None

            def __enter__(server_self):
                return server_self

            def __exit__(server_self, exc_type, exc_value, traceback):
                with self.module._oauth_lock:
                    awaiting_snapshot.update(self.module._oauth_state)
                server_closed.set()

            def handle_request(server_self):
                self.fail('zero timeout must not handle a request')

        with (
            patch(
                'subscriptions.youtube_service.InstalledAppFlow.from_client_secrets_file',
                return_value=flow,
            ),
            patch('http.server.HTTPServer', FakeServer),
            patch.object(self.service, 'OAUTH_CALLBACK_TIMEOUT', 0),
        ):
            auth_url = self.service.start_oauth()
            self.assertTrue(server_closed.wait(1))

        with self.module._oauth_lock:
            completion_event = self.module._oauth_state['completion_event']
            self.assertEqual(self.module._oauth_state['phase'], 'failed')
            self.assertFalse(self.module._oauth_state['in_progress'])
            self.assertIsNone(self.module._oauth_state['auth_url'])
            self.assertIsNone(self.module._oauth_state['flow'])
            self.assertEqual(
                self.module._oauth_state['error'],
                'OAuth callback timed out (5 minutes)',
            )
        self.assertEqual(awaiting_snapshot['phase'], 'awaiting_callback')
        self.assertEqual(
            awaiting_snapshot['auth_url'],
            'https://accounts.example/authorize',
        )
        self.assertIs(awaiting_snapshot['flow'], flow)
        self.assertEqual(awaiting_snapshot['expected_state'], 'expected-state')
        self.assertTrue(completion_event.is_set())
        self.assertIn(auth_url, (None, 'https://accounts.example/authorize'))
        self.assertFalse(os.path.exists(self.token_path))

    def test_local_callback_handler_builds_exact_url_and_sanitizes_html(self):
        flow = MagicMock()
        flow.authorization_url.return_value = (
            'https://accounts.example/authorize',
            'expected-state',
        )
        handler_captured = threading.Event()
        callback_handled = threading.Event()
        captured = {}

        success = {
            'authenticated': True,
            'in_progress': False,
            'auth_url': None,
            'error': None,
        }
        failure = {
            'authenticated': False,
            'in_progress': False,
            'auth_url': None,
            'error': 'OAuth token exchange failed.',
        }

        def invoke_handler(handler_class, path):
            handler = handler_class.__new__(handler_class)
            handler.path = path
            handler.send_response = MagicMock()
            handler.send_header = MagicMock()
            handler.end_headers = MagicMock()
            handler.wfile = io.BytesIO()
            handler.do_GET()
            return handler

        class FakeServer:
            def __init__(server_self, address, handler):
                captured['handler_class'] = handler
                server_self.socket = MagicMock()
                server_self.timeout = None
                handler_captured.set()

            def __enter__(server_self):
                return server_self

            def __exit__(server_self, exc_type, exc_value, traceback):
                pass

            def handle_request(server_self):
                captured['success_handler'] = invoke_handler(
                    captured['handler_class'],
                    '/?state=expected-state&code=secret-code',
                )
                with self.module._oauth_lock:
                    self.module._oauth_state['completion_event'].set()
                callback_handled.set()

        with (
            patch(
                'subscriptions.youtube_service.InstalledAppFlow.from_client_secrets_file',
                return_value=flow,
            ),
            patch('http.server.HTTPServer', FakeServer),
            patch.object(
                self.service,
                'complete_oauth',
                side_effect=[success, failure],
            ) as complete_oauth,
        ):
            self.service.start_oauth()
            self.assertTrue(handler_captured.wait(1))
            self.assertTrue(callback_handled.wait(1))
            failure_handler = invoke_handler(
                captured['handler_class'],
                '/?state=expected-state&code=other-secret-code',
            )

        complete_oauth.assert_any_call(
            'http://localhost:8085/?state=expected-state&code=secret-code'
        )
        complete_oauth.assert_any_call(
            'http://localhost:8085/?state=expected-state&code=other-secret-code'
        )
        self.assertEqual(complete_oauth.call_count, 2)

        success_handler = captured['success_handler']
        success_handler.send_response.assert_called_once_with(200)
        success_handler.send_header.assert_called_once_with(
            'Content-type', 'text/html'
        )
        success_html = success_handler.wfile.getvalue()
        self.assertIn(b'Sign-in complete!', success_html)
        self.assertNotIn(b'secret-code', success_html)
        self.assertNotIn(b'expected-state', success_html)

        failure_handler.send_response.assert_called_once_with(200)
        failure_html = failure_handler.wfile.getvalue()
        self.assertIn(b'Sign-in failed', failure_html)
        self.assertNotIn(b'other-secret-code', failure_html)
        self.assertNotIn(b'expected-state', failure_html)

    def test_successful_relay_cannot_be_overwritten_by_listener_timeout(self):
        self._awaiting_flow()
        event = self.module._oauth_state['completion_event']

        result = self.service.complete_oauth(
            'http://localhost:8085/?state=expected-state&code=secret-code'
        )
        with self.module._oauth_lock:
            if self.module._oauth_state['phase'] == 'awaiting_callback':
                self.module._oauth_state['error'] = 'OAuth callback timed out (5 minutes)'

        self.assertTrue(event.is_set())
        self.assertTrue(result['authenticated'])
        self.assertIsNone(self.service.get_oauth_state()['error'])


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
