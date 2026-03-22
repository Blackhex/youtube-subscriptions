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
