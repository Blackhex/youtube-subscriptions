import json

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from subscriptions.models import Category, Subscription, SubscriptionCategory


class CategoryListTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.root = Category.objects.create(name="Root", sort_order=0)
        self.child = Category.objects.create(name="Child", parent=self.root, sort_order=0)
        self.sub_cat = Subscription.objects.create(
            channel_id="UC_cat1", channel_title="Categorized",
        )
        self.sub_uncat = Subscription.objects.create(
            channel_id="UC_uncat", channel_title="Uncategorized",
        )
        SubscriptionCategory.objects.create(subscription=self.sub_cat, category=self.root)

    def test_list_returns_tree_with_counts(self):
        resp = self.client.get('/api/categories/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('categories', data)
        self.assertEqual(data['total_count'], 2)
        self.assertEqual(data['uncategorized_count'], 1)
        # Root categories only at top level
        root_names = [c['name'] for c in data['categories']]
        self.assertIn('Root', root_names)
        self.assertNotIn('Child', root_names)

    def test_children_nested_in_parent(self):
        resp = self.client.get('/api/categories/')
        data = resp.json()
        root_cat = next(c for c in data['categories'] if c['name'] == 'Root')
        self.assertEqual(len(root_cat['children']), 1)
        self.assertEqual(root_cat['children'][0]['name'], 'Child')


class CategoryCreateTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_create_category(self):
        resp = self.client.post('/api/categories/', {'name': 'New Cat'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['name'], 'New Cat')
        self.assertTrue(Category.objects.filter(name='New Cat').exists())

    def test_auto_sort_order(self):
        self.client.post('/api/categories/', {'name': 'First'}, format='json')
        resp = self.client.post('/api/categories/', {'name': 'Second'}, format='json')
        self.assertEqual(resp.status_code, 201)
        second = Category.objects.get(name='Second')
        first = Category.objects.get(name='First')
        self.assertGreater(second.sort_order, first.sort_order)

    def test_create_child_category(self):
        parent = Category.objects.create(name="Parent", sort_order=0)
        resp = self.client.post('/api/categories/', {
            'name': 'SubChild',
            'parent_id': parent.id,
        }, format='json')
        self.assertEqual(resp.status_code, 201)
        child = Category.objects.get(name='SubChild')
        self.assertEqual(child.parent_id, parent.id)


class CategoryUpdateTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.root = Category.objects.create(name="Root", sort_order=0)
        self.child = Category.objects.create(name="Child", parent=self.root, sort_order=0)

    def test_update_name(self):
        resp = self.client.put(
            f'/api/categories/{self.root.id}/',
            {'name': 'Updated Root'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.root.refresh_from_db()
        self.assertEqual(self.root.name, 'Updated Root')

    def test_prevent_self_parent(self):
        resp = self.client.put(
            f'/api/categories/{self.root.id}/',
            {'name': 'Root', 'parent_id': self.root.id},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_prevent_circular_parent(self):
        resp = self.client.put(
            f'/api/categories/{self.root.id}/',
            {'name': 'Root', 'parent_id': self.child.id},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)


class CategoryDeleteTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.root = Category.objects.create(name="Root", sort_order=0)
        self.child = Category.objects.create(name="Child", parent=self.root, sort_order=0)

    def test_delete_cascades_to_children(self):
        resp = self.client.delete(f'/api/categories/{self.root.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Category.objects.filter(pk=self.root.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.child.pk).exists())


class CategoryReorderTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.c1 = Category.objects.create(name="A", sort_order=0)
        self.c2 = Category.objects.create(name="B", sort_order=1)
        self.c3 = Category.objects.create(name="C", sort_order=2)

    def test_reorder(self):
        resp = self.client.post('/api/categories/reorder/', {
            'parent_id': None,
            'ordered_ids': [self.c3.id, self.c1.id, self.c2.id],
        }, format='json')
        self.assertEqual(resp.status_code, 200)
        self.c1.refresh_from_db()
        self.c2.refresh_from_db()
        self.c3.refresh_from_db()
        self.assertEqual(self.c3.sort_order, 0)
        self.assertEqual(self.c1.sort_order, 1)
        self.assertEqual(self.c2.sort_order, 2)


class CategoryExportTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.cat = Category.objects.create(name="TestCat", sort_order=0)
        self.sub = Subscription.objects.create(
            channel_id="UC_exp1", channel_title="Export Channel",
        )
        SubscriptionCategory.objects.create(subscription=self.sub, category=self.cat)

    def test_export_returns_json_with_content_disposition(self):
        resp = self.client.get('/api/categories/export/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn('Content-Disposition', resp)
        self.assertIn('attachment', resp['Content-Disposition'])
        self.assertIn('categories_export_', resp['Content-Disposition'])

    def test_export_contains_category_channel_mapping(self):
        resp = self.client.get('/api/categories/export/')
        data = json.loads(resp.content)
        self.assertIn('TestCat', data)
        self.assertEqual(data['TestCat'], ['UC_exp1'])

    def test_export_contains_metadata_keys(self):
        resp = self.client.get('/api/categories/export/')
        data = json.loads(resp.content)
        self.assertIn('channelsHealth', data)
        self.assertIn('ysc_channel_metadata', data)
        self.assertIn('ysc_subs_count', data)


class CategoryImportTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def _make_import_json(self):
        return json.dumps({
            "Gaming": ["UC_game1", "UC_game2"],
            "Music": ["UC_music1"],
            "ysc_channel_metadata": {
                "UC_game1": {"title": "Game Channel 1", "img": "", "ts": 0},
                "UC_game2": {"title": "Game Channel 2", "img": "", "ts": 0},
                "UC_music1": {"title": "Music Channel", "img": "", "ts": 0},
            },
            "channelsHealth": {},
            "topicCache": {},
            "ysc_subs_count": {},
        })

    def test_import_creates_categories_and_subscriptions(self):
        from io import BytesIO
        from django.core.files.uploadedfile import SimpleUploadedFile

        content = self._make_import_json().encode('utf-8')
        file = SimpleUploadedFile("import.json", content, content_type="application/json")
        resp = self.client.post('/api/categories/import/', {'file': file}, format='multipart')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['created_categories'], 2)  # Gaming, Music
        self.assertEqual(data['created_subscriptions'], 3)
        self.assertEqual(data['assignments_added'], 3)
        self.assertTrue(Category.objects.filter(name='Gaming').exists())
        self.assertTrue(Category.objects.filter(name='Music').exists())

    def test_import_no_file_returns_400(self):
        resp = self.client.post('/api/categories/import/', {}, format='multipart')
        self.assertEqual(resp.status_code, 400)

    def test_import_invalid_json_returns_400(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        file = SimpleUploadedFile("bad.json", b"not json", content_type="application/json")
        resp = self.client.post('/api/categories/import/', {'file': file}, format='multipart')
        self.assertEqual(resp.status_code, 400)
