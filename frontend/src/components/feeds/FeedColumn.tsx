import { useCallback, useMemo } from 'react';
import { Edit } from '@mui/icons-material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  onMarkWatched: (videoId: string) => void;
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
  onMarkWatched,
}: FeedColumnProps) {
  const fetchMore = useCallback(() => {
    onLoadMore();
  }, [onLoadMore]);

  const sentinelRef = useInfiniteScroll(fetchMore, hasMore, loading);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: feed.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: isDragging ? ('relative' as const) : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  const videoActions = useMemo(
    () => ({ onAddToQueue, onAddToPlaylist, onMarkWatched }),
    [onAddToQueue, onAddToPlaylist, onMarkWatched]
  );

  return (
    <div ref={setNodeRef} style={style} className={`column${isDragging ? ' is-drag-source' : ''}`}>
      <div className="column-header">
        <h3 title={feed.name}>
          <span
            className="feed-title-handle"
            {...attributes}
            {...listeners}
          >
            {feed.name}
          </span>
        </h3>
        <button className="btn-action" title="Edit feed" onClick={onEdit}>
          <Edit style={{ fontSize: '1rem' }} />
        </button>
      </div>
      <FilterTags feed={feed} categories={categories} />
      <div className="column-body">
        {videos.map((video) => (
          <VideoItem key={video.id} video={video} actions={videoActions} />
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
