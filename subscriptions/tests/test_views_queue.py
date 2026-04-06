from django.test import TestCase
from rest_framework.test import APIClient

from subscriptions.models import QueueItem, Subscription, Video


class QueueListTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_empty_queue(self):
        resp = self.client.get('/api/queue/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['items'], [])


class QueueAddTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_add", channel_title="Queue Add Channel",
        )
        self.video1 = Video.objects.create(
            video_id="v_qadd1", channel_id="UC_q_add", title="Video 1",
        )
        self.video2 = Video.objects.create(
            video_id="v_qadd2", channel_id="UC_q_add", title="Video 2",
        )

    def test_add_single_video(self):
        resp = self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        self.assertEqual(resp.status_code, 201)
        data = resp.json()
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['video']['video_id'], 'v_qadd1')

    def test_add_multiple_videos(self):
        resp = self.client.post('/api/queue/', {
            'video_ids': ['v_qadd1', 'v_qadd2'],
        }, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 2)

    def test_duplicate_is_skipped(self):
        self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        resp = self.client.post('/api/queue/', {'video_id': 'v_qadd1'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 1)

    def test_add_nonexistent_video_ignored(self):
        resp = self.client.post('/api/queue/', {'video_id': 'v_nonexist'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()['items']), 0)

    def test_no_video_id_returns_400(self):
        resp = self.client.post('/api/queue/', {}, format='json')
        self.assertEqual(resp.status_code, 400)


class QueueDeleteTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_del", channel_title="Queue Del Channel",
        )
        self.video = Video.objects.create(
            video_id="v_qdel1", channel_id="UC_q_del", title="Del Video",
        )
        self.qi = QueueItem.objects.create(video=self.video, sort_order=0)

    def test_delete_item(self):
        resp = self.client.delete(f'/api/queue/{self.qi.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(QueueItem.objects.filter(pk=self.qi.pk).exists())

    def test_delete_nonexistent_returns_404(self):
        resp = self.client.delete('/api/queue/99999/')
        self.assertEqual(resp.status_code, 404)


class QueueReorderTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sub = Subscription.objects.create(
            channel_id="UC_q_reorder", channel_title="Reorder Channel",
        )
        self.v1 = Video.objects.create(
            video_id="v_qr1", channel_id="UC_q_reorder", title="V1",
        )
        self.v2 = Video.objects.create(
            video_id="v_qr2", channel_id="UC_q_reorder", title="V2",
        )
        self.v3 = Video.objects.create(
            video_id="v_qr3", channel_id="UC_q_reorder", title="V3",
        )
        self.qi1 = QueueItem.objects.create(video=self.v1, sort_order=0)
        self.qi2 = QueueItem.objects.create(video=self.v2, sort_order=1)
        self.qi3 = QueueItem.objects.create(video=self.v3, sort_order=2)

    def test_reorder(self):
        resp = self.client.post('/api/queue/reorder/', {
            'queue_item_ids': [self.qi3.id, self.qi1.id, self.qi2.id],
        }, format='json')
        self.assertEqual(resp.status_code, 200)
        self.qi1.refresh_from_db()
        self.qi2.refresh_from_db()
        self.qi3.refresh_from_db()
        self.assertEqual(self.qi3.sort_order, 0)
        self.assertEqual(self.qi1.sort_order, 1)
        self.assertEqual(self.qi2.sort_order, 2)

    def test_reorder_empty_returns_400(self):
        resp = self.client.post('/api/queue/reorder/', {}, format='json')
        self.assertEqual(resp.status_code, 400)


class QueueClearTest(TestCase):
    def setUp(self):
        self.client = APIClient()
        sub = Subscription.objects.create(
            channel_id="UC_q_clear", channel_title="Clear Channel",
        )
        v1 = Video.objects.create(
            video_id="v_qclr1", channel_id="UC_q_clear", title="C1",
        )
        v2 = Video.objects.create(
            video_id="v_qclr2", channel_id="UC_q_clear", title="C2",
        )
        QueueItem.objects.create(video=v1, sort_order=0)
        QueueItem.objects.create(video=v2, sort_order=1)

    def test_clear_removes_all(self):
        resp = self.client.post('/api/queue/clear/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['items'], [])
        self.assertEqual(QueueItem.objects.count(), 0)
