import json
import logging
import os
from pathlib import Path
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, cast

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import func, or_, text
from flask_cors import CORS
import requests

from models import Category, Feed, QueueItem, Subscription, Video, db, subscription_category
from youtube_service import YouTubeService

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///subscriptions.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
CORS(app)

_youtube_service_local = threading.local()
THUMBNAIL_CACHE_DIR = Path(app.instance_path) / "thumbnails"

# Lounge session state for Cast playback tracking
_lounge_session: Optional[Dict[str, str]] = None
_LOUNGE_SESSION_FILE = Path(app.instance_path) / "lounge_session.json"


def _save_lounge_session() -> None:
    """Persist lounge session to disk so it survives server restarts."""
    if _lounge_session:
        _LOUNGE_SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LOUNGE_SESSION_FILE.write_text(json.dumps(_lounge_session))
    elif _LOUNGE_SESSION_FILE.exists():
        _LOUNGE_SESSION_FILE.unlink()


def _load_lounge_session() -> Optional[Dict[str, str]]:
    """Load persisted lounge session from disk."""
    global _lounge_session
    if _lounge_session is None and _LOUNGE_SESSION_FILE.exists():
        try:
            _lounge_session = json.loads(_LOUNGE_SESSION_FILE.read_text())
            logger.debug("Restored lounge session from disk")
        except (json.JSONDecodeError, OSError):
            logger.warning("Failed to read lounge session file, ignoring")
            _lounge_session = None
    return _lounge_session


def get_youtube_service() -> YouTubeService:
    """Lazily initialize a thread-local YouTube service."""
    service = getattr(_youtube_service_local, "service", None)
    if service is None:
        logger.debug("Initializing YouTube service for thread=%s", threading.current_thread().name)
        service = YouTubeService()
        _youtube_service_local.service = service
    else:
        logger.debug("Reusing thread-local YouTube service for thread=%s", threading.current_thread().name)
    return service


def _thumbnail_extension(content_type: str, thumbnail_url: str) -> str:
    content_type = (content_type or "").lower()
    if "png" in content_type:
        return ".png"
    if "webp" in content_type:
        return ".webp"
    if "gif" in content_type:
        return ".gif"

    suffix = Path(thumbnail_url).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return suffix
    return ".jpg"


def _cache_thumbnail(thumbnail_url: Optional[str], video_id: str) -> Optional[str]:
    if not thumbnail_url:
        return None

    THUMBNAIL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    response = requests.get(thumbnail_url, timeout=20)
    response.raise_for_status()

    extension = _thumbnail_extension(response.headers.get("Content-Type", ""), thumbnail_url)
    cached_path = THUMBNAIL_CACHE_DIR / f"{video_id}{extension}"
    cached_path.write_bytes(response.content)
    return str(cached_path)


def _serialize_queue_items() -> List[Dict[str, Any]]:
    """Return queued videos ordered by sort order."""
    queue_items = cast(List[QueueItem], QueueItem.query.order_by(QueueItem.sort_order.asc(), QueueItem.added_at.asc()).all())
    return [item.to_dict() for item in queue_items]


def _next_queue_sort_order() -> int:
    """Return the next queue sort order value."""
    max_sort = db.session.query(func.max(QueueItem.sort_order)).scalar()
    return (max_sort or 0) + 1


def _clear_queue_items() -> None:
    """Remove all queue items."""
    QueueItem.query.delete()
    db.session.commit()


def _reorder_queue_items(ordered_ids: List[int]) -> Dict[str, Any]:
    """Persist a new queue item order."""
    queue_items = cast(List[QueueItem], QueueItem.query.all())
    queue_items_by_id = {item.id: item for item in queue_items}
    current_ids = set(queue_items_by_id.keys())
    requested_ids = set(ordered_ids)

    if len(ordered_ids) != len(current_ids):
        raise ValueError("Queue item list is incomplete")

    if requested_ids != current_ids:
        raise ValueError("Queue item IDs do not match the current queue")

    for sort_order, queue_item_id in enumerate(ordered_ids, start=1):
        queue_items_by_id[queue_item_id].sort_order = sort_order

    db.session.commit()
    return {"items": _serialize_queue_items(), "updated_count": len(ordered_ids)}


def _playlist_title_for_queue(prefix: str) -> str:
    """Build a short playlist title for the current queue."""
    return f"{prefix} {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}"


def _mark_video_played(video_id: str) -> None:
    """Set a video's playback_progress to 100 (fully watched)."""
    video = Video.query.filter_by(video_id=video_id).first()
    if video:
        video.playback_progress = 100


def _remove_queue_item_as_played(item: QueueItem) -> None:
    """Delete a queue item and mark its video as played."""
    _mark_video_played(item.video_id)
    db.session.delete(item)


def _refresh_queue_playback_progress() -> Dict[str, Any]:
    """Refresh playback progress for queued videos and prune watched items."""
    global _lounge_session
    _load_lounge_session()
    queue_items = cast(List[QueueItem], QueueItem.query.order_by(QueueItem.sort_order.asc(), QueueItem.added_at.asc()).all())
    if not queue_items:
        _lounge_session = None
        _save_lounge_session()
        return {"items": [], "removed_count": 0, "updated_count": 0}

    removed_count = 0

    # If we have an active Lounge session, ask the receiver what's playing now
    if _lounge_session:
        try:
            service = get_youtube_service()
            now_playing = service.get_now_playing(
                lounge_token=_lounge_session["lounge_token"],
                sid=_lounge_session["SID"],
                gsessionid=_lounge_session["gsessionid"],
            )
            has_played = _lounge_session.get("has_played", False)
            stale_count = _lounge_session.get("stale_count", 0)

            if now_playing:
                current_video_id = now_playing.get("videoId", "")
                state = now_playing.get("state", "")
                duration = now_playing.get("duration", "0")
                current_time = now_playing.get("currentTime", "0")
                logger.debug(
                    "Lounge nowPlaying videoId=%s state=%s duration=%s currentTime=%s has_played=%s stale_count=%s",
                    current_video_id, state, duration, current_time, has_played, stale_count,
                )

                queue_video_ids = [item.video_id for item in queue_items]

                # Mark session as having active playback once we see a queue
                # video actually playing (state 1 = playing, 2 = paused,
                # or any state with a real duration).
                if current_video_id in queue_video_ids and not has_played:
                    if state in ("1", "2") or duration not in ("0", ""):
                        _lounge_session["has_played"] = True
                        has_played = True
                        _lounge_session["stale_count"] = 0
                        _save_lounge_session()
                        logger.debug("Marked lounge session as has_played=True")

                if current_video_id in queue_video_ids:
                    # Reset stale counter when video is actively playing (has real duration)
                    if stale_count > 0 and duration not in ("0", ""):
                        _lounge_session["stale_count"] = 0
                        stale_count = 0
                        _save_lounge_session()

                    # Remove all queue items that come before the currently playing video
                    for item in queue_items:
                        if item.video_id == current_video_id:
                            # If playback is stopped/ended (state 0 or -1), also remove the current video
                            if state in ("0", "-1"):
                                _remove_queue_item_as_played(item)
                                removed_count += 1
                            break
                        _remove_queue_item_as_played(item)
                        removed_count += 1

                    # After a playlist finishes, the Lounge keeps reporting the
                    # last video with state=3, duration=0, currentTime=0.  When
                    # the current video is the last item AND we have previously
                    # seen active playback, treat the playlist as finished —
                    # but only after seeing this pattern multiple times.
                    is_last_item = (queue_video_ids[-1] == current_video_id)
                    if is_last_item and has_played and duration == "0" and current_time == "0" and state != "1":
                        stale_count += 1
                        _lounge_session["stale_count"] = stale_count
                        _save_lounge_session()
                        if stale_count >= 3:
                            logger.debug("Last queue video stale for %s polls, removing it", stale_count)
                            remaining_items = cast(List[QueueItem], QueueItem.query.all())
                            for ri in remaining_items:
                                if ri.video_id == current_video_id:
                                    _remove_queue_item_as_played(ri)
                                    removed_count += 1
                        else:
                            logger.debug("Last queue video duration=0 stale_count=%s, waiting", stale_count)
                elif current_video_id and current_video_id not in queue_video_ids and has_played:
                    # Receiver moved to a video not in our queue (autoplay) — playlist ended
                    logger.debug(
                        "Lounge nowPlaying videoId=%s not in queue (has_played=True), clearing queue",
                        current_video_id,
                    )
                    for item in queue_items:
                        _remove_queue_item_as_played(item)
                        removed_count += 1
                else:
                    # Empty videoId or videoId not in queue before playback started — skip
                    logger.debug(
                        "Lounge nowPlaying videoId=%r not actionable (has_played=%s), keeping queue",
                        current_video_id, has_played,
                    )
            else:
                # No nowPlaying data in this long-poll chunk — this does NOT
                # reliably indicate playback has ended.  Skip and retry next poll.
                logger.debug("Lounge returned no nowPlaying, skipping (not a reliable end signal)")

            if removed_count > 0:
                db.session.commit()
                logger.debug("Removed %s queue items", removed_count)

            remaining = QueueItem.query.count()
            if remaining == 0:
                _lounge_session = None
                _save_lounge_session()

            logger.debug(
                "Queue playback progress refreshed removed_count=%s remaining=%s",
                removed_count, remaining,
            )
            return {
                "items": _serialize_queue_items(),
                "removed_count": removed_count,
                "updated_count": 0,
            }
        except Exception:
            logger.exception("Failed to query Lounge nowPlaying, clearing session and falling back to history")
            _lounge_session = None
            _save_lounge_session()

    # Fallback: check YouTube watch history for progress
    video_ids = [item.video_id for item in queue_items]
    videos_by_id = {
        video.video_id: video
        for video in cast(List[Video], Video.query.filter(Video.video_id.in_(video_ids)).all())
    }
    service = YouTubeService.from_credentials(get_youtube_service().credentials)

    try:
        progress_map = service.fetch_watch_progress(video_ids)
    except Exception:
        logger.exception("Failed to refresh queue playback progress")
        progress_map = {}

    updated_count = 0
    removed_items: List[QueueItem] = []

    for item in queue_items:
        video = videos_by_id.get(item.video_id)
        if video is None:
            removed_items.append(item)
            removed_count += 1
            continue

        progress = progress_map.get(item.video_id)
        if progress is not None:
            video.playback_progress = progress
            updated_count += 1

        if (video.playback_progress or 0) >= 95:
            removed_items.append(item)
            removed_count += 1

    for item in removed_items:
        db.session.delete(item)

    db.session.commit()
    logger.debug(
        "Queue playback progress refreshed updated_count=%s removed_count=%s remaining=%s",
        updated_count,
        removed_count,
        QueueItem.query.count(),
    )
    return {"items": _serialize_queue_items(), "removed_count": removed_count, "updated_count": updated_count}


def _create_queue_playlist(clear_queue_items: bool) -> Dict[str, Any]:
    """Create a YouTube playlist from the current queue."""
    queue_items = cast(List[QueueItem], QueueItem.query.order_by(QueueItem.sort_order.asc(), QueueItem.added_at.asc()).all())
    if not queue_items:
        raise ValueError("Queue is empty")

    service = get_youtube_service()
    playlist_title = _playlist_title_for_queue("Queue")
    playlist_description = "Created from YouTube Subscriptions Organizer queue."
    playlist_id = service.create_playlist(playlist_title, playlist_description)
    added_count = service.add_videos_to_playlist(playlist_id, [item.video_id for item in queue_items])

    if clear_queue_items:
        QueueItem.query.delete()
        db.session.commit()

    return {
        "playlist_id": playlist_id,
        "playlist_url": f"https://www.youtube.com/playlist?list={playlist_id}",
        "playlist_title": playlist_title,
        "added_count": added_count,
        "cleared": clear_queue_items,
    }


# ============================================================================
# Background Sync State
# ============================================================================

# How old a channel's videos_synced_at must be before re-syncing (15 minutes)
SYNC_STALENESS_SECONDS = 15 * 60

_sync_lock = threading.Lock()
_sync_state: Dict[str, Any] = {
    "running": False,
    "phase": None,           # "subscriptions" | "videos" | None
    "total": 0,
    "processed": 0,
    "fetched_new": 0,
    "errors": 0,
    "skipped": 0,
    "subs_synced": 0,
    "started_at": None,
    "finished_at": None,
    "current_channel": None,
}


@app.before_request
def init_db():
    """Initialize database on first request."""
    logger.debug(
        "Ensuring database is initialized for request method=%s path=%s",
        request.method,
        request.path,
    )
    with app.app_context():
        db.create_all()
        _ensure_category_sort_order_column()
        _initialize_category_sort_order()
        _ensure_subscription_videos_synced_at_column()
        _ensure_feed_play_state_column()


def _ensure_category_sort_order_column() -> None:
    logger.debug("Checking categories table for sort_order column")
    result = db.session.execute(text("PRAGMA table_info(categories)"))
    columns = [row[1] for row in result.fetchall()]
    if "sort_order" not in columns:
        logger.debug("Adding missing sort_order column to categories table")
        db.session.execute(text("ALTER TABLE categories ADD COLUMN sort_order INTEGER"))
        db.session.commit()
    else:
        logger.debug("sort_order column already present")


def _initialize_category_sort_order() -> None:
    # Assign sort_order for any rows missing it, grouped by parent
    parents = db.session.execute(
        text("SELECT DISTINCT parent_id FROM categories")
    ).fetchall()
    logger.debug("Initializing category sort order for %s parent groups", len(parents))

    updated_rows = 0

    for (parent_id,) in parents:
        if parent_id is None:
            rows = db.session.execute(
                text(
                    "SELECT id, sort_order FROM categories "
                    "WHERE parent_id IS NULL "
                    "ORDER BY COALESCE(sort_order, 0), id"
                )
            ).fetchall()
        else:
            rows = db.session.execute(
                text(
                    "SELECT id, sort_order FROM categories "
                    "WHERE parent_id = :parent_id "
                    "ORDER BY COALESCE(sort_order, 0), id"
                ),
                {"parent_id": parent_id},
            ).fetchall()

        order = 1
        for row in rows:
            if row[1] is None:
                db.session.execute(
                    text("UPDATE categories SET sort_order = :order WHERE id = :id"),
                    {"order": order, "id": row[0]},
                )
                updated_rows += 1
            order += 1
    db.session.commit()
    logger.debug("Category sort order initialization complete; updated_rows=%s", updated_rows)


def _ensure_subscription_videos_synced_at_column() -> None:
    """Add videos_synced_at column to subscriptions table if missing (schema migration)."""
    result = db.session.execute(text("PRAGMA table_info(subscriptions)"))
    columns = [row[1] for row in result.fetchall()]
    if "videos_synced_at" not in columns:
        logger.debug("Adding missing videos_synced_at column to subscriptions table")
        db.session.execute(text("ALTER TABLE subscriptions ADD COLUMN videos_synced_at DATETIME"))
        db.session.commit()
    else:
        logger.debug("videos_synced_at column already present")


def _ensure_feed_play_state_column() -> None:
    """Add filter_play_state column to feeds table if missing (schema migration)."""
    result = db.session.execute(text("PRAGMA table_info(feeds)"))
    columns = [row[1] for row in result.fetchall()]
    if "filter_play_state" in columns:
        logger.debug("filter_play_state column already present")
        return

    logger.debug("Adding missing filter_play_state column to feeds table")
    db.session.execute(text("ALTER TABLE feeds ADD COLUMN filter_play_state VARCHAR(16)"))
    db.session.commit()

    if "filter_played_only" in columns:
        logger.debug("Backfilling filter_play_state from legacy filter_played_only values")
        db.session.execute(
            text(
                "UPDATE feeds SET filter_play_state = CASE "
                "WHEN filter_played_only = 1 THEN 'played' "
                "WHEN filter_played_only = 0 THEN 'both' "
                "ELSE 'both' END"
            )
        )
        db.session.commit()


# ============================================================================
# Background Video Sync
# ============================================================================


def _sync_subscriptions_phase() -> int:
    """Fetch all subscriptions from YouTube and upsert into the DB.

    Must be called inside an active app context.  Returns the count of upserted rows.
    """
    logger.info("Starting subscriptions phase")
    service = get_youtube_service()
    yt_subs = service.fetch_all_subscriptions()
    logger.debug("Fetched %s subscriptions from YouTube", len(yt_subs))

    synced_count = 0
    now = datetime.utcnow()
    for yt_sub in yt_subs:
        sub = Subscription.query.filter_by(channel_id=yt_sub["channelId"]).first()
        if not sub:
            sub = Subscription(channel_id=yt_sub["channelId"])
        sub.subscription_id = yt_sub.get("subscriptionId")
        sub.channel_title = yt_sub["channelTitle"]
        sub.channel_description = yt_sub.get("channelDescription", "")
        sub.thumbnail_url = yt_sub.get("thumbnailUrl")
        sub.subscription_date = _parse_iso(yt_sub.get("subscriptionDate"))
        sub.synced_at = now
        db.session.add(sub)
        synced_count += 1

    db.session.commit()
    logger.info("Subscriptions phase complete synced_count=%s", synced_count)
    return synced_count


def _run_full_sync(force: bool = False) -> None:
    """Background thread: sync subscriptions then fetch new videos.

    Phases:
      1. "subscriptions" – Pull the full subscription list from YouTube and upsert.
      2. "videos"        – Incrementally fetch new uploads for every channel.
    """
    with app.app_context():
        logger.info("Full background sync started force=%s", force)
        try:
            # ---- Phase 1: subscriptions ----
            with _sync_lock:
                _sync_state["phase"] = "subscriptions"
                _sync_state["current_channel"] = None

            subs_synced = _sync_subscriptions_phase()

            with _sync_lock:
                _sync_state["subs_synced"] = subs_synced

            # ---- Phase 2: videos ----
            with _sync_lock:
                _sync_state["phase"] = "videos"

            _run_video_sync_inner(force=force)

        except Exception:
            logger.exception("Full sync failed unexpectedly")
        finally:
            with _sync_lock:
                _sync_state["running"] = False
                _sync_state["phase"] = None
                _sync_state["finished_at"] = datetime.utcnow().isoformat()
                _sync_state["current_channel"] = None
            logger.info("Full sync thread exiting")


@app.post("/api/sync/all")
def start_full_sync() -> Dict[str, Any]:
    """Start a full background sync: subscriptions then videos.

    Accepts optional JSON body:
      force (bool) — skip staleness check and re-sync all video channels
    """
    data = request.json or {}
    force: bool = bool(data.get("force", False))
    logger.debug("Handling start_full_sync force=%s", force)

    with _sync_lock:
        if _sync_state["running"]:
            return jsonify({"error": "Sync already in progress", "state": dict(_sync_state)}), 409

        _sync_state.update({
            "running": True,
            "phase": "subscriptions",
            "total": 0,
            "processed": 0,
            "fetched_new": 0,
            "errors": 0,
            "skipped": 0,
            "subs_synced": 0,
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "current_channel": None,
        })

    thread = threading.Thread(
        target=_run_full_sync,
        kwargs={"force": force},
        daemon=True,
        name="full-sync",
    )
    thread.start()
    logger.debug("Started full sync background thread")

    with _sync_lock:
        return jsonify({"message": "Sync started", "state": dict(_sync_state)}), 202


def _fetch_channel_videos_bg(channel_id: str, published_after: Optional[datetime]) -> List[Dict[str, Any]]:
    """Fetch playlist items for a single channel; called from worker threads.
    Creates its own YouTube API resource so concurrent calls are thread-safe."""
    svc = YouTubeService.from_credentials(get_youtube_service().credentials)
    return svc.fetch_recent_uploads_for_channel(channel_id, limit=50, published_after=published_after)


def _get_feed_subscription_channel_ids() -> Optional[List[str]]:
    """Return channel IDs of subscriptions used in at least one Feed.

    Returns None if any feed has no category filter (i.e. uses all subscriptions),
    or an empty list if there are no feeds at all.
    """
    feeds = Feed.query.all()
    if not feeds:
        logger.info("No feeds defined; no subscriptions need video sync")
        return []

    all_category_ids: set = set()
    for feed in feeds:
        groups = feed._parse_category_groups()
        if not groups:
            # Feed with no category filter uses ALL subscriptions
            logger.debug("Feed id=%s has no category filter; all subscriptions needed", feed.id)
            return None
        for group in groups:
            all_category_ids.update(group)

    if not all_category_ids:
        return []

    channel_ids = [
        row[0]
        for row in (
            db.session.query(Subscription.channel_id)
            .join(subscription_category, Subscription.id == subscription_category.c.subscription_id)
            .filter(subscription_category.c.category_id.in_(all_category_ids))
            .distinct()
            .all()
        )
    ]
    logger.info("Feeds reference %s categories -> %s subscriptions", len(all_category_ids), len(channel_ids))
    return channel_ids


def _run_video_sync_inner(channel_ids: Optional[List[str]] = None, force: bool = False) -> None:
    """Incrementally fetch new videos for subscriptions. Must be called inside an app context.

    Only syncs subscriptions that are used in at least one Video Feed (by category).

    Strategy:
    1. Skip channels synced within SYNC_STALENESS_SECONDS (unless force=True).
    2. For each channel to process, find the newest stored video date and pass it
       as published_after so only genuinely new videos are downloaded.
    3. YouTube API calls are made concurrently (ThreadPoolExecutor) while DB writes
       are serialised to keep SQLite happy.
    4. After collecting new video IDs, bulk-fetch durations/types via videos.list.
    """
    logger.info("Video sync inner started force=%s", force)

    try:
        # Build a dedicated service instance for the background thread
        bg_service = YouTubeService.from_credentials(get_youtube_service().credentials)

        if channel_ids:
            subs = Subscription.query.filter(Subscription.channel_id.in_(channel_ids)).all()
        else:
            # Only sync subscriptions referenced by feeds
            feed_channel_ids = _get_feed_subscription_channel_ids()
            if feed_channel_ids is not None:
                if not feed_channel_ids:
                    logger.info("No subscriptions are used in any feed; skipping video sync")
                    return
                subs = Subscription.query.filter(
                    Subscription.channel_id.in_(feed_channel_ids)
                ).all()
            else:
                # A feed with no category filter exists → need all subscriptions
                subs = Subscription.query.all()

        now = datetime.utcnow()
        cutoff_ts = now - timedelta(seconds=SYNC_STALENESS_SECONDS)

        to_process: List[Subscription] = []
        skipped = 0
        for sub in subs:
            if not force and sub.videos_synced_at and sub.videos_synced_at > cutoff_ts:
                skipped += 1
            else:
                to_process.append(sub)

        with _sync_lock:
            _sync_state.update({
                "total": len(subs),
                "processed": skipped,
                "fetched_new": 0,
                "errors": 0,
                "skipped": skipped,
                "current_channel": None,
            })

        logger.info(
            "Video sync plan total=%s to_process=%s skipped=%s",
            len(subs), len(to_process), skipped,
        )

        if not to_process:
            logger.info("All channels are fresh; nothing to sync")
            return

        # Single query for newest stored video per channel (avoids N queries)
        newest_per_channel: Dict[str, datetime] = dict(
            db.session.query(Video.channel_id, func.max(Video.published_at))
            .filter(Video.channel_id.in_([s.channel_id for s in to_process]))
            .group_by(Video.channel_id)
            .all()
        )

        # --- Concurrent YouTube API fetches ---
        playlist_results: Dict[str, List[Dict[str, Any]]] = {}
        error_channels: set = set()

        with ThreadPoolExecutor(max_workers=3) as executor:
            future_map = {
                executor.submit(
                    _fetch_channel_videos_bg,
                    sub.channel_id,
                    newest_per_channel.get(sub.channel_id),
                ): sub
                for sub in to_process
            }
            for future in as_completed(future_map):
                sub = future_map[future]
                with _sync_lock:
                    _sync_state["current_channel"] = sub.channel_title
                try:
                    playlist_results[sub.channel_id] = future.result()
                except Exception:
                    logger.exception("Error fetching channel_id=%s", sub.channel_id)
                    error_channels.add(sub.channel_id)
                    playlist_results[sub.channel_id] = []

        # --- Determine which video IDs are truly new ---
        existing_ids: set = set()
        candidate_ids = [
            v["videoId"]
            for videos in playlist_results.values()
            for v in videos
            if v.get("videoId")
        ]
        if candidate_ids:
            existing_rows = db.session.query(Video.video_id).filter(
                Video.video_id.in_(candidate_ids)
            ).all()
            existing_ids = {row[0] for row in existing_rows}

        new_video_data: List[Dict[str, Any]] = []
        for channel_id, videos in playlist_results.items():
            for v in videos:
                vid_id = v.get("videoId")
                if vid_id and vid_id not in existing_ids:
                    v["_channel_id"] = channel_id
                    new_video_data.append(v)

        logger.info("Found %s new videos across %s channels", len(new_video_data), len(to_process))

        # --- Bulk-fetch durations and video types ---
        new_ids_list = [v["videoId"] for v in new_video_data]
        video_details: Dict[str, Dict[str, Any]] = {}
        if new_ids_list:
            try:
                video_details = bg_service.fetch_video_details(new_ids_list)
            except Exception:
                logger.exception("Failed to fetch video details; storing without duration/type")

        playback_progress: Dict[str, int] = {}
        if new_ids_list:
            try:
                playback_progress = bg_service.fetch_watch_progress(new_ids_list)
            except Exception:
                logger.exception("Failed to fetch watch progress during sync")

        # --- Write new videos to DB ---
        sync_ts = datetime.utcnow()
        fetched_new = 0

        for v in new_video_data:
            thumbnail_path = None
            try:
                thumbnail_path = _cache_thumbnail(v.get("thumbnailUrl"), v["videoId"])
            except Exception:
                logger.exception("Failed to cache thumbnail for video_id=%s", v["videoId"])

            details = video_details.get(v["videoId"], {})
            vid = Video(
                video_id=v["videoId"],
                channel_id=v["_channel_id"],
                title=v.get("title", ""),
                thumbnail_url=v.get("thumbnailUrl"),
                thumbnail_path=thumbnail_path,
                published_at=_parse_iso(v.get("publishedAt")),
                duration_seconds=details.get("duration_seconds"),
                video_type=details.get("video_type"),
                playback_progress=playback_progress.get(v["videoId"]),
            )
            db.session.add(vid)
            fetched_new += 1

        # Update synced_at on each processed subscription
        processed = skipped
        errors = len(error_channels)
        for sub in to_process:
            if sub.channel_id not in error_channels:
                sub.videos_synced_at = sync_ts
            processed += 1
            with _sync_lock:
                _sync_state["processed"] = processed
                _sync_state["fetched_new"] = fetched_new
                _sync_state["errors"] = errors

        try:
            db.session.commit()
            logger.info("Video sync complete fetched_new=%s errors=%s", fetched_new, errors)
        except Exception:
            logger.exception("DB commit failed during video sync")
            db.session.rollback()

    except Exception:
        logger.exception("Video sync inner failed unexpectedly")


@app.post("/api/sync/videos")
def start_video_sync() -> Dict[str, Any]:
    """Start a background video synchronization job.

    Accepts optional JSON body:
      force (bool)         — ignore staleness threshold and re-sync all channels
      channel_ids (list)   — restrict sync to these channel IDs
    """
    data = request.json or {}
    force: bool = bool(data.get("force", False))
    channel_ids: Optional[List[str]] = data.get("channel_ids") or None

    logger.debug("Handling start_video_sync force=%s channel_ids_count=%s", force,
                 len(channel_ids) if channel_ids else "all")

    with _sync_lock:
        if _sync_state["running"]:
            return jsonify({"error": "Sync already in progress", "state": dict(_sync_state)}), 409

        _sync_state.update({
            "running": True,
            "phase": "videos",
            "total": 0,
            "processed": 0,
            "fetched_new": 0,
            "errors": 0,
            "skipped": 0,
            "subs_synced": 0,
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "current_channel": None,
        })

    def _video_only_thread():
        with app.app_context():
            try:
                _run_video_sync_inner(channel_ids=channel_ids, force=force)
            finally:
                with _sync_lock:
                    _sync_state["running"] = False
                    _sync_state["phase"] = None
                    _sync_state["finished_at"] = datetime.utcnow().isoformat()

    thread = threading.Thread(target=_video_only_thread, daemon=True, name="video-sync")
    thread.start()
    logger.debug("Started background video sync thread")

    with _sync_lock:
        return jsonify({"message": "Sync started", "state": dict(_sync_state)}), 202


@app.get("/api/sync/status")
def get_sync_status() -> Dict[str, Any]:
    """Return the current background sync state."""
    logger.debug("Handling get_sync_status request")
    with _sync_lock:
        return jsonify(dict(_sync_state))


def _serialize_playlist_items_page(playlist_id: str, page: int, per_page: int) -> Dict[str, Any]:
    """Fetch and enrich a single page of playlist items."""
    service = get_youtube_service()
    raw_data = service.fetch_playlist_items(playlist_id, page=page, per_page=per_page)
    raw_items = cast(List[Dict[str, Any]], raw_data.get("items", []))
    video_ids = [item.get("video_id") for item in raw_items if item.get("video_id")]

    local_videos: Dict[str, Video] = {}
    if video_ids:
        local_rows = cast(List[Video], Video.query.filter(Video.video_id.in_(video_ids)).all())
        local_videos = {video.video_id: video for video in local_rows}

    video_details: Dict[str, Dict[str, Any]] = {}
    if video_ids:
        try:
            video_details = service.fetch_video_details(video_ids)
        except Exception:
            logger.exception("Failed to fetch video details for playlist_id=%s page=%s", playlist_id, page)
            video_details = {}

    items: List[Dict[str, Any]] = []
    for raw_item in raw_items:
        video_id = raw_item.get("video_id")
        local_video = local_videos.get(video_id or "")

        if local_video:
            video_data = local_video.to_dict()
        else:
            details = video_details.get(video_id or "", {})
            video_data = {
                "video_id": video_id,
                "title": raw_item.get("title", "Untitled video"),
                "channel_title": raw_item.get("channel_title", ""),
                "published_at": raw_item.get("published_at"),
                "thumbnail_url": raw_item.get("thumbnail_url"),
                "duration_seconds": details.get("duration_seconds"),
                "video_type": details.get("video_type"),
                "playback_progress": None,
            }

        if not video_data.get("thumbnail_url"):
            video_data["thumbnail_url"] = raw_item.get("thumbnail_url")
        if not video_data.get("title"):
            video_data["title"] = raw_item.get("title", "Untitled video")
        if not video_data.get("channel_title"):
            video_data["channel_title"] = raw_item.get("channel_title", "")
        if not video_data.get("published_at"):
            video_data["published_at"] = raw_item.get("published_at")

        video_data["playlist_item_id"] = raw_item.get("playlist_item_id")
        video_data["playlist_id"] = playlist_id
        items.append(video_data)

    return {
        **raw_data,
        "items": items,
        "has_more": bool(raw_data.get("next_page_token")),
    }


# ============================================================================
# Playlist API Endpoints
# ============================================================================


@app.get("/api/playlists")
def get_playlists() -> Dict[str, Any]:
    """Get all playlists owned by the authenticated user."""
    logger.debug("Handling get_playlists request")
    service = get_youtube_service()
    playlists = service.fetch_owned_playlists()
    return jsonify({"items": playlists})


@app.post("/api/playlists/<string:playlist_id>/items")
def add_playlist_items(playlist_id: str) -> Dict[str, Any]:
    """Add one or more videos to a playlist."""
    logger.debug("Handling add_playlist_items request playlist_id=%s", playlist_id)
    data = request.get_json(silent=True) or {}
    video_ids = data.get("video_ids")
    if isinstance(video_ids, str):
        video_ids = [video_ids]
    elif data.get("video_id"):
        video_ids = [data.get("video_id")]

    if not isinstance(video_ids, list) or not video_ids:
        return jsonify({"error": "video_ids must be a non-empty list"}), 400

    try:
        service = get_youtube_service()
        added_count = service.add_videos_to_playlist(playlist_id, video_ids)
        return jsonify({
            "message": "Videos added to playlist",
            "playlist_id": playlist_id,
            "added_count": added_count,
            "video_ids": video_ids,
        }), 201
    except Exception as error:
        logger.exception("Failed to add playlist items playlist_id=%s", playlist_id)
        return jsonify({"error": str(error)}), 500


@app.post("/api/playlists/<string:playlist_id>/items/reorder")
def reorder_playlist_items(playlist_id: str) -> Dict[str, Any]:
    """Reorder items in a playlist."""
    logger.debug("Handling reorder_playlist_items request playlist_id=%s", playlist_id)
    data = request.get_json(silent=True) or {}
    playlist_item_ids = data.get("playlist_item_ids")
    if not isinstance(playlist_item_ids, list) or not playlist_item_ids:
        return jsonify({"error": "playlist_item_ids must be a non-empty list"}), 400

    try:
        service = get_youtube_service()
        current_items = service.fetch_all_playlist_items(playlist_id)
        items_by_id = {
            item.get("playlist_item_id"): item
            for item in current_items
            if item.get("playlist_item_id") and item.get("video_id")
        }

        ordered_ids = []
        for playlist_item_id in playlist_item_ids:
            if playlist_item_id in items_by_id and playlist_item_id not in ordered_ids:
                ordered_ids.append(playlist_item_id)

        if len(ordered_ids) < 2:
            return jsonify({"message": "Playlist order unchanged", "updated_count": 0}), 200

        current_index_by_id = {
            item["playlist_item_id"]: index
            for index, item in enumerate(current_items)
            if item.get("playlist_item_id")
        }
        insert_at = min(current_index_by_id[playlist_item_id] for playlist_item_id in ordered_ids)

        updated_count = 0
        for offset, playlist_item_id in enumerate(ordered_ids):
            item = items_by_id[playlist_item_id]
            service.update_playlist_item_position(
                playlist_item_id=playlist_item_id,
                playlist_id=playlist_id,
                video_id=str(item["video_id"]),
                position=insert_at + offset,
            )
            updated_count += 1

        return jsonify({
            "message": "Playlist reordered",
            "playlist_id": playlist_id,
            "updated_count": updated_count,
            "playlist_item_ids": ordered_ids,
        }), 200
    except Exception as error:
        logger.exception("Failed to reorder playlist items playlist_id=%s", playlist_id)
        return jsonify({"error": str(error)}), 500


@app.get("/api/playlists/<string:playlist_id>/items")
def get_playlist_items(playlist_id: str) -> Dict[str, Any]:
    """Get a page of items for a specific playlist."""
    page = request.args.get("page", default=1, type=int) or 1
    per_page = request.args.get("per_page", default=20, type=int) or 20
    logger.debug(
        "Handling get_playlist_items request playlist_id=%s page=%s per_page=%s",
        playlist_id,
        page,
        per_page,
    )
    try:
        data = _serialize_playlist_items_page(playlist_id, page, per_page)
        return jsonify(data)
    except Exception as error:
        logger.exception("Failed to load playlist items playlist_id=%s", playlist_id)
        return jsonify({"error": str(error)}), 500


@app.delete("/api/playlists/<string:playlist_id>/items/<string:playlist_item_id>")
def delete_playlist_item(playlist_id: str, playlist_item_id: str) -> Dict[str, Any]:
    """Delete an item from a playlist."""
    logger.debug(
        "Handling delete_playlist_item request playlist_id=%s playlist_item_id=%s",
        playlist_id,
        playlist_item_id,
    )
    try:
        service = get_youtube_service()
        if not service.delete_playlist_item(playlist_item_id):
            return jsonify({"error": "Failed to delete playlist item"}), 500
        return jsonify({"message": "Playlist item removed", "playlist_id": playlist_id, "playlist_item_id": playlist_item_id})
    except Exception as error:
        logger.exception("Failed to delete playlist item playlist_item_id=%s", playlist_item_id)
        return jsonify({"error": str(error)}), 500


@app.delete("/api/playlists/<string:playlist_id>")
def delete_playlist(playlist_id: str) -> Dict[str, Any]:
    """Delete an owned playlist."""
    logger.debug("Handling delete_playlist request playlist_id=%s", playlist_id)
    try:
        service = get_youtube_service()
        if not service.delete_playlist(playlist_id):
            return jsonify({"error": "Failed to delete playlist"}), 500
        return jsonify({"message": "Playlist deleted", "playlist_id": playlist_id})
    except Exception as error:
        logger.exception("Failed to delete playlist playlist_id=%s", playlist_id)
        return jsonify({"error": str(error)}), 500


@app.post("/api/playlists/<string:playlist_id>/cast")
def cast_playlist(playlist_id: str) -> Dict[str, Any]:
    """Start playback for a playlist on a YouTube Cast receiver."""
    logger.debug("Handling cast_playlist request playlist_id=%s", playlist_id)
    try:
        data = request.get_json(silent=True) or {}
        screen_id = data.get("screen_id")
        logger.debug("cast_playlist screen_id=%s", screen_id)

        if not screen_id:
            return jsonify({"error": "screen_id is required – ensure Cast session is connected"}), 400

        service = get_youtube_service()
        all_video_ids = service.fetch_all_playlist_video_ids(playlist_id)
        if not all_video_ids:
            return jsonify({"error": "No videos found in playlist"}), 400

        lounge_result = service.cast_to_receiver(
            screen_id=screen_id,
            video_id=all_video_ids[0],
            playlist_id=playlist_id,
            video_ids=all_video_ids,
        )

        global _lounge_session
        _lounge_session = {
            "lounge_token": lounge_result.get("lounge_token", ""),
            "SID": lounge_result.get("SID", ""),
            "gsessionid": lounge_result.get("gsessionid", ""),
            "has_played": False,
        }
        _save_lounge_session()

        return jsonify({
            "playlist_id": playlist_id,
            "video_count": len(all_video_ids),
            "lounge": lounge_result,
        }), 201
    except Exception as error:
        logger.exception("Failed to cast playlist playlist_id=%s", playlist_id)
        return jsonify({"error": str(error)}), 500


# ============================================================================
# Category API Endpoints
# ============================================================================


@app.get("/api/categories")
def get_categories() -> Dict[str, Any]:
    """Get all root-level categories with nested children."""
    logger.debug("Handling get_categories request")
    root_categories = (
        Category.query.filter_by(parent_id=None)
        .order_by(Category.sort_order.asc(), Category.name.asc())
        .all()
    )
    logger.debug("Returning %s root categories", len(root_categories))
    return jsonify([cat.to_dict(include_children=True) for cat in root_categories])


@app.get("/api/categories/<int:category_id>")
def get_category(category_id: int) -> Dict[str, Any]:
    """Get a single category with children."""
    logger.debug("Handling get_category request category_id=%s", category_id)
    category = Category.query.get_or_404(category_id)
    return jsonify(category.to_dict(include_children=True))


@app.post("/api/categories")
def create_category() -> Dict[str, Any]:
    """Create a new category."""
    data = request.get_json()
    logger.debug("Handling create_category request payload_keys=%s", list((data or {}).keys()))
    if not data or "name" not in data:
        logger.debug("create_category rejected due to missing name")
        return jsonify({"error": "Missing required field: name"}), 400

    parent_id = data.get("parent_id")
    if parent_id:
        logger.debug("Validating parent category parent_id=%s", parent_id)
        Category.query.get_or_404(parent_id)

    max_sort = (
        db.session.query(db.func.max(Category.sort_order))
        .filter(Category.parent_id == parent_id)
        .scalar()
    )
    next_sort = (max_sort or 0) + 1

    category = Category(
        name=data["name"],
        description=data.get("description"),
        parent_id=parent_id,
        sort_order=next_sort,
    )
    db.session.add(category)
    db.session.commit()

    logger.debug(
        "Created category id=%s name=%s parent_id=%s sort_order=%s",
        category.id,
        category.name,
        category.parent_id,
        category.sort_order,
    )

    return jsonify(category.to_dict()), 201


@app.put("/api/categories/<int:category_id>")
def update_category(category_id: int) -> Dict[str, Any]:
    """Update a category."""
    logger.debug("Handling update_category request category_id=%s", category_id)
    category = Category.query.get_or_404(category_id)
    data = request.get_json()
    logger.debug("update_category payload_keys=%s", list((data or {}).keys()))

    if "name" in data:
        category.name = data["name"]
    if "description" in data:
        category.description = data["description"]
    if "parent_id" in data:
        new_parent_id = data["parent_id"]
        if new_parent_id and new_parent_id != category_id:
            new_parent = Category.query.get_or_404(new_parent_id)
            ancestor = new_parent
            while ancestor is not None:
                if ancestor.id == category_id:
                    return jsonify({"error": "Cannot move a category into one of its descendants"}), 400
                ancestor = ancestor.parent
            category.parent_id = new_parent_id
        elif not new_parent_id:
            category.parent_id = None

        # Put moved category at end of new parent
        max_sort = (
            db.session.query(db.func.max(Category.sort_order))
            .filter(Category.parent_id == category.parent_id)
            .scalar()
        )
        category.sort_order = (max_sort or 0) + 1

    db.session.commit()
    logger.debug(
        "Updated category id=%s name=%s parent_id=%s sort_order=%s",
        category.id,
        category.name,
        category.parent_id,
        category.sort_order,
    )
    return jsonify(category.to_dict())


@app.delete("/api/categories/<int:category_id>")
def delete_category(category_id: int) -> Dict[str, Any]:
    """Delete a category and its children."""
    logger.debug("Handling delete_category request category_id=%s", category_id)
    category = Category.query.get_or_404(category_id)
    db.session.delete(category)
    db.session.commit()
    logger.debug("Deleted category id=%s", category_id)
    return jsonify({"message": "Category deleted"}), 200


@app.post("/api/categories/reorder")
def reorder_categories() -> Dict[str, Any]:
    """Persist drag-and-drop category order within a parent."""
    data = request.get_json() or {}
    parent_id = data.get("parent_id")
    ordered_ids = data.get("ordered_ids", [])
    logger.debug(
        "Handling reorder_categories request parent_id=%s ordered_count=%s",
        parent_id,
        len(ordered_ids) if isinstance(ordered_ids, list) else "invalid",
    )

    if not isinstance(ordered_ids, list) or not ordered_ids:
        logger.debug("reorder_categories rejected due to invalid ordered_ids payload")
        return jsonify({"error": "ordered_ids must be a non-empty list"}), 400

    for index, cat_id in enumerate(ordered_ids, start=1):
        category = Category.query.get(cat_id)
        if not category:
            logger.debug("Skipping missing category during reorder category_id=%s", cat_id)
            continue
        if category.parent_id != parent_id:
            logger.debug(
                "reorder_categories rejected because category_id=%s has parent_id=%s",
                cat_id,
                category.parent_id,
            )
            return jsonify({"error": "All categories must share the same parent"}), 400
        category.sort_order = index

    db.session.commit()
    logger.debug("Category reorder committed for parent_id=%s", parent_id)
    return jsonify({"message": "Order updated"}), 200


# ============================================================================
# Subscription API Endpoints
# ============================================================================


@app.get("/api/subscriptions")
def get_subscriptions() -> Dict[str, Any]:
    """Get subscriptions with pagination, optionally filtered by category."""
    category_id = request.args.get("category_id", type=int)
    uncategorized = request.args.get("uncategorized", type=str)
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 50, type=int)
    per_page = min(per_page, 200)
    logger.debug(
        "Handling get_subscriptions request category_id=%s uncategorized=%s page=%s per_page=%s",
        category_id,
        uncategorized,
        page,
        per_page,
    )

    if uncategorized == "true":
        query = Subscription.query.filter(
            ~Subscription.categories.any()
        )
    elif category_id:
        Category.query.get_or_404(category_id)
        query = Subscription.query.filter(
            Subscription.categories.any(Category.id == category_id)
        )
    else:
        query = Subscription.query

    query = query.order_by(Subscription.channel_title)
    total = query.count()
    subscriptions = query.offset((page - 1) * per_page).limit(per_page).all()

    logger.debug("Returning %s/%s subscriptions page=%s", len(subscriptions), total, page)
    return jsonify({
        "items": [sub.to_dict(include_categories=True) for sub in subscriptions],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": page * per_page < total,
    })


@app.get("/api/subscriptions/<int:sub_id>")
def get_subscription(sub_id: int) -> Dict[str, Any]:
    """Get a single subscription with its categories."""
    logger.debug("Handling get_subscription request sub_id=%s", sub_id)
    sub = Subscription.query.get_or_404(sub_id)
    return jsonify(sub.to_dict(include_categories=True))


@app.post("/api/subscriptions/sync")
def sync_subscriptions() -> Dict[str, Any]:
    """Fetch subscriptions from YouTube and sync to database (synchronous endpoint)."""
    logger.debug("Handling sync_subscriptions request")
    try:
        synced_count = _sync_subscriptions_phase()
        return jsonify({"message": f"Synced {synced_count} subscriptions"}), 200
    except Exception as e:
        logger.exception("Subscription sync failed")
        return jsonify({"error": str(e)}), 500


# ============================================================================
# Category-Subscription Assignment Endpoints
# ============================================================================


@app.post("/api/subscriptions/<int:sub_id>/categories/<int:cat_id>")
def assign_subscription_to_category(sub_id: int, cat_id: int) -> Dict[str, Any]:
    """Assign a subscription to a category."""
    logger.debug(
        "Handling assign_subscription_to_category request sub_id=%s cat_id=%s",
        sub_id,
        cat_id,
    )
    sub = Subscription.query.get_or_404(sub_id)
    cat = Category.query.get_or_404(cat_id)

    if cat not in sub.categories:
        sub.categories.append(cat)
        db.session.commit()
        logger.debug("Assigned subscription id=%s to category id=%s", sub_id, cat_id)
    else:
        logger.debug("Subscription id=%s already assigned to category id=%s", sub_id, cat_id)

    return jsonify({"message": "Subscription assigned to category"}), 200


@app.delete("/api/subscriptions/<int:sub_id>/categories/<int:cat_id>")
def unassign_subscription_from_category(sub_id: int, cat_id: int) -> Dict[str, Any]:
    """Unassign a subscription from a category."""
    logger.debug(
        "Handling unassign_subscription_from_category request sub_id=%s cat_id=%s",
        sub_id,
        cat_id,
    )
    sub = Subscription.query.get_or_404(sub_id)
    cat = Category.query.get_or_404(cat_id)

    if cat in sub.categories:
        sub.categories.remove(cat)
        db.session.commit()
        logger.debug("Unassigned subscription id=%s from category id=%s", sub_id, cat_id)
    else:
        logger.debug("Subscription id=%s was not assigned to category id=%s", sub_id, cat_id)

    return jsonify({"message": "Subscription unassigned from category"}), 200


@app.delete("/api/subscriptions/<int:sub_id>")
def delete_subscription(sub_id: int) -> Dict[str, Any]:
    """Delete a subscription from both YouTube and local database."""
    logger.debug("Handling delete_subscription request sub_id=%s", sub_id)
    sub = Subscription.query.get_or_404(sub_id)
    
    youtube_success = True
    youtube_message = ""
    
    # Try to unsubscribe from YouTube if we have the subscription ID
    if sub.subscription_id:
        try:
            service = get_youtube_service()
            youtube_success = service.unsubscribe_from_channel(sub.subscription_id)
            logger.debug(
                "YouTube unsubscribe attempt completed subscription_id=%s success=%s",
                sub.subscription_id,
                youtube_success,
            )
            if youtube_success:
                youtube_message = " and from YouTube"
            else:
                youtube_message = " (failed to unsubscribe from YouTube)"
        except Exception as e:
            logger.exception(
                "Error unsubscribing from YouTube for local_subscription_id=%s youtube_subscription_id=%s",
                sub_id,
                sub.subscription_id,
            )
            youtube_message = f" (YouTube error: {str(e)})"
    else:
        logger.debug("No YouTube subscription ID found for local_subscription_id=%s", sub_id)
        youtube_message = " (no YouTube subscription ID found)"
    
    # Delete from local database regardless
    db.session.delete(sub)
    db.session.commit()
    logger.debug("Deleted local subscription id=%s", sub_id)
    
    return jsonify({"message": f"Subscription deleted from local database{youtube_message}"}), 200


# ============================================================================
# Suggestions
# ============================================================================


def _tokenize(text: str) -> List[str]:
    logger.debug("Tokenizing text of length=%s", len(text) if text else 0)
    if not text:
        return []
    lowered = text.lower()
    for ch in ",.;:!?()[]{}<>\"'/|@#$%^&*+-=_~`":
        lowered = lowered.replace(ch, " ")
    tokens = [t.strip() for t in lowered.split() if len(t.strip()) > 2]
    return list(dict.fromkeys(tokens))


def _load_gemini_api_key() -> str:
    key_file = os.environ.get("GEMINI_API_KEY_FILE", "gemini_api_key.txt")
    logger.debug("Loading Gemini API key from %s", key_file)
    if not os.path.exists(key_file):
        logger.debug("Gemini API key file not found")
        return ""
    with open(key_file, "r", encoding="utf-8") as handle:
        logger.debug("Gemini API key file loaded")
        return handle.read().strip()


def _heuristic_suggestions(sub: Subscription, categories: List[Category]) -> List[int]:
    logger.debug(
        "Generating heuristic suggestions for sub_id=%s category_count=%s",
        sub.id,
        len(categories),
    )
    haystack = f"{sub.channel_title} {sub.channel_description or ''}".lower()
    suggestions: List[Dict[str, Any]] = []

    for category in categories:
        tokens = _tokenize(f"{category.name} {category.description or ''}")
        if not tokens:
            continue
        score = sum(1 for t in tokens if t in haystack)

        if category.name and category.name.lower() in haystack:
            score += 2

        if score > 0:
            suggestions.append({"category_id": category.id, "score": score})

    suggestions.sort(key=lambda x: (-x["score"], x["category_id"]))
    logger.debug("Heuristic suggestions generated count=%s", len(suggestions[:5]))
    return [s["category_id"] for s in suggestions[:5]]


def _gemini_suggestions(sub: Subscription, categories: List[Category]) -> List[int]:
    logger.debug(
        "Generating Gemini suggestions for sub_id=%s category_count=%s",
        sub.id,
        len(categories),
    )
    api_key = _load_gemini_api_key()
    if not api_key:
        logger.debug("Skipping Gemini suggestions because API key is unavailable")
        return []

    category_payload = [
        {"id": cat.id, "name": cat.name, "description": cat.description or ""}
        for cat in categories
    ]

    prompt = (
        "You are a classification assistant. "
        "Given a YouTube channel title and description, select the best matching "
        "category IDs from the provided list. "
        "Return only a JSON array of integer IDs. Do not create new categories."
    )

    user_input = {
        "channel_title": sub.channel_title,
        "channel_description": sub.channel_description or "",
        "categories": category_payload,
    }

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-1.5-flash:generateContent?key="
        + api_key
    )

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]},
            {"role": "user", "parts": [{"text": json.dumps(user_input)}]},
        ],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 256},
    }

    response = requests.post(url, json=payload, timeout=15)
    response.raise_for_status()
    logger.debug("Gemini suggestions response received for sub_id=%s", sub.id)

    data = response.json()
    candidates = data.get("candidates", [])
    if not candidates:
        logger.debug("Gemini returned no candidates for sub_id=%s", sub.id)
        return []

    text_out = (
        candidates[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
        .strip()
    )

    try:
        parsed = json.loads(text_out)
        if isinstance(parsed, list):
            logger.debug("Gemini returned %s suggestion IDs for sub_id=%s", len(parsed), sub.id)
            return [int(x) for x in parsed if isinstance(x, (int, float, str))]
    except json.JSONDecodeError:
        logger.exception("Failed to parse Gemini suggestion payload for sub_id=%s", sub.id)
        return []

    logger.debug("Gemini response was not a list for sub_id=%s", sub.id)
    return []


@app.get("/api/subscriptions/<int:sub_id>/suggestions")
def suggest_categories(sub_id: int) -> Dict[str, Any]:
    """Suggest existing categories based on channel title/description."""
    logger.debug("Handling suggest_categories request sub_id=%s", sub_id)
    sub = Subscription.query.get_or_404(sub_id)
    categories = Category.query.all()
    suggested_ids = []

    try:
        suggested_ids = _gemini_suggestions(sub, categories)
    except requests.RequestException:
        logger.exception("Gemini suggestion request failed for sub_id=%s", sub_id)
        suggested_ids = []

    if not suggested_ids:
        suggested_ids = _heuristic_suggestions(sub, categories)

    logger.debug("Returning %s suggested categories for sub_id=%s", len(suggested_ids), sub_id)
    return jsonify({"subscription_id": sub_id, "suggested_category_ids": suggested_ids})


# ============================================================================
# Feed Endpoints
# ============================================================================


@app.get("/api/feeds")
def get_feeds():
    """Get all feeds ordered by sort_order."""
    feeds = Feed.query.order_by(Feed.sort_order).all()
    logger.debug("Handling get_feeds request returning_count=%s", len(feeds))
    return jsonify([f.to_dict() for f in feeds])


@app.post("/api/feeds")
def create_feed():
    """Create a new feed."""
    data = request.json
    logger.debug("Handling create_feed request payload_keys=%s", list((data or {}).keys()))
    max_order = db.session.query(db.func.max(Feed.sort_order)).scalar() or 0

    feed = Feed(
        name=data.get("name", "New Feed"),
        sort_order=max_order + 1,
        filter_category_ids=json.dumps(data.get("filter_category_ids", [])),
        filter_video_type=data.get("filter_video_type"),
        filter_min_duration=data.get("filter_min_duration"),
        filter_max_duration=data.get("filter_max_duration"),
        filter_max_age_days=data.get("filter_max_age_days"),
        filter_play_state=data.get("filter_play_state") or (
            "played" if data.get("filter_played_only") else "both"
        ),
    )
    db.session.add(feed)
    db.session.commit()
    logger.debug("Created feed id=%s name=%s", feed.id, feed.name)
    return jsonify(feed.to_dict()), 201


@app.put("/api/feeds/<int:feed_id>")
def update_feed(feed_id: int):
    """Update a feed's name and filters."""
    logger.debug("Handling update_feed request feed_id=%s", feed_id)
    feed = Feed.query.get_or_404(feed_id)
    data = request.json
    logger.debug("update_feed payload_keys=%s", list((data or {}).keys()))

    if "name" in data:
        feed.name = data["name"]
    if "filter_category_ids" in data:
        feed.filter_category_ids = json.dumps(data["filter_category_ids"])
    if "filter_video_type" in data:
        feed.filter_video_type = data["filter_video_type"] or None
    if "filter_min_duration" in data:
        feed.filter_min_duration = data["filter_min_duration"]
    if "filter_max_duration" in data:
        feed.filter_max_duration = data["filter_max_duration"]
    if "filter_max_age_days" in data:
        feed.filter_max_age_days = data["filter_max_age_days"]
    if "filter_play_state" in data:
        feed.filter_play_state = data["filter_play_state"] or "both"
    elif "filter_played_only" in data:
        feed.filter_play_state = "played" if data["filter_played_only"] else "both"

    db.session.commit()
    logger.debug("Updated feed id=%s name=%s", feed.id, feed.name)
    return jsonify(feed.to_dict())


@app.delete("/api/feeds/<int:feed_id>")
def delete_feed(feed_id: int):
    """Delete a feed."""
    logger.debug("Handling delete_feed request feed_id=%s", feed_id)
    feed = Feed.query.get_or_404(feed_id)
    db.session.delete(feed)
    db.session.commit()
    logger.debug("Deleted feed id=%s", feed_id)
    return jsonify({"message": "Feed deleted"})


@app.get("/api/feeds/<int:feed_id>/videos")
def get_feed_videos(feed_id: int):
    """Get filtered videos for a feed."""
    logger.debug("Handling get_feed_videos request feed_id=%s", feed_id)
    feed = Feed.query.get_or_404(feed_id)

    query = Video.query

    # Filter by categories (AND of OR groups)
    category_groups = feed._parse_category_groups()
    if category_groups:
        logger.debug("Applying category filter for feed_id=%s groups=%s", feed_id, category_groups)
        for group in category_groups:
            # OR group: subscription must belong to ANY category in this group
            subq = (
                db.session.query(Subscription.channel_id)
                .join(subscription_category, Subscription.id == subscription_category.c.subscription_id)
                .filter(subscription_category.c.category_id.in_(group))
                .subquery()
            )
            query = query.filter(Video.channel_id.in_(db.session.query(subq)))

    # Filter by video type
    if feed.filter_video_type:
        logger.debug("Applying video type filter for feed_id=%s type=%s", feed_id, feed.filter_video_type)
        query = query.filter(Video.video_type == feed.filter_video_type)

    # Filter by duration
    if feed.filter_min_duration is not None:
        logger.debug("Applying min duration filter for feed_id=%s min=%s", feed_id, feed.filter_min_duration)
        query = query.filter(Video.duration_seconds >= feed.filter_min_duration)
    if feed.filter_max_duration is not None:
        logger.debug("Applying max duration filter for feed_id=%s max=%s", feed_id, feed.filter_max_duration)
        query = query.filter(Video.duration_seconds <= feed.filter_max_duration)

    # Filter by age
    if feed.filter_max_age_days is not None:
        logger.debug("Applying max age filter for feed_id=%s days=%s", feed_id, feed.filter_max_age_days)
        cutoff = datetime.utcnow() - timedelta(days=feed.filter_max_age_days)
        query = query.filter(Video.published_at >= cutoff)

    if feed.filter_play_state == "played":
        logger.debug("Applying played-only filter for feed_id=%s", feed_id)
        query = query.filter(Video.playback_progress >= 95)
    elif feed.filter_play_state == "unplayed":
        logger.debug("Applying unplayed-only filter for feed_id=%s", feed_id)
        query = query.filter(or_(Video.playback_progress.is_(None), Video.playback_progress < 95))

    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 20, type=int)
    per_page = min(per_page, 100)

    total = query.count()
    videos = query.order_by(Video.published_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    logger.debug("Returning %s/%s videos for feed_id=%s page=%s", len(videos), total, feed_id, page)
    return jsonify({
        "items": [v.to_dict() for v in videos],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": page * per_page < total,
    })


# ============================================================================
# Queue Endpoints
# ============================================================================


@app.get("/api/queue")
def get_queue() -> Dict[str, Any]:
    """Get the current play queue."""
    logger.debug("Handling get_queue request")
    return jsonify({"items": _serialize_queue_items()})


@app.post("/api/queue")
def add_to_queue() -> Dict[str, Any]:
    """Add one or more videos to the queue."""
    data = request.get_json() or {}
    video_ids = data.get("video_ids")
    if isinstance(video_ids, str):
        video_ids = [video_ids]
    elif data.get("video_id"):
        video_ids = [data.get("video_id")]

    logger.debug("Handling add_to_queue request video_count=%s", len(video_ids) if isinstance(video_ids, list) else 0)
    if not isinstance(video_ids, list) or not video_ids:
        return jsonify({"error": "video_ids must be a non-empty list"}), 400

    existing_ids = {
        row[0]
        for row in db.session.query(QueueItem.video_id).filter(QueueItem.video_id.in_(video_ids)).all()
    }

    next_sort = _next_queue_sort_order()
    added_count = 0
    missing_ids: List[str] = []
    seen_ids: set = set()

    for video_id in video_ids:
        if video_id in seen_ids:
            continue
        seen_ids.add(video_id)

        if video_id in existing_ids:
            continue

        video = Video.query.filter_by(video_id=video_id).first()
        if not video:
            missing_ids.append(video_id)
            continue

        queue_item = QueueItem(video_id=video_id, sort_order=next_sort)
        db.session.add(queue_item)
        next_sort += 1
        added_count += 1

    if added_count > 0:
        db.session.commit()

    logger.debug("Queue add complete added_count=%s skipped_existing=%s missing_count=%s", added_count, len(existing_ids), len(missing_ids))
    return jsonify({"message": "Videos added to queue", "added_count": added_count, "missing_ids": missing_ids, "items": _serialize_queue_items()}), 201


@app.delete("/api/queue/<int:queue_item_id>")
def remove_queue_item(queue_item_id: int) -> Dict[str, Any]:
    """Remove a queued video."""
    logger.debug("Handling remove_queue_item request queue_item_id=%s", queue_item_id)
    queue_item = QueueItem.query.get_or_404(queue_item_id)
    db.session.delete(queue_item)
    db.session.commit()
    return jsonify({"message": "Queue item removed", "items": _serialize_queue_items()})


@app.post("/api/queue/reorder")
def reorder_queue_items() -> Dict[str, Any]:
    """Reorder queue items."""
    logger.debug("Handling reorder_queue_items request")
    data = request.get_json(silent=True) or {}
    ordered_ids = data.get("queue_item_ids")

    if not isinstance(ordered_ids, list) or not ordered_ids:
        return jsonify({"error": "queue_item_ids must be a non-empty list"}), 400

    try:
        ordered_queue_item_ids = [int(queue_item_id) for queue_item_id in ordered_ids]
    except (TypeError, ValueError):
        return jsonify({"error": "queue_item_ids must contain integers"}), 400

    try:
        result = _reorder_queue_items(ordered_queue_item_ids)
        return jsonify({"message": "Queue reordered", **result})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/queue/clear")
def clear_queue() -> Dict[str, Any]:
    """Clear the entire queue."""
    logger.debug("Handling clear_queue request")
    _clear_queue_items()
    return jsonify({"message": "Queue cleared", "items": []})


@app.post("/api/queue/create-playlist")
def create_queue_playlist() -> Dict[str, Any]:
    """Create a YouTube playlist from the queue and clear it afterward."""
    logger.debug("Handling create_queue_playlist request")
    try:
        result = _create_queue_playlist(clear_queue_items=True)
        result["items"] = _serialize_queue_items()
        return jsonify(result), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        logger.exception("Failed to create queue playlist")
        return jsonify({"error": str(error)}), 500


@app.post("/api/queue/cast")
def cast_queue() -> Dict[str, Any]:
    """Start playback on a YouTube Cast receiver via the Lounge API.

    Expects JSON body with ``screen_id`` (obtained from the MDX session status
    on the Cast channel).  Sends the queue video IDs to the YouTube receiver
    via the Lounge API to initiate playback.
    """
    logger.debug("Handling cast_queue request")
    try:
        data = request.get_json(silent=True) or {}
        screen_id = data.get("screen_id")
        logger.debug("cast_queue screen_id=%s", screen_id)

        if not screen_id:
            return jsonify({"error": "screen_id is required – ensure Cast session is connected"}), 400

        # Determine the videos to play
        queue_items_db = cast(
            List[QueueItem],
            QueueItem.query.order_by(QueueItem.sort_order.asc(), QueueItem.added_at.asc()).all(),
        )
        if not queue_items_db:
            return jsonify({"error": "No videos in queue"}), 400
        all_video_ids = [item.video_id for item in queue_items_db]

        # Start playback via YouTube Lounge API
        service = get_youtube_service()
        lounge_result = service.cast_to_receiver(
            screen_id=screen_id,
            video_id=all_video_ids[0],
            video_ids=all_video_ids,
        )
        logger.debug("cast_queue lounge_result=%s", lounge_result)

        # Store Lounge session for nowPlaying polling
        global _lounge_session
        _lounge_session = {
            "lounge_token": lounge_result.get("lounge_token", ""),
            "SID": lounge_result.get("SID", ""),
            "gsessionid": lounge_result.get("gsessionid", ""),
            "has_played": False,
        }
        _save_lounge_session()
        logger.debug("Stored lounge session for polling")

        result: Dict[str, Any] = {
            "items": _serialize_queue_items(),
            "lounge": lounge_result,
        }
        return jsonify(result), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        logger.exception("Failed to cast queue")
        return jsonify({"error": str(error)}), 500


@app.post("/api/queue/refresh-progress")
def refresh_queue_progress() -> Dict[str, Any]:
    """Refresh queued videos' watch progress and remove watched items."""
    logger.debug("Handling refresh_queue_progress request")
    result = _refresh_queue_playback_progress()
    return jsonify(result)


@app.get("/api/videos/<string:video_id>/thumbnail")
def get_video_thumbnail(video_id: str):
    """Serve a cached thumbnail for a video."""
    logger.debug("Handling get_video_thumbnail video_id=%s", video_id)
    video = Video.query.filter_by(video_id=video_id).first_or_404()

    if not video.thumbnail_path:
        logger.debug("Thumbnail not cached yet for video_id=%s; caching now", video_id)
        try:
            cached_path = _cache_thumbnail(video.thumbnail_url, video.video_id)
            if not cached_path:
                return jsonify({"error": "Thumbnail not cached"}), 404
            video.thumbnail_path = cached_path
            db.session.commit()
        except Exception:
            logger.exception("Failed to cache thumbnail on demand for video_id=%s", video_id)
            db.session.rollback()
            return jsonify({"error": "Thumbnail not cached"}), 404

    thumbnail_path = Path(video.thumbnail_path)
    if not thumbnail_path.exists():
        logger.debug("Cached thumbnail missing for video_id=%s path=%s", video_id, video.thumbnail_path)
        return jsonify({"error": "Thumbnail not found"}), 404

    return send_from_directory(str(thumbnail_path.parent), thumbnail_path.name)


# ============================================================================
# Video Endpoints
# ============================================================================


@app.post("/api/videos/fetch")
def fetch_videos():
    """Legacy endpoint: triggers background sync for backward compatibility."""
    logger.debug("Handling legacy fetch_videos request; redirecting to background sync")
    data = request.json or {}
    channel_ids: Optional[List[str]] = data.get("channel_ids") or None

    with _sync_lock:
        if _sync_state["running"]:
            return jsonify({"message": "Sync already in progress"}), 200

        _sync_state.update({
            "running": True,
            "phase": "videos",
            "total": 0,
            "processed": 0,
            "fetched_new": 0,
            "errors": 0,
            "skipped": 0,
            "subs_synced": 0,
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "current_channel": None,
        })

    def _legacy_video_thread():
        with app.app_context():
            try:
                _run_video_sync_inner(channel_ids=channel_ids, force=False)
            finally:
                with _sync_lock:
                    _sync_state["running"] = False
                    _sync_state["phase"] = None
                    _sync_state["finished_at"] = datetime.utcnow().isoformat()

    thread = threading.Thread(target=_legacy_video_thread, daemon=True, name="video-sync-legacy")
    thread.start()
    return jsonify({"message": "Video sync started in background"}), 202


def _parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.debug("Failed to parse ISO timestamp value=%s", value)
        return None


# ============================================================================
# Health check
# ============================================================================


@app.get("/api/health")
def health() -> Dict[str, Any]:
    """Health check endpoint."""
    logger.debug("Handling health check request")
    return jsonify({"status": "ok"}), 200


@app.route("/")
def index():
    """Serve index.html"""
    logger.debug("Serving index page")
    return send_from_directory("templates", "index.html")


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)
