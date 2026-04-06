import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { useAppContext } from '../context/AppContext';

declare global {
  interface Window {
    chrome?: {
      cast?: {
        media?: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        };
      };
    };
    cast?: {
      framework?: {
        CastContext: {
          getInstance: () => CastContextInstance;
        };
      };
    };
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
  }
}

interface CastContextInstance {
  setOptions: (options: { receiverApplicationId: string; autoJoinPolicy?: string }) => void;
  requestSession: () => Promise<unknown>;
  getCurrentSession: () => CastSession | null;
}

interface CastSession {
  getSessionId: () => string;
  getSessionObj: () => { receiver?: { friendlyName?: string }; media?: unknown[] };
}

export function useCast() {
  const { dispatch } = useAppContext();
  const [castAvailable, setCastAvailable] = useState(false);
  const [castSession, setCastSession] = useState<CastSession | null>(null);
  const [receiverScreenId, setReceiverScreenId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check for Cast SDK availability
  useEffect(() => {
    const checkCast = () => {
      if (window.cast?.framework) {
        setCastAvailable(true);
        try {
          const ctx = window.cast.framework.CastContext.getInstance();
          ctx.setOptions({
            receiverApplicationId: window.chrome?.cast?.media?.DEFAULT_MEDIA_RECEIVER_APP_ID ?? 'CC1AD845',
          });
        } catch {
          // Cast init may fail in some environments
        }
        // Try to resume session
        const savedScreenId = sessionStorage.getItem('castScreenId');
        if (savedScreenId) {
          setReceiverScreenId(savedScreenId);
        }
      }
    };

    // Cast SDK calls this global callback when ready
    if (window.cast?.framework) {
      checkCast();
    } else {
      window.__onGCastApiAvailable = (isAvailable: boolean) => {
        if (isAvailable) checkCast();
      };
    }

    return () => {
      window.__onGCastApiAvailable = undefined;
    };
  }, []);

  const requestCastSession = useCallback(async (): Promise<string | null> => {
    if (!castAvailable || !window.cast?.framework) {
      dispatch({ type: 'SHOW_TOAST', message: 'Cast not available', toastType: 'error' });
      return null;
    }
    try {
      const ctx = window.cast.framework.CastContext.getInstance();
      await ctx.requestSession();
      const session = ctx.getCurrentSession();
      if (session) {
        setCastSession(session);
        const sessionId = session.getSessionId();
        sessionStorage.setItem('castSessionId', sessionId);
        // Get YouTube screen ID via MDX - for now use the session ID
        // The actual screen ID comes from the Cast device's MDX status
        const screenId = sessionId;
        setReceiverScreenId(screenId);
        sessionStorage.setItem('castScreenId', screenId);
        return screenId;
      }
      return null;
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to connect to Cast device', toastType: 'error' });
      return null;
    }
  }, [castAvailable, dispatch]);

  const castQueue = useCallback(async (screenId?: string) => {
    const sid = screenId ?? receiverScreenId;
    if (!sid) {
      dispatch({ type: 'SHOW_TOAST', message: 'No Cast session active', toastType: 'error' });
      return;
    }
    try {
      await api.castQueue(sid);
      dispatch({ type: 'SHOW_TOAST', message: 'Queue sent to Cast device', toastType: 'success' });
      dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: true });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to cast queue', toastType: 'error' });
    }
  }, [receiverScreenId, dispatch]);

  const castPlaylist = useCallback(async (playlistId: string, screenId?: string) => {
    const sid = screenId ?? receiverScreenId;
    if (!sid) {
      dispatch({ type: 'SHOW_TOAST', message: 'No Cast session active', toastType: 'error' });
      return;
    }
    try {
      await api.castPlaylist(playlistId, sid);
      dispatch({ type: 'SHOW_TOAST', message: 'Playlist sent to Cast device', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to cast playlist', toastType: 'error' });
    }
  }, [receiverScreenId, dispatch]);

  const startProgressPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(async () => {
      try {
        const res = await api.refreshQueueProgress();
        dispatch({ type: 'SET_QUEUE_ITEMS', items: res.data.items });
        if (res.data.items.length === 0) {
          dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: false });
          dispatch({ type: 'SHOW_TOAST', message: 'Queue playback completed', toastType: 'info' });
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
      } catch {
        // Silently fail on polling errors
      }
    }, 10000);
  }, [dispatch]);

  const stopProgressPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: false });
  }, [dispatch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  return {
    castAvailable,
    castSession,
    receiverScreenId,
    requestCastSession,
    castQueue,
    castPlaylist,
    startProgressPolling,
    stopProgressPolling,
  };
}
