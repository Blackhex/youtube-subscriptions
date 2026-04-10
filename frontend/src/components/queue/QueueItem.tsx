import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QueueItem as QueueItemType } from '../../types';
import VideoItem from '../feeds/VideoItem';

interface QueueItemProps {
  queueItem: QueueItemType;
  onRemove: () => void;
}

const QueueItem = React.memo(function QueueItem({ queueItem, onRemove }: QueueItemProps) {
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
      <VideoItem
        video={queueItem.video}
        actions={{ showDragHandle: true, onRemove }}
        dragListeners={listeners}
      />
    </div>
  );
});

export default QueueItem;
