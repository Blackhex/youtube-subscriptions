import json
import os
import shutil
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from subscriptions.models import (
    Category,
    Feed,
    QueueItem,
    Subscription,
    SubscriptionCategory,
    Video,
)


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


class PocketTubeMetadataPathMixin:
    """Redirects the module-level metadata path so tests never touch the real file."""

    def _isolate_metadata_path(self):
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmpdir, True)
        self.metadata_path = os.path.join(tmpdir, 'media', 'pockettube_metadata.json')
        patcher = patch('subscriptions.views.POCKETTUBE_METADATA_PATH', self.metadata_path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write_metadata_raw(self, content):
        os.makedirs(os.path.dirname(self.metadata_path), exist_ok=True)
        with open(self.metadata_path, 'w') as f:
            f.write(content)

    def _read_metadata(self):
        with open(self.metadata_path, 'r') as f:
            return json.load(f)

    def _post_import(self, payload):
        content = json.dumps(payload).encode('utf-8')
        file = SimpleUploadedFile("import.json", content, content_type="application/json")
        return self.client.post('/api/categories/import/', {'file': file}, format='multipart')


class CategoryImportTest(PocketTubeMetadataPathMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()

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
        file = SimpleUploadedFile("bad.json", b"not json", content_type="application/json")
        resp = self.client.post('/api/categories/import/', {'file': file}, format='multipart')
        self.assertEqual(resp.status_code, 400)


class PocketTubeMetadataPreservationTest(PocketTubeMetadataPathMixin, TestCase):
    """Regression tests: a partial import must not destroy preserved PocketTube keys."""

    PRESERVED_KEYS = (
        'ysc_collection', 'ysc_meta', 'ysc_settings',
        'ysc_title_id', 'ysc_deck', 'ysc_popup', 'ysc_token_google',
    )

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self.existing_meta = {
            'ysc_collection': {'col1': ['UC_a']},
            'ysc_meta': {'version': 5},
            'ysc_settings': {'sub_groups': {}, 'theme': 'old'},
            'ysc_title_id': {'UC_a': 'Old Title'},
            'ysc_deck': ['deck-one'],
            'ysc_popup': {'open': True},
            'ysc_token_google': 'secret-token-value',
        }

    def _valid_payload(self, **extra):
        payload = {
            "Gaming": ["UC_game1"],
            "ysc_channel_metadata": {
                "UC_game1": {"title": "Game Channel 1", "img": "", "ts": 0},
            },
            "channelsHealth": {},
            "topicCache": {},
            "ysc_subs_count": {},
        }
        payload.update(extra)
        return payload

    def test_partial_import_preserves_absent_metadata_keys(self):
        self._write_metadata_raw(json.dumps(self.existing_meta))
        new_settings = {'sub_groups': {}, 'theme': 'new'}

        resp = self._post_import(self._valid_payload(ysc_settings=new_settings))

        self.assertEqual(resp.status_code, 200)
        stored = self._read_metadata()
        self.assertEqual(stored['ysc_settings'], new_settings)
        for key in self.PRESERVED_KEYS:
            if key == 'ysc_settings':
                continue
            self.assertIn(key, stored)
            self.assertEqual(stored[key], self.existing_meta[key])

    def test_present_key_is_overwritten_not_deep_merged(self):
        self._write_metadata_raw(json.dumps(self.existing_meta))
        new_settings = {'theme': 'new'}

        resp = self._post_import(self._valid_payload(ysc_settings=new_settings))

        self.assertEqual(resp.status_code, 200)
        stored = self._read_metadata()
        self.assertEqual(stored['ysc_settings'], new_settings)
        self.assertNotIn('sub_groups', stored['ysc_settings'])

    def test_import_creates_metadata_file_when_missing(self):
        self.assertFalse(os.path.exists(self.metadata_path))

        resp = self._post_import(self._valid_payload(ysc_meta={'version': 9}))

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(os.path.exists(self.metadata_path))
        self.assertEqual(self._read_metadata(), {'ysc_meta': {'version': 9}})

    def test_corrupt_metadata_file_does_not_error(self):
        self._write_metadata_raw('{ this is not valid json')

        resp = self._post_import(self._valid_payload(ysc_meta={'version': 9}))

        self.assertGreaterEqual(resp.status_code, 200)
        self.assertLess(resp.status_code, 300)
        self.assertEqual(self._read_metadata(), {'ysc_meta': {'version': 9}})

    def test_list_metadata_file_is_replaced(self):
        self._write_metadata_raw(json.dumps(['not', 'a', 'dict']))

        resp = self._post_import(self._valid_payload(ysc_deck=['deck-two']))

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._read_metadata(), {'ysc_deck': ['deck-two']})

    def test_string_metadata_file_is_replaced(self):
        self._write_metadata_raw(json.dumps("just a string"))

        resp = self._post_import(self._valid_payload(ysc_deck=['deck-two']))

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._read_metadata(), {'ysc_deck': ['deck-two']})

    def test_token_google_not_echoed_in_response(self):
        self._write_metadata_raw(json.dumps(self.existing_meta))

        resp = self._post_import(
            self._valid_payload(ysc_token_google='incoming-secret-token')
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode('utf-8')
        self.assertNotIn('ysc_token_google', body)
        self.assertNotIn('incoming-secret-token', body)
        self.assertNotIn('secret-token-value', body)


_OMIT = object()


class ImportModeMixin(PocketTubeMetadataPathMixin):
    """Seeding and posting helpers for the replace/additive import modes.

    Every filesystem path the import touches is redirected into tempfile, so the real
    data/, media/ and db.sqlite3 are never involved.
    """

    def _isolate_backup_dir(self):
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmpdir, True)
        self.backup_dir = os.path.join(tmpdir, 'db-backups')
        patcher = patch('subscriptions.views.DB_BACKUP_DIR', self.backup_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _payload(self, **extra):
        payload = {
            "Gaming": ["UC_game1"],
            "Music": ["UC_music1"],
            "ysc_channel_metadata": {
                "UC_game1": {"title": "Game Channel 1", "img": "", "ts": 0},
                "UC_music1": {"title": "Music Channel", "img": "", "ts": 0},
            },
            "channelsHealth": {},
            "topicCache": {},
            "ysc_subs_count": {},
        }
        payload.update(extra)
        return payload

    def _import(self, payload=None, mode=_OMIT):
        body = json.dumps(self._payload() if payload is None else payload).encode('utf-8')
        data = {
            'file': SimpleUploadedFile("import.json", body, content_type="application/json"),
        }
        if mode is not _OMIT:
            data['mode'] = mode
        return self.client.post('/api/categories/import/', data, format='multipart')

    def _seed_existing_state(self):
        """Categories, assignments and a subscription the payload does not mention."""
        self.stale_cat = Category.objects.create(name="Stale", sort_order=0)
        self.stale_child = Category.objects.create(
            name="Stale Child", parent=self.stale_cat, sort_order=0,
        )
        self.old_gaming = Category.objects.create(name="Gaming", sort_order=1)
        self.orphan_sub = Subscription.objects.create(
            channel_id="UC_orphan", channel_title="Orphan Channel",
        )
        self.payload_sub = Subscription.objects.create(
            channel_id="UC_game1", channel_title="Game Channel 1",
        )
        SubscriptionCategory.objects.create(
            subscription=self.orphan_sub, category=self.stale_cat,
        )
        SubscriptionCategory.objects.create(
            subscription=self.payload_sub, category=self.old_gaming,
        )

    def _category_names(self):
        return set(Category.objects.values_list('name', flat=True))


class CategoryImportReplaceModeTest(ImportModeMixin, TestCase):
    """The import tests above start from an empty database, where replace deletes
    nothing; these seed pre-existing state so the wipe is actually observable."""

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self._seed_existing_state()

    def test_replace_removes_stale_categories_and_assignments(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['mode'], 'replace')
        self.assertEqual(data['deleted_categories'], 3)  # Stale, Stale Child, Gaming
        self.assertEqual(data['deleted_assignments'], 2)
        self.assertEqual(self._category_names(), {'Gaming', 'Music'})
        self.assertFalse(Category.objects.filter(pk=self.stale_cat.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.stale_child.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.old_gaming.pk).exists())

    def test_replace_rebuilds_only_payload_assignments(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['assignments_added'], 2)
        assigned = set(
            SubscriptionCategory.objects.values_list(
                'subscription__channel_id', 'category__name',
            )
        )
        self.assertEqual(assigned, {('UC_game1', 'Gaming'), ('UC_music1', 'Music')})
        self.assertFalse(
            SubscriptionCategory.objects.filter(subscription=self.orphan_sub).exists()
        )

    def test_omitted_mode_defaults_to_replace(self):
        resp = self._import()

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['mode'], 'replace')
        self.assertEqual(data['deleted_categories'], 3)
        self.assertEqual(data['deleted_assignments'], 2)
        self.assertEqual(self._category_names(), {'Gaming', 'Music'})

    def test_empty_mode_defaults_to_replace(self):
        resp = self._import(mode='')

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['mode'], 'replace')
        self.assertEqual(data['deleted_categories'], 3)
        self.assertEqual(data['deleted_assignments'], 2)
        self.assertEqual(self._category_names(), {'Gaming', 'Music'})

    def test_additive_preserves_existing_categories_and_assignments(self):
        resp = self._import(mode='additive')

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['mode'], 'additive')
        self.assertEqual(data['deleted_categories'], 0)
        self.assertEqual(data['deleted_assignments'], 0)
        self.assertEqual(
            self._category_names(), {'Stale', 'Stale Child', 'Gaming', 'Music'},
        )
        self.assertTrue(Category.objects.filter(pk=self.stale_cat.pk).exists())
        self.assertTrue(Category.objects.filter(pk=self.old_gaming.pk).exists())
        self.assertTrue(
            SubscriptionCategory.objects.filter(
                subscription=self.orphan_sub, category=self.stale_cat,
            ).exists()
        )

    def test_additive_reuses_existing_category_instead_of_duplicating(self):
        self._import(mode='additive')

        self.assertEqual(Category.objects.filter(name='Gaming').count(), 1)

    def test_invalid_mode_returns_400_with_exact_error(self):
        resp = self._import(mode='merge')

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.json(),
            {'error': "Invalid mode. Accepted values: 'replace', 'additive'."},
        )

    def test_invalid_mode_mutates_nothing(self):
        resp = self._import(mode='delete-everything')

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._category_names(), {'Stale', 'Stale Child', 'Gaming'})
        self.assertEqual(SubscriptionCategory.objects.count(), 2)
        self.assertEqual(Subscription.objects.count(), 2)
        self.assertFalse(Subscription.objects.filter(channel_id='UC_music1').exists())
        self.assertFalse(os.path.exists(self.metadata_path))
        self.assertFalse(os.path.isdir(self.backup_dir))

    def test_unknown_mode_is_rejected_case_insensitively_only_for_valid_values(self):
        self.assertEqual(self._import(mode='REPLACE').status_code, 200)
        self.assertEqual(self._import(mode='  Additive ').status_code, 200)
        self.assertEqual(self._import(mode='repl').status_code, 400)


class CategoryImportReplacePreservesContentTest(ImportModeMixin, TestCase):
    """Video and QueueItem cascade from Subscription, so pruning subscriptions during a
    replace would silently destroy the whole video library."""

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self.absent_sub = Subscription.objects.create(
            channel_id="UC_absent", channel_title="Absent From Payload",
        )
        self.video = Video.objects.create(
            video_id="vid_absent", channel=self.absent_sub, title="Absent Video",
        )
        self.queue_item = QueueItem.objects.create(video=self.video, sort_order=0)
        self.cat = Category.objects.create(name="Stale", sort_order=0)
        SubscriptionCategory.objects.create(
            subscription=self.absent_sub, category=self.cat,
        )

    def test_replace_keeps_subscriptions_videos_and_queue_items(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(Subscription.objects.filter(pk=self.absent_sub.pk).exists())
        self.assertTrue(Video.objects.filter(pk=self.video.pk).exists())
        self.assertTrue(QueueItem.objects.filter(pk=self.queue_item.pk).exists())

    def test_replace_only_drops_the_assignment_of_a_surviving_subscription(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.absent_sub.refresh_from_db()
        self.assertEqual(self.absent_sub.channel_title, "Absent From Payload")
        self.assertFalse(
            SubscriptionCategory.objects.filter(subscription=self.absent_sub).exists()
        )


class CategoryImportFeedRemapTest(ImportModeMixin, TestCase):
    """filter_category_ids holds primary keys that change when categories are rebuilt."""

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self.gaming = Category.objects.create(name="Gaming", sort_order=0)
        self.music = Category.objects.create(name="Music", sort_order=1)
        self.stale = Category.objects.create(name="Stale", sort_order=2)
        self.flat = Feed.objects.create(
            name="Flat", filter_category_ids=[self.gaming.id, self.music.id],
        )
        self.nested = Feed.objects.create(
            name="Nested", filter_category_ids=[[self.gaming.id], [self.music.id]],
        )
        self.flat_with_stale = Feed.objects.create(
            name="Flat With Stale", filter_category_ids=[self.gaming.id, self.stale.id],
        )
        self.nested_emptied_group = Feed.objects.create(
            name="Nested Emptied", filter_category_ids=[[self.stale.id], [self.music.id]],
        )
        self.nested_all_gone = Feed.objects.create(
            name="Nested All Gone", filter_category_ids=[[self.stale.id]],
        )
        self.no_filter = Feed.objects.create(name="No Filter", filter_category_ids=None)

    def _names(self, feed):
        feed.refresh_from_db()
        ids = feed.filter_category_ids
        if ids and isinstance(ids[0], list):
            return [
                [Category.objects.get(pk=i).name for i in group] for group in ids
            ]
        return [Category.objects.get(pk=i).name for i in (ids or [])]

    def test_flat_ids_are_remapped_by_name(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.flat.refresh_from_db()
        self.assertNotEqual(self.flat.filter_category_ids, [self.gaming.id, self.music.id])
        self.assertEqual(self._names(self.flat), ['Gaming', 'Music'])

    def test_nested_groups_are_remapped_by_name(self):
        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._names(self.nested), [['Gaming'], ['Music']])

    def test_id_of_absent_category_is_dropped_from_flat_list(self):
        self._import(mode='replace')

        self.assertEqual(self._names(self.flat_with_stale), ['Gaming'])

    def test_group_emptied_by_remapping_is_dropped_not_left_empty(self):
        self._import(mode='replace')

        self.nested_emptied_group.refresh_from_db()
        self.assertNotIn([], self.nested_emptied_group.filter_category_ids)
        self.assertEqual(self._names(self.nested_emptied_group), [['Music']])

    def test_feed_losing_all_groups_ends_up_empty(self):
        self._import(mode='replace')

        self.nested_all_gone.refresh_from_db()
        self.assertEqual(self.nested_all_gone.filter_category_ids, [])

    def test_null_filter_is_left_alone(self):
        self._import(mode='replace')

        self.no_filter.refresh_from_db()
        self.assertIsNone(self.no_filter.filter_category_ids)

    def test_feeds_are_never_deleted_by_replace(self):
        self._import(mode='replace')

        self.assertEqual(Feed.objects.count(), 6)

    def test_additive_leaves_feed_filters_untouched(self):
        resp = self._import(mode='additive')

        self.assertEqual(resp.status_code, 200)
        self.flat.refresh_from_db()
        self.nested.refresh_from_db()
        self.nested_emptied_group.refresh_from_db()
        self.assertEqual(self.flat.filter_category_ids, [self.gaming.id, self.music.id])
        self.assertEqual(
            self.nested.filter_category_ids, [[self.gaming.id], [self.music.id]],
        )
        self.assertEqual(
            self.nested_emptied_group.filter_category_ids,
            [[self.stale.id], [self.music.id]],
        )


class CategoryImportDatabaseSnapshotTest(ImportModeMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self.db_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.db_dir, True)
        self.db_path = os.path.join(self.db_dir, 'db.sqlite3')

    def _patch_database(self, engine='django.db.backends.sqlite3', name=None):
        # _snapshot_database is the only request-time reader of settings in views, so
        # patching the module-level name leaves Django's real connections alone.
        fake = SimpleNamespace(DATABASES={'default': {'ENGINE': engine, 'NAME': name}})
        patcher = patch('subscriptions.views.settings', fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write_db_file(self, content=b'SQLite format 3\x00fake payload'):
        with open(self.db_path, 'wb') as f:
            f.write(content)

    def _backups(self):
        if not os.path.isdir(self.backup_dir):
            return []
        return sorted(os.listdir(self.backup_dir))

    def test_replace_writes_a_snapshot(self):
        self._write_db_file()
        self._patch_database(name=self.db_path)

        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        backups = self._backups()
        self.assertEqual(len(backups), 1)
        self.assertRegex(backups[0], r'^db-\d{8}-\d{6}\.sqlite3$')
        with open(os.path.join(self.backup_dir, backups[0]), 'rb') as f:
            self.assertEqual(f.read(), b'SQLite format 3\x00fake payload')

    def test_snapshots_are_pruned_to_the_newest_five(self):
        self._write_db_file()
        self._patch_database(name=self.db_path)
        os.makedirs(self.backup_dir, exist_ok=True)
        old_names = [f'db-20200101-0000{n:02d}.sqlite3' for n in range(1, 8)]
        for name in old_names:
            with open(os.path.join(self.backup_dir, name), 'wb') as f:
                f.write(b'old')

        resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        backups = self._backups()
        self.assertEqual(len(backups), 5)
        # Timestamped names sort chronologically; the new one plus the four newest stay
        self.assertEqual(backups[:4], old_names[3:])
        self.assertRegex(backups[4], r'^db-\d{8}-\d{6}\.sqlite3$')
        self.assertNotIn(backups[4], old_names)

    def test_unrelated_files_in_the_backup_dir_are_not_pruned(self):
        self._write_db_file()
        self._patch_database(name=self.db_path)
        os.makedirs(self.backup_dir, exist_ok=True)
        keep = os.path.join(self.backup_dir, 'README.txt')
        with open(keep, 'w') as f:
            f.write('not a snapshot')

        self._import(mode='replace')

        self.assertTrue(os.path.exists(keep))

    def test_additive_writes_no_snapshot(self):
        self._write_db_file()
        self._patch_database(name=self.db_path)

        resp = self._import(mode='additive')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._backups(), [])

    def test_missing_database_file_logs_and_skips(self):
        self._patch_database(name=self.db_path)  # never created

        with self.assertLogs('subscriptions.views', level='WARNING') as logs:
            resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            any('no database file' in line for line in logs.output), logs.output,
        )
        self.assertEqual(self._backups(), [])

    def test_non_sqlite_engine_logs_and_skips(self):
        self._write_db_file()
        self._patch_database(engine='django.db.backends.postgresql', name=self.db_path)

        with self.assertLogs('subscriptions.views', level='WARNING') as logs:
            resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            any('not SQLite' in line for line in logs.output), logs.output,
        )
        self.assertEqual(self._backups(), [])

    def test_snapshot_failure_does_not_block_the_import(self):
        self._write_db_file()
        self._patch_database(name=self.db_path)

        with patch('subscriptions.views.shutil.copy2', side_effect=OSError('disk full')):
            with self.assertLogs('subscriptions.views', level='WARNING'):
                resp = self._import(mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(Category.objects.filter(name='Gaming').exists())


class CategoryImportAtomicityTest(ImportModeMixin, TestCase):
    """A failure partway through the rebuild must not leave the categories wiped."""

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self._seed_existing_state()

    def test_failure_creating_categories_rolls_back_the_wipe(self):
        with patch.object(
            Category.objects, 'get_or_create', side_effect=RuntimeError('boom'),
        ) as mock_create:
            with self.assertRaises(RuntimeError):
                self._import(mode='replace')

        # Proves the failure landed after the wipe, not before it
        self.assertTrue(mock_create.called)
        self.assertEqual(self._category_names(), {'Stale', 'Stale Child', 'Gaming'})
        self.assertEqual(SubscriptionCategory.objects.count(), 2)
        self.assertTrue(
            SubscriptionCategory.objects.filter(
                subscription=self.orphan_sub, category=self.stale_cat,
            ).exists()
        )
        self.assertTrue(Subscription.objects.filter(pk=self.orphan_sub.pk).exists())

    def test_failure_remapping_feeds_rolls_back_the_wipe(self):
        feed = Feed.objects.create(
            name="Feed", filter_category_ids=[[self.old_gaming.id]],
        )

        with patch(
            'subscriptions.views._remap_feed_categories', side_effect=RuntimeError('boom'),
        ) as mock_remap:
            with self.assertRaises(RuntimeError):
                self._import(mode='replace')

        self.assertTrue(mock_remap.called)
        self.assertEqual(self._category_names(), {'Stale', 'Stale Child', 'Gaming'})
        self.assertEqual(SubscriptionCategory.objects.count(), 2)
        feed.refresh_from_db()
        self.assertEqual(feed.filter_category_ids, [[self.old_gaming.id]])


class CategoryImportReplaceStructureTest(ImportModeMixin, TestCase):
    """Hierarchy detection and chunk merging must behave the same after a wipe."""

    def setUp(self):
        self.client = APIClient()
        self._isolate_metadata_path()
        self._isolate_backup_dir()
        self._seed_existing_state()

    def _structured_payload(self):
        return {
            "Parent": ["UC_p1"],
            "Child": ["UC_c1"],
            "Child_ysm_1": ["UC_c2"],
            "Loose": ["UC_l1"],
            "ysc_settings": {"sub_groups": {"Parent": {"Child": {}}}},
            "ysc_channel_metadata": {
                ch: {"title": ch, "img": "", "ts": 0}
                for ch in ("UC_p1", "UC_c1", "UC_c2", "UC_l1")
            },
            "channelsHealth": {},
            "topicCache": {},
            "ysc_subs_count": {},
        }

    def test_replace_rebuilds_the_parent_child_hierarchy(self):
        resp = self._import(self._structured_payload(), mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['created_categories'], 3)
        self.assertEqual(self._category_names(), {'Parent', 'Child', 'Loose'})
        parent = Category.objects.get(name='Parent')
        child = Category.objects.get(name='Child')
        loose = Category.objects.get(name='Loose')
        self.assertIsNone(parent.parent)
        self.assertEqual(child.parent_id, parent.id)
        self.assertIsNone(loose.parent)

    def test_replace_merges_chunked_category_keys(self):
        resp = self._import(self._structured_payload(), mode='replace')

        self.assertEqual(resp.status_code, 200)
        self.assertFalse(Category.objects.filter(name='Child_ysm_1').exists())
        child = Category.objects.get(name='Child')
        assigned = set(
            SubscriptionCategory.objects.filter(category=child)
            .values_list('subscription__channel_id', flat=True)
        )
        self.assertEqual(assigned, {'UC_c1', 'UC_c2'})
