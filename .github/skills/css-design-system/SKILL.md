---
name: css-design-system
description: "CSS design system and styling for YouTube Subscriptions Organizer. Use when: implementing app.css, Bootstrap overrides, Material Design aesthetic, action button styles, column layouts, category tree styling, video item styling, scrollbar customization, responsive design."
---

# CSS Design System Implementation

## When to Use
- Creating or modifying `frontend/src/styles/app.css`
- Implementing Bootstrap 5 overrides
- Styling any component to match the design system
- Working on layout (column sizing, flex containers, scrollable areas)

## Design References
- **Full Spec**: See [Frontend Design](../../../docs/04-frontend-design.md) §2 (Design System), §7 (CSS Architecture)
- **Documentation**: See [README](../../../docs/README.md) for the documentation index

## Color Palette (CSS Custom Properties)
```css
--md-primary:       #667eea;  /* Purple - brand color */
--md-primary-dark:  #5568d3;  /* Darker purple - hover */
--md-success:       #48bb78;  /* Green - success */
--md-danger:        #f56565;  /* Red - error/delete */
```
- Background: `#f5f5f5`
- Card background: white, no border, subtle `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`
- Text: `#333` primary, `#666` secondary, `#999` meta

## Typography
- Base: `0.875rem` (14px)
- Card headers: `1rem`
- List item titles: `0.9rem`, font-weight 600
- Subtitles: `0.8rem`
- Category tree: `0.8rem`
- Badges: `0.65rem`

## CSS Architecture Order in `app.css`
1. CSS Variables (color palette)
2. Base/Layout (fullscreen, flex utilities: `flex-col`, `flex-fill`)
3. Bootstrap Overrides (primary color, card, scrollbar)
4. Action Buttons (`btn-icon`, `btn-action`, variants)
5. List Items (shared base for subscription/video/queue)
6. Video-specific (thumbnail 168×94px, duration badge, progress bar, `.watched` 50% opacity)
7. Category Tree (node, toggle, drag, collapse, selection, suggestion purple border)
8. Column Layout (`flex: 0 0 clamp(300px, 30vw, 500px)`, horizontal scroll)
9. Navigation (nav pills, section visibility)
10. Utilities (spinner, dialog, toast, filter groups)

## Key CSS Patterns

### Action Buttons
- `.btn-icon`: 32px circle, white icon, transparent bg, hover shows white 20% opacity (navbar)
- `.btn-action`: 24px square, primary icon, no border, hover 10% primary tint
- `.btn-action-sm`: 20px variant for category tree
- `.btn-action-danger`: Red-colored for destructive actions
- `.btn-action-reveal`: Hidden by default, shown on parent `:hover`

### Layout Utilities
- `.flex-col`: `display: flex; flex-direction: column; min-height: 0`
- `.flex-fill`: `flex: 1; min-height: 0`
- `.scrollable`: `overflow-y: auto` with thin scrollbar (4px width)
- `.scrollable-x`: Horizontal scroll for column layouts

### Column Sizing
- Feed/playlist columns: `flex: 0 0 clamp(300px, 30vw, 500px)` with `min-width: 0` (prevents content from stretching columns beyond flex-basis)
- Category sidebar: 200px default, resizable (120px min, 50% max)

### Video Item
- Thumbnail: 168×94px with duration badge overlay (bottom-right)
- Progress bar: red `div` at bottom of thumbnail, width = playback %
- Watched state: `.watched` class → 50% opacity for videos ≥95% progress

### Category Tree
- Indented recursively per nesting level
- `.suggested-category`: purple left border + "Suggested" badge
- Drag handle with `drag_indicator` icon
- Collapse/expand via `ExpandMore` rotation

### Inline Drag Handles Inside Truncating Text (`.feed-title-handle`)
Pattern for making an inline element inside a `text-overflow: ellipsis` container a WCAG 2.2 SC 2.5.8 (24×24) hit target:
- `display: inline` cannot grow vertically — vertical padding does not affect the box height. Use `display: inline-block` with `padding: 2px 6px; margin: -2px -6px` so the hit area grows while the surrounding layout stays visually identical (vertical margins on inline-block boxes do shrink the line box back).
- An `inline-block` is an atomic box, so the parent's `text-overflow: ellipsis` **does not** apply to it — long text is hard-clipped with no ellipsis. Move the truncation onto the span itself: `max-width`, `overflow: hidden`, `text-overflow: ellipsis`, `vertical-align: bottom`.
- With `box-sizing: border-box` (Bootstrap Reboot), `max-width: 100%` resolves against the parent's *content* box and then subtracts the span's own padding, clipping even short labels. Compensate with `max-width: calc(100% + <horizontal padding total>)` — e.g. `calc(100% + 12px)` for `padding: 2px 6px`.
- The parent's `overflow: hidden` clips the handle's hover background and focus ring. Give the parent matching `padding: 2px 6px; margin: -2px -6px` (scope with `:has(.feed-title-handle)` so other headers are untouched).
- Outlines and outset `box-shadow` rings are still clipped by an ancestor `overflow: hidden`. Use an **inset** ring instead: `box-shadow: inset 0 0 0 2px var(--md-primary), inset 0 0 0 0.2rem var(--md-primary-tint-15)` with `outline: none`.
- `cursor: grab`, `:active { cursor: grabbing }`, `user-select: none`, `touch-action: none` are all required by dnd-kit `PointerSensor` — never drop them.

### Drag State Styling
- Never reuse blanket `opacity: 0.5` for "being dragged" — `.video-item.watched` already owns 50% opacity as the *watched* semantic, so a dimmed column reads as all-watched.
- `.column.is-drag-source`: `outline: 2px dashed var(--md-primary); outline-offset: -2px` (negative offset keeps the dashes inside the column's `overflow: hidden`), and dim only `.column-header` with `opacity: 0.5`. The dashed outline doubles as the drop-position indicator.

## Constraints
- Bootstrap 5 imported via npm (`import 'bootstrap/dist/css/bootstrap.min.css'` in main.tsx)
- All overrides in `app.css`, no CSS-in-JS
- No page scrolling — internal scrolling containers only (`overflow-y: auto`)
- Thin custom scrollbar: 4px width
