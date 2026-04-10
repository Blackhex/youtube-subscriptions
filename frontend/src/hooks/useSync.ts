import { useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAppContext } from '../context/AppContext';
import { startFullSync, fetchSyncStatus } from '../api/client';

export function useSync() {
  const { state, dispatch } = useAppContext();
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    try {
      const { data } = await fetchSyncStatus();
      dispatch({ type: 'SET_SYNC_STATE', state: data });

      if (!data.running && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;

        if (data.errors > 0 && data.subs_synced === 0 && data.processed === 0) {
          const errorMsg = data.current_channel || 'Sync failed';
          dispatch({ type: 'SHOW_TOAST', message: errorMsg, toastType: 'error' });
        } else {
          const msg = data.subs_synced
            ? `Sync complete: ${data.subs_synced} subscriptions, ${data.fetched_new} new videos`
            : 'Sync complete';
          dispatch({ type: 'SHOW_TOAST', message: msg, toastType: data.errors > 0 ? 'error' : 'success' });
        }
      }
    } catch {
      // Ignore polling errors
    }
  }, [dispatch]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollStatus();
    pollingRef.current = setInterval(pollStatus, 2000);
  }, [pollStatus]);

  const startSync = useCallback(async (force = false) => {
    try {
      await startFullSync(force);
      startPolling();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        startPolling();
        dispatch({ type: 'SHOW_TOAST', message: 'Sync already in progress', toastType: 'info' });
      } else {
        dispatch({ type: 'SHOW_TOAST', message: 'Failed to start sync', toastType: 'error' });
      }
    }
  }, [dispatch, startPolling]);

  // On mount, check if sync is already running
  useEffect(() => {
    pollStatus();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [pollStatus]);

  // When sync state changes to running, ensure polling is active
  useEffect(() => {
    if (state.syncState.running && !pollingRef.current) {
      startPolling();
    }
  }, [state.syncState.running, startPolling]);

  return {
    syncState: state.syncState,
    startSync,
  };
}
