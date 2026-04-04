# Frontend Design & UI/UX Reference

## 1. Overall Layout

The application is a **React single-page app (SPA)** with three main sections managed via component-level routing (or simple state toggle). The layout uses Bootstrap 5 with Material UI icons, full-viewport height, no page scrolling (internal scrolling containers instead).

### Navigation Bar
- Fixed at top, dark purple background (`--md-primary: #667eea`)
- Left: Tab navigation pills (Feeds, Playlists, Subscriptions) — React state toggles visible section
- Right: Context-sensitive action buttons (icon-only, 32px circular)
  - **Feeds section**: New Feed (`NoteAdd`), Sync (`Sync`)
  - **Subscriptions section**: New Category (`CreateNewFolder`), AI Suggestions (`AutoAwesome`), Export (`FileUpload`), Import (`FileDownload`), Sync (`Sync`)
  - **Playlists section**: Sync (`Sync`)

### Screenshot: Feeds Section (Empty State)

The Feeds section shows a horizontal column layout with a Queue column always on the left, followed by feed columns. When no feeds exist, an empty state prompt with a "New Feed" button is shown.

> Queue column has: PlaylistAdd (create YouTube playlist), Cast (Cast to device) actions in header

### Screenshot: Subscriptions Section

A two-panel layout:
- **Left sidebar** (200px, resizable): `<CategoryTree>` component with "All" and "Uncategorized" special filters at top
- **Right panel** (flex-fill): `<SubscriptionList>` with search input

### Screenshot: Playlists Section

A horizontal column layout. Each owned YouTube playlist is a `<PlaylistColumn>` component with video cards. Each column header shows: item count, privacy status, Cast button, Delete button.

## 2. Design System

### Color Palette (CSS custom properties in `app.css`)
```css
--md-primary:      #667eea   /* Purple - primary brand color */
--md-primary-dark:  #5568d3   /* Darker purple - hover state */
--md-success:      #48bb78   /* Green - success toasts */
--md-danger:       #f56565   /* Red - error/delete actions */
Background:        #f5f5f5   /* Light gray page background */
Card background:   white
Card border:       none (subtle box-shadow: 0 1px 3px rgba(0,0,0,0.08))
Text primary:      #333
Text secondary:    #666
Text meta:         #999
```

### Typography
- Base font size: `0.875rem` (14px)
- Card headers: `1rem`
- List item titles: `0.9rem`, font-weight 600
- List item subtitles: `0.8rem`
- Category tree items: `0.8rem`
- Badges: `0.65rem`

### Icons
All icons use **Material Design Icons** via `@mui/icons-material` (or `react-icons/md`). No Unicode emojis or custom icons. Icons are imported as React components:

```tsx
import { Folder, Description, DragIndicator, Edit, Delete, ExpandMore, Sync, AutoAwesome } from '@mui/icons-material';
```

### Action Buttons
Two button styles (CSS classes in `app.css`):
1. **`btn-icon`**: Navbar action buttons (32px circle, white icon, transparent bg, hover shows white 20% opacity)
2. **`btn-action`**: Inline action buttons (24px square, primary-colored icon, no border, hover shows 10% primary tint)
   - `btn-action-sm`: 20px variant for category tree
   - `btn-action-danger`: Red-colored for destructive actions
   - `btn-action-reveal`: Hidden by default, shown on parent `:hover`

## 3. Section Details

### 3.1 Feeds Section — `<FeedsSection>`

**Layout:** Horizontal scrolling column layout (CSS `display: flex; overflow-x: auto`)
- First column: `<QueueColumn>` (always visible)
- Subsequent columns: `<FeedColumn>` for each configured Feed

**`<FeedColumn>`:**
- Header: Feed name + Edit button
- `<FilterTags>`: Shows active filters as pills (categories, type, duration, age, play state)
- Scrollable `<VideoItem>` list with infinite scroll (via `IntersectionObserver` or `useInfiniteScroll` hook)

**`<QueueColumn>`:**
- Header: "Queue" + toolbar (PlaylistAdd, Cast icons)
- Cast receiver status text (shown when Cast device is connected)
- `<QueueItem>` list wrapped in `<DndContext>` / `<SortableContext>` from `@dnd-kit`
- Cast button triggers `useCast()` hook → YouTube Lounge + polling

**`<VideoItem>` (shared component):**
- Stacked layout: thumbnail (168×94px) on left with duration badge overlay and progress bar
- Action buttons below thumbnail: drag handle, queue add, playlist add, remove
- Right side: title (truncated), channel name, relative time (`timeAgo()` utility)
- Watched videos (≥95%) have 50% opacity
- Red progress bar at bottom of thumbnail shows playback %

**`<FeedModal>` (Create/Edit):**
- React controlled form with `useState` for each field
- Category filter: AND/OR group builder component
  - Each `<CategoryGroupSelector>`: checkboxes for all categories (nested, indented)
  - "AND group" button adds new group
  - Within a group: OR logic (any match), between groups: AND logic (all match)
- Video type `<select>`: All / Regular / Shorts / Live
- Duration range: min/max number inputs in minutes
- Max age: days number input
- Play state: radio button group (Both / Played / Unplayed)
- Delete button (only in edit mode, left-aligned in footer)

### 3.2 Subscriptions Section — `<SubscriptionsSection>`

**`<CategoryTree>` (sidebar):**

Special filters at top:
- "All" with total subscription count
- "Uncategorized" with unfiltered count

Tree structure rendered recursively via `<CategoryNode>`:
- Each node shows: drag handle + expand toggle/checkbox + name + count + edit/delete buttons
- Nodes are drag-reorderable via `@dnd-kit/sortable`
- Nodes are collapsible (local `useState` or tracked in context)
- Drag to reorder within same parent; drag sideways to nest under target
- **Selection mode**: When `selectedSubscriptionIds.length > 0`, checkboxes replace expand toggles
  - Checked = all selected subs assigned
  - Indeterminate = some assigned (`ref.indeterminate = true`)
  - Unchecked = none assigned
  - Clicking checkbox triggers batch assign/unassign API calls
- AI-suggested categories get `suggested-category` CSS class (purple left border + "Suggested" badge)

**`<SubscriptionList>` (main area):**
- Paginated via `useSubscriptions()` hook (50 per page, infinite scroll via `IntersectionObserver`)
- Each `<SubscriptionItem>`: checkbox + circular thumbnail (48px) + title + description + category badges
- Click item: toggles selection via `dispatch({ type: 'TOGGLE_SELECTION', id })`
- Click info area: opens YouTube channel in new tab
- Hover reveals delete (unsubscribe) button
- Controlled search `<input>` filters client-side by title/description

**Selection Workflow:**
1. Click subscription → selected (blue border, checkbox checked)
2. `<CategoryTree>` re-renders in assignment mode (checkboxes)
3. Click category checkbox → calls `POST /api/subscriptions/{id}/assign/{catId}/` or `DELETE .../unassign/...` in parallel
4. "AI Suggestions" button appears for single selection → `GET /api/subscriptions/{id}/suggestions/` → highlights suggested categories

### 3.3 Playlists Section — `<PlaylistsSection>`

**Layout:** Horizontal scrolling columns via `<PlaylistColumn>` per playlist

**`<PlaylistColumn>`:**
- Header: playlist title (truncated) + item count + privacy status + Cast + Delete buttons
- `<VideoItem>` list with infinite scroll (`usePlaylists()` hook)
- Items wrapped in `@dnd-kit` `<SortableContext>` for drag reorder
- Each item has: remove action, drag handle
- Cast button calls `useCast()` → Lounge API

## 4. User Feedback Components

### `<Toast>` Component
- Bootstrap-styled toast in bottom-right corner (absolute positioned)
- 3 variants: success (green), error (red), info (purple)
- Auto-dismiss after 4 seconds
- Global `useToast()` hook or context-based `showToast(message, type)`

### `<ConfirmDialog>` Component
- Bootstrap modal, centered, small size
- Title + message + Cancel/OK buttons
- Exposes via `useConfirm()` hook returning `Promise<boolean>`

### `<AlertDialog>` Component
- Same as confirm but with only OK button
- `useAlert()` hook returning `Promise<void>`

### `<Spinner>` Component
- Fixed centered overlay with large Bootstrap spinner
- Shown via global loading state in context

### Sync Progress Indicator
- Sync button icon gets `spin-icon` CSS class during active sync (CSS `@keyframes spin`)
- Toast on completion with summary (subscriptions synced, new videos)

### Infinite Scroll
- `IntersectionObserver` on a sentinel `<div>` at bottom of scrollable containers
- `useInfiniteScroll(fetchMore, hasMore, isLoading)` custom hook

## 5. Drag & Drop System

All drag-and-drop uses **`@dnd-kit`** library:

### Category Reorder — `<CategoryTree>`
- `<DndContext>` wraps tree, `<SortableContext>` per parent group
- `DragHandle` component with `drag_indicator` icon
- `onDragEnd` handler: reorder within same parent, or re-parent (nest) based on drop position
- Persisted via `POST /api/categories/reorder/`

### Queue Reorder — `<QueueColumn>`
- `<SortableContext>` wraps queue items
- `onDragEnd` → reorder and persist via `POST /api/queue/reorder/`

### Playlist Reorder — `<PlaylistColumn>`
- `<SortableContext>` wraps playlist items
- `onDragEnd` → persist via `POST /api/playlists/{id}/items/reorder/`

All provide:
- Visual feedback: `dragging` style (opacity 0.5), `drop-target` (primary border)
- Keyboard accessibility via `@dnd-kit`'s built-in keyboard sensor

## 6. Google Cast Integration

### Architecture
```
React (Cast SDK)            Django Backend (Lounge API)    YouTube Receiver
     │                            │                          │
     ├── requestSession() ───────►│                          │
     │   (user selects device)    │                          │
     │                            │                          │
     ├── getMdxSessionStatus ────►│                          │
     │   (get receiver screenId)  │                          │
     │                            │                          │
     │   screenId ◄──────────────┤                          │
     │                            │                          │
     ├── POST /api/queue/cast/ ──►│                          │
     │   { screen_id }            │── get_lounge_token ─────►│
     │                            │── bind (get SID) ───────►│
     │                            │── setPlaylist ──────────►│
     │                            │   (video_ids)           │
     │   ◄─── { lounge data } ──┤                          │
     │                            │                          │
     ├── poll /api/queue/         │                          │
     │   refresh-progress/ ──────►│── nowPlaying(Lounge) ──►│
     │   (every 10 seconds)       │   ◄── current state ───┤
     │   ◄─── { updated queue } ─┤                          │
```

### Implementation via `useCast()` Hook
- Wraps Google Cast SDK initialization, session management, MDX listener
- `castSession`, `receiverScreenId` stored in hook state + `sessionStorage`
- `requestCastSession()`, `getYouTubeScreenId()` as hook methods
- Cast sender SDK loaded via `<script>` tag in `index.html`

### Session Persistence
- Cast session ID and screen ID saved to `sessionStorage`
- On mount, `useCast()` attempts `tryResumeCastSession()`
- Server-side: Lounge session saved to `media/lounge_session.json`

## 7. CSS Architecture

### Organization (`frontend/src/styles/app.css`)
1. **CSS Variables**: Color palette
2. **Base/Layout**: html/body fullscreen, flex utilities
3. **Bootstrap Overrides**: Primary color, card styling, scrollbar customization
4. **Action Buttons**: `btn-icon`, `btn-action` variants
5. **List Items**: Shared base for subscription/video/queue items
6. **Categories Tree**: Node, toggle, drag, collapse, selection styles
7. **Column Layout**: Fixed-width scrollable columns for feeds/playlists
8. **Navigation**: Nav pills, section visibility
9. **Utilities**: Spinner, dialog, toast, filter group styles

### Key CSS Patterns
- **`flex-col`**: `display: flex; flex-direction: column; min-height: 0`
- **`flex-fill`**: `flex: 1; min-height: 0`
- **`scrollable`**: `overflow-y: auto` with thin custom scrollbar (4px)
- **`scrollable-x`**: Horizontal scroll for column layouts
- **Column sizing**: `flex: 0 0 clamp(300px, 30vw, 500px)` with `min-width: 0` (overrides flexbox `auto` to enforce uniform width)

Bootstrap is imported via npm (`import 'bootstrap/dist/css/bootstrap.min.css'` in `main.tsx`). Custom overrides live in `app.css`.

## 8. React Architecture

### State Management
```
AppContext (React Context + useReducer)
├── categories: Category[]          // Category tree
├── totalCount: number              // Total subscription count
├── uncategorizedCount: number      // Uncategorized count
├── selectedCategoryId: number|null // Active category filter
├── selectedSubscriptionIds: number[] // Multi-select for assignment
├── suggestedCategoryIds: number[]  // AI suggestion highlights
├── syncState: SyncState            // Background sync progress
├── queueItems: QueueItem[]         // Play queue
├── queuePlaybackActive: boolean    // Cast polling active
└── activeSection: 'feeds'|'playlists'|'subscriptions'
```

### Custom Hooks
| Hook | Responsibility |
|------|---------------|
| `useCategories()` | CRUD, reorder, import/export, tree operations |
| `useSubscriptions()` | Paginated fetch, search, selection, assignment |
| `useFeeds()` | CRUD, video loading with infinite scroll |
| `useQueue()` | Add/remove/reorder, create playlist |
| `usePlaylists()` | Fetch playlists + items, reorder, delete |
| `useSync()` | Trigger sync, poll status, update UI |
| `useCast()` | Cast SDK, session management, Lounge playback |
| `useToast()` | Toast notification state and display |
| `useConfirm()` | Promise-based confirmation dialog |
| `useInfiniteScroll(ref, fetchMore, hasMore)` | IntersectionObserver-based pagination |

### Component Tree
```
<App>
├── <AppProvider>  (context)
├── <Navbar>
│   ├── <NavPills>
│   └── <ActionButtons>
├── <Spinner>
├── <Toast>
├── <ConfirmDialog>
├── {activeSection === 'feeds' && <FeedsSection>}
│   ├── <QueueColumn>
│   │   ├── <QueueItem> (× n, sortable)
│   │   └── @dnd-kit SortableContext
│   └── <FeedColumn> (× n)
│       ├── <FilterTags>
│       └── <VideoItem> (× n, infinite scroll)
├── {activeSection === 'subscriptions' && <SubscriptionsSection>}
│   ├── <CategoryTree>
│   │   └── <CategoryNode> (recursive, sortable)
│   ├── <SidebarResizer>
│   └── <SubscriptionList>
│       └── <SubscriptionItem> (× n, infinite scroll)
├── {activeSection === 'playlists' && <PlaylistsSection>}
│   └── <PlaylistColumn> (× n)
│       └── <VideoItem> (× n, sortable + infinite scroll)
├── <FeedModal>
├── <CategoryModal>
└── <AddToPlaylistModal>
```

### TypeScript Interfaces (`types/index.ts`)
```typescript
interface Category {
  id: number;
  name: string;
  description: string | null;
  parent_id: number | null;
  sort_order: number;
  subscription_count: number;
  children: Category[];
  created_at: string;
  updated_at: string;
}

interface Subscription {
  id: number;
  channel_id: string;
  channel_title: string;
  channel_description: string | null;
  thumbnail_url: string | null;
  subscription_date: string | null;
  categories: Category[];
}

interface Video {
  id: number;
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  video_type: 'video' | 'short' | 'live' | null;
  playback_progress: number | null;
  channel_title: string | null;
  playlist_item_id?: string;
}

interface QueueItem {
  id: number;
  video_id: string;
  sort_order: number;
  added_at: string;
  video: Video;
}

interface Feed {
  id: number;
  name: string;
  sort_order: number;
  filter_category_ids: number[][];
  filter_video_type: string | null;
  filter_min_duration: number | null;
  filter_max_duration: number | null;
  filter_max_age_days: number | null;
  filter_play_state: 'played' | 'unplayed' | 'both';
}

interface SyncState {
  running: boolean;
  phase: 'subscriptions' | 'videos' | null;
  total: number;
  processed: number;
  fetched_new: number;
  errors: number;
  subs_synced: number;
}
```

### API Client (`api/client.ts`)
```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Typed API functions
export const fetchCategories = () => api.get('/categories/');
export const createCategory = (data: Partial<Category>) => api.post('/categories/', data);
export const fetchSubscriptions = (params: SubscriptionParams) => api.get('/subscriptions/', { params });
export const startFullSync = (force = false) => api.post('/sync/all/', { force });
// ... etc
```
