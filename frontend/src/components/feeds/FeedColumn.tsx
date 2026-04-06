import { useCallback } from 'react';
import { Edit } from '@mui/icons-material';
import type { Feed, Video, Category } from '../../types';
import VideoItem from './VideoItem';
import FilterTags from './FilterTags';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';

interface FeedColumnProps {
  feed: Feed;
  videos: Video[];
  hasMore: boolean;
  loading: boolean;
  categories: Category[];
  onLoadMore: () => void;
  onEdit: () => void;
  onAddToQueue: (videoId: string) => void;
  onAddToPlaylist: (video: Video) => void;
}

export default function FeedColumn({
  feed,
  videos,
  hasMore,
  loading,
  categories,
  onLoadMore,
  onEdit,
  onAddToQueue,
  onAddToPlaylist,
}: FeedColumnProps) {
  const fetchMore = useCallback(() => {
    onLoadMore();
  }, [onLoadMore]);

  const sentinelRef = useInfiniteScroll(fetchMore, hasMore, loading);

  return (
    <div className="column">
      <div className="column-header">
        <h3>{feed.name}</h3>
        <button className="btn-action" title="Edit feed" onClick={onEdit}>
          <Edit style={{ fontSize: '1rem' }} />
        </button>
      </div>
      <FilterTags feed={feed} categories={categories} />
      <div className="column-body">
        {videos.map((video) => (
          <VideoItem
            key={video.id}
            video={video}
            actions={{
              onAddToQueue,
              onAddToPlaylist: () => onAddToPlaylist(video),
            }}
          />
        ))}
        {loading && (
          <div className="text-center py-2">
            <div className="spinner-border spinner-border-sm text-secondary" role="status" />
          </div>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
        {!loading && videos.length === 0 && (
          <div className="empty-state">
            <p>No videos match this feed's filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
