import axios from 'axios';
import type { Category, Subscription, Video, QueueItem, Feed, SyncState, Playlist, PaginatedResponse } from '../types';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Categories
export const fetchCategories = () =>
  api.get<{ categories: Category[]; total_count: number; uncategorized_count: number }>('/categories/');
export const createCategory = (data: { name: string; description?: string; parent_id?: number | null }) =>
  api.post<Category>('/categories/', data);
export const updateCategory = (id: number, data: Partial<Category>) =>
  api.put<Category>(`/categories/${id}/`, data);
export const deleteCategory = (id: number) =>
  api.delete(`/categories/${id}/`);
export const reorderCategories = (parent_id: number | null, ordered_ids: number[]) =>
  api.post('/categories/reorder/', { parent_id, ordered_ids });
export const exportCategories = () =>
  api.get('/categories/export/', { responseType: 'blob' });
export const importCategories = (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post('/categories/import/', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

// Subscriptions
export const fetchSubscriptions = (params: {
  category_id?: number;
  uncategorized?: string;
  page?: number;
  per_page?: number;
}) => api.get<PaginatedResponse<Subscription>>('/subscriptions/', { params });
export const deleteSubscription = (id: number) =>
  api.delete(`/subscriptions/${id}/`);
export const assignSubscription = (subId: number, catId: number) =>
  api.post(`/subscriptions/${subId}/assign/${catId}/`);
export const unassignSubscription = (subId: number, catId: number) =>
  api.delete(`/subscriptions/${subId}/unassign/${catId}/`);
export const fetchSuggestions = (subId: number) =>
  api.get<{ subscription_id: number; suggested_category_ids: number[] }>(`/subscriptions/${subId}/suggestions/`);

// Feeds
export const fetchFeeds = () => api.get<Feed[]>('/feeds/');
export const createFeed = (data: Partial<Feed>) => api.post<Feed>('/feeds/', data);
export const updateFeed = (id: number, data: Partial<Feed>) => api.put<Feed>(`/feeds/${id}/`, data);
export const deleteFeed = (id: number) => api.delete(`/feeds/${id}/`);
export const fetchFeedVideos = (feedId: number, params: { page?: number; per_page?: number }) =>
  api.get<PaginatedResponse<Video>>(`/feeds/${feedId}/videos/`, { params });

// Queue
export const fetchQueue = () => api.get<{ items: QueueItem[] }>('/queue/');
export const addToQueue = (videoId: string) => api.post<{ items: QueueItem[] }>('/queue/', { video_id: videoId });
export const addMultipleToQueue = (videoIds: string[]) => api.post<{ items: QueueItem[] }>('/queue/', { video_ids: videoIds });
export const removeFromQueue = (queueItemId: number) => api.delete(`/queue/${queueItemId}/`);
export const reorderQueue = (queueItemIds: number[]) =>
  api.post<{ items: QueueItem[] }>('/queue/reorder/', { queue_item_ids: queueItemIds });
export const clearQueue = () => api.post('/queue/clear/');
export const createPlaylistFromQueue = () =>
  api.post('/queue/create-playlist/');
export const castQueue = (screenId: string) =>
  api.post('/queue/cast/', { screen_id: screenId });
export const refreshQueueProgress = () =>
  api.post<{ items: QueueItem[] }>('/queue/refresh-progress/');

// Sync
export const startFullSync = (force = false) => api.post('/sync/all/', { force });
export const startVideoSync = (force = false, channelIds?: string[]) =>
  api.post('/sync/videos/', { force, channel_ids: channelIds });
export const fetchSyncStatus = () => api.get<SyncState>('/sync/status/');

// Playlists
export const fetchPlaylists = () => api.get<Playlist[]>('/playlists/');
export const deletePlaylist = (playlistId: string) => api.delete(`/playlists/${playlistId}/`);
export const fetchPlaylistItems = (playlistId: string, params: { page?: number; per_page?: number; page_token?: string }) =>
  api.get<PaginatedResponse<Video>>(`/playlists/${playlistId}/items/`, { params });
export const addToPlaylist = (playlistId: string, videoId: string) =>
  api.post(`/playlists/${playlistId}/items/`, { video_id: videoId });
export const reorderPlaylistItems = (playlistId: string, itemIds: string[], videoIds: string[]) =>
  api.post(`/playlists/${playlistId}/items/reorder/`, { item_ids: itemIds, video_ids: videoIds });
export const removeFromPlaylist = (playlistId: string, itemId: string) =>
  api.delete(`/playlists/${playlistId}/items/${itemId}/`);
export const castPlaylist = (playlistId: string, screenId: string) =>
  api.post(`/playlists/${playlistId}/cast/`, { screen_id: screenId });

// Videos
export const fetchVideosBatch = (videoIds: string[]) =>
  api.post('/videos/fetch/', { video_ids: videoIds });
