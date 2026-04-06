import { useCallback, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../api/client';
import type { Feed, Video } from '../types';

interface FeedVideoState {
  videos: Video[];
  page: number;
  hasMore: boolean;
  loading: boolean;
}

export function useFeeds() {
  const { dispatch } = useAppContext();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedVideos, setFeedVideos] = useState<Record<number, FeedVideoState>>({});

  const fetchFeeds = useCallback(async () => {
    try {
      const res = await api.fetchFeeds();
      setFeeds(res.data);
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load feeds', toastType: 'error' });
    }
  }, [dispatch]);

  const createFeed = useCallback(async (data: Partial<Feed>) => {
    try {
      await api.createFeed(data);
      await fetchFeeds();
      dispatch({ type: 'SHOW_TOAST', message: `Feed "${data.name}" created`, toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to create feed', toastType: 'error' });
    }
  }, [dispatch, fetchFeeds]);

  const updateFeed = useCallback(async (id: number, data: Partial<Feed>) => {
    try {
      await api.updateFeed(id, data);
      await fetchFeeds();
      dispatch({ type: 'SHOW_TOAST', message: 'Feed updated', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to update feed', toastType: 'error' });
    }
  }, [dispatch, fetchFeeds]);

  const deleteFeed = useCallback(async (id: number) => {
    try {
      await api.deleteFeed(id);
      setFeedVideos((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await fetchFeeds();
      dispatch({ type: 'SHOW_TOAST', message: 'Feed deleted', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to delete feed', toastType: 'error' });
    }
  }, [dispatch, fetchFeeds]);

  const fetchFeedVideos = useCallback(async (feedId: number, page = 1) => {
    setFeedVideos((prev) => ({
      ...prev,
      [feedId]: {
        ...prev[feedId],
        videos: page === 1 ? [] : (prev[feedId]?.videos ?? []),
        page,
        hasMore: prev[feedId]?.hasMore ?? true,
        loading: true,
      },
    }));
    try {
      const res = await api.fetchFeedVideos(feedId, { page, per_page: 20 });
      setFeedVideos((prev) => ({
        ...prev,
        [feedId]: {
          videos: page === 1 ? res.data.items : [...(prev[feedId]?.videos ?? []), ...res.data.items],
          page,
          hasMore: res.data.has_more,
          loading: false,
        },
      }));
    } catch {
      setFeedVideos((prev) => ({
        ...prev,
        [feedId]: {
          ...prev[feedId],
          videos: prev[feedId]?.videos ?? [],
          page: prev[feedId]?.page ?? 1,
          hasMore: false,
          loading: false,
        },
      }));
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load feed videos', toastType: 'error' });
    }
  }, [dispatch]);

  const loadMoreVideos = useCallback((feedId: number) => {
    const state = feedVideos[feedId];
    if (state && !state.loading && state.hasMore) {
      fetchFeedVideos(feedId, state.page + 1);
    }
  }, [feedVideos, fetchFeedVideos]);

  const refreshAllFeedVideos = useCallback(async () => {
    for (const feed of feeds) {
      await fetchFeedVideos(feed.id, 1);
    }
  }, [feeds, fetchFeedVideos]);

  return {
    feeds,
    feedVideos,
    fetchFeeds,
    createFeed,
    updateFeed,
    deleteFeed,
    fetchFeedVideos,
    loadMoreVideos,
    refreshAllFeedVideos,
  };
}
