---
name: test-frontend
description: "Frontend testing for YouTube Subscriptions Organizer. Use when: writing React component tests, hook tests, integration tests, testing user interactions, testing drag-and-drop, testing API client, testing state management, Vitest and React Testing Library."
---

# Frontend Testing

## When to Use
- Writing unit tests for custom hooks
- Writing component tests with React Testing Library
- Writing integration tests for user workflows
- Testing API client with mocked axios
- Testing drag-and-drop interactions
- Testing infinite scroll behavior

## Test Setup

### Dependencies
```bash
cd frontend
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @types/jest
```

### Vitest Config (`frontend/vitest.config.ts`)
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

### Test Setup (`frontend/src/test/setup.ts`)
```typescript
import '@testing-library/jest-dom';
// Mock Cast SDK
window.__onGCastApiAvailable = undefined;
// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.IntersectionObserver = MockIntersectionObserver as any;
```

### Directory Structure
```
frontend/src/
├── test/
│   ├── setup.ts
│   └── helpers.tsx          # renderWithProviders, mockApi
├── hooks/
│   ├── __tests__/
│   │   ├── useCategories.test.ts
│   │   ├── useSubscriptions.test.ts
│   │   ├── useFeeds.test.ts
│   │   ├── useQueue.test.ts
│   │   └── useSync.test.ts
├── components/
│   ├── layout/
│   │   └── __tests__/
│   │       ├── Navbar.test.tsx
│   │       └── Toast.test.tsx
│   ├── subscriptions/
│   │   └── __tests__/
│   │       ├── CategoryTree.test.tsx
│   │       ├── SubscriptionList.test.tsx
│   │       └── CategoryModal.test.tsx
│   ├── feeds/
│   │   └── __tests__/
│   │       ├── FeedColumn.test.tsx
│   │       ├── FeedModal.test.tsx
│   │       └── VideoItem.test.tsx
│   └── queue/
│       └── __tests__/
│           └── QueueColumn.test.tsx
└── api/
    └── __tests__/
        └── client.test.ts
```

## Test Categories

### Hook Tests
```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

// useCategories
test('fetches and structures category tree', async () => { ... });
test('creates category and refetches tree', async () => { ... });
test('reorders categories via API', async () => { ... });
test('handles import with file upload', async () => { ... });

// useSubscriptions
test('loads paginated subscriptions', async () => { ... });
test('filters by category_id', async () => { ... });
test('handles selection toggle', async () => { ... });
test('assigns subscription to category', async () => { ... });

// useFeeds
test('creates feed and refetches list', async () => { ... });
test('loads feed videos with pagination', async () => { ... });

// useQueue
test('adds video to queue (deduplicates)', async () => { ... });
test('reorders queue items', async () => { ... });

// useSync
test('starts sync and polls status', async () => { ... });
test('stops polling when sync completes', async () => { ... });
```

Hook stability tip:
- For callbacks created with `useCallback` and state dependencies (for example, `markWatched` depending on `feeds`), split setup into separate `act` steps, `waitFor` the state update, then call `rerender()` before invoking the callback. This avoids stale-closure flakes in regression tests.

### Component Tests
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Navbar
test('renders section tabs and switches sections', () => { ... });
test('shows context-sensitive action buttons per section', () => { ... });

// CategoryTree
test('renders hierarchical tree with counts', () => { ... });
test('shows checkboxes in assignment mode', () => { ... });
test('highlights AI-suggested categories', () => { ... });

// SubscriptionList
test('renders paginated subscription items', () => { ... });
test('filters by search query', () => { ... });
test('toggles selection on click', () => { ... });

// VideoItem
test('shows duration badge on thumbnail', () => { ... });
test('shows progress bar for partially watched', () => { ... });
test('applies watched class at 95%', () => { ... });

// FeedModal
test('creates feed with AND/OR category groups', () => { ... });
test('validates required fields', () => { ... });
```

### API Client Tests
```typescript
import axios from 'axios';
import { vi } from 'vitest';

vi.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

test('getCategories fetches tree structure', async () => { ... });
test('createFeed sends correct payload', async () => { ... });
test('handles API errors gracefully', async () => { ... });
```

## Test Helpers (`frontend/src/test/helpers.tsx`)
```typescript
import { render } from '@testing-library/react';
import { AppProvider } from '../context/AppContext';

export function renderWithProviders(ui: React.ReactElement, options = {}) {
  return render(ui, { wrapper: AppProvider, ...options });
}

export const mockCategory = (overrides = {}): Category => ({
  id: 1, name: 'Test Category', description: null, parent_id: null,
  sort_order: 0, subscription_count: 10, children: [],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});
```

## Running Tests
```bash
cd frontend
npm test                    # Run all tests
npm test -- --watch         # Watch mode
npm test -- --coverage      # Coverage report
npm test -- CategoryTree    # Run specific test file
```
