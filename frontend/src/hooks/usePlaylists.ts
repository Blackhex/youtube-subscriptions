import { useCallback, useState } from 'react';
import * as api from '../api/client';
import { useAppContext } from '../context/AppContext';
import type { Playlist, Video } from '../types';

interface PlaylistItemsState {
  items: Video[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  nextPageToken?: string;
}

export function usePlaylists() {
  const { dispatch } = useAppContext();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistItems, setPlaylistItems] = useState<Record<string, PlaylistItemsState>>({});
  const [loading, setLoading] = useState(false);

  const fetchPlaylists = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.fetchPlaylists();
      setPlaylists(res.data);
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load playlists', toastType: 'error' });
    } finally {
      setLoading(false);
    }
  }, [dispatch]);

  const fetchPlaylistItems = useCallback(async (playlistId: string, pageToken?: string) => {
    setPlaylistItems((prev) => ({
      ...prev,
      [playlistId]: {
        ...(prev[playlistId] ?? { items: [], page: 1, hasMore: true, loading: false }),
        loading: true,
      },
    }));
    try {
      const res = await api.fetchPlaylistItems(playlistId, {
        per_page: 20,
        page_token: pageToken,
      });
      setPlaylistItems((prev) => {
        const existing = prev[playlistId];
        const newItems = pageToken && existing
          ? [...existing.items, ...res.data.items]
          : res.data.items;
        return {
          ...prev,
          [playlistId]: {
            items: newItems,
            page: res.data.page,
            hasMore: res.data.has_more,
            loading: false,
            nextPageToken: res.data.next_page_token,
          },
        };
      });
    } catch {
      setPlaylistItems((prev) => ({
        ...prev,
        [playlistId]: {
          ...(prev[playlistId] ?? { items: [], page: 1, hasMore: false, loading: false }),
          loading: false,
        },
      }));
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load playlist items', toastType: 'error' });
    }
  }, [dispatch]);

  const loadMoreItems = useCallback((playlistId: string) => {
    const state = playlistItems[playlistId];
    if (!state || state.loading || !state.hasMore) return;
    fetchPlaylistItems(playlistId, state.nextPageToken);
  }, [playlistItems, fetchPlaylistItems]);

  const removeItem = useCallback(async (playlistId: string, itemId: string) => {
    try {
      await api.removeFromPlaylist(playlistId, itemId);
      setPlaylistItems((prev) => {
        const state = prev[playlistId];
        if (!state) return prev;
        return {
          ...prev,
          [playlistId]: {
            ...state,
            items: state.items.filter((v) => v.playlist_item_id !== itemId),
          },
        };
      });
      // Update playlist item count
      setPlaylists((prev) =>
        prev.map((p) => p.id === playlistId ? { ...p, item_count: Math.max(0, p.item_count - 1) } : p),
      );
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to remove item', toastType: 'error' });
    }
  }, [dispatch]);

  const reorderItems = useCallback(async (playlistId: string, itemIds: string[], videoIds: string[], reorderedItems: Video[]) => {
    const previous = playlistItems[playlistId];
    // Optimistically update local state
    setPlaylistItems((prev) => {
      const state = prev[playlistId];
      if (!state) return prev;
      return { ...prev, [playlistId]: { ...state, items: reorderedItems } };
    });
    try {
      await api.reorderPlaylistItems(playlistId, itemIds, videoIds);
    } catch {
      // Revert on error
      if (previous) {
        setPlaylistItems((prev) => ({ ...prev, [playlistId]: previous }));
      }
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to reorder items', toastType: 'error' });
    }
  }, [dispatch, playlistItems]);

  const deletePlaylist = useCallback(async (playlistId: string) => {
    try {
      await api.deletePlaylist(playlistId);
      setPlaylists((prev) => prev.filter((p) => p.id !== playlistId));
      setPlaylistItems((prev) => {
        const next = { ...prev };
        delete next[playlistId];
        return next;
      });
      dispatch({ type: 'SHOW_TOAST', message: 'Playlist deleted', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to delete playlist', toastType: 'error' });
    }
  }, [dispatch]);

  return {
    playlists,
    playlistItems,
    loading,
    fetchPlaylists,
    fetchPlaylistItems,
    loadMoreItems,
    removeItem,
    reorderItems,
    deletePlaylist,
  };
}
