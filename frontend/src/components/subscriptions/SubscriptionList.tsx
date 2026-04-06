import { useCallback } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';
import { useConfirm } from '../layout/ConfirmDialog';
import SubscriptionItem from './SubscriptionItem';
import type { Category } from '../../types';

function getCategoryName(categories: Category[], id: number | null): string {
  if (id === null) return 'All Subscriptions';
  if (id === -1) return 'Uncategorized';
  const find = (cats: Category[]): string | null => {
    for (const cat of cats) {
      if (cat.id === id) return cat.name;
      const found = find(cat.children);
      if (found) return found;
    }
    return null;
  };
  return find(categories) || 'Subscriptions';
}

interface SubscriptionListProps {
  confirm: ReturnType<typeof useConfirm>['confirm'];
}

export default function SubscriptionList({ confirm }: SubscriptionListProps) {
  const { state } = useAppContext();
  const {
    filteredSubscriptions,
    total,
    hasMore,
    loading,
    searchQuery,
    setSearchQuery,
    loadMore,
    toggleSelection,
    deleteSubscription,
  } = useSubscriptions();

  const sentinelRef = useInfiniteScroll(loadMore, hasMore && !searchQuery, loading);

  const categoryName = getCategoryName(state.categories, state.selectedCategoryId);

  const handleDelete = useCallback(async (id: number) => {
    const sub = filteredSubscriptions.find((s) => s.id === id);
    const ok = await confirm({
      title: 'Unsubscribe',
      message: `Are you sure you want to unsubscribe from ${sub?.channel_title || 'this channel'}?`,
    });
    if (ok) {
      await deleteSubscription(id);
    }
  }, [confirm, deleteSubscription, filteredSubscriptions]);

  return (
    <div className="subscription-list">
      <div className="subscription-list-header">
        <h3>{categoryName} <span className="text-muted fs-6 fw-normal">({total})</span></h3>
        <input
          type="text"
          className="subscription-search"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="flex-fill scrollable">
        {filteredSubscriptions.map((sub) => (
          <SubscriptionItem
            key={sub.id}
            subscription={sub}
            isSelected={state.selectedSubscriptionIds.includes(sub.id)}
            onToggleSelection={toggleSelection}
            onDelete={handleDelete}
          />
        ))}
        {!loading && filteredSubscriptions.length === 0 && (
          <div className="empty-state">
            <p>{searchQuery ? 'No matching subscriptions' : 'No subscriptions found'}</p>
          </div>
        )}
        <div ref={sentinelRef} />
        {loading && (
          <div className="d-flex justify-content-center p-3">
            <div className="spinner-border spinner-border-sm text-primary" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
