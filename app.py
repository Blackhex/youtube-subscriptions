import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import func, or_, text
from flask_cors import CORS
import requests

from models import Category, Feed, Subscription, Video, db, subscription_category
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

youtube_service = None


def get_youtube_service() -> YouTubeService:
    """Lazily initialize YouTube service."""
    global youtube_service
    if youtube_service is None:
        logger.debug("Initializing YouTube service")
        youtube_service = YouTubeService()
    else:
        logger.debug("Reusing existing YouTube service")
    return youtube_service


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

        # --- Write new videos to DB ---
        sync_ts = datetime.utcnow()
        fetched_new = 0

        for v in new_video_data:
            details = video_details.get(v["videoId"], {})
            vid = Video(
                video_id=v["videoId"],
                channel_id=v["_channel_id"],
                title=v.get("title", ""),
                thumbnail_url=v.get("thumbnailUrl"),
                published_at=_parse_iso(v.get("publishedAt")),
                duration_seconds=details.get("duration_seconds"),
                video_type=details.get("video_type"),
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
            Category.query.get_or_404(new_parent_id)
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
    """Get all subscriptions, optionally filtered by category."""
    category_id = request.args.get("category_id", type=int)
    uncategorized = request.args.get("uncategorized", type=str)
    logger.debug(
        "Handling get_subscriptions request category_id=%s uncategorized=%s",
        category_id,
        uncategorized,
    )

    if uncategorized == "true":
        # Get subscriptions with no categories
        subscriptions = Subscription.query.filter(
            ~Subscription.categories.any()
        ).all()
    elif category_id:
        category = Category.query.get_or_404(category_id)
        subscriptions = category.subscriptions
    else:
        subscriptions = Subscription.query.all()

    logger.debug("Returning %s subscriptions", len(subscriptions))
    return jsonify([sub.to_dict(include_categories=True) for sub in subscriptions])


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

    videos = query.order_by(Video.published_at.desc()).limit(50).all()
    logger.debug("Returning %s videos for feed_id=%s", len(videos), feed_id)
    return jsonify([v.to_dict() for v in videos])


@app.post("/api/videos/watch-progress")
def get_watch_progress():
    """Fetch watch progress for a list of video IDs via YouTube InnerTube API."""
    data = request.json or {}
    video_ids: List[str] = data.get("video_ids", [])
    logger.debug("Handling get_watch_progress request video_count=%s", len(video_ids))

    if not video_ids:
        return jsonify({})

    try:
        service = get_youtube_service()
        progress = service.fetch_watch_progress(video_ids)
        logger.debug("Returning watch progress for %s/%s videos", len(progress), len(video_ids))
        return jsonify(progress)
    except Exception:
        logger.exception("Error fetching watch progress")
        return jsonify({})


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
