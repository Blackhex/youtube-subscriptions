from datetime import datetime

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Category(db.Model):
    """Category model with self-referential parent-child relationship for nesting."""

    __tablename__ = "categories"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(256), nullable=False)
    description = db.Column(db.Text, nullable=True)
    parent_id = db.Column(db.Integer, db.ForeignKey("categories.id"), nullable=True)
    sort_order = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Self-referential relationship (one-to-many with orphan cleanup)
    children = db.relationship(
        "Category",
        backref=db.backref("parent", remote_side=[id]),
        cascade="all, delete-orphan",
        single_parent=True,
        order_by="Category.sort_order",
    )

    # Relationship to subscriptions
    subscriptions = db.relationship(
        "Subscription",
        secondary="subscription_category",
        backref="categories",
    )

    def to_dict(self, include_children=False):
        """Convert to dictionary for JSON serialization."""
        data = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "parent_id": self.parent_id,
            "sort_order": self.sort_order,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_children:
            data["children"] = [child.to_dict(include_children=True) for child in self.children]
        return data


class Subscription(db.Model):
    """YouTube subscription model."""

    __tablename__ = "subscriptions"

    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.String(256), nullable=True, unique=True)  # YouTube subscription ID
    channel_id = db.Column(db.String(256), nullable=False, unique=True)
    channel_title = db.Column(db.String(256), nullable=False)
    channel_description = db.Column(db.Text, nullable=True)
    thumbnail_url = db.Column(db.String(512), nullable=True)
    subscription_date = db.Column(db.DateTime, nullable=True)
    synced_at = db.Column(db.DateTime, nullable=True)
    videos_synced_at = db.Column(db.DateTime, nullable=True)  # When videos were last fetched
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self, include_categories=False):
        """Convert to dictionary for JSON serialization."""
        data = {
            "id": self.id,
            "channel_id": self.channel_id,
            "channel_title": self.channel_title,
            "channel_description": self.channel_description,
            "thumbnail_url": self.thumbnail_url,
            "subscription_date": self.subscription_date.isoformat()
            if self.subscription_date
            else None,
        }
        if include_categories:
            data["categories"] = [cat.to_dict() for cat in self.categories]
        return data


# Association table
subscription_category = db.Table(
    "subscription_category",
    db.Column("subscription_id", db.Integer, db.ForeignKey("subscriptions.id"), primary_key=True),
    db.Column("category_id", db.Integer, db.ForeignKey("categories.id"), primary_key=True),
)


class Video(db.Model):
    """Cached YouTube video metadata."""

    __tablename__ = "videos"

    id = db.Column(db.Integer, primary_key=True)
    video_id = db.Column(db.String(32), nullable=False, unique=True)  # YouTube video ID
    channel_id = db.Column(db.String(256), db.ForeignKey("subscriptions.channel_id"), nullable=False)
    title = db.Column(db.String(512), nullable=False)
    description = db.Column(db.Text, nullable=True)
    thumbnail_url = db.Column(db.String(512), nullable=True)
    thumbnail_path = db.Column(db.String(512), nullable=True)
    published_at = db.Column(db.DateTime, nullable=True)
    duration_seconds = db.Column(db.Integer, nullable=True)
    video_type = db.Column(db.String(32), nullable=True)  # video, short, live
    playback_progress = db.Column(db.Integer, nullable=True)  # percent watched 0-100
    fetched_at = db.Column(db.DateTime, default=datetime.utcnow)

    subscription = db.relationship("Subscription", backref="videos", foreign_keys=[channel_id], primaryjoin="Video.channel_id == Subscription.channel_id")

    def to_dict(self):
        thumbnail_url = None
        if self.thumbnail_url or self.thumbnail_path:
            thumbnail_url = f"/api/videos/{self.video_id}/thumbnail"

        return {
            "id": self.id,
            "video_id": self.video_id,
            "channel_id": self.channel_id,
            "title": self.title,
            "description": self.description,
            "thumbnail_url": thumbnail_url,
            "published_at": self.published_at.isoformat() if self.published_at else None,
            "duration_seconds": self.duration_seconds,
            "video_type": self.video_type,
            "playback_progress": self.playback_progress,
            "channel_title": self.subscription.channel_title if self.subscription else None,
        }


class Feed(db.Model):
    """A named feed column with filter criteria."""

    __tablename__ = "feeds"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(256), nullable=False)
    sort_order = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Filter criteria stored as JSON
    filter_category_ids = db.Column(db.Text, nullable=True)  # JSON: array of arrays (AND of OR groups)
    filter_video_type = db.Column(db.String(32), nullable=True)  # video, short, live, or null for all
    filter_min_duration = db.Column(db.Integer, nullable=True)  # seconds
    filter_max_duration = db.Column(db.Integer, nullable=True)  # seconds
    filter_max_age_days = db.Column(db.Integer, nullable=True)  # only show videos from last N days

    def _parse_category_groups(self) -> list:
        """Parse filter_category_ids into normalized OR-of-AND groups.

        Returns list of lists.  Legacy flat arrays are migrated to a
        single OR-group.
        """
        import json
        if not self.filter_category_ids:
            return []
        raw = json.loads(self.filter_category_ids)
        if not raw:
            return []
        # Legacy: flat array of ints → wrap in single group
        if raw and not isinstance(raw[0], list):
            return [raw]
        return raw

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "sort_order": self.sort_order,
            "filter_category_ids": self._parse_category_groups(),
            "filter_video_type": self.filter_video_type,
            "filter_min_duration": self.filter_min_duration,
            "filter_max_duration": self.filter_max_duration,
            "filter_max_age_days": self.filter_max_age_days,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
