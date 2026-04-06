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
} from '@dnd-kit/sortable';
import { PlaylistAdd, Cast } from '@mui/icons-material';
import type { QueueItem as QueueItemType } from '../../types';
import QueueItemComponent from './QueueItem';

interface QueueColumnProps {
  queueItems: QueueItemType[];
  onRemove: (queueItemId: number) => void;
  onReorder: (ids: number[]) => void;
  onCreatePlaylist: () => void;
  onCast: () => void;
  castAvailable: boolean;
}

export default function QueueColumn({
  queueItems,
  onRemove,
  onReorder,
  onCreatePlaylist,
  onCast,
  castAvailable,
}: QueueColumnProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = queueItems.findIndex((item) => item.id === active.id);
    const newIndex = queueItems.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newItems = [...queueItems];
    const [moved] = newItems.splice(oldIndex, 1);
    newItems.splice(newIndex, 0, moved);
    onReorder(newItems.map((item) => item.id));
  }, [queueItems, onReorder]);

  return (
    <div className="column">
      <div className="column-header">
        <h3>Queue</h3>
        <div className="d-flex gap-1">
          <button
            className="btn-action"
            title="Create YouTube playlist from queue"
            onClick={onCreatePlaylist}
            disabled={queueItems.length === 0}
          >
            <PlaylistAdd style={{ fontSize: '1.1rem' }} />
          </button>
          {castAvailable && (
            <button
              className="btn-action"
              title="Cast queue to device"
              onClick={onCast}
              disabled={queueItems.length === 0}
            >
              <Cast style={{ fontSize: '1rem' }} />
            </button>
          )}
        </div>
      </div>
      <div className="column-body">
        {queueItems.length === 0 ? (
          <div className="empty-state">
            <p>Queue is empty</p>
            <p style={{ fontSize: '0.75rem' }}>Add videos from feeds</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={queueItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              {queueItems.map((item) => (
                <QueueItemComponent
                  key={item.id}
                  queueItem={item}
                  onRemove={() => onRemove(item.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
