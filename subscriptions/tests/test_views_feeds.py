from datetime import timedelta

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
