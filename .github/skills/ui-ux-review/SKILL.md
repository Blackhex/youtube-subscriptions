---
name: ui-ux-review
description: "UI/UX review for YouTube Subscriptions Organizer. Use when: reviewing visual design compliance, checking layout correctness, verifying interaction patterns, assessing accessibility, reviewing responsive behavior, checking design system consistency, verifying user scenario flows."
---

# UI/UX Review

## When to Use
- Reviewing implemented components against the UI/UX specification
- Checking visual design matches the design system (colors, typography, spacing)
- Verifying interaction patterns (drag-and-drop, selection, infinite scroll)
- Assessing accessibility (keyboard navigation, screen reader support)
- Reviewing user scenario flows end-to-end

## Design References
- **UI/UX Spec**: See [Frontend Design](../../../docs/04-frontend-design.md) — full visual specification
- **User Flows**: See [User Scenarios](../../../docs/05-user-scenarios.md) — 14 detailed scenarios
- **Documentation**: See [README](../../../docs/README.md) — documentation index

## Review Procedure

### 1. Layout Compliance
- [ ] Full-viewport height, no page scrolling (internal scroll containers only)
- [ ] Navbar: fixed top, white bg in light / dark bg in dark mode (YouTube-style), tab pills left, actions right, bottom border
- [ ] Feeds section: horizontal flex layout, QueueColumn always first
- [ ] Subscriptions section: two-panel with resizable sidebar (200px default)
- [ ] Playlists section: horizontal flex columns
- [ ] Column sizing: `clamp(300px, 30vw, 500px)` for feed/playlist columns
- [ ] Sidebar resizer: col-resize cursor, 120px min / 50% max, localStorage persistence

### 2. Design System Compliance
- [ ] Colors match CSS custom properties (primary neutral #0f0f0f light / #f1f1f1 dark, matching YouTube's monochromatic palette)
- [ ] Typography matches spec (base 0.875rem, titles 0.9rem/600, meta 0.8rem)
- [ ] Card styling: white bg, no border, subtle box-shadow
- [ ] Icons: all from @mui/icons-material, no Unicode emojis or custom icons
- [ ] Action buttons: `btn-icon` (32px navbar), `btn-action` (24px inline), variants

### 3. Component-Level Review

#### Video Items
- [ ] Thumbnail 168×94px with duration badge overlay (bottom-right)
- [ ] Red progress bar at thumbnail bottom (width = playback %)
- [ ] Watched videos (≥95%) have 50% opacity
- [ ] Action buttons: drag handle, queue add, playlist add, remove
- [ ] Title truncated, channel name, relative time

#### Category Tree
- [ ] Recursive indentation per nesting level
- [ ] Drag handle + expand toggle + name + count + action buttons
- [ ] Assignment mode: checkboxes replace expand toggles when selection active
- [ ] Indeterminate checkbox state when partially assigned
- [ ] AI-suggested: purple left border + "Suggested" badge
- [ ] Collapsible nodes

#### Subscription List
- [ ] Circular thumbnail (48px) + title + description + category badges
- [ ] Selection: blue border, checkbox checked
- [ ] Hover reveals delete button (`btn-action-reveal`)
- [ ] Search input filters client-side
- [ ] Infinite scroll pagination (50 per page)

### 4. Interaction Patterns
- [ ] Drag-and-drop: visual feedback (opacity 0.5 dragging, primary border drop target)
- [ ] @dnd-kit keyboard accessibility (built-in keyboard sensor)
- [ ] Toast: bottom-right, 3 variants, auto-dismiss 4s
- [ ] ConfirmDialog: centered modal, Cancel/OK
- [ ] Infinite scroll: IntersectionObserver sentinel at bottom
- [ ] Sync progress: spinning icon animation during sync

### 5. User Scenario Walkthrough
Verify each scenario from [User Scenarios](../../../docs/05-user-scenarios.md):
1. First-time setup → OAuth → sync → subscriptions visible
2. PocketTube import → categories created → assignments made
3. Subscription assignment → selection → checkbox → AI suggestions
4. Feed creation → filter modal → column appears → videos load
5. Queue → add videos → reorder → Cast → playback polling
6. Playlist management → columns → reorder → delete
7. Add feed video to playlist → modal → select → confirm
8. Background sync → progress polling → completion toast
9. Category CRUD → create/edit/delete/reorder/nest
10. Export categories → PocketTube JSON download
11. Search subscriptions → instant filter → clear restores
12. Unsubscribe → confirm dialog → removed
13. Playback progress → progress bars → watched opacity
14. Sidebar resize → drag → persist to localStorage

### 6. Accessibility
- [ ] All interactive elements are keyboard-reachable (Tab, Enter, Space, Arrow keys)
- [ ] Focus indicators visible on all interactive elements
- [ ] @dnd-kit provides keyboard drag-and-drop support
- [ ] Images have alt text (channel thumbnails, video thumbnails)
- [ ] Color contrast meets WCAG AA (verify primary on white, white on primary)
- [ ] aria-labels on icon-only buttons
- [ ] Modal focus trapping (ConfirmDialog, FeedModal, etc.)

### 7. @dnd-kit Drag Handle Checklist
Apply to every new sortable surface (queue items, playlist items, category nodes, feed columns).

- [ ] **Visible affordance** — a persistent `DragIndicator` icon per [Frontend Design §5](../../../docs/04-frontend-design.md). `cursor: grab` alone is not discoverable; verify the draggable element is visually distinguishable from a nearby non-draggable twin (e.g. feed column title vs. Queue column title).
- [ ] **Never put `aria-label` on the only child of a heading** — the label overrides the heading's accessible name. Verify with a snapshot: a heading must read `heading "Czech"`, not `heading "Reorder Czech"`.
- [ ] **Hit target ≥ 24×24 CSS px** (WCAG 2.2 SC 2.5.8 AA). Text-only handles are `display: inline`, so vertical padding does not grow the box — use `inline-block` or a fixed-size icon handle. Measure with `getBoundingClientRect()`, and test the shortest possible label.
- [ ] **Dragging element paints above its neighbours** — a `useSortable` item with only `transform` + `opacity` stays in DOM paint order and gets overlapped by later siblings. Require `position: relative; z-index` while dragging, or a `<DragOverlay>`. Screenshot mid-drag to confirm.
- [ ] **Opacity semantics** — `opacity: 0.5` already means "watched" on `.video-item`. Reusing it for the drag source makes a whole column look watched. Prefer a dashed placeholder or overlay.
- [ ] **Explicit drop indicator** — for large items (full-height columns), the transform shuffle alone is ambiguous; check for a placeholder/slot outline.
- [ ] **Custom `accessibility.announcements` on `DndContext`** — the dnd-kit default announces raw ids ("Draggable item 5 was moved over droppable area 4"). Must announce human names and positions.
- [ ] **`:focus-visible` uses a design token**, not the UA default `outline: auto 1px`. Also check the ring isn't clipped by an ancestor `overflow: hidden` (common with `text-overflow: ellipsis` headers), and that `color-scheme` is set if relying on UA rings in dark mode.
- [ ] **`touch-action: none` scoped to the handle only** so surrounding scroll containers still pan.
- [ ] **Regression-test neighbours in the browser**: sibling buttons still click, inner scroll containers still scroll, the outer `.scrollable-x` still scrolls and auto-scrolls during drag, Escape cancels, focus stays on the handle after drop.
- [ ] **`user-select: none`** on text used as a handle removes copy/select — flag as a trade-off; a separate icon handle avoids it.

#### Testing drag in Playwright
`locator.dragTo()` does not reliably trigger a `PointerSensor` with an `activationConstraint`. Dispatch a real sequence instead: `pointerdown` on the handle, then ~10+ `pointermove` events on `document` with ~25ms sleeps, then `pointerup`. Leave the pointer down between two `evaluate` calls to screenshot mid-drag.

## Output Format
```
## UI/UX Review: [component/section]

### Visual Compliance
- [Pass/Fail items with details]

### Interaction Compliance
- [Pass/Fail items with details]

### Accessibility
- [Pass/Fail items with details]

### Issues Found
1. **[Severity]** — [description with expected vs actual]

### Overall Assessment
[Pass/Fail] with summary
```
