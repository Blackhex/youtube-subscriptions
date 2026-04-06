import { useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../api/client';

export function useQueue() {
  const { state, dispatch } = useAppContext();

  const fetchQueue = useCallback(async () => {
    try {
      const res = await api.fetchQueue();
      dispatch({ type: 'SET_QUEUE_ITEMS', items: res.data.items });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load queue', toastType: 'error' });
    }
  }, [dispatch]);

  const addToQueue = useCallback(async (videoId: string) => {
    try {
      const res = await api.addToQueue(videoId);
      dispatch({ type: 'SET_QUEUE_ITEMS', items: res.data.items });
      dispatch({ type: 'SHOW_TOAST', message: 'Video added to queue', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to add to queue', toastType: 'error' });
    }
  }, [dispatch]);

  const removeFromQueue = useCallback(async (queueItemId: number) => {
    try {
      await api.removeFromQueue(queueItemId);
      await fetchQueue();
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to remove from queue', toastType: 'error' });
    }
  }, [dispatch, fetchQueue]);

  const reorderQueue = useCallback(async (ids: number[]) => {
    try {
      const res = await api.reorderQueue(ids);
      dispatch({ type: 'SET_QUEUE_ITEMS', items: res.data.items });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to reorder queue', toastType: 'error' });
    }
  }, [dispatch]);

  const clearQueue = useCallback(async () => {
    try {
      await api.clearQueue();
      dispatch({ type: 'SET_QUEUE_ITEMS', items: [] });
      dispatch({ type: 'SHOW_TOAST', message: 'Queue cleared', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to clear queue', toastType: 'error' });
    }
  }, [dispatch]);

  const createPlaylist = useCallback(async () => {
    try {
      const res = await api.createPlaylistFromQueue();
      dispatch({ type: 'SET_QUEUE_ITEMS', items: [] });
      dispatch({ type: 'SHOW_TOAST', message: 'Playlist created from queue', toastType: 'success' });
      return res.data;
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to create playlist', toastType: 'error' });
      return null;
    }
  }, [dispatch]);

  return {
    queueItems: state.queueItems,
    fetchQueue,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    createPlaylist,
  };
}
