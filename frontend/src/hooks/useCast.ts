import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { useAppContext } from '../context/AppContext';

declare global {
  interface Window {
    chrome?: {
      cast?: {
        AutoJoinPolicy?: {
          ORIGIN_SCOPED: string;
        };
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
        CastContextEventType?: {
          SESSION_STATE_CHANGED: string;
        };
        SessionState?: {
          SESSION_STARTED: string;
          SESSION_RESUMED: string;
          SESSION_ENDED: string;
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
  addEventListener: (type: string, listener: (event: SessionStateEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: SessionStateEvent) => void) => void;
}

interface SessionStateEvent {
  session: CastSession | null;
  sessionState: string;
  errorCode?: string | null;
}

interface CastSession {
  getSessionId: () => string;
  getSessionObj: () => {
    appId?: string;
    receiver?: { friendlyName?: string };
    media?: unknown[];
    namespaces?: { name: string }[];
  };
  addMessageListener: (namespace: string, listener: (namespace: string, message: string) => void) => void;
  removeMessageListener: (namespace: string, listener: (namespace: string, message: string) => void) => void;
  sendMessage: (namespace: string, data: object | string) => Promise<unknown>;
}

const YOUTUBE_APP_ID = '233637DE';
const YOUTUBE_MDX_NAMESPACE = 'urn:x-cast:com.google.youtube.mdx';
const MDX_STATUS_TIMEOUT_MS = 10000;
const QUEUE_CAST_ACTIVE_KEY = 'queueCastPlaybackActive';

export function getYouTubeScreenId(session: CastSession): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (screenId?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      queueMicrotask(() => {
        session.removeMessageListener(YOUTUBE_MDX_NAMESPACE, onMessage);
      });
      if (screenId) {
        resolve(screenId);
      } else {
        reject(error ?? new Error('YouTube receiver did not provide a screen ID'));
      }
    };

    const onMessage = (_namespace: string, rawMessage: string) => {
      try {
        const message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
        if (message?.type === 'mdxSessionStatus' && message.data?.screenId) {
          finish(message.data.screenId);
        }
      } catch {
        // Ignore unrelated or malformed receiver messages until the timeout.
      }
    };

    const timeoutId = setTimeout(
      () => finish(undefined, new Error('Timed out waiting for YouTube receiver status')),
      MDX_STATUS_TIMEOUT_MS,
    );

    session.addMessageListener(YOUTUBE_MDX_NAMESPACE, onMessage);
    session.sendMessage(YOUTUBE_MDX_NAMESPACE, { type: 'getMdxSessionStatus' })
      .catch(() => finish(undefined, new Error('Could not query YouTube receiver status')));
  });
}

export async function getOrRequestYouTubeSession(
  context: CastContextInstance,
): Promise<CastSession | null> {
  let session = context.getCurrentSession();
  if (session?.getSessionObj().appId === YOUTUBE_APP_ID) {
    return session;
  }

  await context.requestSession();
  session = context.getCurrentSession();
  return session;
}

export function useCast() {
  const { dispatch } = useAppContext();
  const [castAvailable, setCastAvailable] = useState(false);
  const [castSession, setCastSession] = useState<CastSession | null>(null);
  const [receiverScreenId, setReceiverScreenId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingActiveRef = useRef(false);
  const pollingFailuresRef = useRef(0);
  const activeSessionRef = useRef<{ sessionId: string; screenId: string } | null>(null);
  const pendingScreenIdRef = useRef<{
    sessionId: string;
    promise: Promise<string>;
  } | null>(null);
  const sessionGenerationRef = useRef(0);

  const clearCastSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    activeSessionRef.current = null;
    pendingScreenIdRef.current = null;
    setCastSession(null);
    setReceiverScreenId(null);
    sessionStorage.removeItem('castSessionId');
    sessionStorage.removeItem('castScreenId');
    pollingActiveRef.current = false;
    pollingFailuresRef.current = 0;
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: false });
  }, [dispatch]);

  const connectCastSession = useCallback((session: CastSession): Promise<string> => {
    const sessionId = session.getSessionId();
    const active = activeSessionRef.current;
    if (active?.sessionId === sessionId) {
      return Promise.resolve(active.screenId);
    }

    const pending = pendingScreenIdRef.current;
    if (pending?.sessionId === sessionId) {
      return pending.promise;
    }

    const generation = ++sessionGenerationRef.current;
    setCastSession(session);
    sessionStorage.setItem('castSessionId', sessionId);

    const promise = getYouTubeScreenId(session)
      .then((screenId) => {
        if (sessionGenerationRef.current !== generation) {
          throw new Error('Cast session ended before YouTube receiver was ready');
        }
        activeSessionRef.current = { sessionId, screenId };
        setReceiverScreenId(screenId);
        sessionStorage.setItem('castScreenId', screenId);
        return screenId;
      })
      .finally(() => {
        if (pendingScreenIdRef.current?.promise === promise) {
          pendingScreenIdRef.current = null;
        }
      });

    pendingScreenIdRef.current = { sessionId, promise };
    return promise;
  }, []);

  // Check for Cast SDK availability
  useEffect(() => {
    let context: CastContextInstance | null = null;
    let sessionEventType: string | null = null;

    const handleSessionState = (event: SessionStateEvent) => {
      const framework = window.cast?.framework;
      const started = framework?.SessionState?.SESSION_STARTED ?? 'SESSION_STARTED';
      const resumed = framework?.SessionState?.SESSION_RESUMED ?? 'SESSION_RESUMED';
      const ended = framework?.SessionState?.SESSION_ENDED ?? 'SESSION_ENDED';

      if ((event.sessionState === started || event.sessionState === resumed) && event.session) {
        connectCastSession(event.session).catch((error) => {
          console.error('Failed to resume YouTube Cast session', error);
          clearCastSession();
        });
      } else if (event.sessionState === ended) {
        clearCastSession();
      }
    };

    const checkCast = () => {
      if (window.cast?.framework) {
        setCastAvailable(true);
        try {
          context = window.cast.framework.CastContext.getInstance();
          context.setOptions({
            receiverApplicationId: YOUTUBE_APP_ID,
            autoJoinPolicy: window.chrome?.cast?.AutoJoinPolicy?.ORIGIN_SCOPED,
          });
          sessionEventType = (
            window.cast.framework.CastContextEventType?.SESSION_STATE_CHANGED
            ?? 'sessionstatechanged'
          );
          context.addEventListener(sessionEventType, handleSessionState);

          const existingSession = context.getCurrentSession();
          if (existingSession?.getSessionObj().appId === YOUTUBE_APP_ID) {
            connectCastSession(existingSession).catch((error) => {
              console.error('Failed to restore YouTube Cast session', error);
              clearCastSession();
            });
          } else {
            clearCastSession();
          }
        } catch (error) {
          console.error('Cast initialization failed', error);
          // Cast init may fail in some environments
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
      if (context && sessionEventType) {
        context.removeEventListener(sessionEventType, handleSessionState);
      }
    };
  }, [clearCastSession, connectCastSession]);

  const requestCastSession = useCallback(async (): Promise<string | null> => {
    if (!castAvailable || !window.cast?.framework) {
      dispatch({ type: 'SHOW_TOAST', message: 'Cast not available', toastType: 'error' });
      return null;
    }
    try {
      const ctx = window.cast.framework.CastContext.getInstance();
      const session = await getOrRequestYouTubeSession(ctx);
      if (session) {
        return await connectCastSession(session);
      }
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('Cast session failed', error);
      dispatch({
        type: 'SHOW_TOAST',
        message: `Failed to connect to YouTube on Cast device: ${detail}`,
        toastType: 'error',
      });
      return null;
    }
  }, [castAvailable, connectCastSession, dispatch]);

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
    if (pollingActiveRef.current) return;
    pollingActiveRef.current = true;
    pollingFailuresRef.current = 0;
    localStorage.setItem(QUEUE_CAST_ACTIVE_KEY, 'true');

    const poll = async () => {
      pollingRef.current = null;
      if (!pollingActiveRef.current) return;

      let nextDelay = 10000;
      try {
        const res = await api.refreshQueueProgress();
        pollingFailuresRef.current = 0;
        dispatch({ type: 'SET_QUEUE_ITEMS', items: res.data.items });
        const progress = Object.fromEntries(
          res.data.items.map((item) => [
            item.video.video_id,
            item.video.playback_progress,
          ]),
        );
        for (const videoId of res.data.removed_video_ids ?? []) {
          progress[videoId] = 100;
        }
        dispatch({ type: 'SET_VIDEO_PROGRESS', progress });
        if (res.data.items.length === 0) {
          pollingActiveRef.current = false;
          localStorage.removeItem(QUEUE_CAST_ACTIVE_KEY);
          dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: false });
          dispatch({ type: 'SHOW_TOAST', message: 'Queue playback completed', toastType: 'info' });
        }
      } catch {
        pollingFailuresRef.current += 1;
        nextDelay = Math.min(10000 * (2 ** pollingFailuresRef.current), 60000);
      }

      if (pollingActiveRef.current) {
        pollingRef.current = setTimeout(poll, nextDelay);
      }
    };

    pollingRef.current = setTimeout(poll, 10000);
  }, [dispatch]);

  const stopProgressPolling = useCallback(() => {
    pollingActiveRef.current = false;
    pollingFailuresRef.current = 0;
    localStorage.removeItem(QUEUE_CAST_ACTIVE_KEY);
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: false });
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;

    const resumeProgressPolling = async () => {
      if (localStorage.getItem(QUEUE_CAST_ACTIVE_KEY) === 'true') {
        dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: true });
        startProgressPolling();
        return;
      }

      try {
        const response = await api.fetchQueueCastStatus();
        if (!cancelled && response.data.active) {
          dispatch({ type: 'SET_QUEUE_PLAYBACK_ACTIVE', active: true });
          startProgressPolling();
        }
      } catch {
        // Cast status probing is best-effort; a manual Cast action can still start polling.
      }
    };

    resumeProgressPolling();
    return () => { cancelled = true; };
  }, [dispatch, startProgressPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pollingActiveRef.current = false;
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
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
