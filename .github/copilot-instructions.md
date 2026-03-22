# YouTube Subscriptions Organizer — Copilot Instructions

## Project Overview

Flask + vanilla JavaScript single-page app for managing YouTube subscriptions with categories, AI suggestions, and video feeds. SQLite database via SQLAlchemy ORM. Bootstrap 5 + Material Design frontend.

## Project Structure

```
app.py              — Flask application, all API routes
models.py           — SQLAlchemy models (Category, Subscription, Video, Feed)
youtube_service.py  — YouTube Data API v3 wrapper
migrate_db.py       — Database migration script
static/app.js       — All frontend JavaScript
static/style.css    — All CSS (Bootstrap overrides + custom)
templates/index.html — Single HTML template
instance/           — SQLite database (auto-created)
```

## Python Conventions

- **Type hints** on all function signatures: `def func(id: int) -> Dict[str, Any]:`
- **Naming**: `snake_case` everywhere; private helpers prefixed with `_`
- **Imports**: stdlib → third-party → local
- **Docstrings**: Triple-quoted, first line is brief summary
- **Section dividers**: `# region Name` and `# endregion` for logical grouping of routes and helpers
- **Error handling**: Use `try/except` with specific exceptions; return JSON error messages with appropriate status codes
- **Logging**: Use `logging` module for server-side logs; no print statements; add debug logs to every route and critical functions

### Flask Routes

- Use `@app.get()`, `@app.post()`, `@app.put()`, `@app.delete()` decorators
- All responses via `jsonify()`; errors as `jsonify({"error": "msg"}), status_code`
- Status codes: 201 for creation, 200 for success, 400/404/500 for errors
- Services initialized lazily via global getter functions

### SQLAlchemy Models

- Explicit `__tablename__`, `id` as Integer primary key
- Timestamps: `created_at`, `updated_at` with `datetime.utcnow`
- `to_dict()` method with optional include flags (`include_children`, `include_categories`)
- Cascade deletes: `cascade="all, delete-orphan"` for parent-child relationships
- Schema changes: raw SQL via `db.session.execute(text(...))` in migration helpers

## JavaScript Conventions

- **`const`** by default, **`let`** for reassignment, never `var`
- **camelCase** for variables/functions, **SCREAMING_SNAKE** for constants
- **async/await** for all API calls; `Promise.all()` for parallel ops
- Global state variables at file top: `allCategories`, `allSubscriptions`, etc.
- Organized in commented sections with `// ============================================================================`

### API Communication

- Use `fetchAPI(endpoint, options)` wrapper — handles JSON headers and error parsing
- All async functions wrapped in try/catch with `showToast()` error feedback
- Show/hide spinner for loading states via `showSpinner()` / `hideSpinner()`

### User Feedback (no native dialogs)

- `showToast(message, type)` — type: `"success"`, `"error"`, `"info"`
- `showConfirm(message, title)` — returns `Promise<boolean>` via Bootstrap modal
- `showAlert(message, title)` — returns `Promise<void>` via Bootstrap modal
- `showSpinner()` / `hideSpinner()` — centered loading overlay

### DOM Patterns

- Data attributes for state: `data-category-id`, `data-subscription-id`, `data-feed-id`
- Event listeners attached in `DOMContentLoaded`
- Render functions build HTML via template literals and `.innerHTML`

## CSS Styling

- Bootstrap 5 grid for responsive layout (`col-12 col-md-3 col-lg-2`)
- Always use Material Design icons, do not use Unicode emojis or custom icons.
- Do not use inline styles; all styling via `style.css` with semantic class names.
- Organize CSS into sections: Variables, Layout, Components, Utilities delimited by comments.
- Compact sizing: base font `1rem`, reduced symmetrical padding/gaps throughout

## HTML Conventions

- Single-page app with sections toggled via JS (`sectionSubscriptions`, `sectionFeeds`)
- Bootstrap 5 components: Modal, Card, Navbar, Form, Toast, Spinner
- Material Design principles: clean, minimal, intuitive UI with consistent spacing and alignment
- Data attributes for JS interop on interactive elements
- Modals defined at page root level, outside section containers

## Adding New Features

1. **Model**: Add to `models.py` with `__tablename__`, timestamps, `to_dict()`
2. **Routes**: Add to `app.py` following decorator pattern with type hints
3. **Frontend**: Use `fetchAPI()`, async/await, `showToast()` for errors
4. **Styling**: Use CSS variables, responsive Bootstrap grid, component naming
5. **Dialogs**: Use `showConfirm()`/`showToast()` — never native `alert()`/`confirm()`
6. **Database migration**: Add column migration logic to `migrate_db.py`
