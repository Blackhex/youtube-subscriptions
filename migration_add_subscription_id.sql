-- Migration: Add subscription_id column to subscriptions table
-- This column stores the YouTube subscription ID for unsubscribing functionality
-- Run this if you have an existing database

-- For SQLite (default):
ALTER TABLE subscriptions ADD COLUMN subscription_id VARCHAR(256);

-- Note: After running this migration, you should sync your subscriptions again
-- to populate the subscription_id field:
-- 1. Open the app
-- 2. Click the Sync button
-- 3. All subscriptions will be updated with their YouTube subscription IDs

-- The subscription_id is required for unsubscribing from YouTube.
-- Subscriptions without this ID can still be deleted from the local database,
-- but won't be removed from YouTube.
