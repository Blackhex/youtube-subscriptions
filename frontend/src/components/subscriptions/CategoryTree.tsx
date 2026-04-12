import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Description, DragIndicator, Folder } from '@mui/icons-material';
import { useAppContext } from '../../context/AppContext';
import CategoryNode from './CategoryNode';
import type { Category } from '../../types';

const COLLAPSED_STORAGE_KEY = 'categoryCollapsedIds';

// Collapsed ids are stored rather than expanded ones so untouched and freshly imported
// categories (which get new database ids) default to expanded.
function loadCollapsedIds(): Set<number> {
  try {
    const saved = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!saved) return new Set<number>();
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return new Set<number>();
    return new Set(parsed.filter((id): id is number => typeof id === 'number'));
  } catch {
    return new Set<number>();
  }
}

function buildCategoryMaps(categories: Category[]) {
  const parentMap = new Map<number, number | null>();
  const siblingsMap = new Map<number | null, number[]>();

  function walk(cats: Category[], parentId: number | null) {
    const ids = cats.map(c => c.id);
    siblingsMap.set(parentId, ids);
    for (const cat of cats) {
      parentMap.set(cat.id, parentId);
      if (cat.children.length > 0) {
        walk(cat.children, cat.id);
      }
    }
  }
  walk(categories, null);
  return { parentMap, siblingsMap };
}

interface CategoryTreeProps {
  categories: Category[];
  suggestedCategoryIds: number[];
  selectedSubscriptionIds: number[];
  subscriptions: { id: number; categories: { id: number; name: string }[] }[];
  onSelectCategory: (id: number | null) => void;
  onReorderCategories: (parentId: number | null, orderedIds: number[]) => void;
  onMoveCategory: (categoryId: number, newParentId: number | null, newSiblingOrder: number[]) => Promise<void>;
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
  onMoveCategory,
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
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(loadCollapsedIds);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsedIds]));
  }, [collapsedIds]);

  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    function walk(cats: Category[]) {
      for (const cat of cats) {
        map.set(cat.id, cat);
        if (cat.children.length > 0) walk(cat.children);
      }
    }
    walk(categories);
    return map;
  }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggleExpand = useCallback((id: number) => {
    setCollapsedIds((prev) => {
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

  const topLevelIds = useMemo(() => categories.map(c => c.id), [categories]);

  const { parentMap, siblingsMap } = useMemo(() => buildCategoryMaps(categories), [categories]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const cat = categoryById.get(event.active.id as number);
    setActiveCategory(cat ?? null);
  }, [categoryById]);

  const handleDragCancel = useCallback(() => {
    setActiveCategory(null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveCategory(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as number;
    const overId = over.id as number;
    const activeParent = parentMap.get(activeId) ?? null;
    const overParent = parentMap.get(overId) ?? null;

    if (activeParent === overParent) {
      // Same parent: reorder within siblings
      const siblings = siblingsMap.get(activeParent);
      if (!siblings) return;
      const oldIndex = siblings.indexOf(activeId);
      const newIndex = siblings.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = [...siblings];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeId);
      onReorderCategories(activeParent, newOrder);
    } else {
      // Different parent: re-parent and insert at position
      const targetSiblings = siblingsMap.get(overParent) ?? [];
      const overIndex = targetSiblings.indexOf(overId);
      const newOrder = targetSiblings.filter(id => id !== activeId);
      const insertAt = newOrder.indexOf(overId);
      newOrder.splice(insertAt === -1 ? overIndex : insertAt, 0, activeId);

      // Auto-expand the target parent so the moved item is visible
      if (overParent !== null) {
        setCollapsedIds(prev => {
          const next = new Set(prev);
          next.delete(overParent);
          return next;
        });
      }

      onMoveCategory(activeId, overParent, newOrder);
    }
  }, [parentMap, siblingsMap, onReorderCategories, onMoveCategory]);

  const isSelectionMode = selectedSubscriptionIds.length > 0;

  return (
    <>
      <div className="category-sidebar-header">
        <h3 className="m-0">Categories</h3>
      </div>
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
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
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
                collapsedIds={collapsedIds}
                subscriptionCategoryIds={subscriptionCategoryIds}
                activeId={activeCategory?.id ?? null}
                onSelect={(id) => onSelectCategory(id)}
                onToggleExpand={toggleExpand}
                onEdit={onEditCategory}
                onDelete={onDeleteCategory}
                onAssign={handleAssign}
                onUnassign={handleUnassign}
              />
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeCategory ? (
              <div className="category-node drag-overlay">
                <DragIndicator sx={{ fontSize: '0.85rem' }} />
                <Folder sx={{ fontSize: '0.85rem', color: 'var(--md-text-meta)', marginRight: '2px' }} />
                <span className="category-name">{activeCategory.name}</span>
                <span className="category-count">{activeCategory.subscription_count}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </>
  );
}
