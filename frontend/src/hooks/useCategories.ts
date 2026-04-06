import { useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../api/client';

export function useCategories() {
  const { state, dispatch } = useAppContext();

  const fetchCategories = useCallback(async () => {
    try {
      const res = await api.fetchCategories();
      dispatch({
        type: 'SET_CATEGORIES',
        categories: res.data.categories,
        totalCount: res.data.total_count,
        uncategorizedCount: res.data.uncategorized_count,
      });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to load categories', toastType: 'error' });
    }
  }, [dispatch]);

  const createCategory = useCallback(async (data: { name: string; description?: string; parent_id?: number | null }) => {
    try {
      await api.createCategory(data);
      await fetchCategories();
      dispatch({ type: 'SHOW_TOAST', message: `Category "${data.name}" created`, toastType: 'success' });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to create category', toastType: 'error' });
    }
  }, [dispatch, fetchCategories]);

  const updateCategory = useCallback(async (id: number, data: Partial<{ name: string; description: string | null; parent_id: number | null }>) => {
    try {
      await api.updateCategory(id, data);
      await fetchCategories();
      dispatch({ type: 'SHOW_TOAST', message: 'Category updated', toastType: 'success' });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to update category', toastType: 'error' });
    }
  }, [dispatch, fetchCategories]);

  const deleteCategory = useCallback(async (id: number) => {
    try {
      await api.deleteCategory(id);
      await fetchCategories();
      dispatch({ type: 'SHOW_TOAST', message: 'Category deleted', toastType: 'success' });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to delete category', toastType: 'error' });
    }
  }, [dispatch, fetchCategories]);

  const reorderCategories = useCallback(async (parentId: number | null, orderedIds: number[]) => {
    try {
      await api.reorderCategories(parentId, orderedIds);
      await fetchCategories();
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to reorder categories', toastType: 'error' });
    }
  }, [dispatch, fetchCategories]);

  const exportCategories = useCallback(async () => {
    try {
      const res = await api.exportCategories();
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '_');
      a.download = `categories_export_${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to export categories', toastType: 'error' });
    }
  }, [dispatch]);

  const importCategories = useCallback(async (file: File) => {
    try {
      dispatch({ type: 'SET_LOADING', loading: true });
      const res = await api.importCategories(file);
      await fetchCategories();
      const msg = res.data?.message || 'Import complete';
      dispatch({ type: 'SHOW_TOAST', message: msg, toastType: 'success' });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: 'Failed to import categories', toastType: 'error' });
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  }, [dispatch, fetchCategories]);

  const selectCategory = useCallback((id: number | null) => {
    dispatch({ type: 'SELECT_CATEGORY', id });
  }, [dispatch]);

  return {
    categories: state.categories,
    totalCount: state.totalCount,
    uncategorizedCount: state.uncategorizedCount,
    selectedCategoryId: state.selectedCategoryId,
    fetchCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    exportCategories,
    importCategories,
    selectCategory,
  };
}
