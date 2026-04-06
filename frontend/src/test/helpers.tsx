import { render } from '@testing-library/react';
import { AppProvider } from '../context/AppContext';
import type { Category, Subscription, Video, Feed, QueueItem } from '../types';

export function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: AppProvider });
}

export const mockCategory = (overrides: Partial<Category> = {}): Category => ({
  id: 1,
  name: 'Test Category',
  description: null,
  parent_id: null,
  sort_order: 0,
  subscription_count: 10,
  children: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

export const mockSubscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 1,
  subscription_id: 'sub_123',
  channel_id: 'UC123',
  channel_title: 'Test Channel',
  channel_description: 'A test channel description',
  thumbnail_url: '/media/thumbnails/channels/UC123.jpg',
  subscription_date: '2026-01-01T00:00:00Z',
  categories: [{ id: 1, name: 'Tech' }],
  ...overrides,
});

export const mockVideo = (overrides: Partial<Video> = {}): Video => ({
  id: 1,
  video_id: 'vid_123',
  channel_id: 'UC123',
  title: 'Test Video Title',
  thumbnail_url: '/media/thumbnails/videos/vid_123.jpg',
  published_at: '2026-01-01T00:00:00Z',
  duration_seconds: 600,
  video_type: 'video',
  playback_progress: 0,
  channel_title: 'Test Channel',
  ...overrides,
});

export const mockFeed = (overrides: Partial<Feed> = {}): Feed => ({
  id: 1,
  name: 'Test Feed',
  sort_order: 0,
  filter_category_ids: null,
  filter_video_type: null,
  filter_min_duration: null,
  filter_max_duration: null,
  filter_max_age_days: null,
  filter_play_state: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

export const mockQueueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: 1,
  video_id: 'vid_123',
  sort_order: 0,
  added_at: '2026-01-01T00:00:00Z',
  video: mockVideo(),
  ...overrides,
});
