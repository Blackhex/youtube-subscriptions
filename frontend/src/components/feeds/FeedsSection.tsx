import { useEffect, useCallback, useState } from 'react';
import { NoteAdd } from '@mui/icons-material';
import type { Feed, Video } from '../../types';
import { useFeeds } from '../../hooks/useFeeds';
import { useQueue } from '../../hooks/useQueue';
import { useCast } from '../../hooks/useCast';
import { useCategories } from '../../hooks/useCategories';
import FeedColumn from './FeedColumn';
import FeedModal from './FeedModal';
import AddToPlaylistModal from './AddToPlaylistModal';
import QueueColumn from '../queue/QueueColumn';

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
    fetchFeedVideos,
    loadMoreVideos,
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

  const [addToPlaylistVideo, setAddToPlaylistVideo] = useState<Video | null>(null);

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
    <div className="scrollable-x flex-fill">
      <QueueColumn
        queueItems={queueItems}
        onRemove={removeFromQueue}
        onReorder={reorderQueue}
        onCreatePlaylist={createPlaylist}
        onCast={handleCast}
        castAvailable={castAvailable}
      />
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
          />
        );
      })}
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
