import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timedelta

from django.utils import timezone

from .models import Feed, Subscription, SubscriptionCategory, Video
from .youtube_service import YouTubeService

logger = logging.getLogger(__name__)

_sync_state = {
    'running': False,
    'phase': None,
    'total': 0,
    'processed': 0,
    'fetched_new': 0,
    'errors': 0,
    'skipped': 0,
    'subs_synced': 0,
    'started_at': None,
    'finished_at': None,
    'current_channel': None,
}
_sync_lock = threading.Lock()


def get_sync_state() -> dict:
    with _sync_lock:
        return dict(_sync_state)


def is_sync_running() -> bool:
    with _sync_lock:
        return _sync_state['running']


def _reset_state():
    _sync_state.update({
        'running': True,
        'phase': None,
        'total': 0,
        'processed': 0,
        'fetched_new': 0,
        'errors': 0,
        'skipped': 0,
        'subs_synced': 0,
        'started_at': timezone.now().isoformat(),
        'finished_at': None,
        'current_channel': None,
    })


def run_full_sync(force: bool = False):
    """Run full sync (subscriptions + videos) in a daemon thread."""
    with _sync_lock:
        if _sync_state['running']:
            return
        _reset_state()

    try:
        yt_service = YouTubeService()

        _sync_state['phase'] = 'subscriptions'
        sync_subscriptions_phase(yt_service)

        _sync_state['phase'] = 'videos'
        sync_videos_phase(yt_service, force=force)
    except Exception:
        logger.exception("Full sync failed")
    finally:
        with _sync_lock:
            _sync_state['running'] = False
            _sync_state['finished_at'] = timezone.now().isoformat()
            _sync_state['phase'] = None
            _sync_state['current_channel'] = None


def run_video_sync(force: bool = False, channel_ids: list = None):
    """Run video-only sync in a daemon thread."""
    with _sync_lock:
        if _sync_state['running']:
            return
        _reset_state()

    try:
        yt_service = YouTubeService()

        _sync_state['phase'] = 'videos'
        sync_videos_phase(yt_service, force=force, channel_ids=channel_ids)
    except Exception:
        logger.exception("Video sync failed")
    finally:
        with _sync_lock:
            _sync_state['running'] = False
            _sync_state['finished_at'] = timezone.now().isoformat()
            _sync_state['phase'] = None
            _sync_state['current_channel'] = None


def sync_subscriptions_phase(yt_service: YouTubeService):
    """Phase 1: Sync subscriptions from Data API + InnerTube."""
    logger.info("Starting subscriptions sync phase")

    # Fetch from Data API v3
    api_subs = yt_service.fetch_subscriptions()

    # Fetch supplemental from InnerTube (non-fatal)
    innertube_subs = []
    try:
        innertube_subs = yt_service.fetch_innertube_subscriptions()
    except Exception:
        logger.warning("InnerTube subscription fetch failed, continuing with Data API only")

    # Merge: add InnerTube channels not already in the Data API list
    api_channel_ids = {s['channel_id'] for s in api_subs}
    merged = list(api_subs)
    for it_sub in innertube_subs:
        if it_sub['channel_id'] not in api_channel_ids:
            merged.append({
                'channel_id': it_sub['channel_id'],
                'channel_title': it_sub.get('channel_title', ''),
                'channel_description': '',
                'thumbnail_url': None,
                'subscription_id': None,
                'subscription_date': None,
            })

    with _sync_lock:
        _sync_state['total'] = len(merged)
        _sync_state['processed'] = 0

    now = timezone.now()
    for sub_data in merged:
        try:
            defaults = {
                'channel_title': sub_data.get('channel_title', ''),
                'channel_description': sub_data.get('channel_description', ''),
                'thumbnail_url': sub_data.get('thumbnail_url'),
                'synced_at': now,
            }
            if sub_data.get('subscription_id'):
                defaults['subscription_id'] = sub_data['subscription_id']
            if sub_data.get('subscription_date'):
                defaults['subscription_date'] = sub_data['subscription_date']

            Subscription.objects.update_or_create(
                channel_id=sub_data['channel_id'],
                defaults=defaults,
            )
        except Exception:
            logger.exception("Failed to upsert subscription %s", sub_data.get('channel_id'))
            with _sync_lock:
                _sync_state['errors'] += 1
            continue

        with _sync_lock:
            _sync_state['processed'] += 1
            _sync_state['subs_synced'] += 1

    logger.info("Subscriptions sync complete: %d synced", _sync_state['subs_synced'])


def _get_channels_to_sync() -> list[str]:
    """Determine which channels need video sync based on feed category filters."""
    # Collect all category IDs referenced by any feed's filter_category_ids
    all_cat_ids = set()
    feeds = Feed.objects.exclude(filter_category_ids__isnull=True)
    for feed in feeds:
        if isinstance(feed.filter_category_ids, list):
            for item in feed.filter_category_ids:
                if isinstance(item, list):
                    all_cat_ids.update(item)
                else:
                    all_cat_ids.add(item)

    if all_cat_ids:
        # Get channel IDs for subscriptions in those categories
        channel_ids = list(
            SubscriptionCategory.objects.filter(category_id__in=all_cat_ids)
            .values_list('subscription__channel_id', flat=True)
            .distinct()
        )
        if channel_ids:
            return channel_ids

    # Fallback: sync all channels
    return list(Subscription.objects.values_list('channel_id', flat=True))


def _sync_single_channel(yt_service: YouTubeService, channel_id: str, force: bool):
    """Sync videos for a single channel. Returns count of new videos."""
    try:
        sub = Subscription.objects.get(channel_id=channel_id)
    except Subscription.DoesNotExist:
        logger.warning("Subscription not found for channel %s", channel_id)
        return 0

    _sync_state['current_channel'] = sub.channel_title

    # Staleness check
    if not force and sub.videos_synced_at:
        if timezone.now() - sub.videos_synced_at < timedelta(minutes=15):
            with _sync_lock:
                _sync_state['skipped'] += 1
                _sync_state['processed'] += 1
            return 0

    # Get uploads playlist ID
    details = yt_service.fetch_channel_details([channel_id])
    channel_detail = details.get(channel_id)
    if not channel_detail or not channel_detail.get('uploads_playlist_id'):
        logger.warning("No uploads playlist for channel %s", channel_id)
        with _sync_lock:
            _sync_state['processed'] += 1
        return 0

    playlist_id = channel_detail['uploads_playlist_id']

    # Determine published_after for incremental sync
    published_after = None
    latest_video = Video.objects.filter(channel_id=channel_id).order_by('-published_at').first()
    if latest_video and latest_video.published_at:
        published_after = latest_video.published_at.isoformat()

    # Fetch uploads
    uploads = yt_service.fetch_uploads(playlist_id, published_after=published_after)

    # Create Video records for new uploads
    new_video_ids = []
    for upload in uploads:
        _, created = Video.objects.get_or_create(
            video_id=upload['video_id'],
            defaults={
                'channel_id': channel_id,
                'title': upload.get('title', ''),
                'published_at': upload.get('published_at'),
                'thumbnail_url': upload.get('thumbnail_url'),
            },
        )
        if created:
            new_video_ids.append(upload['video_id'])

    # Batch fetch video details for new videos
    if new_video_ids:
        video_details = yt_service.fetch_video_details(new_video_ids)
        for vid_id, details in video_details.items():
            Video.objects.filter(video_id=vid_id).update(
                duration_seconds=details.get('duration_seconds'),
                video_type=details.get('video_type'),
            )

    with _sync_lock:
        _sync_state['fetched_new'] += len(new_video_ids)

    # Update subscription's videos_synced_at
    sub.videos_synced_at = timezone.now()
    sub.save(update_fields=['videos_synced_at'])

    with _sync_lock:
        _sync_state['processed'] += 1

    return len(new_video_ids)


def sync_videos_phase(yt_service: YouTubeService, force: bool = False, channel_ids: list = None):
    """Phase 2: Sync videos for channels using ThreadPoolExecutor."""
    logger.info("Starting videos sync phase")

    if channel_ids:
        channels_to_sync = channel_ids
    else:
        channels_to_sync = _get_channels_to_sync()

    with _sync_lock:
        _sync_state['total'] = len(channels_to_sync)
        _sync_state['processed'] = 0

    logger.info("Syncing videos for %d channels", len(channels_to_sync))

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(_sync_single_channel, yt_service, ch_id, force): ch_id
            for ch_id in channels_to_sync
        }
        for future in as_completed(futures):
            ch_id = futures[future]
            try:
                future.result()
            except Exception:
                logger.exception("Error syncing channel %s", ch_id)
                with _sync_lock:
                    _sync_state['errors'] += 1

    # Fetch watch progress after all channels synced
    try:
        progress_map = yt_service.fetch_watch_history()
        if progress_map:
            for video_id, progress in progress_map.items():
                Video.objects.filter(video_id=video_id).update(
                    playback_progress=progress
                )
            logger.info("Updated watch progress for %d videos", len(progress_map))
    except Exception:
        logger.warning("Failed to fetch watch progress, continuing")

    logger.info("Videos sync complete: %d new videos, %d errors, %d skipped",
                _sync_state['fetched_new'], _sync_state['errors'], _sync_state['skipped'])
