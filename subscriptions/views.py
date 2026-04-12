import json
import logging
import mimetypes
import os
import re
import threading
import time
from datetime import datetime, timedelta

import requests as http_requests
from django.db import models, transaction
from django.db.models import Count, Max, Q
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from .models import Category, Feed, QueueItem, Subscription, SubscriptionCategory, Video
from .serializers import CategorySerializer, FeedSerializer, QueueItemSerializer, SubscriptionSerializer, VideoSerializer
from .suggestions import get_suggestions

logger = logging.getLogger(__name__)


class HealthCheckView(APIView):
    def get(self, request):
        return Response({"status": "ok"})


POCKETTUBE_METADATA_PATH = os.path.join('media', 'pockettube_metadata.json')

# Keys in PocketTube JSON that are not category mappings
POCKETTUBE_INTERNAL_KEYS = {
    'channelsHealth', 'topicCache',
    'ysc_channel_metadata', 'ysc_collection', 'ysc_deck', 'ysc_meta',
    'ysc_popup', 'ysc_settings', 'ysc_subs_count', 'ysc_title_id',
    'ysc_token_google',
}


class CategoryViewSet(ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer

    def list(self, request):
        root_categories = Category.objects.filter(parent__isnull=True)
        serializer = self.get_serializer(root_categories, many=True)
        total_count = Subscription.objects.count()
        uncategorized_count = Subscription.objects.filter(
            subscriptioncategory__isnull=True
        ).count()
        return Response({
            'categories': serializer.data,
            'total_count': total_count,
            'uncategorized_count': uncategorized_count,
        })

    def create(self, request):
        data = request.data.copy()
        parent_id = data.get('parent_id')
        max_order = Category.objects.filter(
            parent_id=parent_id
        ).aggregate(m=models.Max('sort_order'))['m']
        data['sort_order'] = (max_order or 0) + 1
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        data = request.data.copy()

        # Validate no circular parent references
        new_parent_id = data.get('parent_id')
        if new_parent_id is not None:
            if str(new_parent_id) == str(instance.id):
                return Response(
                    {'error': 'A category cannot be its own parent.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Walk ancestor chain of proposed parent
            ancestor_id = int(new_parent_id) if new_parent_id else None
            while ancestor_id is not None:
                try:
                    ancestor = Category.objects.get(id=ancestor_id)
                except Category.DoesNotExist:
                    break
                if ancestor.id == instance.id:
                    return Response(
                        {'error': 'Circular parent reference detected.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                ancestor_id = ancestor.parent_id

        serializer = self.get_serializer(instance, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        parent_id = request.data.get('parent_id')
        ordered_ids = request.data.get('ordered_ids', [])
        with transaction.atomic():
            for idx, cat_id in enumerate(ordered_ids):
                Category.objects.filter(
                    id=cat_id, parent_id=parent_id
                ).update(sort_order=idx)
        return Response({'status': 'ok'})

    @action(detail=False, methods=['get'], url_path='export')
    def export_categories(self, request):
        export = {}

        # Category -> channel ID mappings with chunking
        categories = Category.objects.all()
        for cat in categories:
            channel_ids = list(
                SubscriptionCategory.objects.filter(category=cat)
                .values_list('subscription__channel_id', flat=True)
            )
            if len(channel_ids) <= 250:
                export[cat.name] = channel_ids
            else:
                # Split into 250-item chunks
                for i in range(0, len(channel_ids), 250):
                    chunk = channel_ids[i:i + 250]
                    if i == 0:
                        export[cat.name] = chunk
                    else:
                        chunk_num = i // 250
                        export[f'{cat.name}_ysm_{chunk_num}'] = chunk

        # channelsHealth
        subs = Subscription.objects.exclude(last_published_at__isnull=True)
        export['channelsHealth'] = {
            s.channel_id: s.last_published_at for s in subs
            if s.last_published_at
        }

        # topicCache - only for subscriptions with topic_in_topic_cache=True
        topic_subs = Subscription.objects.filter(
            topic_in_topic_cache=True, topics__isnull=False
        )
        export['topicCache'] = {
            s.channel_id: s.topics for s in topic_subs
        }

        # ysc_channel_metadata
        all_subs = Subscription.objects.all()
        export['ysc_channel_metadata'] = {
            s.channel_id: {
                'title': s.channel_title,
                'img': s.thumbnail_url or '',
                'ts': 0,
            }
            for s in all_subs
        }

        # ysc_subs_count
        export['ysc_subs_count'] = {
            s.channel_id: {
                'sc': s.subscriber_count or '0',
                't': s.topics or [],
            }
            for s in all_subs
        }

        # Load preserved PocketTube metadata if available
        if os.path.exists(POCKETTUBE_METADATA_PATH):
            with open(POCKETTUBE_METADATA_PATH, 'r') as f:
                preserved = json.load(f)
            for key in ('ysc_collection', 'ysc_meta', 'ysc_settings',
                        'ysc_title_id', 'ysc_deck', 'ysc_popup',
                        'ysc_token_google'):
                if key in preserved:
                    export[key] = preserved[key]

        now = datetime.now().strftime('%Y-%m-%d-%H_%M')
        response = JsonResponse(export, json_dumps_params={'indent': 2})
        response['Content-Type'] = 'application/json'
        response['Content-Disposition'] = (
            f'attachment; filename="categories_export_{now}.json"'
        )
        return response

    @action(detail=False, methods=['post'], url_path='import',
            parser_classes=[MultiPartParser])
    def import_categories(self, request):
        file = request.FILES.get('file')
        if not file:
            return Response(
                {'error': 'No file provided.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            data = json.load(file)
        except json.JSONDecodeError:
            return Response(
                {'error': 'Invalid JSON file.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Save PocketTube-specific metadata for later export
        pockettube_meta = {}
        for key in ('ysc_collection', 'ysc_meta', 'ysc_settings',
                     'ysc_title_id', 'ysc_deck', 'ysc_popup',
                     'ysc_token_google'):
            if key in data:
                pockettube_meta[key] = data[key]
        os.makedirs(os.path.dirname(POCKETTUBE_METADATA_PATH), exist_ok=True)
        with open(POCKETTUBE_METADATA_PATH, 'w') as f:
            json.dump(pockettube_meta, f, indent=2)

        # Detect hierarchy from ysc_settings.sub_groups
        sub_groups = {}
        settings = data.get('ysc_settings', {})
        if isinstance(settings, dict) and 'sub_groups' in settings:
            sub_groups = settings['sub_groups']  # dict: parent -> {child: {}, ...}

        # Merge chunked category keys (e.g., "Name_ysm_1") into base category
        category_channels = {}
        for key, value in data.items():
            if key in POCKETTUBE_INTERNAL_KEYS or key.startswith('ysc_'):
                continue
            if not isinstance(value, list):
                continue
            # Check if this is a chunk key
            match = re.match(r'^(.+?)_ysm_\d+$', key)
            base_name = match.group(1) if match else key
            if base_name not in category_channels:
                category_channels[base_name] = []
            category_channels[base_name].extend(value)

        # Create subscriptions from ysc_channel_metadata
        channel_metadata = data.get('ysc_channel_metadata', {})
        channels_health = data.get('channelsHealth', {})
        topic_cache = data.get('topicCache', {})
        subs_count = data.get('ysc_subs_count', {})

        created_subs = 0
        with transaction.atomic():
            for ch_id, meta in channel_metadata.items():
                title = meta.get('title', ch_id)
                thumbnail = meta.get('img', '')
                sub, created = Subscription.objects.get_or_create(
                    channel_id=ch_id,
                    defaults={
                        'channel_title': title,
                        'thumbnail_url': thumbnail,
                    },
                )
                if created:
                    created_subs += 1

                # Update metadata from PocketTube data
                updated_fields = []
                sc_data = subs_count.get(ch_id, {})
                if sc_data.get('sc'):
                    sub.subscriber_count = sc_data['sc']
                    updated_fields.append('subscriber_count')
                if sc_data.get('t'):
                    sub.topics = sc_data['t']
                    updated_fields.append('topics')
                if ch_id in channels_health:
                    sub.last_published_at = channels_health[ch_id]
                    updated_fields.append('last_published_at')
                if ch_id in topic_cache:
                    sub.topic_in_topic_cache = True
                    if not sub.topics:
                        sub.topics = topic_cache[ch_id]
                        updated_fields.append('topics')
                    updated_fields.append('topic_in_topic_cache')
                if updated_fields:
                    sub.save(update_fields=list(set(updated_fields)))

        # Create categories using hierarchy
        created_cats = 0
        cat_objects = {}  # name -> Category

        def _get_or_create_category(name, parent=None):
            nonlocal created_cats
            if name in cat_objects:
                return cat_objects[name]
            cat, created = Category.objects.get_or_create(
                name=name,
                parent=parent,
                defaults={
                    'sort_order': Category.objects.filter(
                        parent=parent
                    ).count() + 1,
                },
            )
            if created:
                created_cats += 1
            cat_objects[name] = cat
            return cat

        with transaction.atomic():
            if sub_groups:
                # Use hierarchy from sub_groups
                for parent_name, children_dict in sub_groups.items():
                    if parent_name in category_channels:
                        parent_cat = _get_or_create_category(parent_name)
                        for child_name in children_dict:
                            if child_name in category_channels:
                                _get_or_create_category(child_name, parent=parent_cat)
                # Create any remaining categories not in sub_groups hierarchy
                for name in category_channels:
                    if name not in cat_objects:
                        _get_or_create_category(name)
            else:
                for name in category_channels:
                    _get_or_create_category(name)

        # Assign subscriptions to categories
        assignments_added = 0
        unmatched_channels = 0

        with transaction.atomic():
            for cat_name, channel_ids in category_channels.items():
                cat = cat_objects.get(cat_name)
                if not cat:
                    continue
                for ch_id in channel_ids:
                    try:
                        sub = Subscription.objects.get(channel_id=ch_id)
                        _, created = SubscriptionCategory.objects.get_or_create(
                            subscription=sub,
                            category=cat,
                        )
                        if created:
                            assignments_added += 1
                    except Subscription.DoesNotExist:
                        unmatched_channels += 1

        return Response({
            'message': 'Import complete',
            'created_categories': created_cats,
            'created_subscriptions': created_subs,
            'assignments_added': assignments_added,
            'unmatched_channels': unmatched_channels,
        })


class SubscriptionViewSet(ModelViewSet):
    queryset = Subscription.objects.all()
    serializer_class = SubscriptionSerializer
    http_method_names = ['get', 'delete', 'post']

    def list(self, request):
        page = int(request.query_params.get('page', 1))
        per_page = min(int(request.query_params.get('per_page', 50)), 200)
        category_id = request.query_params.get('category_id')
        uncategorized = request.query_params.get('uncategorized')

        qs = Subscription.objects.prefetch_related('subscriptioncategory_set__category').all()

        if category_id:
            qs = qs.filter(categories__id=category_id)
        elif uncategorized and uncategorized.lower() == 'true':
            qs = qs.annotate(cat_count=Count('categories')).filter(cat_count=0)

        qs = qs.order_by('channel_title')
        total = qs.count()
        start = (page - 1) * per_page
        end = start + per_page
        items = qs[start:end]

        serializer = self.get_serializer(items, many=True)
        return Response({
            'items': serializer.data,
            'total': total,
            'page': page,
            'per_page': per_page,
            'has_more': end < total,
        })

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        # Try YouTube unsubscribe if subscription_id exists
        if instance.subscription_id:
            try:
                from .youtube_service import YouTubeService
                yt = YouTubeService()
                yt.delete_subscription(instance.subscription_id)
            except Exception as e:
                logger.warning("YouTube unsubscribe failed for %s: %s", instance.subscription_id, e)
        instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'], url_path='assign/(?P<cat_id>[^/.]+)')
    def assign(self, request, pk=None, cat_id=None):
        subscription = self.get_object()
        try:
            category = Category.objects.get(pk=cat_id)
        except Category.DoesNotExist:
            return Response({'error': 'Category not found.'}, status=status.HTTP_404_NOT_FOUND)
        SubscriptionCategory.objects.get_or_create(
            subscription=subscription, category=category
        )
        serializer = self.get_serializer(subscription)
        return Response(serializer.data)

    @action(detail=True, methods=['delete'], url_path='unassign/(?P<cat_id>[^/.]+)')
    def unassign(self, request, pk=None, cat_id=None):
        subscription = self.get_object()
        SubscriptionCategory.objects.filter(
            subscription=subscription, category_id=cat_id
        ).delete()
        serializer = self.get_serializer(subscription)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def suggestions(self, request, pk=None):
        subscription = self.get_object()
        suggested_ids = get_suggestions(subscription)
        return Response({
            'subscription_id': subscription.id,
            'suggested_category_ids': suggested_ids,
        })


class ChannelVideosView(APIView):
    """Paginated list of locally synced videos for a single channel."""

    def get(self, request, channel_id):
        from .sync import backfill_channel_videos, is_sync_running, sync_channel_videos_now

        page = int(request.query_params.get('page', 1))
        per_page = min(int(request.query_params.get('per_page', 20)), 100)

        if page == 1 and not is_sync_running():
            subscription = Subscription.objects.filter(channel_id=channel_id).first()
            # videos_synced_at, not the video count: a channel with zero uploads must not refetch
            if subscription and subscription.videos_synced_at is None:
                try:
                    sync_channel_videos_now(channel_id)
                except Exception as e:
                    logger.warning("On-demand video sync failed for channel %s: %s", channel_id, e)

        needed = page * per_page
        if not is_sync_running() and Subscription.objects.filter(channel_id=channel_id).exists():
            if Video.objects.filter(channel_id=channel_id).count() < needed:
                try:
                    backfill_channel_videos(channel_id, needed)
                except Exception as e:
                    logger.warning("Video backfill failed for channel %s: %s", channel_id, e)

        qs = (
            Video.objects.select_related('channel')
            .filter(channel_id=channel_id)
            .order_by('-published_at')
        )

        total = qs.count()
        offset = (page - 1) * per_page
        items = qs[offset:offset + per_page]

        serializer = VideoSerializer(items, many=True)
        return Response({
            'items': serializer.data,
            'total': total,
            'page': page,
            'per_page': per_page,
            'has_more': (page * per_page) < total,
        })


class ChannelProgressView(APIView):
    """Watch progress for a channel's videos, fetched live from YouTube."""

    def get(self, request, channel_id):
        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            progress = yt.fetch_channel_video_progress(channel_id)
        except Exception:
            logger.warning("Failed to fetch watch progress for channel %s", channel_id)
            return Response({'progress': {}})

        for video_id, percent in progress.items():
            Video.objects.filter(video_id=video_id).update(playback_progress=percent)

        return Response({'progress': progress})


class SubscriptionThumbnailView(APIView):
    def get(self, request, channel_id):
        try:
            subscription = Subscription.objects.get(channel_id=channel_id)
        except Subscription.DoesNotExist:
            return Response({'error': 'Subscription not found.'}, status=status.HTTP_404_NOT_FOUND)

        cache_path = os.path.join('media', 'thumbnails', 'channels', f'{channel_id}.jpg')

        # Check if cached and on disk
        if subscription.thumbnail_path and os.path.exists(subscription.thumbnail_path):
            content_type = mimetypes.guess_type(subscription.thumbnail_path)[0] or 'image/jpeg'
            return FileResponse(open(subscription.thumbnail_path, 'rb'), content_type=content_type)

        if not subscription.thumbnail_url:
            return Response({'error': 'No thumbnail available.'}, status=status.HTTP_404_NOT_FOUND)

        # Download and cache
        try:
            resp = http_requests.get(subscription.thumbnail_url, timeout=10)
            resp.raise_for_status()
        except Exception:
            return Response({'error': 'Failed to download thumbnail.'}, status=status.HTTP_502_BAD_GATEWAY)

        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, 'wb') as f:
            f.write(resp.content)

        subscription.thumbnail_path = cache_path
        subscription.save(update_fields=['thumbnail_path'])

        content_type = resp.headers.get('Content-Type', 'image/jpeg')
        return FileResponse(open(cache_path, 'rb'), content_type=content_type)


class VideoThumbnailView(APIView):
    def get(self, request, video_id):
        cache_path = os.path.join('media', 'thumbnails', 'videos', f'{video_id}.jpg')

        # Check if already cached on disk
        if os.path.exists(cache_path):
            content_type = mimetypes.guess_type(cache_path)[0] or 'image/jpeg'
            return FileResponse(open(cache_path, 'rb'), content_type=content_type)

        # Determine the source URL
        thumbnail_url = None
        video_obj = None
        try:
            video_obj = Video.objects.get(video_id=video_id)
            if video_obj.thumbnail_path and os.path.exists(video_obj.thumbnail_path):
                content_type = mimetypes.guess_type(video_obj.thumbnail_path)[0] or 'image/jpeg'
                return FileResponse(open(video_obj.thumbnail_path, 'rb'), content_type=content_type)
            thumbnail_url = video_obj.thumbnail_url
        except Video.DoesNotExist:
            pass

        # Fall back to standard YouTube thumbnail URL
        if not thumbnail_url:
            thumbnail_url = f'https://i.ytimg.com/vi/{video_id}/mqdefault.jpg'

        # Download and cache
        try:
            resp = http_requests.get(thumbnail_url, timeout=10)
            resp.raise_for_status()
        except Exception:
            return Response({'error': 'Failed to download thumbnail.'}, status=status.HTTP_502_BAD_GATEWAY)

        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, 'wb') as f:
            f.write(resp.content)

        if video_obj:
            video_obj.thumbnail_path = cache_path
            video_obj.save(update_fields=['thumbnail_path'])

        content_type = resp.headers.get('Content-Type', 'image/jpeg')
        return FileResponse(open(cache_path, 'rb'), content_type=content_type)


class FeedViewSet(ModelViewSet):
    queryset = Feed.objects.all().order_by('sort_order', 'name')
    serializer_class = FeedSerializer

    def perform_create(self, serializer):
        if serializer.validated_data.get('sort_order') is not None:
            serializer.save()
            return
        max_order = Feed.objects.aggregate(Max('sort_order'))['sort_order__max']
        serializer.save(sort_order=0 if max_order is None else max_order + 1)

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        raw_ids = request.data.get('ordered_ids', [])
        if not isinstance(raw_ids, list):
            return Response(
                {'error': 'ordered_ids must be a list.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(raw_ids) > 1000:
            return Response(
                {'error': 'ordered_ids must contain at most 1000 items.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            ordered_ids = [int(i) for i in raw_ids]
        except (TypeError, ValueError):
            return Response(
                {'error': 'ordered_ids must contain integers.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            for idx, feed_id in enumerate(ordered_ids):
                Feed.objects.filter(id=feed_id).update(sort_order=idx)
        return Response({'status': 'ok'})

    @action(detail=True, methods=['get'], url_path='videos')
    def videos(self, request, pk=None):
        feed = self.get_object()

        page = int(request.query_params.get('page', 1))
        per_page = min(int(request.query_params.get('per_page', 20)), 100)

        qs = Video.objects.select_related('channel').all()

        # 1. Category filter (AND of OR groups)
        filter_category_ids = feed.filter_category_ids
        if filter_category_ids:
            # Normalize: flat array becomes single OR group
            if filter_category_ids and not isinstance(filter_category_ids[0], list):
                filter_category_ids = [filter_category_ids]
            for group in filter_category_ids:
                channel_ids = SubscriptionCategory.objects.filter(
                    category_id__in=group
                ).values_list('subscription__channel_id', flat=True)
                qs = qs.filter(channel_id__in=channel_ids)

        # 2. Video type (supports comma-separated values for multi-select)
        if feed.filter_video_type:
            types = [t.strip() for t in feed.filter_video_type.split(',') if t.strip()]
            if types:
                qs = qs.filter(video_type__in=types)

        # 3. Duration
        if feed.filter_min_duration is not None:
            qs = qs.filter(duration_seconds__gte=feed.filter_min_duration)
        if feed.filter_max_duration is not None:
            qs = qs.filter(duration_seconds__lte=feed.filter_max_duration)

        # 4. Max age
        if feed.filter_max_age_days is not None:
            cutoff = timezone.now() - timedelta(days=feed.filter_max_age_days)
            qs = qs.filter(published_at__gte=cutoff)

        # 5. Play state
        if feed.filter_play_state == 'unplayed':
            qs = qs.filter(Q(playback_progress__isnull=True) | Q(playback_progress__lt=95))
        elif feed.filter_play_state == 'played':
            qs = qs.filter(playback_progress__gte=95)

        # 6. Ordering
        qs = qs.order_by('-published_at')

        # 7. Pagination
        total = qs.count()
        offset = (page - 1) * per_page
        items = qs[offset:offset + per_page]

        # 8. Fetch watch progress for displayed videos
        # Get unique channel IDs from this page's videos
        page_channel_ids = set()
        for video in items:
            if video.channel_id:
                page_channel_ids.add(video.channel_id)

        if page_channel_ids:
            try:
                from .youtube_service import YouTubeService
                yt = YouTubeService()
                # Fetch progress per channel and merge
                all_progress = {}
                for ch_id in page_channel_ids:
                    channel_progress = yt.fetch_channel_video_progress(ch_id)
                    all_progress.update(channel_progress)

                # Update videos in DB with fresh progress
                if all_progress:
                    page_video_ids = [v.video_id for v in items]
                    for vid_id in page_video_ids:
                        progress = all_progress.get(vid_id)
                        if progress is not None:
                            Video.objects.filter(video_id=vid_id).update(playback_progress=progress)
                        else:
                            # Video not in channel browse = not watched (or channel didn't return it)
                            # Only reset if video currently has progress
                            Video.objects.filter(
                                video_id=vid_id,
                                playback_progress__isnull=False,
                            ).update(playback_progress=None, watched_locally=False)

                    # Refresh items from DB to get updated progress
                    items = qs[offset:offset + per_page]
            except Exception:
                logger.warning("Failed to fetch watch progress for feed videos")

        serializer = VideoSerializer(items, many=True)
        return Response({
            'items': serializer.data,
            'total': total,
            'page': page,
            'per_page': per_page,
            'has_more': (page * per_page) < total,
        })


class SyncAllView(APIView):
    def post(self, request):
        from .sync import get_sync_state, is_sync_running, run_full_sync

        if is_sync_running():
            return Response(
                {'error': 'Sync is already running.', 'state': get_sync_state()},
                status=status.HTTP_409_CONFLICT,
            )

        force = request.data.get('force', False) if request.data else False
        thread = threading.Thread(target=run_full_sync, kwargs={'force': force}, daemon=True)
        thread.start()

        return Response(
            {'message': 'Full sync started.', 'state': get_sync_state()},
            status=status.HTTP_202_ACCEPTED,
        )


class SyncVideosView(APIView):
    def post(self, request):
        from .sync import get_sync_state, is_sync_running, run_video_sync

        if is_sync_running():
            return Response(
                {'error': 'Sync is already running.', 'state': get_sync_state()},
                status=status.HTTP_409_CONFLICT,
            )

        data = request.data or {}
        force = data.get('force', False)
        channel_ids = data.get('channel_ids', None)
        thread = threading.Thread(
            target=run_video_sync,
            kwargs={'force': force, 'channel_ids': channel_ids},
            daemon=True,
        )
        thread.start()

        return Response(
            {'message': 'Video sync started.', 'state': get_sync_state()},
            status=status.HTTP_202_ACCEPTED,
        )


class SyncStatusView(APIView):
    def get(self, request):
        from .sync import get_sync_state

        return Response(get_sync_state())


# ── Queue Views ──────────────────────────────────────────────────────────


class QueueListCreateView(APIView):
    def get(self, request):
        items = QueueItem.objects.select_related('video__channel').order_by('sort_order')
        serializer = QueueItemSerializer(items, many=True)
        return Response({'items': serializer.data})

    def post(self, request):
        video_id = request.data.get('video_id')
        video_ids = request.data.get('video_ids', [])
        if video_id:
            video_ids = [video_id]
        if not video_ids:
            return Response({'error': 'video_id or video_ids required.'}, status=status.HTTP_400_BAD_REQUEST)

        max_order = QueueItem.objects.aggregate(m=models.Max('sort_order'))['m'] or 0
        added = 0
        for vid in video_ids:
            try:
                video = Video.objects.get(video_id=vid)
            except Video.DoesNotExist:
                continue
            if QueueItem.objects.filter(video=video).exists():
                continue
            max_order += 1
            QueueItem.objects.create(video=video, sort_order=max_order)
            added += 1

        items = QueueItem.objects.select_related('video__channel').order_by('sort_order')
        serializer = QueueItemSerializer(items, many=True)
        return Response({'items': serializer.data}, status=status.HTTP_201_CREATED)


class QueueDetailView(APIView):
    def delete(self, request, pk):
        try:
            item = QueueItem.objects.get(pk=pk)
        except QueueItem.DoesNotExist:
            return Response({'error': 'Queue item not found.'}, status=status.HTTP_404_NOT_FOUND)
        item.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class QueueReorderView(APIView):
    def post(self, request):
        queue_item_ids = request.data.get('queue_item_ids', [])
        if not queue_item_ids:
            return Response({'error': 'queue_item_ids required.'}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            for idx, item_id in enumerate(queue_item_ids):
                QueueItem.objects.filter(pk=item_id).update(sort_order=idx)
        items = QueueItem.objects.select_related('video__channel').order_by('sort_order')
        serializer = QueueItemSerializer(items, many=True)
        return Response({'items': serializer.data})


class QueueClearView(APIView):
    def post(self, request):
        QueueItem.objects.all().delete()
        return Response({'message': 'Queue cleared', 'items': []})


class QueueCreatePlaylistView(APIView):
    def post(self, request):
        items = QueueItem.objects.select_related('video').order_by('sort_order')
        if not items.exists():
            return Response({'error': 'Queue is empty.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
        except Exception as e:
            logger.exception("Failed to initialize YouTubeService")
            return Response({'error': f'YouTube service error: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        title = f"Queue {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        try:
            result = yt.create_playlist(title=title)
            playlist_id = result['id']
        except Exception as e:
            logger.exception("Failed to create playlist")
            return Response({'error': f'Failed to create playlist: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        added_count = 0
        for item in items:
            try:
                yt.add_to_playlist(playlist_id, item.video.video_id)
                added_count += 1
            except Exception as e:
                logger.warning("Failed to add video %s to playlist: %s", item.video.video_id, e)

        QueueItem.objects.all().delete()

        return Response({
            'playlist_id': playlist_id,
            'playlist_url': f'https://www.youtube.com/playlist?list={playlist_id}',
            'playlist_title': title,
            'added_count': added_count,
            'cleared': True,
            'items': [],
        }, status=status.HTTP_201_CREATED)


class QueueCastView(APIView):
    def post(self, request):
        screen_id = request.data.get('screen_id')
        if not screen_id:
            return Response({'error': 'screen_id required.'}, status=status.HTTP_400_BAD_REQUEST)

        video_ids = list(
            QueueItem.objects.select_related('video')
            .order_by('sort_order')
            .values_list('video__video_id', flat=True)
        )
        if not video_ids:
            return Response({'error': 'Queue is empty.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            session_data = yt.cast_to_receiver(screen_id, video_ids)
        except Exception as e:
            logger.exception("Cast failed")
            return Response({'error': f'Cast failed: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(session_data)


class QueueCastStatusView(APIView):
    def get(self, request):
        lounge_session_path = os.path.join('media', 'lounge_session.json')
        if not os.path.exists(lounge_session_path):
            return Response({'active': False, 'now_playing': None})

        try:
            with open(lounge_session_path, 'r') as session_file:
                lounge_session = json.load(session_file)
            from .youtube_service import YouTubeService
            now_playing = YouTubeService().get_now_playing(lounge_session)
        except Exception:
            logger.warning("Failed to detect active Cast session")
            return Response({'active': False, 'now_playing': None})

        active = bool(
            now_playing
            and now_playing.get('video_id')
            and str(now_playing.get('state')) != '0'
        )
        return Response({
            'active': active,
            'now_playing': now_playing if active else None,
        })


class QueueRefreshProgressView(APIView):
    def post(self, request):
        lounge_session_path = os.path.join('media', 'lounge_session.json')
        lounge_session = None
        now_playing_video_id = None
        lounge_progress = None
        completed_video_ids = set()

        # 1. Try to load lounge session
        if os.path.exists(lounge_session_path):
            try:
                with open(lounge_session_path, 'r') as f:
                    lounge_session = json.load(f)
            except Exception:
                logger.warning("Failed to load lounge session")

        # 2. Get now-playing state from lounge
        if lounge_session:
            try:
                from .youtube_service import YouTubeService
                yt = YouTubeService()
                now_playing = yt.get_now_playing(lounge_session)
                if now_playing and now_playing.get('video_id'):
                    vid = now_playing['video_id']
                    now_playing_video_id = vid
                    receiver_video_ids = now_playing.get('video_ids') or []
                    if vid in receiver_video_ids:
                        completed_video_ids.update(
                            receiver_video_ids[:receiver_video_ids.index(vid)]
                        )
                    current_item = QueueItem.objects.filter(video_id=vid).first()
                    if current_item:
                        completed_video_ids.update(
                            QueueItem.objects.filter(
                                sort_order__lt=current_item.sort_order
                            ).values_list('video_id', flat=True)
                        )
                        if str(now_playing.get('state')) == '0':
                            completed_video_ids.add(vid)
                    if completed_video_ids:
                        Video.objects.filter(video_id__in=completed_video_ids).update(
                            playback_progress=100,
                            watched_locally=True,
                        )
                    # Estimate progress if current_time available
                    if vid not in completed_video_ids:
                        try:
                            video = Video.objects.get(video_id=vid)
                            current_time = float(now_playing.get('current_time', 0))
                            if video.duration_seconds and video.duration_seconds > 0:
                                progress = int((current_time / video.duration_seconds) * 100)
                                progress = min(progress, 100)
                                lounge_progress = progress
                                video.playback_progress = progress
                                video.save(update_fields=['playback_progress'])
                        except Video.DoesNotExist:
                            pass
            except Exception:
                logger.exception("Failed to get now playing from lounge")

        # 3. Fetch watch progress for queue videos
        queue_video_ids = list(
            QueueItem.objects.values_list('video__video_id', flat=True)
        )
        if queue_video_ids:
            try:
                from .youtube_service import YouTubeService
                yt = YouTubeService()
                # Get unique channel IDs for queue videos
                queue_channel_ids = set(
                    Video.objects.filter(video_id__in=queue_video_ids)
                    .values_list('channel_id', flat=True)
                    .distinct()
                )
                all_progress = {}
                for ch_id in queue_channel_ids:
                    channel_progress = yt.fetch_channel_video_progress(ch_id)
                    all_progress.update(channel_progress)

                for vid in queue_video_ids:
                    if vid in completed_video_ids:
                        continue
                    progress = all_progress.get(vid)
                    if vid == now_playing_video_id:
                        if progress is not None and (
                            lounge_progress is None or progress > lounge_progress
                        ):
                            Video.objects.filter(video_id=vid).update(playback_progress=progress)
                        continue
                    if progress is not None:
                        Video.objects.filter(video_id=vid).update(playback_progress=progress)
            except Exception:
                logger.exception("Failed to fetch watch progress for queue")

        # 4. Auto-remove watched items (progress >= 95%)
        watched_items = QueueItem.objects.filter(video__playback_progress__gte=95)
        removed_video_ids = list(dict.fromkeys([
            *completed_video_ids,
            *watched_items.values_list('video_id', flat=True),
        ]))
        removed_count = watched_items.count()
        watched_items.delete()

        # 5. Return updated queue
        items = QueueItem.objects.select_related('video__channel').order_by('sort_order')
        serializer = QueueItemSerializer(items, many=True)
        return Response({
            'items': serializer.data,
            'removed_count': removed_count,
            'removed_video_ids': removed_video_ids,
        })


# ── Playlist Views (YouTube pass-through) ────────────────────────────────


class PlaylistListView(APIView):
    def get(self, request):
        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            raw_playlists = yt.fetch_playlists()
        except Exception as e:
            logger.exception("Failed to fetch playlists")
            return Response({'error': f'Failed to fetch playlists: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        playlists = []
        for p in raw_playlists:
            snippet = p.get('snippet', {})
            thumbnails = snippet.get('thumbnails', {})
            thumb_url = (
                thumbnails.get('medium', {}).get('url')
                or thumbnails.get('high', {}).get('url')
                or thumbnails.get('default', {}).get('url')
            )
            playlists.append({
                'id': p.get('id', ''),
                'title': snippet.get('title', ''),
                'description': snippet.get('description', ''),
                'thumbnail_url': thumb_url,
                'item_count': int(p.get('contentDetails', {}).get('itemCount', 0)),
                'privacy_status': p.get('status', {}).get('privacyStatus', 'private'),
            })

        return Response(playlists)


class PlaylistDetailView(APIView):
    def delete(self, request, playlist_id):
        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            yt.delete_playlist(playlist_id)
        except Exception as e:
            logger.exception("Failed to delete playlist %s", playlist_id)
            return Response({'error': f'Failed to delete playlist: {e}'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PlaylistItemsView(APIView):
    def get(self, request, playlist_id):
        per_page = min(int(request.query_params.get('per_page', 20)), 50)
        page = int(request.query_params.get('page', 1))
        page_token = request.query_params.get('page_token')

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            raw_items, next_page_token = yt.fetch_playlist_items(
                playlist_id, max_results=per_page, page_token=page_token
            )
        except Exception as e:
            logger.exception("Failed to fetch playlist items for %s", playlist_id)
            return Response({'error': f'Failed to fetch playlist items: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        # Collect video IDs for local enrichment
        video_ids = []
        for item in raw_items:
            vid = item.get('snippet', {}).get('resourceId', {}).get('videoId')
            if vid:
                video_ids.append(vid)

        local_videos = {}
        if video_ids:
            for v in Video.objects.filter(video_id__in=video_ids).select_related('channel'):
                local_videos[v.video_id] = v

        items = []
        for item in raw_items:
            snippet = item.get('snippet', {})
            video_id = snippet.get('resourceId', {}).get('videoId', '')
            local = local_videos.get(video_id)

            items.append({
                'id': item.get('id', ''),
                'video_id': video_id,
                'channel_id': local.channel_id if local else snippet.get('videoOwnerChannelId', ''),
                'title': local.title if local else snippet.get('title', ''),
                'channel_title': local.channel.channel_title if local and local.channel else snippet.get('videoOwnerChannelTitle', ''),
                'thumbnail_url': f'/api/videos/{video_id}/thumbnail/' if video_id else '',
                'published_at': snippet.get('publishedAt', ''),
                'duration_seconds': local.duration_seconds if local else None,
                'video_type': local.video_type if local else None,
                'playback_progress': local.playback_progress if local else None,
                'playlist_item_id': item.get('id', ''),
                'position': snippet.get('position', 0),
            })

        return Response({
            'items': items,
            'total': len(items),
            'page': page,
            'per_page': per_page,
            'has_more': next_page_token is not None,
            'next_page_token': next_page_token,
        })

    def post(self, request, playlist_id):
        video_id = request.data.get('video_id')
        if not video_id:
            return Response({'error': 'video_id required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            result = yt.add_to_playlist(playlist_id, video_id)
        except Exception as e:
            logger.exception("Failed to add video to playlist %s", playlist_id)
            return Response({'error': f'Failed to add video to playlist: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(result, status=status.HTTP_201_CREATED)


class PlaylistItemsReorderView(APIView):
    def post(self, request, playlist_id):
        item_ids = request.data.get('item_ids', [])
        video_ids = request.data.get('video_ids', [])

        if not item_ids or not video_ids or len(item_ids) != len(video_ids):
            return Response(
                {'error': 'item_ids and video_ids are required and must be the same length.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            for position, (item_id, video_id) in enumerate(zip(item_ids, video_ids)):
                if position > 0:
                    time.sleep(0.5)
                yt.reorder_playlist_item(playlist_id, item_id, video_id, position)
        except Exception as e:
            logger.exception("Failed to reorder playlist items in %s", playlist_id)
            return Response({'error': f'Failed to reorder playlist items: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({'status': 'ok'})


class PlaylistItemDetailView(APIView):
    def delete(self, request, playlist_id, item_id):
        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()
            yt.remove_from_playlist(item_id)
        except Exception as e:
            logger.exception("Failed to remove item %s from playlist %s", item_id, playlist_id)
            return Response({'error': f'Failed to remove playlist item: {e}'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PlaylistCastView(APIView):
    def post(self, request, playlist_id):
        screen_id = request.data.get('screen_id')
        if not screen_id:
            return Response({'error': 'screen_id required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from .youtube_service import YouTubeService
            yt = YouTubeService()

            # Fetch all playlist items to get video IDs
            all_video_ids = []
            page_token = None
            while True:
                items, next_token = yt.fetch_playlist_items(
                    playlist_id, max_results=50, page_token=page_token
                )
                for item in items:
                    vid = item.get('snippet', {}).get('resourceId', {}).get('videoId')
                    if vid:
                        all_video_ids.append(vid)
                if not next_token:
                    break
                page_token = next_token

            if not all_video_ids:
                return Response({'error': 'Playlist is empty.'}, status=status.HTTP_400_BAD_REQUEST)

            session_data = yt.cast_to_receiver(screen_id, all_video_ids)
        except Exception as e:
            logger.exception("Failed to cast playlist %s", playlist_id)
            return Response({'error': f'Cast failed: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(session_data)


class OAuthView(APIView):
    """Manage Google OAuth for YouTube API access."""

    def get(self, request):
        """Check OAuth authentication status."""
        from .youtube_service import YouTubeService
        return Response(YouTubeService.get_oauth_state())

    def post(self, request):
        """Start OAuth flow — returns auth URL for frontend to open."""
        from .youtube_service import YouTubeService
        state = YouTubeService.get_oauth_state()
        if state['authenticated']:
            return Response({'status': 'already_authenticated', **state})
        if state['in_progress']:
            return Response({'status': 'already_in_progress', **state})

        auth_url = YouTubeService.start_oauth()
        return Response({
            'status': 'started',
            'auth_url': auth_url,
            **YouTubeService.get_oauth_state(),
        })

    def delete(self, request):
        """Delete OAuth token (logout)."""
        from .youtube_service import YouTubeService
        if os.path.exists(YouTubeService.TOKEN_FILE):
            os.remove(YouTubeService.TOKEN_FILE)
        return Response({'status': 'ok', **YouTubeService.get_oauth_state()})


class YouTubeSessionView(APIView):
    """Manage YouTube browser session for cookie-based features."""

    def get(self, request):
        """Check YouTube session status."""
        from .youtube_service import YouTubeCookieAPI
        return Response(YouTubeCookieAPI.get_login_state())

    def delete(self, request):
        """Delete YouTube session."""
        from .youtube_service import YouTubeCookieAPI
        YouTubeCookieAPI.logout()
        return Response({'status': 'ok', **YouTubeCookieAPI.get_login_state()})


class YouTubeSessionCookiesView(APIView):
    """Accept YouTube cookies from the browser extension."""

    def post(self, request):
        """Import YouTube cookies to create a browser session.
        
        Expected body: { "cookies": [ { "name": "...", "value": "...", "domain": "...", ... } ] }
        Cookies are in Playwright storage state format.
        """
        from .youtube_service import YouTubeCookieAPI

        cookies = request.data.get('cookies')
        if not cookies or not isinstance(cookies, list):
            return Response({'error': 'cookies array required'}, status=status.HTTP_400_BAD_REQUEST)

        # Validate SAPISID is present
        has_sapisid = any(
            c.get('name') in ('SAPISID', '__Secure-3PAPISID')
            for c in cookies
        )
        if not has_sapisid:
            return Response(
                {'error': 'SAPISID cookie not found. Make sure you are signed in to YouTube.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Save as Playwright browser state format
        state = {'cookies': cookies, 'origins': []}
        state_file = YouTubeCookieAPI._STATE_FILE
        os.makedirs(os.path.dirname(state_file), exist_ok=True)
        with open(state_file, 'w') as f:
            json.dump(state, f)

        logger.info("YouTube session imported from extension (%d cookies)", len(cookies))
        return Response({
            'status': 'ok',
            **YouTubeCookieAPI.get_login_state(),
        })


class MarkWatchedView(APIView):
    def post(self, request, video_id):
        try:
            video = Video.objects.get(video_id=video_id)
        except Video.DoesNotExist:
            return Response({'error': 'Video not found'}, status=status.HTTP_404_NOT_FOUND)

        # Try YouTube propagation first — only mark locally if it succeeds
        youtube_propagated = False
        youtube_session_needed = False
        try:
            from .youtube_service import YouTubeCookieAPI
            session_state = YouTubeCookieAPI.get_login_state()
            if not session_state['authenticated']:
                youtube_session_needed = True
            else:
                cookie_api = YouTubeCookieAPI()
                youtube_propagated = cookie_api.report_watch(video_id)
        except Exception:
            logger.warning("Failed to report watch to YouTube for %s", video_id)

        if not youtube_propagated:
            return Response({
                'status': 'not_propagated',
                'video_id': video_id,
                'playback_progress': video.playback_progress,
                'youtube_propagated': False,
                'youtube_session_needed': youtube_session_needed,
            })

        video.playback_progress = 100
        video.watched_locally = True
        video.save(update_fields=['playback_progress', 'watched_locally'])

        return Response({
            'status': 'ok',
            'video_id': video_id,
            'playback_progress': 100,
            'watched_locally': True,
            'youtube_propagated': True,
            'youtube_session_needed': False,
        })
