import { useCallback, useEffect, useRef } from 'react';
import {
  DragIndicator,
  Folder,
  ExpandMore,
  ExpandLess,
  Edit,
  Delete,
} from '@mui/icons-material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Category } from '../../types';

interface CategoryNodeProps {
  category: Category;
  depth: number;
  selectedCategoryId: number | null;
  selectedSubscriptionIds: number[];
  suggestedCategoryIds: number[];
  expandedIds: Set<number>;
  subscriptionCategoryIds: Set<number>;
  onSelect: (id: number) => void;
  onToggleExpand: (id: number) => void;
  onEdit: (category: Category) => void;
  onDelete: (category: Category) => void;
  onAssign: (catId: number) => void;
  onUnassign: (catId: number) => void;
}

export default function CategoryNode({
  category,
  depth,
  selectedCategoryId,
  selectedSubscriptionIds,
  suggestedCategoryIds,
  expandedIds,
  subscriptionCategoryIds,
  onSelect,
  onToggleExpand,
  onEdit,
  onDelete,
  onAssign,
  onUnassign,
}: CategoryNodeProps) {
  const isSelectionMode = selectedSubscriptionIds.length > 0;
  const isActive = selectedCategoryId === category.id;
  const isExpanded = expandedIds.has(category.id);
  const isSuggested = suggestedCategoryIds.includes(category.id);
  const hasChildren = category.children.length > 0;

  const checkboxRef = useRef<HTMLInputElement>(null);

  // Determine checkbox state for assignment mode
  const isAssigned = subscriptionCategoryIds.has(category.id);

  useEffect(() => {
    if (checkboxRef.current && isSelectionMode) {
      // We use a simple on/off: assigned means all selected subs have this category
      checkboxRef.current.indeterminate = false;
    }
  }, [isSelectionMode, isAssigned]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: category.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleCheckboxChange = useCallback(() => {
    if (isAssigned) {
      onUnassign(category.id);
    } else {
      onAssign(category.id);
    }
  }, [isAssigned, category.id, onAssign, onUnassign]);

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`category-node${isActive ? ' active' : ''}${isDragging ? ' dragging' : ''}${isSuggested ? ' suggested-category' : ''}`}
        onClick={() => !isSelectionMode && onSelect(category.id)}
      >
        <span className="drag-handle" {...attributes} {...listeners}>
          <DragIndicator sx={{ fontSize: '0.85rem' }} />
        </span>

        {isSelectionMode ? (
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={isAssigned}
            onChange={handleCheckboxChange}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          hasChildren ? (
            <button
              className="btn-action btn-action-sm"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(category.id);
              }}
            >
              {isExpanded ? (
                <ExpandLess sx={{ fontSize: '0.85rem' }} />
              ) : (
                <ExpandMore sx={{ fontSize: '0.85rem' }} />
              )}
            </button>
          ) : (
            <Folder sx={{ fontSize: '0.85rem', color: 'var(--md-text-meta)', marginRight: '2px' }} />
          )
        )}

        <span className="category-name">{category.name}</span>
        {isSuggested && <span className="suggested-badge">Suggested</span>}
        <span className="category-count">{category.subscription_count}</span>

        <button
          className="btn-action btn-action-sm btn-action-reveal"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(category);
          }}
        >
          <Edit sx={{ fontSize: '0.8rem' }} />
        </button>
        <button
          className="btn-action btn-action-sm btn-action-reveal btn-action-danger"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(category);
          }}
        >
          <Delete sx={{ fontSize: '0.8rem' }} />
        </button>
      </div>

      {hasChildren && (
        <div className={`category-children${!isExpanded ? ' collapsed' : ''}`}>
          {category.children.map((child) => (
            <CategoryNode
              key={child.id}
              category={child}
              depth={depth + 1}
              selectedCategoryId={selectedCategoryId}
              selectedSubscriptionIds={selectedSubscriptionIds}
              suggestedCategoryIds={suggestedCategoryIds}
              expandedIds={expandedIds}
              subscriptionCategoryIds={subscriptionCategoryIds}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onEdit={onEdit}
              onDelete={onDelete}
              onAssign={onAssign}
              onUnassign={onUnassign}
            />
          ))}
        </div>
      )}
    </>
  );
}
