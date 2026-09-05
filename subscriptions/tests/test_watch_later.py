from unittest.mock import MagicMock, patch

import requests
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from subscriptions.youtube_service import YouTubeInnerTubeAPI, YouTubeService


class WatchLaterServiceTest(SimpleTestCase):
    @patch('subscriptions.youtube_service.http_requests.post')
    def test_fetches_watch_later_with_existing_oauth_and_normalizes_items(self, post):
        post.return_value.status_code = 200
        post.return_value.json.return_value = {
            'contents': {'playlistVideoListRenderer': {'contents': [
                {'playlistVideoRenderer': {
                    'videoId': 'video-one', 'setVideoId': 'item-one',
                    'title': {'runs': [{'text': 'First video'}]},
                    'shortBylineText': {'runs': [{
                        'text': 'Channel',
                        'navigationEndpoint': {'browseEndpoint': {'browseId': 'UC_channel'}},
                    }]},
                    'thumbnail': {'thumbnails': [{'url': 'https://i.ytimg.com/vi/video-one/hqdefault.jpg'}]},
                    'lengthSeconds': '125',
                }},
                {'continuationItemRenderer': {'continuationEndpoint': {
                    'continuationCommand': {'token': 'next-page'},
                }}},
            ]}},
        }
        client = YouTubeInnerTubeAPI(MagicMock(token='synthetic-token'))

        items, token = client.fetch_watch_later()

        self.assertEqual(token, 'next-page')
        self.assertEqual(items[0]['id'], 'item-one')
        self.assertEqual(items[0]['snippet']['resourceId']['videoId'], 'video-one')
        self.assertEqual(items[0]['snippet']['title'], 'First video')
        self.assertEqual(items[0]['snippet']['videoOwnerChannelId'], 'UC_channel')
        self.assertEqual(items[0]['duration_seconds'], 125)
        self.assertEqual(post.call_args.kwargs['json']['browseId'], 'VLWL')
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer synthetic-token')
        self.assertEqual(post.call_args.kwargs['timeout'], 30)
        self.assertFalse(post.call_args.kwargs['allow_redirects'])

    def test_watch_later_is_first_and_not_duplicated(self):
        service = YouTubeService.__new__(YouTubeService)
        service.public = MagicMock()
        service.public.fetch_playlists.return_value = [
            {'id': 'PL_normal'}, {'id': 'WL'},
        ]
        playlists = service.fetch_playlists()
        self.assertEqual([item['id'] for item in playlists], ['WL', 'PL_normal'])
        self.assertEqual(playlists[0]['snippet']['title'], 'Watch Later')
        self.assertTrue(playlists[0]['read_only'])

    def test_watch_later_routes_to_innertube_only(self):
        service = YouTubeService.__new__(YouTubeService)
        service.public = MagicMock()
        service.innertube = MagicMock()
        service.innertube.fetch_watch_later.return_value = ([], 'next')
        self.assertEqual(service.fetch_playlist_items('WL', 20, 'page'), ([], 'next'))
        service.innertube.fetch_watch_later.assert_called_once_with('page')
        service.public.fetch_playlist_items.assert_not_called()

    @patch('subscriptions.youtube_service.http_requests.post')
    def test_tv_tiles_and_continuation_use_oauth_without_cookies(self, post):
        post.return_value.status_code = 200
        post.return_value.json.return_value = {'continuationContents': {'gridContinuation': {
            'items': [{'tileRenderer': {
                'contentId': 'tv-video', 'contentType': 'TILE_CONTENT_TYPE_VIDEO',
                'metadata': {'tileMetadataRenderer': {'title': {'simpleText': 'TV video'}}},
                'header': {'tileHeaderRenderer': {
                    'thumbnail': {'thumbnails': [{'url': '//i.ytimg.com/vi/tv-video/hqdefault.jpg'}]},
                    'thumbnailOverlays': [{'thumbnailOverlayTimeStatusRenderer': {
                        'text': {'simpleText': '1:02:03'},
                    }}],
                }},
            }}],
            'continuations': [{'nextContinuationData': {'continuation': 'last-page'}}],
        }}}
        client = YouTubeInnerTubeAPI(MagicMock(token='synthetic-token'))
        items, token = client.fetch_watch_later('page-two')
        self.assertEqual(token, 'last-page')
        self.assertEqual(items[0]['snippet']['title'], 'TV video')
        self.assertEqual(items[0]['duration_seconds'], 3723)
        self.assertEqual(post.call_args.kwargs['json'], {
            'context': client._INNERTUBE_CONTEXT, 'continuation': 'page-two',
        })
        self.assertNotIn('cookies', post.call_args.kwargs)

    def test_append_continuation_and_missing_items(self):
        items, token = YouTubeInnerTubeAPI._parse_watch_later({
            'onResponseReceivedActions': [{'appendContinuationItemsAction': {
                'continuationItems': [
                    {'playlistVideoRenderer': {'videoId': 'hidden', 'isPlayable': False}},
                    {'playlistVideoRenderer': {'title': {'simpleText': 'Deleted'}}},
                    {'playlistVideoRenderer': {'videoId': 'visible', 'title': {'simpleText': 'Visible'}}},
                ],
            }}],
        })
        self.assertIsNone(token)
        self.assertEqual([item['snippet']['resourceId']['videoId'] for item in items], ['visible'])

    def test_empty_playlist_and_unselected_recommendations(self):
        result = YouTubeInnerTubeAPI._parse_watch_later({'contents': {
            'twoColumnBrowseResultsRenderer': {
                'tabs': [
                    {'tabRenderer': {'selected': True, 'content': {'playlistVideoListRenderer': {'contents': []}}}},
                    {'tabRenderer': {'selected': False, 'content': {'gridRenderer': {'items': [
                        {'videoRenderer': {'videoId': 'recommendation'}},
                    ]}}}},
                ],
                'secondaryContents': {'gridRenderer': {'items': [
                    {'videoRenderer': {'videoId': 'another-recommendation'}},
                ]}},
            },
        }})
        self.assertEqual(result, ([], None))

    @patch('subscriptions.youtube_service.http_requests.post')
    def test_failures_are_sanitized_and_not_reported_as_empty(self, post):
        client = YouTubeInnerTubeAPI(MagicMock(token='synthetic-token'))
        for payload in (
            {'error': {'message': 'synthetic-private-error'}},
            {'alerts': [{'alertRenderer': {'type': 'ERROR', 'text': 'synthetic-private-error'}}]},
            {'contents': {'gridRenderer': {'items': [{'signInRenderer': {}}]}}},
            {'contents': {'gridRenderer': {'items': [None]}}},
            {'contents': {'playlistVideoListRenderer': {'contents': [], 'continuations': [
                {'nextContinuationData': {'continuation': {'unexpected': 'object'}}},
            ]}}},
            {}, [], None,
        ):
            with self.subTest(payload=payload):
                post.return_value.status_code = 200
                post.return_value.json.return_value = payload
                with self.assertRaisesRegex(RuntimeError, 'Watch Later is unavailable') as caught:
                    client.fetch_watch_later()
                self.assertNotIn('synthetic-private-error', str(caught.exception))
        post.side_effect = requests.Timeout('synthetic-token')
        with self.assertRaises(RuntimeError) as caught:
            client.fetch_watch_later()
        self.assertNotIn('synthetic-token', str(caught.exception))

    @patch('subscriptions.youtube_service.http_requests.post')
    def test_redirect_and_repeated_continuation_are_rejected(self, post):
        client = YouTubeInnerTubeAPI(MagicMock(token='synthetic-token'))
        post.return_value.status_code = 302
        with self.assertRaises(RuntimeError):
            client.fetch_watch_later()
        post.return_value.status_code = 200
        post.return_value.json.return_value = {'continuationContents': {'gridContinuation': {
            'items': [], 'continuations': [{'nextContinuationData': {'continuation': 'same'}}],
        }}}
        with self.assertRaises(RuntimeError):
            client.fetch_watch_later('same')

    def test_normal_playlists_still_use_public_api(self):
        service = YouTubeService.__new__(YouTubeService)
        service.public = MagicMock()
        service.innertube = MagicMock()
        service.fetch_playlist_items('PL_normal', 20, 'next')
        service.public.fetch_playlist_items.assert_called_once_with('PL_normal', 20, 'next')
        service.innertube.fetch_watch_later.assert_not_called()


class WatchLaterAPITest(APITestCase):
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_list_exposes_unknown_count_and_read_only_flag(self, service):
        service.return_value.fetch_playlists.return_value = [
            {'id': 'WL', 'snippet': {'title': 'Watch Later'},
             'contentDetails': {'itemCount': None}},
            {'id': 'PL_normal', 'snippet': {'title': 'Normal'},
             'contentDetails': {'itemCount': 3}},
        ]
        response = self.client.get('/api/playlists/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data[0]['id'], 'WL')
        self.assertIsNone(response.data[0]['item_count'])
        self.assertTrue(response.data[0]['read_only'])
        self.assertFalse(response.data[1]['read_only'])

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_items_without_local_video_have_thumbnail_duration_and_continuation(self, service):
        service.return_value.fetch_playlist_items.return_value = ([{
            'id': 'item-one', 'duration_seconds': 125,
            'snippet': {
                'resourceId': {'videoId': 'video-one'}, 'title': 'Video',
                'thumbnails': {'medium': {'url': 'https://i.ytimg.com/vi/video-one/hqdefault.jpg'}},
            },
        }], 'next')
        response = self.client.get('/api/playlists/WL/items/', {'page_token': 'first'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['has_more'])
        self.assertEqual(response.data['next_page_token'], 'next')
        self.assertEqual(response.data['items'][0]['duration_seconds'], 125)
        self.assertEqual(response.data['items'][0]['thumbnail_url'],
                         'https://i.ytimg.com/vi/video-one/hqdefault.jpg')
        service.return_value.fetch_playlist_items.assert_called_once_with(
            'WL', max_results=20, page_token='first',
        )

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_watch_later_mutations_are_rejected_before_service_construction(self, service):
        requests = [
            self.client.delete('/api/playlists/WL/'),
            self.client.delete('/api/playlists/WL/items/item-one/'),
            self.client.post('/api/playlists/WL/items/', {'video_id': 'video-one'}),
            self.client.post('/api/playlists/WL/items/reorder/', {}, format='json'),
        ]
        for response in requests:
            self.assertEqual(response.status_code, 405)
        service.assert_not_called()

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_cast_follows_watch_later_continuations(self, service):
        service.return_value.fetch_playlist_items.side_effect = [
            ([{'snippet': {'resourceId': {'videoId': 'first'}}}], 'next'),
            ([{'snippet': {'resourceId': {'videoId': 'second'}}}], None),
        ]
        service.return_value.cast_to_receiver.return_value = {'status': 'ok'}
        response = self.client.post('/api/playlists/WL/cast/', {'screen_id': 'synthetic-screen'})
        self.assertEqual(response.status_code, 200)
        service.return_value.cast_to_receiver.assert_called_once_with('synthetic-screen', ['first', 'second'])

    @patch('subscriptions.youtube_service.YouTubeService')
    def test_failure_returns_error_instead_of_empty_playlist(self, service):
        service.return_value.fetch_playlist_items.side_effect = RuntimeError('Watch Later is unavailable')
        with self.assertLogs('subscriptions.views', level='ERROR'):
            response = self.client.get('/api/playlists/WL/items/')
        self.assertEqual(response.status_code, 502)
        self.assertIn('Watch Later is unavailable', response.data['error'])
        self.assertNotIn('items', response.data)