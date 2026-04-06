from django.db import IntegrityError
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


class CategoryModelTest(TestCase):
    def setUp(self):
        self.root = Category.objects.create(name="Root", sort_order=0)
        self.child1 = Category.objects.create(name="Child1", parent=self.root, sort_order=0)
        self.child2 = Category.objects.create(name="Child2", parent=self.root, sort_order=1)

    def test_create_root_and_children(self):
        children = list(self.root.children.all())
        self.assertEqual(len(children), 2)
        self.assertIn(self.child1, children)
        self.assertIn(self.child2, children)

    def test_cascade_delete_parent(self):
        grandchild = Category.objects.create(name="Grandchild", parent=self.child1, sort_order=0)
        self.root.delete()
        self.assertFalse(Category.objects.filter(pk=self.child1.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.child2.pk).exists())
        self.assertFalse(Category.objects.filter(pk=grandchild.pk).exists())

    def test_ordering_by_sort_order_then_name(self):
        Category.objects.all().delete()
        c_b = Category.objects.create(name="Bravo", sort_order=1)
        c_a = Category.objects.create(name="Alpha", sort_order=1)
        c_z = Category.objects.create(name="Zulu", sort_order=0)
        ordered = list(Category.objects.all())
        self.assertEqual(ordered, [c_z, c_a, c_b])

    def test_str(self):
        self.assertEqual(str(self.root), "Root")


class SubscriptionModelTest(TestCase):
    def setUp(self):
        self.cat1 = Category.objects.create(name="Programming", sort_order=0)
        self.cat2 = Category.objects.create(name="Music", sort_order=1)
        self.sub = Subscription.objects.create(
            channel_id="UC_test123",
            channel_title="Test Channel",
        )

    def test_many_to_many_through(self):
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat1)
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat2)
        cats = list(self.sub.categories.all())
        self.assertEqual(len(cats), 2)
        self.assertIn(self.cat1, cats)
        self.assertIn(self.cat2, cats)

    def test_unique_together_prevents_duplicate(self):
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat1)
        with self.assertRaises(IntegrityError):
            SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat1)

    def test_ordering_by_channel_title(self):
        Subscription.objects.all().delete()
        s_z = Subscription.objects.create(channel_id="UC_z", channel_title="Zulu")
        s_a = Subscription.objects.create(channel_id="UC_a", channel_title="Alpha")
        ordered = list(Subscription.objects.all())
        self.assertEqual(ordered, [s_a, s_z])

    def test_str(self):
        self.assertEqual(str(self.sub), "Test Channel")


class VideoModelTest(TestCase):
    def setUp(self):
        self.sub = Subscription.objects.create(
            channel_id="UC_vid_test",
            channel_title="Video Test Channel",
        )

    def test_fk_to_field_channel_id(self):
        video = Video.objects.create(
            video_id="v_abc123",
            channel_id="UC_vid_test",
            title="Test Video",
            published_at=timezone.now(),
        )
        self.assertEqual(video.channel, self.sub)
        self.assertIn(video, self.sub.videos.all())

    def test_ordering_by_published_at_desc(self):
        now = timezone.now()
        v_old = Video.objects.create(
            video_id="v_old", channel_id="UC_vid_test",
            title="Old Video", published_at=now - timezone.timedelta(days=1),
        )
        v_new = Video.objects.create(
            video_id="v_new", channel_id="UC_vid_test",
            title="New Video", published_at=now,
        )
        ordered = list(Video.objects.all())
        self.assertEqual(ordered, [v_new, v_old])

    def test_str(self):
        video = Video.objects.create(
            video_id="v_str", channel_id="UC_vid_test",
            title="My Title",
        )
        self.assertEqual(str(video), "My Title")


class QueueItemModelTest(TestCase):
    def setUp(self):
        self.sub = Subscription.objects.create(
            channel_id="UC_queue_test",
            channel_title="Queue Channel",
        )
        self.video = Video.objects.create(
            video_id="v_queue1",
            channel_id="UC_queue_test",
            title="Queue Video",
        )

    def test_one_to_one_uniqueness(self):
        QueueItem.objects.create(video=self.video, sort_order=0)
        with self.assertRaises(IntegrityError):
            QueueItem.objects.create(video=self.video, sort_order=1)

    def test_ordering_by_sort_order(self):
        v2 = Video.objects.create(
            video_id="v_queue2", channel_id="UC_queue_test", title="V2",
        )
        qi_b = QueueItem.objects.create(video=v2, sort_order=1)
        qi_a = QueueItem.objects.create(video=self.video, sort_order=0)
        ordered = list(QueueItem.objects.all())
        self.assertEqual(ordered, [qi_a, qi_b])


class FeedModelTest(TestCase):
    def test_json_field_store_retrieve(self):
        nested = [[1, 2], [3]]
        feed = Feed.objects.create(
            name="Test Feed",
            filter_category_ids=nested,
        )
        feed.refresh_from_db()
        self.assertEqual(feed.filter_category_ids, [[1, 2], [3]])

    def test_json_field_null(self):
        feed = Feed.objects.create(name="Empty Feed")
        feed.refresh_from_db()
        self.assertIsNone(feed.filter_category_ids)

    def test_ordering_by_sort_order_then_name(self):
        f_b = Feed.objects.create(name="Bravo", sort_order=1)
        f_a = Feed.objects.create(name="Alpha", sort_order=1)
        f_z = Feed.objects.create(name="Zulu", sort_order=0)
        ordered = list(Feed.objects.all())
        self.assertEqual(ordered, [f_z, f_a, f_b])

    def test_str(self):
        feed = Feed.objects.create(name="My Feed")
        self.assertEqual(str(feed), "My Feed")
