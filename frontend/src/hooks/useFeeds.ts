import { useCallback, useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../api/client';
import type { Feed, Video } from '../types';

interface FeedVideoState {
  videos: Video[];
  page: number;
  hasMore: boolean;
  loading: boolean;
}

const EMPTY_VIDEO_PROGRESS: Record<string, number | null> = {};

function updateVideoStateAfterWatch(feed: Feed, state: FeedVideoState, videoId: string): FeedVideoState {
  if (feed.filter_play_state === 'unplayed') {
    return {
      ...state,
      videos: state.videos.filter((video) => video.video_id !== videoId),
    };
  }

  return {
    ...state,
    videos: state.videos.map((video) =>
      video.video_id === videoId ? { ...video, playback_progress: 100 } : video
    ),
  };
}

function applyVideoProgress(
  feeds: Feed[],
  feedVideos: Record<number, FeedVideoState>,
  progress: Record<string, number | null>
): Record<number, FeedVideoState> {
  if (Object.keys(progress).length === 0) {
    return feedVideos;
  }

  let next = feedVideos;

  for (const feed of feeds) {
    const feedState = feedVideos[feed.id];
    if (!feedState) continue;

    let videosChanged = false;
    const videos = feedState.videos.flatMap((video) => {
      if (!Object.prototype.hasOwnProperty.call(progress, video.video_id)) {
        return [video];
      }

      const playbackProgress = progress[video.video_id];
      if (feed.filter_play_state === 'unplayed' && (playbackProgress ?? 0) >= 95) {
        videosChanged = true;
        return [];
      }
      if (video.playback_progress === playbackProgress) {
        return [video];
      }

      videosChanged = true;
      return [{ ...video, playback_progress: playbackProgress }];
    });

    if (videosChanged) {
      if (next === feedVideos) {
        next = { ...feedVideos };
      }
      next[feed.id] = { ...feedState, videos };
    }
  }

  return next;
}

export function useFeeds() {
  const { state: appState, dispatch } = useAppContext();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedVideos, setFeedVideos] = useState<Record<number, FeedVideoState>>({});
  const videoProgress = appState.videoProgress ?? EMPTY_VIDEO_PROGRESS;

  useEffect(() => {
    if (Object.keys(videoProgress).length === 0) return;

    // Progress updates are events applied to the local page cache. A later fetch
    // must remain authoritative, so this cannot be permanent derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeedVideos((prev) => applyVideoProgress(feeds, prev, videoProgress));
  }, [feeds, videoProgress]);

  const refillLoadedBoundaryPage = useCallback(async (
    feedId: number,
    page: number,
    missingCount: number,
    expectedHasMore: boolean
  ) => {
    if (missingCount <= 0) {
      return;
    }

    try {
      const res = await api.fetchFeedVideos(feedId, { page, per_page: 20 });
      setFeedVideos((prev) => {
        const state = prev[feedId];
        if (!state) {
          return prev;
        }

        // Only apply boundary refill if feed pagination is unchanged since scheduling.
        if (state.page !== page || state.hasMore !== expectedHasMore || state.loading) {
          return prev;
        }

        const existingIds = new Set(state.videos.map((video) => video.video_id));
        const refillItems = res.data.items
          .filter((video) => !existingIds.has(video.video_id))
          .slice(0, missingCount);

        if (refillItems.length === 0 && state.hasMore === res.data.has_more) {
          return prev;
        }

        return {
          ...prev,
          [feedId]: {
            ...state,
            videos: refillItems.length > 0 ? [...state.videos, ...refillItems] : state.videos,
            hasMore: res.data.has_more,
          },
        };
      });
    } catch {
      // Best-effort refill: local removal still keeps the UI responsive.
    }
  }, []);

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

  const reorderFeeds = useCallback(async (orderedIds: number[]) => {
    setFeeds((prev) => {
      // Skip the optimistic update unless the ids match the current list exactly,
      // otherwise the local order would diverge from the server's sort_order.
      // The raw length check also rejects duplicated ids.
      if (orderedIds.length !== prev.length || new Set(orderedIds).size !== prev.length) {
        return prev;
      }
      const byId = new Map(prev.map((feed) => [feed.id, feed]));
      const reordered: Feed[] = [];
      for (let index = 0; index < orderedIds.length; index += 1) {
        const feed = byId.get(orderedIds[index]);
        if (!feed) {
          return prev;
        }
        reordered.push({ ...feed, sort_order: index });
      }
      return reordered;
    });
    try {
      await api.reorderFeeds(orderedIds);
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to reorder feeds', toastType: 'error' });
      await fetchFeeds();
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

  const markWatched = useCallback(async (videoId: string) => {
    try {
      let { data } = await api.markVideoWatched(videoId);

      // If YouTube session needed, try to get cookies from extension
      if (data.youtube_session_needed) {
        const imported = await new Promise<boolean>((resolve) => {
          const handler = async (event: MessageEvent) => {
            if (event.data?.type !== 'YT_SUBS_COOKIES_RESPONSE') return;
            window.removeEventListener('message', handler);
            if (event.data.error) {
              dispatch({ type: 'SHOW_TOAST', message: event.data.error, toastType: 'error' });
              resolve(false);
              return;
            }
            try {
              await api.importYouTubeCookies(event.data.cookies);
              resolve(true);
            } catch {
              resolve(false);
            }
          };
          window.addEventListener('message', handler);
          window.postMessage({ type: 'YT_SUBS_GET_COOKIES' }, '*');
          // Timeout: extension not installed
          setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve(false);
          }, 2000);
        });

        if (imported) {
          // Retry with the imported session
          const retry = await api.markVideoWatched(videoId);
          data = retry.data;
        } else {
          dispatch({ type: 'SHOW_TOAST', message: 'Install the YouTube Subscriptions Helper extension to enable mark-as-watched', toastType: 'error' });
          return;
        }
      }

      if (data.youtube_propagated) {
        dispatch({ type: 'SET_VIDEO_PROGRESS', progress: { [videoId]: 100 } });
        const feedsToRefill: Array<{
          feedId: number;
          page: number;
          missingCount: number;
          expectedHasMore: boolean;
        }> = [];

        setFeedVideos((prev) => {
          const next = { ...prev };
          for (const feed of feeds) {
            const state = next[feed.id];
            if (!state) {
              continue;
            }

            const updatedState = updateVideoStateAfterWatch(feed, state, videoId);

            if (feed.filter_play_state === 'unplayed' && state.hasMore) {
              const missingCount = state.videos.length - updatedState.videos.length;
              if (missingCount > 0) {
                feedsToRefill.push({
                  feedId: feed.id,
                  page: state.page,
                  missingCount,
                  expectedHasMore: state.hasMore,
                });
              }
            }

            next[feed.id] = updatedState;
          }
          return next;
        });

        if (feedsToRefill.length > 0) {
          await Promise.allSettled(
            feedsToRefill.map(({ feedId, page, missingCount, expectedHasMore }) =>
              refillLoadedBoundaryPage(feedId, page, missingCount, expectedHasMore)
            )
          );
        }
      } else {
        dispatch({ type: 'SHOW_TOAST', message: 'Failed to propagate to YouTube', toastType: 'error' });
      }
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to mark as watched', toastType: 'error' });
    }
  }, [dispatch, feeds, refillLoadedBoundaryPage]);

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
    reorderFeeds,
    fetchFeedVideos,
    loadMoreVideos,
    refreshAllFeedVideos,
    markWatched,
  };
}
