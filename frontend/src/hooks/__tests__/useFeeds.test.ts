import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFeeds } from '../useFeeds';
import * as api from '../../api/client';
import { useAppContext } from '../../context/AppContext';
import { mockFeed, mockVideo } from '../../test/helpers';

vi.mock('../../api/client');
vi.mock('../../context/AppContext', () => ({
  useAppContext: vi.fn(),
}));

const mockedApi = vi.mocked(api);
const mockedUseAppContext = vi.mocked(useAppContext);

function makeVideo(videoId: string, playbackProgress = 0) {
  return mockVideo({ video_id: videoId, playback_progress: playbackProgress });
}

describe('useFeeds markWatched regression', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedUseAppContext.mockReturnValue({
      dispatch: vi.fn(),
      state: {} as never,
    });
  });

  it('removes watched video from a loaded unplayed feed when propagation succeeds', async () => {
    const unplayedFeed = mockFeed({ id: 101, filter_play_state: 'unplayed' });
    const pageOne = [makeVideo('v-1'), makeVideo('v-2'), makeVideo('v-3')];

    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [unplayedFeed] } as never);
    mockedApi.fetchFeedVideos.mockResolvedValueOnce({
      data: { items: pageOne, page: 1, per_page: 20, total: 3, has_more: false },
    } as never);
    mockedApi.markVideoWatched.mockResolvedValueOnce({
      data: { youtube_propagated: true, youtube_session_needed: false },
    } as never);

    const { result } = renderHook(() => useFeeds());

    await act(async () => {
      await result.current.fetchFeeds();
    });
    await waitFor(() => {
      expect(result.current.feeds).toHaveLength(1);
    });

    await act(async () => {
      await result.current.fetchFeedVideos(unplayedFeed.id, 1);
    });
    await waitFor(() => {
      expect(result.current.feedVideos[unplayedFeed.id].videos).toHaveLength(3);
    });

    await act(async () => {
      await result.current.markWatched('v-2');
    });

    await waitFor(() => {
      expect(result.current.feedVideos[unplayedFeed.id].videos.map((v) => v.video_id)).toEqual(['v-1', 'v-3']);
    });
  });

  it('applies queue progress to loaded feed videos and removes completed unplayed items', async () => {
    const dispatch = vi.fn();
    const unplayedFeed = mockFeed({ id: 404, filter_play_state: 'unplayed' });
    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: { videoProgress: {} } as never,
    });
    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [unplayedFeed] } as never);
    mockedApi.fetchFeedVideos.mockResolvedValueOnce({
      data: {
        items: [makeVideo('shared-video'), makeVideo('other-video')],
        page: 1,
        per_page: 20,
        total: 2,
        has_more: false,
      },
    } as never);

    const { result, rerender } = renderHook(() => useFeeds());
    await act(async () => { await result.current.fetchFeeds(); });
    await act(async () => { await result.current.fetchFeedVideos(unplayedFeed.id, 1); });

    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: { videoProgress: { 'shared-video': 42 } } as never,
    });
    rerender();

    await waitFor(() => {
      expect(result.current.feedVideos[unplayedFeed.id].videos[0].playback_progress).toBe(42);
    });

    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: { videoProgress: { 'shared-video': 100 } } as never,
    });
    rerender();

    await waitFor(() => {
      expect(
        result.current.feedVideos[unplayedFeed.id].videos.map((video) => video.video_id),
      ).toEqual(['other-video']);
    });
  });

  it('lets a later feed response supersede an older queue progress update', async () => {
    const dispatch = vi.fn();
    const allFeed = mockFeed({ id: 405, filter_play_state: null });
    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: { videoProgress: {} } as never,
    });
    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [allFeed] } as never);
    mockedApi.fetchFeedVideos
      .mockResolvedValueOnce({
        data: {
          items: [makeVideo('shared-video', 10)],
          page: 1,
          per_page: 20,
          total: 1,
          has_more: false,
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          items: [makeVideo('shared-video', 75)],
          page: 1,
          per_page: 20,
          total: 1,
          has_more: false,
        },
      } as never);

    const { result, rerender } = renderHook(() => useFeeds());
    await act(async () => { await result.current.fetchFeeds(); });
    await act(async () => { await result.current.fetchFeedVideos(allFeed.id, 1); });

    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: { videoProgress: { 'shared-video': 42 } } as never,
    });
    rerender();
    await waitFor(() => {
      expect(result.current.feedVideos[allFeed.id].videos[0].playback_progress).toBe(42);
    });

    await act(async () => { await result.current.fetchFeedVideos(allFeed.id, 1); });
    expect(result.current.feedVideos[allFeed.id].videos[0].playback_progress).toBe(75);
  });

  it('refills loaded unplayed boundary page to avoid skipping shifted item without resetting feed state', async () => {
    const unplayedFeed = mockFeed({ id: 202, filter_play_state: 'unplayed' });
    const pageOne = Array.from({ length: 20 }, (_, idx) => makeVideo(`v-${idx + 1}`));
    const pageTwo = Array.from({ length: 20 }, (_, idx) => makeVideo(`v-${idx + 21}`));
    const refillPageTwo = [...pageTwo, makeVideo('v-41')];

    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [unplayedFeed] } as never);
    mockedApi.fetchFeedVideos
      .mockResolvedValueOnce({ data: { items: pageOne, page: 1, per_page: 20, total: 100, has_more: true } } as never)
      .mockResolvedValueOnce({ data: { items: pageTwo, page: 2, per_page: 20, total: 100, has_more: true } } as never)
      .mockResolvedValueOnce({ data: { items: refillPageTwo, page: 2, per_page: 20, total: 100, has_more: true } } as never);
    mockedApi.markVideoWatched.mockResolvedValueOnce({
      data: { youtube_propagated: true, youtube_session_needed: false },
    } as never);

    const { result, rerender } = renderHook(() => useFeeds());

    await act(async () => {
      await result.current.fetchFeeds();
    });
    await waitFor(() => {
      expect(result.current.feeds).toHaveLength(1);
    });

    await act(async () => {
      await result.current.fetchFeedVideos(unplayedFeed.id, 1);
      await result.current.fetchFeedVideos(unplayedFeed.id, 2);
    });
    await waitFor(() => {
      expect(result.current.feedVideos[unplayedFeed.id].videos).toHaveLength(40);
      expect(result.current.feedVideos[unplayedFeed.id].hasMore).toBe(true);
    });

    rerender();

    await act(async () => {
      await result.current.markWatched('v-10');
    });

    await waitFor(() => {
      expect(mockedApi.fetchFeedVideos).toHaveBeenCalledTimes(3);
    });

    expect(mockedApi.fetchFeedVideos).toHaveBeenNthCalledWith(1, unplayedFeed.id, { page: 1, per_page: 20 });
    expect(mockedApi.fetchFeedVideos).toHaveBeenNthCalledWith(2, unplayedFeed.id, { page: 2, per_page: 20 });
    expect(mockedApi.fetchFeedVideos).toHaveBeenNthCalledWith(3, unplayedFeed.id, { page: 2, per_page: 20 });

    await waitFor(() => {
      const state = result.current.feedVideos[unplayedFeed.id];
      const ids = state.videos.map((v) => v.video_id);

      expect(state.page).toBe(2);
      expect(state.loading).toBe(false);
      expect(ids).not.toContain('v-10');
      expect(ids).toContain('v-41');
      expect(ids[0]).toBe('v-1');
    });
  });

  it('keeps video in non-unplayed feed and sets playback_progress to 100', async () => {
    const allFeed = mockFeed({ id: 303, filter_play_state: null });
    const video = makeVideo('v-keep', 15);

    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [allFeed] } as never);
    mockedApi.fetchFeedVideos.mockResolvedValueOnce({
      data: { items: [video], page: 1, per_page: 20, total: 1, has_more: false },
    } as never);
    mockedApi.markVideoWatched.mockResolvedValueOnce({
      data: { youtube_propagated: true, youtube_session_needed: false },
    } as never);

    const { result } = renderHook(() => useFeeds());

    await act(async () => {
      await result.current.fetchFeeds();
    });
    await waitFor(() => {
      expect(result.current.feeds).toHaveLength(1);
    });

    await act(async () => {
      await result.current.fetchFeedVideos(allFeed.id, 1);
    });
    await waitFor(() => {
      expect(result.current.feedVideos[allFeed.id].videos).toHaveLength(1);
    });

    await act(async () => {
      await result.current.markWatched('v-keep');
    });

    await waitFor(() => {
      const videos = result.current.feedVideos[allFeed.id].videos;
      expect(videos).toHaveLength(1);
      expect(videos[0].video_id).toBe('v-keep');
      expect(videos[0].playback_progress).toBe(100);
    });

    expect(mockedApi.fetchFeedVideos).toHaveBeenCalledTimes(1);
  });
});

describe('useFeeds reorderFeeds', () => {
  const dispatch = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mockedUseAppContext.mockReturnValue({
      dispatch,
      state: {} as never,
    });
  });

  const feedA = mockFeed({ id: 1, name: 'Feed A', sort_order: 0 });
  const feedB = mockFeed({ id: 2, name: 'Feed B', sort_order: 1 });
  const feedC = mockFeed({ id: 3, name: 'Feed C', sort_order: 2 });

  async function renderLoadedFeeds() {
    mockedApi.fetchFeeds.mockResolvedValueOnce({ data: [feedA, feedB, feedC] } as never);
    const view = renderHook(() => useFeeds());

    await act(async () => {
      await view.result.current.fetchFeeds();
    });
    await waitFor(() => {
      expect(view.result.current.feeds.map((feed) => feed.id)).toEqual([1, 2, 3]);
    });
    view.rerender();

    return view;
  }

  it('reorders local feeds optimistically before the API call resolves', async () => {
    const { result } = await renderLoadedFeeds();

    let resolveReorder: () => void = () => {};
    mockedApi.reorderFeeds.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReorder = () => resolve({ data: [] });
      }) as never
    );

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.reorderFeeds([3, 1, 2]);
    });

    // Optimistic: order applied while the request is still in flight.
    expect(result.current.feeds.map((feed) => feed.id)).toEqual([3, 1, 2]);
    expect(result.current.feeds.map((feed) => feed.sort_order)).toEqual([0, 1, 2]);
    expect(mockedApi.reorderFeeds).toHaveBeenCalledWith([3, 1, 2]);

    await act(async () => {
      resolveReorder();
      await pending;
    });

    expect(result.current.feeds.map((feed) => feed.id)).toEqual([3, 1, 2]);
    expect(mockedApi.fetchFeeds).toHaveBeenCalledTimes(1);
  });

  it('keeps loaded feed videos untouched and does not refetch them after a reorder', async () => {
    const { result } = await renderLoadedFeeds();

    mockedApi.fetchFeedVideos.mockResolvedValueOnce({
      data: { items: [makeVideo('v-1')], page: 1, per_page: 20, total: 1, has_more: false },
    } as never);

    await act(async () => {
      await result.current.fetchFeedVideos(feedA.id, 1);
    });
    await waitFor(() => {
      expect(result.current.feedVideos[feedA.id].videos).toHaveLength(1);
    });

    const videosBefore = result.current.feedVideos;
    const fetchVideoCallsBefore = mockedApi.fetchFeedVideos.mock.calls.length;
    mockedApi.reorderFeeds.mockResolvedValueOnce({ data: [] } as never);

    await act(async () => {
      await result.current.reorderFeeds([2, 3, 1]);
    });

    expect(result.current.feeds.map((feed) => feed.id)).toEqual([2, 3, 1]);
    expect(result.current.feedVideos).toBe(videosBefore);
    expect(result.current.feedVideos[feedA.id].videos.map((video) => video.video_id)).toEqual(['v-1']);
    expect(mockedApi.fetchFeedVideos).toHaveBeenCalledTimes(fetchVideoCallsBefore);
  });

  it('skips the optimistic update when the id set is missing a feed', async () => {
    const { result } = await renderLoadedFeeds();
    mockedApi.reorderFeeds.mockResolvedValueOnce({ data: [] } as never);

    await act(async () => {
      await result.current.reorderFeeds([3, 1]);
    });

    expect(result.current.feeds.map((feed) => feed.id)).toEqual([1, 2, 3]);
    expect(result.current.feeds.map((feed) => feed.sort_order)).toEqual([0, 1, 2]);
    expect(mockedApi.reorderFeeds).toHaveBeenCalledWith([3, 1]);
  });

  it('skips the optimistic update when the id list contains a duplicated feed id', async () => {
    const { result } = await renderLoadedFeeds();
    mockedApi.reorderFeeds.mockResolvedValueOnce({ data: [] } as never);

    await act(async () => {
      await result.current.reorderFeeds([1, 1, 2, 3]);
    });

    expect(result.current.feeds.map((feed) => feed.id)).toEqual([1, 2, 3]);
    expect(result.current.feeds.map((feed) => feed.sort_order)).toEqual([0, 1, 2]);
    expect(mockedApi.reorderFeeds).toHaveBeenCalledWith([1, 1, 2, 3]);
  });

  it('skips the optimistic update when the id set contains an unknown feed id', async () => {
    const { result } = await renderLoadedFeeds();
    mockedApi.reorderFeeds.mockResolvedValueOnce({ data: [] } as never);

    await act(async () => {
      await result.current.reorderFeeds([3, 1, 999]);
    });

    expect(result.current.feeds.map((feed) => feed.id)).toEqual([1, 2, 3]);
    expect(mockedApi.reorderFeeds).toHaveBeenCalledWith([3, 1, 999]);
  });

  it('shows an error toast and recovers from the server when the reorder request fails', async () => {
    const { result } = await renderLoadedFeeds();

    mockedApi.reorderFeeds.mockRejectedValueOnce(new Error('boom'));
    // Server order differs from both the pre-drag snapshot and the optimistic order,
    // so recovery must come from fetchFeeds rather than a restored local snapshot.
    mockedApi.fetchFeeds.mockResolvedValueOnce({
      data: [
        { ...feedB, sort_order: 0 },
        { ...feedC, sort_order: 1 },
        { ...feedA, sort_order: 2 },
      ],
    } as never);

    await act(async () => {
      await result.current.reorderFeeds([3, 1, 2]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SHOW_TOAST',
      message: 'Failed to reorder feeds',
      toastType: 'error',
    });
    expect(mockedApi.fetchFeeds).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(result.current.feeds.map((feed) => feed.id)).toEqual([2, 3, 1]);
    });
  });
});