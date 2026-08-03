from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from subscriptions.models import (
    Category,
    Feed,
    Subscription,
    SubscriptionCategory,
    Video,
)


class FeedCRUDTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_create_feed(self):
        resp = self.client.post('/api/feeds/', {
            'name': 'My Feed',
            'filter_category_ids': [[1, 2]],
        }, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['name'], 'My Feed')

    def test_list_feeds(self):
        Feed.objects.create(name="Feed A", sort_order=0)
        Feed.objects.create(name="Feed B", sort_order=1)
        resp = self.client.get('/api/feeds/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 2)

    def test_update_feed(self):
        feed = Feed.objects.create(name="Old", sort_order=0)
        resp = self.client.put(f'/api/feeds/{feed.id}/', {
            'name': 'New',
            'sort_order': 0,
        }, format='json')
        self.assertEqual(resp.status_code, 200)
        feed.refresh_from_db()
        self.assertEqual(feed.name, 'New')

    def test_delete_feed(self):
        feed = Feed.objects.create(name="Delete Me", sort_order=0)
        resp = self.client.delete(f'/api/feeds/{feed.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Feed.objects.filter(pk=feed.pk).exists())


class FeedCreateOrderingTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_create_into_empty_table_gets_sort_order_zero(self):
        resp = self.client.post('/api/feeds/', {'name': 'First'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['sort_order'], 0)
        self.assertEqual(Feed.objects.get(name='First').sort_order, 0)

    def test_create_appends_after_highest_existing_sort_order(self):
        Feed.objects.create(name="A", sort_order=0)
        Feed.objects.create(name="B", sort_order=1)
        Feed.objects.create(name="C", sort_order=5)

        resp = self.client.post('/api/feeds/', {'name': 'D'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['sort_order'], 6)
        self.assertEqual(Feed.objects.get(name='D').sort_order, 6)

    def test_create_with_explicit_sort_order_is_honoured(self):
        Feed.objects.create(name="A", sort_order=0)
        Feed.objects.create(name="B", sort_order=1)

        resp = self.client.post('/api/feeds/', {'name': 'Pinned', 'sort_order': 3}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['sort_order'], 3)
        self.assertEqual(Feed.objects.get(name='Pinned').sort_order, 3)

    def test_create_with_explicit_sort_order_zero_is_honoured(self):
        # A client round-tripping a full Feed object sends sort_order=0 explicitly;
        # it must not be replaced by the auto-append value.
        Feed.objects.create(name="A", sort_order=0)
        Feed.objects.create(name="B", sort_order=1)

        resp = self.client.post('/api/feeds/', {'name': 'Zero', 'sort_order': 0}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['sort_order'], 0)
        self.assertEqual(Feed.objects.get(name='Zero').sort_order, 0)

    def test_create_with_explicit_null_sort_order_is_rejected(self):
        # Feed.sort_order is a non-nullable IntegerField, so the serializer rejects an
        # explicit null before perform_create's auto-append branch is ever reached.
        Feed.objects.create(name="A", sort_order=4)

        resp = self.client.post('/api/feeds/', {'name': 'Auto', 'sort_order': None}, format='json')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('sort_order', resp.json())


class FeedReorderTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.f1 = Feed.objects.create(name="A", sort_order=0)
        self.f2 = Feed.objects.create(name="B", sort_order=1)
        self.f3 = Feed.objects.create(name="C", sort_order=2)

    def _reorder(self, payload):
        return self.client.post('/api/feeds/reorder/', payload, format='json')

    def test_reorder(self):
        resp = self._reorder({'ordered_ids': [self.f3.id, self.f1.id, self.f2.id]})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'status': 'ok'})
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual(self.f3.sort_order, 0)
        self.assertEqual(self.f1.sort_order, 1)
        self.assertEqual(self.f2.sort_order, 2)

    def test_reorder_round_trips_through_list_endpoint(self):
        self._reorder({'ordered_ids': [self.f3.id, self.f1.id, self.f2.id]})
        resp = self.client.get('/api/feeds/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([f['id'] for f in resp.json()], [self.f3.id, self.f1.id, self.f2.id])

    def test_reorder_ignores_unknown_ids(self):
        resp = self._reorder({'ordered_ids': [self.f2.id, 99999, self.f1.id, self.f3.id]})
        self.assertEqual(resp.status_code, 200)
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual(self.f2.sort_order, 0)
        self.assertEqual(self.f1.sort_order, 2)
        self.assertEqual(self.f3.sort_order, 3)

    def test_reorder_empty_list_is_noop(self):
        resp = self._reorder({'ordered_ids': []})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'status': 'ok'})
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual([self.f1.sort_order, self.f2.sort_order, self.f3.sort_order], [0, 1, 2])

    def test_reorder_with_string_returns_400(self):
        resp = self._reorder({'ordered_ids': 'not-a-list'})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must be a list.'})

    def test_reorder_with_dict_returns_400(self):
        resp = self._reorder({'ordered_ids': {'0': self.f1.id}})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must be a list.'})

    def test_reorder_missing_ordered_ids_is_noop(self):
        # Current behaviour: the view defaults ordered_ids to [], so an omitted key is
        # treated as an empty list (200 no-op) rather than a 400 validation error.
        resp = self._reorder({})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'status': 'ok'})
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual([self.f1.sort_order, self.f2.sort_order, self.f3.sort_order], [0, 1, 2])

    def test_reorder_with_non_int_string_element_returns_400(self):
        resp = self._reorder({'ordered_ids': [self.f1.id, 'abc']})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must contain integers.'})

    def test_reorder_with_none_element_returns_400(self):
        resp = self._reorder({'ordered_ids': [self.f1.id, None]})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must contain integers.'})

    def test_reorder_with_nested_list_element_returns_400(self):
        resp = self._reorder({'ordered_ids': [[self.f1.id], self.f2.id]})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must contain integers.'})

    def test_reorder_with_invalid_element_leaves_sort_orders_unchanged(self):
        self._reorder({'ordered_ids': [self.f3.id, self.f2.id, 'abc']})
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual([self.f1.sort_order, self.f2.sort_order, self.f3.sort_order], [0, 1, 2])

    def test_reorder_with_more_than_1000_elements_returns_400(self):
        resp = self._reorder({'ordered_ids': list(range(1, 1002))})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {'error': 'ordered_ids must contain at most 1000 items.'})

    def test_reorder_with_exactly_1000_elements_is_accepted(self):
        ordered_ids = [self.f3.id, self.f2.id, self.f1.id] + list(range(10000, 10997))
        resp = self._reorder({'ordered_ids': ordered_ids})
        self.assertEqual(resp.status_code, 200)
        self.f1.refresh_from_db()
        self.f2.refresh_from_db()
        self.f3.refresh_from_db()
        self.assertEqual(self.f3.sort_order, 0)
        self.assertEqual(self.f2.sort_order, 1)
        self.assertEqual(self.f1.sort_order, 2)


class FeedVideosBaseTest(TestCase):
    """Base class that sets up channels, categories, and videos for feed filtering tests."""

    def setUp(self):
        self.client = APIClient()
        now = timezone.now()

        # Categories
        self.cat_prog = Category.objects.create(name="Programming", sort_order=0)
        self.cat_music = Category.objects.create(name="Music", sort_order=1)
        self.cat_gaming = Category.objects.create(name="Gaming", sort_order=2)

        # Subscriptions
        self.sub_prog = Subscription.objects.create(
            channel_id="UC_prog", channel_title="Programming Channel",
        )
        self.sub_music = Subscription.objects.create(
            channel_id="UC_music", channel_title="Music Channel",
        )
        self.sub_gaming = Subscription.objects.create(
            channel_id="UC_gaming", channel_title="Gaming Channel",
        )

        # Category assignments
        SubscriptionCategory.objects.create(subscription=self.sub_prog, category=self.cat_prog)
        SubscriptionCategory.objects.create(subscription=self.sub_music, category=self.cat_music)
        SubscriptionCategory.objects.create(subscription=self.sub_gaming, category=self.cat_gaming)

        # Videos for programming channel
        self.v_prog1 = Video.objects.create(
            video_id="v_prog1", channel_id="UC_prog", title="Python Tutorial",
            published_at=now - timedelta(days=1), duration_seconds=600,
            video_type="video", playback_progress=None,
        )
        self.v_prog2 = Video.objects.create(
            video_id="v_prog2", channel_id="UC_prog", title="JS Stream",
            published_at=now - timedelta(days=2), duration_seconds=7200,
            video_type="live", playback_progress=100,
        )

        # Videos for music channel
        self.v_music1 = Video.objects.create(
            video_id="v_music1", channel_id="UC_music", title="Song",
            published_at=now - timedelta(hours=6), duration_seconds=180,
            video_type="video", playback_progress=None,
        )

        # Videos for gaming channel
        self.v_gaming1 = Video.objects.create(
            video_id="v_gaming1", channel_id="UC_gaming", title="Gameplay",
            published_at=now - timedelta(days=30), duration_seconds=3600,
            video_type="video", playback_progress=50,
        )

        # An old video
        self.v_old = Video.objects.create(
            video_id="v_old", channel_id="UC_prog", title="Old Video",
            published_at=now - timedelta(days=100), duration_seconds=300,
            video_type="short", playback_progress=None,
        )


class FeedVideosEmptyTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_empty_feed_returns_empty_list(self):
        feed = Feed.objects.create(name="Empty")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['items'], [])
        self.assertEqual(data['total'], 0)


class FeedVideosCategoryFilterTest(FeedVideosBaseTest):
    def test_single_or_group(self):
        """Videos from channels in the Programming category."""
        feed = Feed.objects.create(
            name="Prog Feed",
            filter_category_ids=[self.cat_prog.id],
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        video_ids = [v['video_id'] for v in data['items']]
        # Only prog channel videos
        self.assertIn('v_prog1', video_ids)
        self.assertIn('v_prog2', video_ids)
        self.assertIn('v_old', video_ids)
        self.assertNotIn('v_music1', video_ids)
        self.assertNotIn('v_gaming1', video_ids)

    def test_or_group_multiple_categories(self):
        """OR group: videos from Programming OR Music channels."""
        feed = Feed.objects.create(
            name="Prog+Music",
            filter_category_ids=[self.cat_prog.id, self.cat_music.id],
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        video_ids = [v['video_id'] for v in data['items']]
        self.assertIn('v_prog1', video_ids)
        self.assertIn('v_music1', video_ids)
        self.assertNotIn('v_gaming1', video_ids)

    def test_and_of_or_groups(self):
        """AND of OR groups: channel must be in Programming AND Gaming (intersection = empty)."""
        feed = Feed.objects.create(
            name="AND Feed",
            filter_category_ids=[[self.cat_prog.id], [self.cat_gaming.id]],
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        self.assertEqual(data['total'], 0)

    def test_and_of_or_groups_overlap(self):
        """AND works when a channel is in both groups."""
        # Assign prog channel to gaming too
        SubscriptionCategory.objects.create(
            subscription=self.sub_prog, category=self.cat_gaming,
        )
        feed = Feed.objects.create(
            name="AND Overlap",
            filter_category_ids=[[self.cat_prog.id], [self.cat_gaming.id]],
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        video_ids = [v['video_id'] for v in data['items']]
        # prog channel is in both groups, so its videos appear
        self.assertIn('v_prog1', video_ids)
        # gaming channel is only in gaming group, not prog — excluded by AND
        self.assertNotIn('v_gaming1', video_ids)


class FeedVideosTypeFilterTest(FeedVideosBaseTest):
    def test_video_type_filter(self):
        feed = Feed.objects.create(name="Live Only", filter_video_type="live")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        for item in data['items']:
            self.assertEqual(item['video_type'], 'live')

    def test_short_type_filter(self):
        feed = Feed.objects.create(name="Shorts", filter_video_type="short")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        self.assertEqual(data['total'], 1)
        self.assertEqual(data['items'][0]['video_id'], 'v_old')


class FeedVideosProgressTest(FeedVideosBaseTest):
    @patch('subscriptions.youtube_service.YouTubeService')
    def test_missing_history_does_not_erase_lounge_progress(self, MockYTService):
        self.v_prog1.playback_progress = 42
        self.v_prog1.save(update_fields=['playback_progress'])
        MockYTService.return_value.fetch_channel_video_progress.return_value = {}
        feed = Feed.objects.create(name="Progress")

        response = self.client.get(f'/api/feeds/{feed.id}/videos/')

        self.assertEqual(response.status_code, 200)
        progress_by_id = {
            item['video_id']: item['playback_progress']
            for item in response.json()['items']
        }
        self.assertEqual(progress_by_id['v_prog1'], 42)
        self.v_prog1.refresh_from_db()
        self.assertEqual(self.v_prog1.playback_progress, 42)


class FeedVideosDurationFilterTest(FeedVideosBaseTest):
    def test_min_duration(self):
        feed = Feed.objects.create(name="Long", filter_min_duration=3600)
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        for item in data['items']:
            self.assertGreaterEqual(item['duration_seconds'], 3600)

    def test_max_duration(self):
        feed = Feed.objects.create(name="Short", filter_max_duration=300)
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        for item in data['items']:
            self.assertLessEqual(item['duration_seconds'], 300)

    def test_duration_range(self):
        feed = Feed.objects.create(
            name="Mid", filter_min_duration=300, filter_max_duration=3600,
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        for item in data['items']:
            self.assertGreaterEqual(item['duration_seconds'], 300)
            self.assertLessEqual(item['duration_seconds'], 3600)


class FeedVideosMaxAgeFilterTest(FeedVideosBaseTest):
    def test_max_age_days(self):
        feed = Feed.objects.create(name="Recent", filter_max_age_days=7)
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        video_ids = [v['video_id'] for v in data['items']]
        self.assertIn('v_prog1', video_ids)
        self.assertIn('v_music1', video_ids)
        self.assertNotIn('v_gaming1', video_ids)  # 30 days old
        self.assertNotIn('v_old', video_ids)  # 100 days old


class FeedVideosPlayStateFilterTest(FeedVideosBaseTest):
    def test_unplayed(self):
        feed = Feed.objects.create(name="Unplayed", filter_play_state="unplayed")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        for item in data['items']:
            if item['playback_progress'] is not None:
                self.assertLess(item['playback_progress'], 95)

    def test_played(self):
        feed = Feed.objects.create(name="Played", filter_play_state="played")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        self.assertTrue(len(data['items']) > 0)
        for item in data['items']:
            self.assertGreaterEqual(item['playback_progress'], 95)

    def test_no_filter_returns_all(self):
        feed = Feed.objects.create(name="All")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        self.assertEqual(data['total'], 5)


class FeedVideosCombinedFilterTest(FeedVideosBaseTest):
    def test_category_and_type_and_duration(self):
        feed = Feed.objects.create(
            name="Combined",
            filter_category_ids=[self.cat_prog.id],
            filter_video_type="video",
            filter_min_duration=300,
            filter_max_duration=900,
        )
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/')
        data = resp.json()
        video_ids = [v['video_id'] for v in data['items']]
        self.assertIn('v_prog1', video_ids)  # 600s, video, prog channel
        self.assertNotIn('v_prog2', video_ids)  # live type
        self.assertNotIn('v_old', video_ids)  # short type


class FeedVideosPaginationTest(FeedVideosBaseTest):
    def test_pagination(self):
        feed = Feed.objects.create(name="Paginated")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/?page=1&per_page=2')
        data = resp.json()
        self.assertEqual(len(data['items']), 2)
        self.assertTrue(data['has_more'])
        self.assertEqual(data['page'], 1)

    def test_page2(self):
        feed = Feed.objects.create(name="Paginated2")
        resp = self.client.get(f'/api/feeds/{feed.id}/videos/?page=2&per_page=3')
        data = resp.json()
        self.assertEqual(len(data['items']), 2)  # 5 total, page2 with per_page=3
        self.assertFalse(data['has_more'])
