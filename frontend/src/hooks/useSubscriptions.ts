import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../api/client';
import type { Subscription } from '../types';

export function useSubscriptions() {
  const { state, dispatch } = useAppContext();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchSubscriptions = useCallback(async (pageNum = 1, append = false) => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page: pageNum, per_page: 50 };
      if (state.selectedCategoryId !== null) {
        if (state.selectedCategoryId === -1) {
          params.uncategorized = 'true';
        } else {
          params.category_id = state.selectedCategoryId;
        }
      }
      const res = await api.fetchSubscriptions(params as Parameters<typeof api.fetchSubscriptions>[0]);
      if (append) {
        setSubscriptions((prev) => [...prev, ...res.data.items]);
      } else {
        setSubscriptions(res.data.items);
      }
      setTotal(res.data.total);
      setHasMore(res.data.has_more);
      setPage(pageNum);
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load subscriptions', toastType: 'error' });
    } finally {
      setLoading(false);
    }
  }, [state.selectedCategoryId, dispatch]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore && !searchQuery) {
      fetchSubscriptions(page + 1, true);
    }
  }, [loading, hasMore, page, searchQuery, fetchSubscriptions]);

  // Reset when category changes
  useEffect(() => {
    setPage(1);
    setSubscriptions([]);
    setSearchQuery('');
    fetchSubscriptions(1, false);
  }, [state.selectedCategoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelection = useCallback((id: number) => {
    dispatch({ type: 'TOGGLE_SELECTION', id });
  }, [dispatch]);

  const clearSelection = useCallback(() => {
    dispatch({ type: 'CLEAR_SELECTION' });
  }, [dispatch]);

  const assignToCategory = useCallback(async (subIds: number[], catId: number) => {
    try {
      await Promise.all(subIds.map((subId) => api.assignSubscription(subId, catId)));
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to assign subscriptions', toastType: 'error' });
    }
  }, [dispatch]);

  const unassignFromCategory = useCallback(async (subIds: number[], catId: number) => {
    try {
      await Promise.all(subIds.map((subId) => api.unassignSubscription(subId, catId)));
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to unassign subscriptions', toastType: 'error' });
    }
  }, [dispatch]);

  const deleteSubscription = useCallback(async (id: number) => {
    try {
      await api.deleteSubscription(id);
      setSubscriptions((prev) => prev.filter((s) => s.id !== id));
      setTotal((prev) => prev - 1);
      dispatch({ type: 'SHOW_TOAST', message: 'Subscription deleted', toastType: 'success' });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to delete subscription', toastType: 'error' });
    }
  }, [dispatch]);

  const fetchSuggestions = useCallback(async (subId: number) => {
    try {
      const res = await api.fetchSuggestions(subId);
      dispatch({ type: 'SET_SUGGESTED_CATEGORIES', ids: res.data.suggested_category_ids });
    } catch {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to get AI suggestions', toastType: 'error' });
    }
  }, [dispatch]);

  const filteredSubscriptions = useMemo(() => {
    if (!searchQuery.trim()) return subscriptions;
    const q = searchQuery.toLowerCase();
    return subscriptions.filter(
      (s) =>
        s.channel_title.toLowerCase().includes(q) ||
        (s.channel_description && s.channel_description.toLowerCase().includes(q))
    );
  }, [subscriptions, searchQuery]);

  const refetchCurrentPage = useCallback(async () => {
    // Refetch all loaded pages to update assignment data
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page: 1, per_page: 50 * page };
      if (state.selectedCategoryId !== null) {
        if (state.selectedCategoryId === -1) {
          params.uncategorized = 'true';
        } else {
          params.category_id = state.selectedCategoryId;
        }
      }
      const res = await api.fetchSubscriptions(params as Parameters<typeof api.fetchSubscriptions>[0]);
      setSubscriptions(res.data.items);
      setTotal(res.data.total);
      setHasMore(res.data.has_more);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [page, state.selectedCategoryId]);

  return {
    subscriptions,
    filteredSubscriptions,
    total,
    hasMore,
    loading,
    searchQuery,
    setSearchQuery,
    fetchSubscriptions,
    loadMore,
    toggleSelection,
    clearSelection,
    assignToCategory,
    unassignFromCategory,
    deleteSubscription,
    fetchSuggestions,
    refetchCurrentPage,
  };
}
