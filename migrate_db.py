"""Database migration script to add subscription_id column."""
import sqlite3
import os

def migrate_database():
    # Check both possible locations
    for db_path in ["instance/subscriptions.db", "subscriptions.db"]:
        if os.path.exists(db_path):
            _migrate_file(db_path)
            return
    
    print("No database file found.")
    print("No migration needed - the column will be created when you first run the app.")

def _migrate_file(db_path):
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check if the column already exists
        cursor.execute("PRAGMA table_info(subscriptions)")
        columns = cursor.fetchall()
        column_names = [col[1] for col in columns]
        
        if 'subscription_id' in column_names:
            print("✓ Migration already applied - subscription_id column exists.")
        else:
            print("Adding subscription_id column to subscriptions table...")
            cursor.execute("ALTER TABLE subscriptions ADD COLUMN subscription_id VARCHAR(256)")
            conn.commit()
            print("✓ Migration completed successfully!")
            print("\nNext steps:")
            print("1. Delete token.json (if it exists)")
            print("2. Restart the app")
            print("3. Click the Sync button to populate subscription IDs")
        
        conn.close()
        
    except sqlite3.Error as e:
        print(f"✗ Database error: {e}")
        return
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        return

if __name__ == "__main__":
    print("YouTube Subscriptions Organizer - Database Migration")
    print("=" * 50)
    migrate_database()
