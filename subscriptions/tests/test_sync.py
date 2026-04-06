from unittest.mock import patch, MagicMock

from django.test import TestCase

from subscriptions.models import Category, Feed, Subscription, SubscriptionCategory
from subscriptions.sync import (
    _get_channels_to_sync,
    get_sync_state,
    is_sync_running,
    _sync_state,
    _sync_lock,
)


class GetSyncStateTest(TestCase):
    def test_returns_dict_copy(self):
        state = get_sync_state()
        self.assertIsInstance(state, dict)
        self.assertIn('running', state)
        # Mutating returned dict should not affect internal state
        state['running'] = 'MODIFIED'
        self.assertNotEqual(get_sync_state()['running'], 'MODIFIED')

    def test_initial_state_not_running(self):
        state = get_sync_state()
        self.assertFalse(state['running'])


class IsSyncRunningTest(TestCase):
    def setUp(self):
        with _sync_lock:
            _sync_state['running'] = False

    def test_returns_false_initially(self):
        self.assertFalse(is_sync_running())

    def test_returns_true_when_running(self):
        with _sync_lock:
            _sync_state['running'] = True
        self.assertTrue(is_sync_running())
        # Cleanup
        with _sync_lock:
            _sync_state['running'] = False


class GetChannelsToSyncTest(TestCase):
    def setUp(self):
        self.sub1 = Subscription.objects.create(
            channel_id="UC_sync1", channel_title="Sync Channel 1",
        )
        self.sub2 = Subscription.objects.create(
            channel_id="UC_sync2", channel_title="Sync Channel 2",
        )
        self.sub3 = Subscription.objects.create(
            channel_id="UC_sync3", channel_title="Sync Channel 3",
        )

    def test_fallback_to_all_channels_when_no_feeds(self):
        channels = _get_channels_to_sync()
        self.assertEqual(set(channels), {"UC_sync1", "UC_sync2", "UC_sync3"})

    def test_returns_channels_from_feed_categories(self):
        cat = Category.objects.create(name="SyncCat", sort_order=0)
        SubscriptionCategory.objects.create(subscription=self.sub1, category=cat)
        Feed.objects.create(
            name="Sync Feed",
            filter_category_ids=[cat.id],
        )
        channels = _get_channels_to_sync()
        self.assertIn("UC_sync1", channels)
        self.assertNotIn("UC_sync3", channels)

    def test_handles_nested_category_format(self):
        cat1 = Category.objects.create(name="Cat1", sort_order=0)
        cat2 = Category.objects.create(name="Cat2", sort_order=1)
        SubscriptionCategory.objects.create(subscription=self.sub1, category=cat1)
        SubscriptionCategory.objects.create(subscription=self.sub2, category=cat2)
        Feed.objects.create(
            name="Nested Feed",
            filter_category_ids=[[cat1.id, cat2.id], [cat1.id]],
        )
        channels = _get_channels_to_sync()
        self.assertIn("UC_sync1", channels)
        self.assertIn("UC_sync2", channels)

    def test_feeds_with_null_category_ids_ignored(self):
        Feed.objects.create(name="Null Feed", filter_category_ids=None)
        channels = _get_channels_to_sync()
        # Falls back to all channels
        self.assertEqual(set(channels), {"UC_sync1", "UC_sync2", "UC_sync3"})
