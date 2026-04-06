from django.test import TestCase
from django.utils import timezone

from subscriptions.models import (
    Category,
    Feed,
    QueueItem,
    Subscription,
    SubscriptionCategory,
    Video,
)
from subscriptions.serializers import (
    CategorySerializer,
    FeedSerializer,
    QueueItemSerializer,
    SubscriptionSerializer,
    VideoSerializer,
)


class CategorySerializerTest(TestCase):
    def setUp(self):
        self.root = Category.objects.create(name="Root", sort_order=0)
        self.child = Category.objects.create(name="Child", parent=self.root, sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_ser_test", channel_title="Ser Channel",
        )
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.root)

    def test_includes_children_nested(self):
        data = CategorySerializer(self.root).data
        self.assertIn('children', data)
        self.assertEqual(len(data['children']), 1)
        self.assertEqual(data['children'][0]['name'], 'Child')

    def test_subscription_count(self):
        data = CategorySerializer(self.root).data
        self.assertEqual(data['subscription_count'], 1)

    def test_subscription_count_zero(self):
        data = CategorySerializer(self.child).data
        self.assertEqual(data['subscription_count'], 0)

    def test_fields_present(self):
        data = CategorySerializer(self.root).data
        expected_fields = {
            'id', 'name', 'description', 'parent_id', 'sort_order',
            'subscription_count', 'children', 'created_at', 'updated_at',
        }
        self.assertEqual(set(data.keys()), expected_fields)


class SubscriptionSerializerTest(TestCase):
    def setUp(self):
        self.cat = Category.objects.create(name="Programming", sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_sub_ser",
            channel_title="Sub Ser Channel",
            thumbnail_url="https://example.com/thumb.jpg",
        )
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat)

    def test_nested_categories(self):
        data = SubscriptionSerializer(self.sub).data
        self.assertEqual(len(data['categories']), 1)
        self.assertEqual(data['categories'][0]['name'], 'Programming')
        self.assertEqual(data['categories'][0]['id'], self.cat.id)

    def test_thumbnail_url_format(self):
        data = SubscriptionSerializer(self.sub).data
        self.assertEqual(data['thumbnail_url'], f'/api/subscriptions/{self.sub.channel_id}/thumbnail/')

    def test_fields_present(self):
        data = SubscriptionSerializer(self.sub).data
        expected = {
            'id', 'subscription_id', 'channel_id', 'channel_title',
            'channel_description', 'thumbnail_url', 'subscription_date', 'categories',
        }
        self.assertEqual(set(data.keys()), expected)


class VideoSerializerTest(TestCase):
    def setUp(self):
        self.sub = Subscription.objects.create(
            channel_id="UC_vid_ser", channel_title="Vid Ser Channel",
        )
        self.video = Video.objects.create(
            video_id="v_ser1",
            channel_id="UC_vid_ser",
            title="Serializer Video",
            published_at=timezone.now(),
            duration_seconds=600,
            video_type="video",
        )

    def test_channel_title_from_relationship(self):
        data = VideoSerializer(self.video).data
        self.assertEqual(data['channel_title'], 'Vid Ser Channel')

    def test_thumbnail_url_format(self):
        data = VideoSerializer(self.video).data
        self.assertEqual(data['thumbnail_url'], '/api/videos/v_ser1/thumbnail/')

    def test_fields_present(self):
        data = VideoSerializer(self.video).data
        expected = {
            'id', 'video_id', 'channel_id', 'title', 'thumbnail_url',
            'published_at', 'duration_seconds', 'video_type',
            'playback_progress', 'channel_title',
        }
        self.assertEqual(set(data.keys()), expected)


class QueueItemSerializerTest(TestCase):
    def setUp(self):
        self.sub = Subscription.objects.create(
            channel_id="UC_qi_ser", channel_title="QI Channel",
        )
        self.video = Video.objects.create(
            video_id="v_qi_ser", channel_id="UC_qi_ser", title="QI Video",
        )
        self.qi = QueueItem.objects.create(video=self.video, sort_order=0)

    def test_nested_video_data(self):
        data = QueueItemSerializer(self.qi).data
        self.assertIn('video', data)
        self.assertEqual(data['video']['video_id'], 'v_qi_ser')
        self.assertEqual(data['video']['title'], 'QI Video')

    def test_fields_present(self):
        data = QueueItemSerializer(self.qi).data
        expected = {'id', 'video_id', 'sort_order', 'added_at', 'video'}
        self.assertEqual(set(data.keys()), expected)


class FeedSerializerTest(TestCase):
    def test_json_field_roundtrip(self):
        feed = Feed.objects.create(
            name="Feed Ser",
            filter_category_ids=[[1, 2], [3]],
            filter_video_type="video",
            filter_min_duration=60,
            filter_max_duration=3600,
        )
        data = FeedSerializer(feed).data
        self.assertEqual(data['filter_category_ids'], [[1, 2], [3]])
        self.assertEqual(data['filter_video_type'], 'video')
        self.assertEqual(data['filter_min_duration'], 60)
        self.assertEqual(data['filter_max_duration'], 3600)

    def test_all_fields(self):
        feed = Feed.objects.create(name="Feed All")
        data = FeedSerializer(feed).data
        for field in ['id', 'name', 'sort_order', 'filter_category_ids',
                       'filter_video_type', 'filter_min_duration', 'filter_max_duration',
                       'filter_max_age_days', 'filter_play_state', 'created_at', 'updated_at']:
            self.assertIn(field, data)
