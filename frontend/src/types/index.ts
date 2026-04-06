export interface Category {
  id: number;
  name: string;
  description: string | null;
  parent_id: number | null;
  sort_order: number;
  subscription_count: number;
  children: Category[];
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: number;
  subscription_id: string | null;
  channel_id: string;
  channel_title: string;
  channel_description: string | null;
  thumbnail_url: string | null;
  subscription_date: string | null;
  categories: { id: number; name: string }[];
}

export interface Video {
  id: number;
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  video_type: 'video' | 'short' | 'live' | null;
  playback_progress: number | null;
  channel_title: string | null;
  playlist_item_id?: string;
}

export interface QueueItem {
  id: number;
  video_id: string;
  sort_order: number;
  added_at: string;
  video: Video;
}

export interface Feed {
  id: number;
  name: string;
  sort_order: number;
  filter_category_ids: number[][] | null;
  filter_video_type: string | null;
  filter_min_duration: number | null;
  filter_max_duration: number | null;
  filter_max_age_days: number | null;
  filter_play_state: 'played' | 'unplayed' | 'both' | null;
  created_at: string;
  updated_at: string;
}

export interface SyncState {
  running: boolean;
  phase: 'subscriptions' | 'videos' | null;
  total: number;
  processed: number;
  fetched_new: number;
  errors: number;
  skipped: number;
  subs_synced: number;
  started_at: string | null;
  finished_at: string | null;
  current_channel: string | null;
}

export interface Playlist {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string | null;
  item_count: number;
  privacy_status: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
  next_page_token?: string;
}
