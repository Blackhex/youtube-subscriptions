"""Database migration script to add subscription_id column."""
import logging
import os
import sqlite3

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

def migrate_database():
    logger.debug("Starting database migration lookup")
    # Check both possible locations
    for db_path in ["instance/subscriptions.db", "subscriptions.db"]:
        logger.debug("Checking database path %s", db_path)
        if os.path.exists(db_path):
            logger.debug("Database file found at %s", db_path)
            _migrate_file(db_path)
            return
    
    logger.info("No database file found")
    logger.info("No migration needed - the column will be created when you first run the app")

def _migrate_file(db_path):
    logger.debug("Running migration for db_path=%s", db_path)
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check if the column already exists
        cursor.execute("PRAGMA table_info(subscriptions)")
        columns = cursor.fetchall()
        column_names = [col[1] for col in columns]
        logger.debug("Fetched %s subscription columns", len(column_names))
        
        if 'subscription_id' not in column_names:
            logger.info("Adding subscription_id column to subscriptions table")
            cursor.execute("ALTER TABLE subscriptions ADD COLUMN subscription_id VARCHAR(256)")
            conn.commit()
            logger.info("subscription_id column added successfully")
        else:
            logger.info("subscription_id column already exists")

        if 'videos_synced_at' not in column_names:
            logger.info("Adding videos_synced_at column to subscriptions table")
            cursor.execute("ALTER TABLE subscriptions ADD COLUMN videos_synced_at DATETIME")
            conn.commit()
            logger.info("videos_synced_at column added successfully")
        else:
            logger.info("videos_synced_at column already exists")
        
        conn.close()
        logger.debug("Closed database connection for db_path=%s", db_path)
        
    except sqlite3.Error:
        logger.exception("Database migration failed for db_path=%s", db_path)
        return
    except Exception:
        logger.exception("Unexpected migration error for db_path=%s", db_path)
        return

if __name__ == "__main__":
    logger.info("YouTube Subscriptions Organizer - Database Migration")
    migrate_database()
