import json
import os
from datetime import datetime
from typing import Any, Dict, List

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import text
from flask_cors import CORS
import requests

from models import Category, Subscription, db, subscription_category
from youtube_service import YouTubeService

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
        youtube_service = YouTubeService()
    return youtube_service


@app.before_request
def init_db():
    """Initialize database on first request."""
    with app.app_context():
        db.create_all()
        _ensure_category_sort_order_column()
        _initialize_category_sort_order()


def _ensure_category_sort_order_column() -> None:
    result = db.session.execute(text("PRAGMA table_info(categories)"))
    columns = [row[1] for row in result.fetchall()]
    if "sort_order" not in columns:
        db.session.execute(text("ALTER TABLE categories ADD COLUMN sort_order INTEGER"))
        db.session.commit()


def _initialize_category_sort_order() -> None:
    # Assign sort_order for any rows missing it, grouped by parent
    parents = db.session.execute(
        text("SELECT DISTINCT parent_id FROM categories")
    ).fetchall()

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
            order += 1
    db.session.commit()


# ============================================================================
# Category API Endpoints
# ============================================================================


@app.get("/api/categories")
def get_categories() -> Dict[str, Any]:
    """Get all root-level categories with nested children."""
    root_categories = (
        Category.query.filter_by(parent_id=None)
        .order_by(Category.sort_order.asc(), Category.name.asc())
        .all()
    )
    return jsonify([cat.to_dict(include_children=True) for cat in root_categories])


@app.get("/api/categories/<int:category_id>")
def get_category(category_id: int) -> Dict[str, Any]:
    """Get a single category with children."""
    category = Category.query.get_or_404(category_id)
    return jsonify(category.to_dict(include_children=True))


@app.post("/api/categories")
def create_category() -> Dict[str, Any]:
    """Create a new category."""
    data = request.get_json()
    if not data or "name" not in data:
        return jsonify({"error": "Missing required field: name"}), 400

    parent_id = data.get("parent_id")
    if parent_id:
        parent = Category.query.get_or_404(parent_id)

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

    return jsonify(category.to_dict()), 201


@app.put("/api/categories/<int:category_id>")
def update_category(category_id: int) -> Dict[str, Any]:
    """Update a category."""
    category = Category.query.get_or_404(category_id)
    data = request.get_json()

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
    return jsonify(category.to_dict())


@app.delete("/api/categories/<int:category_id>")
def delete_category(category_id: int) -> Dict[str, Any]:
    """Delete a category and its children."""
    category = Category.query.get_or_404(category_id)
    db.session.delete(category)
    db.session.commit()
    return jsonify({"message": "Category deleted"}), 200


@app.post("/api/categories/reorder")
def reorder_categories() -> Dict[str, Any]:
    """Persist drag-and-drop category order within a parent."""
    data = request.get_json() or {}
    parent_id = data.get("parent_id")
    ordered_ids = data.get("ordered_ids", [])

    if not isinstance(ordered_ids, list) or not ordered_ids:
        return jsonify({"error": "ordered_ids must be a non-empty list"}), 400

    for index, cat_id in enumerate(ordered_ids, start=1):
        category = Category.query.get(cat_id)
        if not category:
            continue
        if category.parent_id != parent_id:
            return jsonify({"error": "All categories must share the same parent"}), 400
        category.sort_order = index

    db.session.commit()
    return jsonify({"message": "Order updated"}), 200


# ============================================================================
# Subscription API Endpoints
# ============================================================================


@app.get("/api/subscriptions")
def get_subscriptions() -> Dict[str, Any]:
    """Get all subscriptions, optionally filtered by category."""
    category_id = request.args.get("category_id", type=int)
    uncategorized = request.args.get("uncategorized", type=str)

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

    return jsonify([sub.to_dict(include_categories=True) for sub in subscriptions])


@app.get("/api/subscriptions/<int:sub_id>")
def get_subscription(sub_id: int) -> Dict[str, Any]:
    """Get a single subscription with its categories."""
    sub = Subscription.query.get_or_404(sub_id)
    return jsonify(sub.to_dict(include_categories=True))


@app.post("/api/subscriptions/sync")
def sync_subscriptions() -> Dict[str, Any]:
    """Fetch subscriptions from YouTube and sync to database."""
    try:
        service = get_youtube_service()
        yt_subs = service.fetch_all_subscriptions()

        synced_count = 0
        def parse_iso_datetime(value):
            if not value:
                return None
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None

        for yt_sub in yt_subs:
            sub = Subscription.query.filter_by(channel_id=yt_sub["channelId"]).first()
            if not sub:
                sub = Subscription(channel_id=yt_sub["channelId"])

            sub.subscription_id = yt_sub.get("subscriptionId")
            sub.channel_title = yt_sub["channelTitle"]
            sub.channel_description = yt_sub.get("channelDescription", "")
            sub.thumbnail_url = yt_sub.get("thumbnailUrl")
            sub.subscription_date = parse_iso_datetime(yt_sub.get("subscriptionDate"))
            sub.synced_at = datetime.utcnow()

            db.session.add(sub)
            synced_count += 1

        db.session.commit()
        return jsonify({"message": f"Synced {synced_count} subscriptions"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================================
# Category-Subscription Assignment Endpoints
# ============================================================================


@app.post("/api/subscriptions/<int:sub_id>/categories/<int:cat_id>")
def assign_subscription_to_category(sub_id: int, cat_id: int) -> Dict[str, Any]:
    """Assign a subscription to a category."""
    sub = Subscription.query.get_or_404(sub_id)
    cat = Category.query.get_or_404(cat_id)

    if cat not in sub.categories:
        sub.categories.append(cat)
        db.session.commit()

    return jsonify({"message": "Subscription assigned to category"}), 200


@app.delete("/api/subscriptions/<int:sub_id>/categories/<int:cat_id>")
def unassign_subscription_from_category(sub_id: int, cat_id: int) -> Dict[str, Any]:
    """Unassign a subscription from a category."""
    sub = Subscription.query.get_or_404(sub_id)
    cat = Category.query.get_or_404(cat_id)

    if cat in sub.categories:
        sub.categories.remove(cat)
        db.session.commit()

    return jsonify({"message": "Subscription unassigned from category"}), 200


@app.delete("/api/subscriptions/<int:sub_id>")
def delete_subscription(sub_id: int) -> Dict[str, Any]:
    """Delete a subscription from both YouTube and local database."""
    sub = Subscription.query.get_or_404(sub_id)
    
    youtube_success = True
    youtube_message = ""
    
    # Try to unsubscribe from YouTube if we have the subscription ID
    if sub.subscription_id:
        try:
            service = get_youtube_service()
            youtube_success = service.unsubscribe_from_channel(sub.subscription_id)
            if youtube_success:
                youtube_message = " and from YouTube"
            else:
                youtube_message = " (failed to unsubscribe from YouTube)"
        except Exception as e:
            youtube_message = f" (YouTube error: {str(e)})"
    else:
        youtube_message = " (no YouTube subscription ID found)"
    
    # Delete from local database regardless
    db.session.delete(sub)
    db.session.commit()
    
    return jsonify({"message": f"Subscription deleted from local database{youtube_message}"}), 200


# ============================================================================
# Suggestions
# ============================================================================


def _tokenize(text: str) -> List[str]:
    if not text:
        return []
    lowered = text.lower()
    for ch in ",.;:!?()[]{}<>\"'/|@#$%^&*+-=_~`":
        lowered = lowered.replace(ch, " ")
    tokens = [t.strip() for t in lowered.split() if len(t.strip()) > 2]
    return list(dict.fromkeys(tokens))


def _load_gemini_api_key() -> str:
    key_file = os.environ.get("GEMINI_API_KEY_FILE", "gemini_api_key.txt")
    if not os.path.exists(key_file):
        return ""
    with open(key_file, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def _heuristic_suggestions(sub: Subscription, categories: List[Category]) -> List[int]:
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
    return [s["category_id"] for s in suggestions[:5]]


def _gemini_suggestions(sub: Subscription, categories: List[Category]) -> List[int]:
    api_key = _load_gemini_api_key()
    if not api_key:
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

    data = response.json()
    candidates = data.get("candidates", [])
    if not candidates:
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
            return [int(x) for x in parsed if isinstance(x, (int, float, str))]
    except json.JSONDecodeError:
        return []

    return []


@app.get("/api/subscriptions/<int:sub_id>/suggestions")
def suggest_categories(sub_id: int) -> Dict[str, Any]:
    """Suggest existing categories based on channel title/description."""
    sub = Subscription.query.get_or_404(sub_id)
    categories = Category.query.all()
    suggested_ids = []

    try:
        suggested_ids = _gemini_suggestions(sub, categories)
    except requests.RequestException:
        suggested_ids = []

    if not suggested_ids:
        suggested_ids = _heuristic_suggestions(sub, categories)

    return jsonify({"subscription_id": sub_id, "suggested_category_ids": suggested_ids})


# ============================================================================
# Health check
# ============================================================================


@app.get("/api/health")
def health() -> Dict[str, Any]:
    """Health check endpoint."""
    return jsonify({"status": "ok"}), 200


@app.route("/")
def index():
    """Serve index.html"""
    return send_from_directory("templates", "index.html")


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)
