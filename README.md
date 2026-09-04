# YouTube Subscriptions Organizer

A local-first web application for organizing YouTube subscriptions into categories, building focused video feeds, managing playlists, and maintaining a playback queue.

The application combines a Django REST API with a React and TypeScript frontend. It syncs subscriptions and videos through YouTube, supports PocketTube-compatible category import and export, and includes optional Google Cast, browser-session, and Gemini integrations.

> [!WARNING]
> The default configuration is intended for personal use on a trusted machine. The API has no application-level authentication, allows cross-origin requests, and the development server listens on all interfaces. Do not expose it directly to the internet or an untrusted network.

## Features

- Synchronize subscriptions, channels, videos, and playlists from YouTube
- Organize subscriptions in hierarchical categories
- Create reorderable feeds with category and video filters
- Browse and update YouTube playlists
- Maintain a reorderable playback queue
- Send queued videos to Google Cast devices
- Import and export PocketTube-compatible categories
- Import live PocketTube data through the companion Chrome extension
- Mark videos as watched using an optional YouTube browser session
- Generate optional AI category suggestions with Google Gemini
- Cache channel and video thumbnails locally
- Switch between light and dark themes

## Technology

- Django, Django REST Framework, and SQLite
- React, TypeScript, Vite, Material UI, and Bootstrap
- YouTube Data API v3 and YouTube InnerTube APIs
- Playwright for browser-assisted YouTube operations and end-to-end tests
- A Chrome Manifest V3 companion extension

## Prerequisites

- Python 3.12 or newer
- Node.js 22.12 or newer with npm
- A Google Cloud project with the YouTube Data API v3 enabled
- OAuth 2.0 credentials created as a **Desktop app**
- Google Chrome or Chromium for companion-extension features

A Gemini API key is optional and is used only for AI category suggestions.

## Quick Start

1. Clone the repository and enter it:

   ```bash
   git clone <repository-url>
   cd youtube-subscriptions
   ```

2. Create and activate a Python virtual environment:

   ```bash
   python -m venv .venv
   ```

   On Windows PowerShell:

   ```powershell
   .venv\Scripts\Activate.ps1
   ```

   On macOS or Linux:

   ```bash
   source .venv/bin/activate
   ```

3. Install the backend dependencies and initialize the database:

   ```bash
   python -m pip install -r requirements.txt
   python manage.py migrate
   ```

4. Install the frontend dependencies:

   ```bash
   cd frontend
   npm install
   cd ..
   ```

5. Download the Desktop OAuth client credentials from Google Cloud and save them as `client_secret.json` in the repository root.

6. Start Django:

   ```bash
   python manage.py runserver 127.0.0.1:8000
   ```

7. In another terminal, start Vite:

   ```bash
   cd frontend
   npm run dev
   ```

8. Open <http://127.0.0.1:8001>. Start a sync in the application and complete the Google OAuth flow when prompted.

The OAuth callback uses `http://localhost:8085/`. Keep port `8085` available while signing in.

## Optional Integrations

### Gemini Suggestions

Place a Gemini API key in `gemini_api_key.txt` in the repository root. If the file is absent, the application uses heuristic category suggestions instead.

### Chrome Companion Extension

The unpacked extension in `extension/` provides features that OAuth alone cannot provide, including importing the active YouTube browser session, marking videos as watched, and direct PocketTube synchronization.

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension/` directory.
5. Stay signed in to YouTube in the same Chrome profile.

The extension can access YouTube cookies and may request access to a configured application origin. Review [extension/manifest.json](extension/manifest.json) before installing it.

### Playwright Browser

Browser-assisted watch tracking and end-to-end tests require Chromium:

```bash
python -m playwright install chromium
cd frontend
npx playwright install chromium
```

## Testing

Run the backend test suite from the repository root:

```bash
python manage.py test
```

Run frontend unit tests, linting, and the production build:

```bash
cd frontend
npm test
npm run lint
npm run build
```

Run extension tests with Node.js:

```bash
node extension/tests/harness.mjs
```

The Playwright end-to-end suite expects the Django and Vite development servers to be running:

```bash
cd frontend
npm run test:e2e
```

## Local Data and Secrets

The following files contain private credentials, browser state, or personal application data and are excluded by Git:

- `client_secret.json`
- `token.json`
- `gemini_api_key.txt`
- `db.sqlite3`
- `media/browser_state.json`
- `media/lounge_session.json`
- `data/pockettube_metadata.json`
- `media/thumbnails/`

Do not force-add these files. If any of them are committed or shared accidentally, revoke the affected credentials and remove the data from Git history before publishing.

## Project Structure

```text
config/          Django project configuration
subscriptions/   Models, API views, sync logic, and YouTube clients
frontend/        React and TypeScript single-page application
extension/       Chrome companion extension
scripts/         Local development utilities
docs/            Architecture, API, data model, and user-flow documentation
media/           Ignored local browser state and thumbnail cache
data/            Ignored PocketTube metadata and database backups
```

## Documentation

Detailed design and implementation documentation is available in [docs/README.md](docs/README.md):

- [Architecture overview](docs/01-architecture-overview.md)
- [Data model](docs/02-data-model.md)
- [REST API reference](docs/03-api-reference.md)
- [Frontend design](docs/04-frontend-design.md)
- [User scenarios](docs/05-user-scenarios.md)
- [Implementation plan](docs/06-implementation-plan.md)

## Deployment

The checked-in Django settings are development settings. Before any networked or multi-user deployment, add caller authentication and authorization, restrict CORS and allowed hosts, disable debug mode, provide a strong secret key through the environment, terminate TLS at a trusted reverse proxy, and use production-grade static-file and process management.
