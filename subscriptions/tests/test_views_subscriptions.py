from django.test import TestCase
from rest_framework.test import APIClient

from subscriptions.models import Category, Subscription, SubscriptionCategory


class SubscriptionListTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.cat = Category.objects.create(name="Programming", sort_order=0)
        # Create 5 subs, assign 3 to category
        self.subs = []
        for i in range(5):
            sub = Subscription.objects.create(
                channel_id=f"UC_sub{i}", channel_title=f"Channel {i:02d}",
            )
            self.subs.append(sub)
            if i < 3:
                SubscriptionCategory.objects.create(subscription=sub, category=self.cat)

    def test_paginated_response(self):
        resp = self.client.get('/api/subscriptions/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('items', data)
        self.assertIn('total', data)
        self.assertIn('has_more', data)
        self.assertIn('page', data)
        self.assertIn('per_page', data)
        self.assertEqual(data['total'], 5)

    def test_filter_by_category(self):
        resp = self.client.get(f'/api/subscriptions/?category_id={self.cat.id}')
        data = resp.json()
        self.assertEqual(data['total'], 3)

    def test_uncategorized_filter(self):
        resp = self.client.get('/api/subscriptions/?uncategorized=true')
        data = resp.json()
        self.assertEqual(data['total'], 2)

    def test_pagination_page2(self):
        resp = self.client.get('/api/subscriptions/?page=1&per_page=3')
        data = resp.json()
        self.assertEqual(len(data['items']), 3)
        self.assertTrue(data['has_more'])

        resp2 = self.client.get('/api/subscriptions/?page=2&per_page=3')
        data2 = resp2.json()
        self.assertEqual(len(data2['items']), 2)
        self.assertFalse(data2['has_more'])

    def test_per_page_capped_at_200(self):
        resp = self.client.get('/api/subscriptions/?per_page=500')
        data = resp.json()
        self.assertEqual(data['per_page'], 200)


class SubscriptionAssignTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.cat = Category.objects.create(name="Gaming", sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_assign1", channel_title="Assign Channel",
        )

    def test_assign_creates_association(self):
        resp = self.client.post(f'/api/subscriptions/{self.sub.id}/assign/{self.cat.id}/')
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            SubscriptionCategory.objects.filter(
                subscription=self.sub, category=self.cat
            ).exists()
        )
        # Verify response includes categories
        data = resp.json()
        self.assertEqual(len(data['categories']), 1)
        self.assertEqual(data['categories'][0]['name'], 'Gaming')

    def test_assign_idempotent(self):
        self.client.post(f'/api/subscriptions/{self.sub.id}/assign/{self.cat.id}/')
        resp = self.client.post(f'/api/subscriptions/{self.sub.id}/assign/{self.cat.id}/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            SubscriptionCategory.objects.filter(
                subscription=self.sub, category=self.cat
            ).count(), 1
        )

    def test_assign_nonexistent_category_returns_404(self):
        resp = self.client.post(f'/api/subscriptions/{self.sub.id}/assign/99999/')
        self.assertEqual(resp.status_code, 404)


class SubscriptionUnassignTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.cat = Category.objects.create(name="Music", sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_unassign1", channel_title="Unassign Channel",
        )
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat)

    def test_unassign_removes_association(self):
        resp = self.client.delete(f'/api/subscriptions/{self.sub.id}/unassign/{self.cat.id}/')
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(
            SubscriptionCategory.objects.filter(
                subscription=self.sub, category=self.cat
            ).exists()
        )
        data = resp.json()
        self.assertEqual(len(data['categories']), 0)

    def test_unassign_nonexistent_is_noop(self):
        resp = self.client.delete(f'/api/subscriptions/{self.sub.id}/unassign/99999/')
        self.assertEqual(resp.status_code, 200)
