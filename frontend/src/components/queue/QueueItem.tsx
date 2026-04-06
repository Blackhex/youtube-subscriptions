import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DragIndicator, Close } from '@mui/icons-material';
import type { QueueItem as QueueItemType } from '../../types';
import { formatDuration } from '../feeds/VideoItem';

interface QueueItemProps {
  queueItem: QueueItemType;
  onRemove: () => void;
}

const QueueItem = React.memo(function QueueItem({ queueItem, onRemove }: QueueItemProps) {
  const { video } = queueItem;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: queueItem.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="queue-item">
      <span className="drag-handle" {...listeners}>
        <DragIndicator style={{ fontSize: '1rem' }} />
      </span>
      <div className="video-thumbnail" style={{ width: 80, height: 45, flexShrink: 0 }}>
        {video.thumbnail_url ? (
          <img src={video.thumbnail_url} alt={video.title} loading="lazy" />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#e0e0e0' }} />
        )}
        {video.duration_seconds != null && video.duration_seconds > 0 && (
          <span className="duration-badge" style={{ fontSize: '0.6rem' }}>
            {formatDuration(video.duration_seconds)}
          </span>
        )}
      </div>
      <div className="video-info" style={{ flex: 1, minWidth: 0 }}>
        <p className="video-title" style={{ fontSize: '0.8rem', WebkitLineClamp: 2 }}>{video.title}</p>
        {video.channel_title && (
          <div className="video-channel" style={{ fontSize: '0.7rem' }}>{video.channel_title}</div>
        )}
      </div>
      <button
        className="btn-action btn-action-danger"
        title="Remove from queue"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >
        <Close style={{ fontSize: '0.9rem' }} />
      </button>
    </div>
  );
});

export default QueueItem;
