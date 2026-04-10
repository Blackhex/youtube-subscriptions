import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { NoteAdd } from '@mui/icons-material';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, Announcements, UniqueIdentifier } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import type { Feed, Video } from '../../types';
import { useFeeds } from '../../hooks/useFeeds';
import { useQueue } from '../../hooks/useQueue';
import { useCast } from '../../hooks/useCast';
import { useCategories } from '../../hooks/useCategories';
import FeedColumn from './FeedColumn';
import FeedModal from './FeedModal';
import AddToPlaylistModal from './AddToPlaylistModal';
import QueueColumn from '../queue/QueueColumn';
import { useAppContext } from '../../context/AppContext';

interface FeedsSectionProps {
  showFeedModal: boolean;
  editingFeed: Feed | null;
  onCloseFeedModal: () => void;
  onOpenFeedModal: (feed?: Feed) => void;
}

export default function FeedsSection({
  showFeedModal,
  editingFeed,
  onCloseFeedModal,
  onOpenFeedModal,
}: FeedsSectionProps) {
  const {
    feeds,
    feedVideos,
    fetchFeeds,
    createFeed,
    updateFeed,
    deleteFeed,
    reorderFeeds,
    fetchFeedVideos,
    loadMoreVideos,
    markWatched,
  } = useFeeds();
  const {
    queueItems,
    fetchQueue,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    createPlaylist,
  } = useQueue();
  const {
    castAvailable,
    requestCastSession,
    castQueue,
    startProgressPolling,
  } = useCast();
  const { categories, fetchCategories } = useCategories();
  const { state } = useAppContext();

  const [addToPlaylistVideo, setAddToPlaylistVideo] = useState<Video | null>(null);
  const prevSyncRunningRef = useRef(state.syncState.running);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = feeds.findIndex((feed) => feed.id === active.id);
    const newIndex = feeds.findIndex((feed) => feed.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newFeeds = [...feeds];
    const [moved] = newFeeds.splice(oldIndex, 1);
    newFeeds.splice(newIndex, 0, moved);
    reorderFeeds(newFeeds.map((feed) => feed.id));
  }, [feeds, reorderFeeds]);

  const announcements = useMemo<Announcements>(() => {
    const describe = (id: UniqueIdentifier | undefined) => {
      if (id === undefined) return null;
      const index = feeds.findIndex((feed) => feed.id === id);
      if (index === -1) return null;
      return { name: feeds[index].name, position: index + 1, total: feeds.length };
    };

    return {
      onDragStart({ active }) {
        const feed = describe(active.id);
        if (!feed) return undefined;
        return `Picked up feed ${feed.name}, position ${feed.position} of ${feed.total}.`;
      },
      onDragOver({ active, over }) {
        const feed = describe(active.id);
        const target = describe(over?.id);
        if (!feed || !target) return undefined;
        return `Feed ${feed.name} moved to position ${target.position} of ${target.total}.`;
      },
      onDragEnd({ active, over }) {
        const feed = describe(active.id);
        const target = describe(over?.id) ?? feed;
        if (!feed || !target) return undefined;
        return `Feed ${feed.name} dropped at position ${target.position} of ${target.total}.`;
      },
      onDragCancel({ active }) {
        const feed = describe(active.id);
        if (!feed) return undefined;
        return `Reordering cancelled. Feed ${feed.name} returned to position ${feed.position} of ${feed.total}.`;
      },
    };
  }, [feeds]);

  useEffect(() => {
    fetchFeeds();
    fetchQueue();
    fetchCategories();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch videos for each feed once feeds are loaded
  useEffect(() => {
    for (const feed of feeds) {
      if (!feedVideos[feed.id]) {
        fetchFeedVideos(feed.id, 1);
      }
    }
  }, [feeds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh all feed videos after sync completes
  useEffect(() => {
    if (prevSyncRunningRef.current && !state.syncState.running) {
      // Sync just finished — refresh all feeds
      for (const feed of feeds) {
        fetchFeedVideos(feed.id, 1);
      }
      fetchQueue();
    }
    prevSyncRunningRef.current = state.syncState.running;
  }, [state.syncState.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveFeed = useCallback(async (data: Partial<Feed>) => {
    if (editingFeed) {
      await updateFeed(editingFeed.id, data);
      // Refresh videos for updated feed
      fetchFeedVideos(editingFeed.id, 1);
    } else {
      await createFeed(data);
    }
    onCloseFeedModal();
  }, [editingFeed, updateFeed, createFeed, fetchFeedVideos, onCloseFeedModal]);

  const handleDeleteFeed = useCallback(async () => {
    if (editingFeed) {
      await deleteFeed(editingFeed.id);
      onCloseFeedModal();
    }
  }, [editingFeed, deleteFeed, onCloseFeedModal]);

  const handleCast = useCallback(async () => {
    let screenId = null;
    screenId = await requestCastSession();
    if (screenId) {
      await castQueue(screenId);
      startProgressPolling();
    }
  }, [requestCastSession, castQueue, startProgressPolling]);

  return (
    <div className="scrollable-x">
      <QueueColumn
        queueItems={queueItems}
        onRemove={removeFromQueue}
        onReorder={reorderQueue}
        onCreatePlaylist={createPlaylist}
        onCast={handleCast}
        castAvailable={castAvailable}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements }}
      >
        <SortableContext items={feeds.map((feed) => feed.id)} strategy={horizontalListSortingStrategy}>
          {feeds.map((feed) => {
            const vs = feedVideos[feed.id];
            return (
              <FeedColumn
                key={feed.id}
                feed={feed}
                videos={vs?.videos ?? []}
                hasMore={vs?.hasMore ?? true}
                loading={vs?.loading ?? false}
                categories={categories}
                onLoadMore={() => loadMoreVideos(feed.id)}
                onEdit={() => onOpenFeedModal(feed)}
                onAddToQueue={addToQueue}
                onAddToPlaylist={(video) => setAddToPlaylistVideo(video)}
                onMarkWatched={markWatched}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {feeds.length === 0 && (
        <div className="empty-state flex-fill">
          <p>No feeds configured</p>
          <button className="btn btn-primary btn-sm mt-2" onClick={() => onOpenFeedModal()}>
            <NoteAdd style={{ fontSize: '1rem', marginRight: 4 }} />
            New Feed
          </button>
        </div>
      )}
      {showFeedModal && (
        <FeedModal
          feed={editingFeed ?? undefined}
          categories={categories}
          onSave={handleSaveFeed}
          onDelete={editingFeed ? handleDeleteFeed : undefined}
          onClose={onCloseFeedModal}
        />
      )}
      {addToPlaylistVideo && (
        <AddToPlaylistModal
          video={addToPlaylistVideo}
          onClose={() => setAddToPlaylistVideo(null)}
        />
      )}
    </div>
  );
}
