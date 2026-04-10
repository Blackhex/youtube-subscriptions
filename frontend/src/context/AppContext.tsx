import { createContext, useContext } from 'react';
import type { Dispatch } from 'react';
import type { Category, QueueItem, SyncState } from '../types';

export interface AppState {
  categories: Category[];
  totalCount: number;
  uncategorizedCount: number;
  selectedCategoryId: number | null;
  selectedSubscriptionIds: number[];
  suggestedCategoryIds: number[];
  syncState: SyncState;
  queueItems: QueueItem[];
  videoProgress: Record<string, number | null>;
  queuePlaybackActive: boolean;
  activeSection: 'feeds' | 'playlists' | 'subscriptions';
  loading: boolean;
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
}

export type AppAction =
  | { type: 'SET_CATEGORIES'; categories: Category[]; totalCount: number; uncategorizedCount: number }
  | { type: 'SELECT_CATEGORY'; id: number | null }
  | { type: 'TOGGLE_SELECTION'; id: number }
  | { type: 'SET_SELECTION'; ids: number[] }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_SUGGESTED_CATEGORIES'; ids: number[] }
  | { type: 'SET_SYNC_STATE'; state: SyncState }
  | { type: 'SET_QUEUE_ITEMS'; items: QueueItem[] }
  | { type: 'SET_VIDEO_PROGRESS'; progress: Record<string, number | null> }
  | { type: 'SET_QUEUE_PLAYBACK_ACTIVE'; active: boolean }
  | { type: 'SET_ACTIVE_SECTION'; section: 'feeds' | 'playlists' | 'subscriptions' }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SHOW_TOAST'; message: string; toastType: 'success' | 'error' | 'info' }
  | { type: 'HIDE_TOAST' };

export const initialState: AppState = {
  categories: [],
  totalCount: 0,
  uncategorizedCount: 0,
  selectedCategoryId: null,
  selectedSubscriptionIds: [],
  suggestedCategoryIds: [],
  syncState: {
    running: false,
    phase: null,
    total: 0,
    processed: 0,
    fetched_new: 0,
    errors: 0,
    skipped: 0,
    subs_synced: 0,
    started_at: null,
    finished_at: null,
    current_channel: null,
  },
  queueItems: [],
  videoProgress: {},
  queuePlaybackActive: false,
  activeSection: 'feeds',
  loading: false,
  toast: null,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CATEGORIES':
      return {
        ...state,
        categories: action.categories,
        totalCount: action.totalCount,
        uncategorizedCount: action.uncategorizedCount,
      };
    case 'SELECT_CATEGORY':
      return { ...state, selectedCategoryId: action.id };
    case 'TOGGLE_SELECTION': {
      const ids = state.selectedSubscriptionIds;
      const exists = ids.includes(action.id);
      return {
        ...state,
        selectedSubscriptionIds: exists
          ? ids.filter((i) => i !== action.id)
          : [...ids, action.id],
      };
    }
    case 'SET_SELECTION':
      return { ...state, selectedSubscriptionIds: action.ids };
    case 'CLEAR_SELECTION':
      return { ...state, selectedSubscriptionIds: [], suggestedCategoryIds: [] };
    case 'SET_SUGGESTED_CATEGORIES':
      return { ...state, suggestedCategoryIds: action.ids };
    case 'SET_SYNC_STATE':
      return { ...state, syncState: action.state };
    case 'SET_QUEUE_ITEMS':
      return { ...state, queueItems: action.items };
    case 'SET_VIDEO_PROGRESS':
      return {
        ...state,
        videoProgress: { ...state.videoProgress, ...action.progress },
      };
    case 'SET_QUEUE_PLAYBACK_ACTIVE':
      return { ...state, queuePlaybackActive: action.active };
    case 'SET_ACTIVE_SECTION':
      return { ...state, activeSection: action.section };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SHOW_TOAST':
      return { ...state, toast: { message: action.message, type: action.toastType } };
    case 'HIDE_TOAST':
      return { ...state, toast: null };
  }
}

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
