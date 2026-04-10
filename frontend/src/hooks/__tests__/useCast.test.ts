import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getOrRequestYouTubeSession, getYouTubeScreenId, useCast } from '../useCast';
import * as api from '../../api/client';
import { useAppContext } from '../../context/AppContext';
import { mockQueueItem } from '../../test/helpers';

vi.mock('../../api/client');
vi.mock('../../context/AppContext', () => ({
  useAppContext: vi.fn(),
}));

const mockedApi = vi.mocked(api);
const mockedUseAppContext = vi.mocked(useAppContext);

const NAMESPACE = 'urn:x-cast:com.google.youtube.mdx';

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mockedUseAppContext.mockReturnValue({ dispatch: vi.fn(), state: {} as never });
  mockedApi.fetchQueueCastStatus.mockResolvedValue({
    data: { active: false, now_playing: null },
  } as never);
});

function createSession() {
  let listener: ((namespace: string, message: string) => void) | undefined;
  let dispatching = false;
  return {
    session: {
      getSessionId: vi.fn(() => 'cast-session-id'),
      getSessionObj: vi.fn(() => ({ appId: '233637DE' })),
      addMessageListener: vi.fn((_namespace, callback) => { listener = callback; }),
      removeMessageListener: vi.fn(() => {
        if (dispatching) throw new Error('The map has changed since the iterator was created');
      }),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    emit(message: object | string) {
      dispatching = true;
      try {
        listener?.(NAMESPACE, typeof message === 'string' ? message : JSON.stringify(message));
      } finally {
        dispatching = false;
      }
    },
  };
}

describe('getYouTubeScreenId', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests MDX status and resolves the receiver screen ID', async () => {
    const { session, emit } = createSession();
    const result = getYouTubeScreenId(session);

    emit({ type: 'mdxSessionStatus', data: { screenId: 'real-screen-id' } });

    await expect(result).resolves.toBe('real-screen-id');
    expect(session.addMessageListener).toHaveBeenCalledWith(NAMESPACE, expect.any(Function));
    expect(session.sendMessage).toHaveBeenCalledWith(NAMESPACE, { type: 'getMdxSessionStatus' });
    expect(session.removeMessageListener).toHaveBeenCalledWith(NAMESPACE, expect.any(Function));
  });

  it('does not mutate the SDK listener map during message dispatch', async () => {
    const { session, emit } = createSession();
    const result = getYouTubeScreenId(session);

    expect(() => {
      emit({ type: 'mdxSessionStatus', data: { screenId: 'screen-id' } });
    }).not.toThrow();

    await expect(result).resolves.toBe('screen-id');
    expect(session.removeMessageListener).toHaveBeenCalledOnce();
  });

  it('ignores unrelated messages until MDX status arrives', async () => {
    const { session, emit } = createSession();
    const result = getYouTubeScreenId(session);

    emit({ type: 'otherMessage', data: { screenId: 'wrong' } });
    emit('{malformed');
    emit({ type: 'mdxSessionStatus', data: { screenId: 'right' } });

    await expect(result).resolves.toBe('right');
  });

  it('rejects when the receiver does not answer', async () => {
    vi.useFakeTimers();
    const { session } = createSession();
    const result = getYouTubeScreenId(session);
    const assertion = expect(result).rejects.toThrow(
      'Timed out waiting for YouTube receiver status',
    );

    await vi.advanceTimersByTimeAsync(10000);

    await assertion;
    expect(session.removeMessageListener).toHaveBeenCalledWith(NAMESPACE, expect.any(Function));
  });
});

describe('getOrRequestYouTubeSession', () => {
  it('reuses an existing YouTube receiver session without opening the picker', async () => {
    const { session } = createSession();
    const context = {
      getCurrentSession: vi.fn(() => session),
      requestSession: vi.fn(),
    };

    await expect(getOrRequestYouTubeSession(context as never)).resolves.toBe(session);
    expect(context.requestSession).not.toHaveBeenCalled();
  });

  it('opens the picker when no YouTube receiver session exists', async () => {
    const { session } = createSession();
    const context = {
      getCurrentSession: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(session),
      requestSession: vi.fn(() => Promise.resolve()),
    };

    await expect(getOrRequestYouTubeSession(context as never)).resolves.toBe(session);
    expect(context.requestSession).toHaveBeenCalledOnce();
  });
});

describe('useCast progress polling', () => {
  it('waits for the current request before scheduling the next poll', async () => {
    vi.useFakeTimers();
    const queueItem = mockQueueItem();

    let resolveFirst: ((value: unknown) => void) | undefined;
    mockedApi.refreshQueueProgress
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }) as never)
      .mockResolvedValue({
        data: { items: [queueItem], removed_count: 0, removed_video_ids: [] },
      } as never);

    const { result, unmount } = renderHook(() => useCast());
    act(() => result.current.startProgressPolling());

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mockedApi.refreshQueueProgress).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mockedApi.refreshQueueProgress).toHaveBeenCalledOnce();

    await act(async () => {
      resolveFirst?.({
        data: { items: [queueItem], removed_count: 0, removed_video_ids: [] },
      });
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mockedApi.refreshQueueProgress).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('resumes progress polling after the app remounts during Cast playback', async () => {
    vi.useFakeTimers();
    localStorage.setItem('queueCastPlaybackActive', 'true');
    mockedApi.refreshQueueProgress.mockResolvedValue({
      data: { items: [mockQueueItem()], removed_count: 0, removed_video_ids: [] },
    } as never);

    const { unmount } = renderHook(() => useCast());

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });

    expect(mockedApi.refreshQueueProgress).toHaveBeenCalledOnce();
    unmount();
  });

  it('discovers server-side Cast playback in a new browser context', async () => {
    mockedApi.fetchQueueCastStatus.mockResolvedValue({
      data: {
        active: true,
        now_playing: { video_id: 'playing-video', state: '1', current_time: 30 },
      },
    } as never);

    const { unmount } = renderHook(() => useCast());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(localStorage.getItem('queueCastPlaybackActive')).toBe('true');
    expect(mockedApi.fetchQueueCastStatus).toHaveBeenCalledOnce();
    unmount();
  });
});