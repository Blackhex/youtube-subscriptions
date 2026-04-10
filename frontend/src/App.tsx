import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from './context/AppContext';
import { AppProvider } from './context/AppProvider';
import Navbar from './components/layout/Navbar';
import Toast from './components/layout/Toast';
import Spinner from './components/layout/Spinner';
import ConfirmDialog from './components/layout/ConfirmDialog';
import { useConfirm } from './hooks/useConfirm';
import SubscriptionsSection from './components/subscriptions/SubscriptionsSection';
import FeedsSection from './components/feeds/FeedsSection';
import PlaylistsSection from './components/playlists/PlaylistsSection';
import { useCategories } from './hooks/useCategories';
import { useSubscriptions } from './hooks/useSubscriptions';
import { useSync } from './hooks/useSync';
import type { Category, Feed } from './types';

function AppContent() {
  const { state } = useAppContext();
  const { dialog, confirm, handleClose } = useConfirm();
  const { fetchCategories, exportCategories, importCategories } = useCategories();
  const { fetchSuggestions } = useSubscriptions();
  const { syncState, startSync } = useSync();
  const prevRunningRef = useRef(syncState.running);

  // After sync completes, refetch categories (and feed videos if new ones were fetched)
  useEffect(() => {
    if (prevRunningRef.current && !syncState.running) {
      fetchCategories();
    }
    prevRunningRef.current = syncState.running;
  }, [syncState.running, fetchCategories]);

  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [showFeedModal, setShowFeedModal] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNewCategory = useCallback(() => {
    setEditingCategory(null);
    setShowCategoryModal(true);
  }, []);

  const handleCloseCategoryModal = useCallback(() => {
    setShowCategoryModal(false);
    setEditingCategory(null);
  }, []);

  const handleNewFeed = useCallback(() => {
    setEditingFeed(null);
    setShowFeedModal(true);
  }, []);

  const handleOpenFeedModal = useCallback((feed?: Feed) => {
    setEditingFeed(feed ?? null);
    setShowFeedModal(true);
  }, []);

  const handleCloseFeedModal = useCallback(() => {
    setShowFeedModal(false);
    setEditingFeed(null);
  }, []);

  const handleAISuggestions = useCallback(() => {
    const { selectedSubscriptionIds } = state;
    if (selectedSubscriptionIds.length === 1) {
      fetchSuggestions(selectedSubscriptionIds[0]);
    }
  }, [state, fetchSuggestions]);

  const handleExport = useCallback(() => {
    exportCategories();
  }, [exportCategories]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirm({
      title: 'Import Categories',
      message: 'Import categories from this file?',
    });
    if (ok) {
      await importCategories(file);
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [confirm, importCategories]);

  // Listen for edit-category events from SubscriptionsSection
  const handleEditCategory = useCallback((category: Category) => {
    setEditingCategory(category);
    setShowCategoryModal(true);
  }, []);

  return (
    <div className="app-container">
      <Navbar
        onNewFeed={handleNewFeed}
        onNewCategory={handleNewCategory}
        onAISuggestions={handleAISuggestions}
        onExport={handleExport}
        onImport={handleImport}
        onSync={startSync}
      />
      <div className="app-body">
        {state.activeSection === 'feeds' && (
          <FeedsSection
            showFeedModal={showFeedModal}
            editingFeed={editingFeed}
            onCloseFeedModal={handleCloseFeedModal}
            onOpenFeedModal={handleOpenFeedModal}
          />
        )}
        {state.activeSection === 'playlists' && (
          <PlaylistsSection confirm={confirm} />
        )}
        {state.activeSection === 'subscriptions' && (
          <SubscriptionsSection
            showCategoryModal={showCategoryModal}
            editingCategory={editingCategory}
            onEditCategory={handleEditCategory}
            onCloseCategoryModal={handleCloseCategoryModal}
            confirm={confirm}
          />
        )}
      </div>
      <Toast />
      <Spinner />
      <ConfirmDialog dialog={dialog} onClose={handleClose} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        hidden
        onChange={handleFileChange}
      />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App
