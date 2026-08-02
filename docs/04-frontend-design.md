# Frontend Design & UI/UX Reference

## 1. Overall Layout

The application is a **React single-page app (SPA)** with three main sections managed via component-level routing (or simple state toggle). The layout uses Bootstrap 5 with Material UI icons, full-viewport height, no page scrolling (internal scrolling containers instead).

### Navigation Bar
- Fixed at top, white background in light mode / dark (`#0f0f0f`) in dark mode — matches YouTube's top bar
- Bottom border separates navbar from content
- Left: Tab navigation pills (Feeds, Playlists, Subscriptions) — React state toggles visible section
- Right: Context-sensitive action buttons (icon-only, 32px circular, dark icons in light / light icons in dark)
  - **All sections**: Theme toggle (`DarkMode`/`LightMode`), Sync (`Sync`)
  - **Feeds section**: New Feed (`NoteAdd`)
  - **Subscriptions section**: New Category (`CreateNewFolder`), AI Suggestions (`AutoAwesome`), Export (`FileUpload`), Import (`FileDownload`)
  - **Playlists section**: (no additional buttons)

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

**Light Theme (default)** — matches YouTube's light mode:
```css
--md-primary:      #0f0f0f   /* Neutral dark - chips, badges, active states, action icons */
--md-primary-dark:  #030303   /* Darker on hover */
--md-success:      #2ba640   /* YouTube green */
--md-danger:       #cc0000   /* YouTube red - brand accent + destructive actions */
--md-bg:           #f2f2f2   /* YouTube light gray background */
--md-card-bg:      #ffffff   /* White card background */
--md-text-primary: #0f0f0f   /* YouTube near-black text */
--md-text-secondary: #606060
--md-text-meta:    #909090
--md-border:       #e5e5e5
--md-hover-bg:     rgba(0,0,0,0.05)
--md-shadow:       0 1px 2px rgba(0,0,0,0.1)
--md-on-primary:   #ffffff   /* Text color on primary backgrounds */
--md-info:         #065fd4   /* Blue - only for informational toasts */
```

**Dark Theme** (`[data-theme="dark"]`) — matches YouTube's dark mode:
```css
--md-primary:      #f1f1f1   /* Neutral light - chips, badges, active states, action icons */
--md-primary-dark:  #ffffff   /* Brighter on hover */
--md-success:      #2ba640
--md-danger:       #ff4e45   /* Lighter red for dark bg */
--md-bg:           #0f0f0f   /* YouTube dark background */
--md-card-bg:      #272727   /* YouTube dark surface */
--md-text-primary: #f1f1f1
--md-text-secondary: #aaaaaa
--md-text-meta:    #717171
--md-border:       #3f3f3f
--md-hover-bg:     rgba(255,255,255,0.1)
--md-shadow:       none
--md-on-primary:   #0f0f0f   /* Dark text on light primary backgrounds */
--md-info:         #3ea6ff   /* Blue - only for informational toasts */
```

YouTube's design is neutral/monochromatic — `--md-primary` is NOT a brand color but a neutral dark/light tone used for chips, tags, badges, and interactive elements. Red (`--md-danger`) doubles as the brand accent.

Theme is managed by `useTheme()` hook, persisted to `localStorage`, and defaults to the user's OS preference (`prefers-color-scheme`). Theme is applied via `data-theme` attribute on `<html>`. An inline script in `index.html` prevents a flash of wrong theme on load.

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
- First column: `<QueueColumn>` (always visible, pinned first — not reorderable)
- Subsequent columns: `<FeedColumn>` for each configured Feed, drag-reorderable (see §5)

**`<FeedColumn>`:**
- Header: Feed name + Edit button. The name is wrapped in a `<span class="feed-title-handle">` inside the `<h3>`, which is the drag activator for column reordering
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
- The category-import call site ("Replace Categories") spells out that every category and assignment is deleted and rebuilt from the file, since `importCategories` sends `mode=replace`

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

### Feed Column Reorder — `<FeedsSection>`
- `<DndContext>` + `<SortableContext strategy={horizontalListSortingStrategy}>` wrap the `<FeedColumn>` list; `<QueueColumn>` is rendered outside and stays pinned first
- **Deviation from the `DragHandle` convention above:** the activator is the column title itself (`.feed-title-handle` inside the `<h3>`), not a `drag_indicator` icon. Column headers have no room for an extra icon beside the Edit button, and the title is the natural window-title grab target
- The `aria-label` is deliberately omitted from the activator so it does not override the `<h3>`'s accessible name; `@dnd-kit` supplies `role="button"`, `tabIndex=0` and `aria-roledescription="sortable"`
- `<DndContext accessibility={{ announcements }}>` maps feed ids to names and 1-based positions, replacing `@dnd-kit`'s default "draggable item 5 / droppable area 4" announcements
- `onDragEnd` → `useFeeds().reorderFeeds()` reorders local state optimistically (skipped unless the id set matches the current list exactly) and persists via `POST /api/feeds/reorder/`. `feedVideos` is keyed by feed id and is left untouched, so no videos are refetched
- Dragging applies `position: relative` + `zIndex: 10` and the `.column.is-drag-source` class (dashed primary outline + dimmed header). The usual `opacity: 0.5` is **not** used here — 50% opacity already means "watched" on `.video-item`, so it would make every thumbnail in the dragged column read as watched

All provide:
- Visual feedback: `dragging` style (opacity 0.5), `drop-target` (primary border)
- Keyboard accessibility via `@dnd-kit`'s built-in keyboard sensor
- Sensors: `PointerSensor` with `activationConstraint: { distance: 5 }` (so buttons inside draggable regions stay clickable) + `KeyboardSensor` with `sortableKeyboardCoordinates`
- Activator elements need `touch-action: none`, or the browser claims touch/pen gestures for the surrounding scroll container and cancels the drag

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
| `useCategories()` | CRUD, reorder, import/export, tree operations. `importCategories(file, mode = 'replace')` sends the mode explicitly and reports deletions as well as creations in its toast |
| `useSubscriptions()` | Paginated fetch, search, selection, assignment |
| `useFeeds()` | CRUD, video loading with infinite scroll, `reorderFeeds()` (optimistic column order + `POST /api/feeds/reorder/`) |
| `useQueue()` | Add/remove/reorder, create playlist |
| `usePlaylists()` | Fetch playlists + items, reorder, delete |
| `useSync()` | Trigger sync, poll status, update UI |
| `useTheme()` | Toggle light/dark theme, persist to localStorage, respect OS preference |
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
│   └── @dnd-kit DndContext + SortableContext (horizontal)
│       └── <FeedColumn> (× n, sortable by title)
│           ├── <FilterTags>
│           └── <VideoItem> (× n, infinite scroll)
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
