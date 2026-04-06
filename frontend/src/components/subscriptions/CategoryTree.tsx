import { useCallback, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Description } from '@mui/icons-material';
import { useAppContext } from '../../context/AppContext';
import CategoryNode from './CategoryNode';
import type { Category } from '../../types';

interface CategoryTreeProps {
  categories: Category[];
  suggestedCategoryIds: number[];
  selectedSubscriptionIds: number[];
  subscriptions: { id: number; categories: { id: number; name: string }[] }[];
  onSelectCategory: (id: number | null) => void;
  onReorderCategories: (parentId: number | null, orderedIds: number[]) => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onAssign: (subIds: number[], catId: number) => Promise<void>;
  onUnassign: (subIds: number[], catId: number) => Promise<void>;
  onRefreshCategories: () => void;
  onRefreshSubscriptions: () => void;
  totalCount: number;
  uncategorizedCount: number;
  selectedCategoryId: number | null;
}

export default function CategoryTree({
  categories,
  suggestedCategoryIds,
  selectedSubscriptionIds,
  subscriptions,
  onSelectCategory,
  onReorderCategories,
  onEditCategory,
  onDeleteCategory,
  onAssign,
  onUnassign,
  onRefreshCategories,
  onRefreshSubscriptions,
  totalCount,
  uncategorizedCount,
  selectedCategoryId,
}: CategoryTreeProps) {
  const { dispatch } = useAppContext();
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Build a set of category IDs that ALL selected subscriptions belong to
  const subscriptionCategoryIds = useMemo(() => {
    if (selectedSubscriptionIds.length === 0) return new Set<number>();
    const selectedSubs = subscriptions.filter((s) =>
      selectedSubscriptionIds.includes(s.id)
    );
    if (selectedSubs.length === 0) return new Set<number>();

    // Get category IDs that every selected subscription has
    const catSets = selectedSubs.map(
      (s) => new Set(s.categories.map((c) => c.id))
    );
    const intersection = new Set<number>();
    for (const catId of catSets[0]) {
      if (catSets.every((set) => set.has(catId))) {
        intersection.add(catId);
      }
    }
    return intersection;
  }, [selectedSubscriptionIds, subscriptions]);

  const handleAssign = useCallback(async (catId: number) => {
    await onAssign(selectedSubscriptionIds, catId);
    await onRefreshCategories();
    await onRefreshSubscriptions();
  }, [selectedSubscriptionIds, onAssign, onRefreshCategories, onRefreshSubscriptions]);

  const handleUnassign = useCallback(async (catId: number) => {
    await onUnassign(selectedSubscriptionIds, catId);
    await onRefreshCategories();
    await onRefreshSubscriptions();
  }, [selectedSubscriptionIds, onUnassign, onRefreshCategories, onRefreshSubscriptions]);

  const topLevelIds = useMemo(() => categories.map((c) => c.id), [categories]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = topLevelIds.indexOf(active.id as number);
    const newIndex = topLevelIds.indexOf(over.id as number);
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = [...topLevelIds];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, active.id as number);
    onReorderCategories(null, newOrder);
  }, [topLevelIds, onReorderCategories]);

  const isSelectionMode = selectedSubscriptionIds.length > 0;

  return (
    <>
      {/* Special filters */}
      <div
        className={`special-filter${selectedCategoryId === null ? ' active' : ''}`}
        onClick={() => onSelectCategory(null)}
      >
        <Description sx={{ fontSize: '0.9rem' }} />
        <span>All</span>
        <span className="special-count">{totalCount}</span>
      </div>
      <div
        className={`special-filter${selectedCategoryId === -1 ? ' active' : ''}`}
        onClick={() => onSelectCategory(-1)}
      >
        <Description sx={{ fontSize: '0.9rem' }} />
        <span>Uncategorized</span>
        <span className="special-count">{uncategorizedCount}</span>
      </div>

      {isSelectionMode && (
        <div className="selection-banner">
          {selectedSubscriptionIds.length} subscription{selectedSubscriptionIds.length !== 1 ? 's' : ''} selected — Check categories to assign
          <button
            className="btn btn-sm btn-link p-0 ms-2"
            onClick={() => dispatch({ type: 'CLEAR_SELECTION' })}
          >
            Clear
          </button>
        </div>
      )}

      {/* Category tree with drag and drop */}
      <div className="category-tree">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={topLevelIds} strategy={verticalListSortingStrategy}>
            {categories.map((cat) => (
              <CategoryNode
                key={cat.id}
                category={cat}
                depth={0}
                selectedCategoryId={selectedCategoryId}
                selectedSubscriptionIds={selectedSubscriptionIds}
                suggestedCategoryIds={suggestedCategoryIds}
                expandedIds={expandedIds}
                subscriptionCategoryIds={subscriptionCategoryIds}
                onSelect={(id) => onSelectCategory(id)}
                onToggleExpand={toggleExpand}
                onEdit={onEditCategory}
                onDelete={onDeleteCategory}
                onAssign={handleAssign}
                onUnassign={handleUnassign}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </>
  );
}
