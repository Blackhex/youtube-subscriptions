import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useCategories } from '../../hooks/useCategories';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useConfirm } from '../../hooks/useConfirm';
import CategoryTree from './CategoryTree';
import SubscriptionList from './SubscriptionList';
import ChannelVideosColumn from './ChannelVideosColumn';
import CategoryModal from './CategoryModal';
import type { Category } from '../../types';

const SIDEBAR_KEY = 'categoriesSidebarWidth';
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 120;

interface SubscriptionsSectionProps {
  showCategoryModal: boolean;
  editingCategory: Category | null;
  onEditCategory: (category: Category) => void;
  onCloseCategoryModal: () => void;
  confirm: ReturnType<typeof useConfirm>['confirm'];
}

export default function SubscriptionsSection({
  showCategoryModal,
  editingCategory,
  onEditCategory,
  onCloseCategoryModal,
  confirm,
}: SubscriptionsSectionProps) {
  const {
    categories,
    totalCount,
    uncategorizedCount,
    selectedCategoryId,
    fetchCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    moveCategory,
    selectCategory,
  } = useCategories();

  const {
    subscriptions,
    assignToCategory,
    unassignFromCategory,
    refetchCurrentPage,
  } = useSubscriptions();

  const { state } = useAppContext();

  // Active channel videos
  const [activeChannel, setActiveChannel] = useState<{id: string; title: string} | null>(null);

  const handleShowVideos = useCallback((channelId: string, channelTitle: string) => {
    setActiveChannel({ id: channelId, title: channelTitle });
  }, []);

  // Sidebar resize
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const [resizing, setResizing] = useState(false);
  const isResizing = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCategories();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseDown = useCallback(() => {
    isResizing.current = true;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const maxWidth = containerRect.width * 0.5;
      const newWidth = Math.max(MIN_WIDTH, Math.min(e.clientX - containerRect.left, maxWidth));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // Persist
      const el = document.querySelector('.category-sidebar') as HTMLElement | null;
      if (el) {
        localStorage.setItem(SIDEBAR_KEY, String(Math.round(parseFloat(el.style.width))));
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Save sidebar width on change
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  const handleEditCategory = useCallback((category: Category) => {
    onEditCategory(category);
  }, [onEditCategory]);

  const handleDeleteCategory = useCallback(async (category: Category) => {
    const ok = await confirm({
      title: 'Delete Category',
      message: `Delete "${category.name}" and all its subcategories?`,
    });
    if (ok) {
      await deleteCategory(category.id);
    }
  }, [confirm, deleteCategory]);

  const handleSaveCategory = useCallback(async (data: { name: string; description?: string; parent_id: number | null }) => {
    if (editingCategory) {
      await updateCategory(editingCategory.id, data);
    } else {
      await createCategory(data);
    }
    onCloseCategoryModal();
  }, [editingCategory, updateCategory, createCategory, onCloseCategoryModal]);

  return (
    <div ref={containerRef} className="d-flex flex-fill" style={{ minHeight: 0 }}>
      <div className="category-sidebar" style={{ width: `${sidebarWidth}px` }}>
        <CategoryTree
          categories={categories}
          suggestedCategoryIds={state.suggestedCategoryIds}
          selectedSubscriptionIds={state.selectedSubscriptionIds}
          subscriptions={subscriptions}
          onSelectCategory={selectCategory}
          onReorderCategories={reorderCategories}
          onMoveCategory={moveCategory}
          onEditCategory={handleEditCategory}
          onDeleteCategory={handleDeleteCategory}
          onAssign={assignToCategory}
          onUnassign={unassignFromCategory}
          onRefreshCategories={fetchCategories}
          onRefreshSubscriptions={refetchCurrentPage}
          totalCount={totalCount}
          uncategorizedCount={uncategorizedCount}
          selectedCategoryId={selectedCategoryId}
        />
      </div>

      <div
        className={`sidebar-resizer${resizing ? ' active' : ''}`}
        onMouseDown={handleMouseDown}
      />

      <SubscriptionList confirm={confirm} activeChannelId={activeChannel?.id ?? null} onShowVideos={handleShowVideos} />

      {activeChannel && (
        <ChannelVideosColumn
          channelId={activeChannel.id}
          channelTitle={activeChannel.title}
          onClose={() => setActiveChannel(null)}
        />
      )}

      {showCategoryModal && (
        <CategoryModal
          category={editingCategory || undefined}
          allCategories={categories}
          onSave={handleSaveCategory}
          onClose={onCloseCategoryModal}
        />
      )}
    </div>
  );
}
