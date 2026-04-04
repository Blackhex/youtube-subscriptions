# Project Guidelines — YouTube Subscriptions Organizer

## Architecture

Django + DRF backend (`config/`, `subscriptions/`) serving a React 18 + TypeScript + Vite SPA (`frontend/`).
SQLite database via Django ORM. See [docs/01-architecture-overview.md](../docs/01-architecture-overview.md) for full details.

## Technology Stack

- **Backend**: Django ≥5.0, DRF ≥3.15, django-cors-headers, google-api-python-client, google-auth-oauthlib, requests
- **Frontend**: React 18, TypeScript 5, Vite 5, axios, Bootstrap 5, @mui/icons-material, @dnd-kit/core + @dnd-kit/sortable
- **External APIs**: YouTube Data v3, InnerTube, Lounge, Google Gemini 1.5 Flash
- **Database**: SQLite (db.sqlite3)

## Code Style

- Python: Follow PEP 8. Use Django/DRF conventions (ModelSerializer, ViewSet, etc.)
- TypeScript: Strict mode. Typed API client functions. Interfaces for all entities in `types/index.ts`.
- CSS: Custom properties in `app.css`. Bootstrap 5 overrides. No CSS-in-JS.
- Components: Functional React with hooks. No class components.

## Build and Test

```bash
# Backend
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver  # :8000

# Frontend
cd frontend && npm install && npm run dev  # :5173 with proxy to :8000

# Tests
python manage.py test subscriptions
cd frontend && npm test
```

## Key Conventions

- All API endpoints prefixed with `/api/`
- DRF `AllowAny` permission (local-only app)
- Thumbnail caching to `media/thumbnails/`
- PocketTube JSON format for category import/export
- Background sync via threading (daemon thread + ThreadPoolExecutor)
- Cast integration via YouTube Lounge API (server-side), Cast SDK (browser-side)
- State management: React Context + useReducer (no Redux)

## Design Documents

Full specifications live in `docs/`. Reference these for implementation details:
- [Architecture](../docs/01-architecture-overview.md) — System diagram, tech stack, file structure
- [Data Model](../docs/02-data-model.md) — Django models, relationships, migrations
- [API Reference](../docs/03-api-reference.md) — ~40 DRF endpoints
- [Frontend Design](../docs/04-frontend-design.md) — UI/UX, components, hooks, CSS
- [User Scenarios](../docs/05-user-scenarios.md) — 14 detailed workflows
- [Implementation Plan](../docs/06-implementation-plan.md) — 15-phase build plan
