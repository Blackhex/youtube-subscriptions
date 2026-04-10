---
name: react-frontend
description: "React frontend implementation for YouTube Subscriptions Organizer. Use when: creating React components, custom hooks, TypeScript interfaces, AppContext/useReducer state, axios API client, section layouts (Feeds, Subscriptions, Playlists), modals, infinite scroll, drag-and-drop with @dnd-kit."
---

# React Frontend Implementation

## When to Use
- Creating or modifying React components in `frontend/src/components/`
- Implementing custom hooks in `frontend/src/hooks/`
- Setting up TypeScript interfaces in `frontend/src/types/index.ts`
- Implementing the API client in `frontend/src/api/client.ts`
- Setting up AppContext and state management in `frontend/src/context/`
- Configuring Vite, tsconfig, or package.json

## Design References
- **UI/UX Spec**: See [Frontend Design](../../../docs/04-frontend-design.md) for component tree, hooks, interfaces, design system
- **User Scenarios**: See [User Scenarios](../../../docs/05-user-scenarios.md) for interaction flows
- **Implementation Plan**: See [Implementation Plan](../../../docs/06-implementation-plan.md) Phases 9, 11-14

## Procedure

### 1. Foundation (Phase 9)
1. `main.tsx`: Render `<App>`, import Bootstrap CSS + `app.css`
2. `types/index.ts`: All TypeScript interfaces (Category, Subscription, Video, QueueItem, Feed, SyncState, Playlist)
3. `api/client.ts`: axios instance (baseURL `/api`), typed functions for every endpoint
4. `context/AppContext.tsx`: `useReducer` with actions for categories, subscriptions, selection, sync, queue, activeSection

### 2. Layout Components
- `<Navbar>`: Section pills (Feeds/Playlists/Subscriptions) + context-sensitive action buttons
- `<Spinner>`: Fixed centered overlay
- `<Toast>`: Bootstrap toast bottom-right, 3 variants, auto-dismiss 4s, `useToast()` hook
- `<ConfirmDialog>`: Modal with `useConfirm()` returning `Promise<boolean>`

### 3. Subscriptions Section (Phase 11)
- `<SubscriptionsSection>`: Two-panel with `<SidebarResizer>` (120px–50%, persisted to localStorage)
- `<CategoryTree>`: Recursive `<CategoryNode>`, @dnd-kit sortable, assignment mode (checkboxes when selections active)
- `<SubscriptionList>`: Paginated (50/page), `IntersectionObserver` infinite scroll, search input
- `<SubscriptionItem>`: Checkbox + circular thumbnail (48px) + title + category badges
- `<CategoryModal>`: Create/edit category form

### 4. Feeds & Queue Section (Phase 12)
- `<FeedsSection>`: Horizontal flex layout with overflow-x. Feed columns are wrapped in `<DndContext>` + `<SortableContext strategy={horizontalListSortingStrategy}>`; `<QueueColumn>` renders outside it and stays pinned first
- `<QueueColumn>`: Always first, @dnd-kit sortable items, Cast/PlaylistAdd actions
- `<FeedColumn>`: Header + `<FilterTags>` pills + `<VideoItem>` list with infinite scroll. `useSortable({ id: feed.id })`; the drag activator is `<span class="feed-title-handle">` **inside** the `<h3>` — the only place in the app that drags by a title instead of a `drag_indicator` handle
- `<VideoItem>`: Thumbnail (168×94px) with duration badge + progress bar, action buttons, channel/time info
- `<FeedModal>`: AND/OR category group builder, type/duration/age/play-state filters

### 5. Playlists Section (Phase 13)
- `<PlaylistsSection>`: Horizontal columns
- `<PlaylistColumn>`: Header (title, count, privacy, Cast, Delete) + sortable `<VideoItem>` list
- `<AddToPlaylistModal>`: Playlist picker dropdown + confirm

### 6. Custom Hooks
| Hook | Key Responsibilities |
|------|---------------------|
| `useCategories()` | CRUD, reorder, import/export, tree operations |
| `useSubscriptions()` | Paginated fetch, search, selection, assign/unassign |
| `useFeeds()` | CRUD feeds, load videos per feed with pagination, `reorderFeeds(orderedIds)` |
| `useQueue()` | Add/remove/reorder, create playlist |
| `usePlaylists()` | Fetch playlists + items, reorder, delete |
| `useSync()` | Trigger sync, poll status every 2s, return syncState |
| `useCast()` | Cast SDK init, session management, MDX, Lounge playback |
| `useInfiniteScroll()` | IntersectionObserver-based pagination trigger |

### 7. State Management Pattern
```typescript
// AppContext uses useReducer
type Action =
  | { type: 'SET_CATEGORIES'; categories: Category[]; totalCount: number; uncategorizedCount: number }
  | { type: 'SELECT_CATEGORY'; id: number | null }
  | { type: 'TOGGLE_SELECTION'; id: number }
  | { type: 'SET_SYNC_STATE'; state: SyncState }
  | { type: 'SET_QUEUE'; items: QueueItem[] }
  | { type: 'SET_ACTIVE_SECTION'; section: 'feeds' | 'playlists' | 'subscriptions' }
  // ... etc
```

## Constraints
- Functional components only (no class components)
- TypeScript strict mode
- No Redux — React Context + useReducer only
- Bootstrap 5 via npm import, not CDN
- @mui/icons-material for all icons (no Unicode emojis)
- @dnd-kit for all drag-and-drop (categories, queue, playlists, feed columns)
- Cast SDK loaded via `<script>` tag in `index.html`

## @dnd-kit Gotchas (learned from feed column reordering)
- **Never spread `attributes` onto a semantic element.** dnd-kit injects `role="button"`, which overrides an `<h3>`'s implicit `heading` role. Put the activator on an inner `<span>` and keep the semantic element intact.
- **Don't add `aria-label` to an activator whose text already names it** — it overrides the parent heading's accessible name (the a11y tree reads `heading "Reorder Czech"` instead of `heading "Czech"`).
- **Always pass `accessibility={{ announcements }}`** on `<DndContext>`. The defaults announce raw ids (`"Draggable item 5 was moved over droppable area 4"`). Map id → human name + 1-based position, and memoize the object.
- **`PointerSensor` needs `activationConstraint: { distance: 5 }`** whenever the draggable region contains buttons, or the sensor swallows the click.
- **Optimistic reorder**: rewrite the local `sort_order` fields too, and bail out unless the incoming id set matches the current list exactly (same length, no duplicates, no unknown ids) — a partial list diverges from the server, which leaves untouched rows at their old `sort_order`.
- **Recover from a failed reorder by re-fetching, not by restoring a captured snapshot** — a concurrent fetch during the in-flight POST makes the snapshot stale (resurrects deleted rows).
- Keep collection state keyed by entity id (e.g. `feedVideos[feed.id]`) so reordering never triggers a refetch.
