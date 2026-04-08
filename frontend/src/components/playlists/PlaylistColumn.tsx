import { useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Cast, Delete } from '@mui/icons-material';
import type { Playlist, Video } from '../../types';
import VideoItem from '../feeds/VideoItem';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';

interface PlaylistColumnProps {
  playlist: Playlist;
  items: Video[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onRemoveItem: (playlistId: string, itemId: string) => void;
  onReorder: (playlistId: string, itemIds: string[], videoIds: string[], reorderedItems: Video[]) => void;
  onDelete: (playlistId: string) => void;
  onCast: (playlistId: string) => void;
  castAvailable: boolean;
  confirm: (opts: { title: string; message: string }) => Promise<boolean>;
}

function SortableVideoItem({
  video,
  onRemove,
}: {
  video: Video;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: video.playlist_item_id ?? video.video_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <VideoItem
        video={video}
        actions={{
          onRemove,
          showDragHandle: true,
        }}
        dragListeners={listeners}
      />
    </div>
  );
}

export default function PlaylistColumn({
  playlist,
  items,
  hasMore,
  loading,
  onLoadMore,
  onRemoveItem,
  onReorder,
  onDelete,
  onCast,
  castAvailable,
  confirm,
}: PlaylistColumnProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sentinelRef = useInfiniteScroll(onLoadMore, hasMore, loading);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex(
      (v) => (v.playlist_item_id ?? v.video_id) === active.id,
    );
    const newIndex = items.findIndex(
      (v) => (v.playlist_item_id ?? v.video_id) === over.id,
    );
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = [...items];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    onReorder(
      playlist.id,
      reordered.map((v) => v.playlist_item_id ?? ''),
      reordered.map((v) => v.video_id),
      reordered,
    );
  }, [items, onReorder, playlist.id]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({
      title: 'Delete Playlist',
      message: `Delete "${playlist.title}"? This cannot be undone.`,
    });
    if (ok) onDelete(playlist.id);
  }, [confirm, onDelete, playlist]);

  const handleCast = useCallback(() => {
    onCast(playlist.id);
  }, [onCast, playlist.id]);

  const sortableIds = items.map((v) => v.playlist_item_id ?? v.video_id);

  return (
    <div className="column">
      <div className="column-header">
        <h3 title={playlist.title}>{playlist.title}</h3>
        <div className="d-flex gap-1">
          {castAvailable && (
            <button
              className="btn-action"
              title="Cast playlist"
              onClick={handleCast}
              disabled={items.length === 0}
            >
              <Cast style={{ fontSize: '1rem' }} />
            </button>
          )}
          <button
            className="btn-action btn-action-danger"
            title="Delete playlist"
            onClick={handleDelete}
          >
            <Delete style={{ fontSize: '1rem' }} />
          </button>
        </div>
      </div>
      <div className="filter-tags">
        <span className="filter-tag">{playlist.item_count} items</span>
        <span className="filter-tag">{playlist.privacy_status}</span>
      </div>
      <div className="column-body">
        {items.length === 0 && !loading ? (
          <div className="empty-state">
            <p>No items</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {items.map((video) => (
                <SortableVideoItem
                  key={video.playlist_item_id ?? video.video_id}
                  video={video}
                  onRemove={() =>
                    onRemoveItem(playlist.id, video.playlist_item_id ?? '')
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
        {loading && <div className="text-center p-2"><span className="spinner-border spinner-border-sm" /></div>}
        <div ref={sentinelRef} />
      </div>
    </div>
  );
}
