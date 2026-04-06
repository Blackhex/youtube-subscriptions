---
name: test-e2e
description: "End-to-end testing with Playwright for YouTube Subscriptions Organizer. Use when: writing E2E tests, verifying user scenarios end-to-end, testing full-stack flows through the browser, setting up Playwright, testing drag-and-drop interactions, testing navigation, testing modals, testing infinite scroll, testing file upload/download."
---

# End-to-End Testing with Playwright

## When to Use
- Writing E2E tests that exercise the full stack (React ↔ Django ↔ SQLite)
- Verifying the 14 user scenarios from the design docs
- Testing browser-level interactions (drag-and-drop, file upload, download, scroll)
- Regression testing after cross-cutting changes

## Design References
- **User Scenarios**: See [User Scenarios](../../../docs/05-user-scenarios.md) — all 14 scenarios to cover
- **Frontend Design**: See [Frontend Design](../../../docs/04-frontend-design.md) — component structure and interactions
- **API Reference**: See [API Reference](../../../docs/03-api-reference.md) — API mocking targets

## Setup

### Installation
```bash
cd frontend
npm install -D @playwright/test
npx playwright install chromium
```

### Config (`frontend/playwright.config.ts`)
```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8001',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'cd .. && python manage.py runserver 8000',
      port: 8000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev',
      port: 8001,
      reuseExistingServer: true,
    },
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

### Directory Structure
```
frontend/
├── e2e/
│   ├── fixtures/
│   │   ├── app.fixture.ts          # Page object model + seeded data
│   │   ├── seed.ts                 # DB seeding via API calls
│   │   └── pockettube-sample.json  # Sample PocketTube import file
│   ├── helpers/
│   │   └── api-mock.ts            # Route interception helpers
│   ├── subscriptions.spec.ts      # Scenarios 2, 3, 9, 10, 11, 12, 14
│   ├── feeds.spec.ts              # Scenarios 4, 7, 13
│   ├── queue.spec.ts              # Scenario 5 (minus Cast hardware)
│   ├── playlists.spec.ts          # Scenario 6
│   ├── sync.spec.ts               # Scenarios 1, 8
│   └── navigation.spec.ts         # Section switching, navbar actions
├── playwright.config.ts
```

## Test Strategy

### API Seeding vs Mocking
- **Seeded tests** (preferred for most): Call Django API directly to create test data (categories, subscriptions, videos, feeds, queue items) before testing UI flows. This validates the full stack.
- **Mocked tests** (for external APIs): Intercept YouTube API and Gemini API calls at the Django level. Use `page.route()` to mock `/api/sync/status/` for sync progress simulation.

### Seed Helper (`e2e/fixtures/seed.ts`)
```typescript
import { APIRequestContext } from '@playwright/test';

export async function seedCategories(api: APIRequestContext) {
  const cats = [
    { name: 'Programming', sort_order: 0 },
    { name: 'Music', sort_order: 1 },
    { name: 'Science', sort_order: 2 },
  ];
  const created = [];
  for (const cat of cats) {
    const res = await api.post('/api/categories/', { data: cat });
    created.push(await res.json());
  }
  // Add child category
  await api.post('/api/categories/', {
    data: { name: 'Python', parent_id: created[0].id, sort_order: 0 },
  });
  return created;
}

export async function seedSubscriptions(api: APIRequestContext) { ... }
export async function seedVideos(api: APIRequestContext) { ... }
export async function seedFeeds(api: APIRequestContext, categoryIds: number[]) { ... }
export async function clearDatabase(api: APIRequestContext) { ... }
```

### App Fixture (`e2e/fixtures/app.fixture.ts`)
```typescript
import { test as base, expect } from '@playwright/test';
import { seedCategories, seedSubscriptions, clearDatabase } from './seed';

type AppFixtures = {
  seededApp: { categories: any[]; subscriptions: any[] };
};

export const test = base.extend<AppFixtures>({
  seededApp: async ({ request }, use) => {
    await clearDatabase(request);
    const categories = await seedCategories(request);
    const subscriptions = await seedSubscriptions(request);
    await use({ categories, subscriptions });
    await clearDatabase(request);
  },
});

export { expect };
```

## Playwright MCP Tools for Interactive Testing

The Playwright MCP (`mcp_microsoft_pla/*`) provides browser control tools for exploratory testing and debugging before writing automated specs. Use them to:

### Explore & Debug
1. `browser_navigate` → Open `http://localhost:8001` to load the app
2. `browser_snapshot` → Get accessibility tree to find correct selectors and verify structure
3. `browser_take_screenshot` → Capture visual state for comparison against design
4. `browser_console_messages` → Check for JavaScript errors after interactions
5. `browser_network_requests` → Inspect API calls made during a flow (filter: `/api/.*`)

### Interact & Verify
1. `browser_click` → Click tabs, buttons, list items to walk through scenarios
2. `browser_type` → Type in search inputs, form fields
3. `browser_hover` → Verify hover-reveal buttons (e.g., `btn-action-reveal` on SubscriptionItem)
4. `browser_drag` → Test @dnd-kit drag-and-drop (category reorder, queue reorder)
5. `browser_select_option` → Select from dropdowns (video type, playlist picker)
6. `browser_fill_form` → Fill FeedModal or CategoryModal forms
7. `browser_file_upload` → Upload PocketTube JSON for import testing
8. `browser_handle_dialog` → Accept/dismiss ConfirmDialog modals
9. `browser_wait_for` → Wait for async operations (sync toast, data loading)

### Workflow: MCP-First Test Development
1. Use MCP tools to manually walk through a user scenario in the browser
2. Note the selectors from `browser_snapshot`, timing from `browser_wait_for`
3. Capture API calls via `browser_network_requests`
4. Translate the manual walkthrough into an automated Playwright spec
5. Run the spec via `npx playwright test` to verify

## Scenario Coverage

### Scenario 2: PocketTube Import (`subscriptions.spec.ts`)
```typescript
test('imports categories from PocketTube JSON file', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /subscriptions/i }).click();
  // Trigger file upload via hidden input
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles('./e2e/fixtures/pockettube-sample.json');
  // Confirm dialog
  await page.getByRole('button', { name: /ok|confirm/i }).click();
  // Verify toast
  await expect(page.getByText(/import complete/i)).toBeVisible();
  // Verify categories appeared in tree
  await expect(page.locator('.category-node')).toHaveCount.greaterThan(0);
});
```

### Scenario 3: Subscription Assignment (`subscriptions.spec.ts`)
```typescript
test('assigns subscription to category via checkbox', async ({ page, seededApp }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /subscriptions/i }).click();
  // Click a subscription to select it
  await page.locator('.subscription-item').first().click();
  // Verify assignment mode: checkboxes appear in category tree
  await expect(page.locator('.category-node input[type="checkbox"]')).toHaveCount.greaterThan(0);
  // Click category checkbox to assign
  await page.locator('.category-node input[type="checkbox"]').first().check();
  // Verify toast or category badge on subscription
  await expect(page.locator('.subscription-item .badge')).toHaveCount.greaterThan(0);
});
```

### Scenario 4: Feed Creation (`feeds.spec.ts`)
```typescript
test('creates feed with filters and displays videos', async ({ page, seededApp }) => {
  await page.goto('/');
  // Click New Feed action button
  await page.getByRole('button', { name: /new feed/i }).click();
  // Fill modal form
  await page.getByLabel(/name/i).fill('Test Feed');
  await page.getByLabel(/video type/i).selectOption('video');
  await page.getByLabel(/max age/i).fill('14');
  await page.getByRole('button', { name: /save|create/i }).click();
  // Verify feed column appeared
  await expect(page.locator('.feed-column')).toContainText('Test Feed');
});
```

### Scenario 5: Queue Management (`queue.spec.ts`)
```typescript
test('adds videos to queue and reorders via drag', async ({ page, seededApp }) => {
  await page.goto('/');
  // Add video to queue from feed
  await page.locator('.video-item .btn-queue-add').first().click();
  await expect(page.getByText(/added to queue/i)).toBeVisible();
  // Verify queue column shows item
  await expect(page.locator('.queue-column .queue-item')).toHaveCount(1);
});
```

### Scenario 6: Playlist Management (`playlists.spec.ts`)
Mock YouTube playlist API responses, then verify column rendering, item actions, delete confirmation.

### Scenario 8: Sync Progress (`sync.spec.ts`)
```typescript
test('shows sync progress and completion toast', async ({ page }) => {
  // Mock sync status to simulate progress
  await page.route('/api/sync/status/', async (route) => {
    await route.fulfill({
      json: { running: true, phase: 'subscriptions', total: 100, processed: 50 },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /sync/i }).click();
  // Verify spinning icon
  await expect(page.locator('.spin-icon')).toBeVisible();
  // Update mock to complete
  await page.route('/api/sync/status/', async (route) => {
    await route.fulfill({
      json: { running: false, phase: null, total: 100, processed: 100, subs_synced: 100 },
    });
  });
  // Verify completion toast
  await expect(page.getByText(/sync complete/i)).toBeVisible({ timeout: 10_000 });
});
```

### Scenario 9: Category CRUD (`subscriptions.spec.ts`)
Test create → verify in tree → edit → verify name change → delete → confirm dialog → verify removed.

### Scenario 10: Export (`subscriptions.spec.ts`)
```typescript
test('exports categories as JSON file download', async ({ page, seededApp }) => {
  await page.getByRole('tab', { name: /subscriptions/i }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /export/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/categories_export.*\.json/);
});
```

### Scenario 11: Subscription Search (`subscriptions.spec.ts`)
Type in search → verify list filters → clear → verify list restores.

### Scenario 12: Unsubscribe (`subscriptions.spec.ts`)
Hover → click delete → confirm dialog → verify item removed → toast shown.

### Scenario 14: Sidebar Resize (`subscriptions.spec.ts`)
```typescript
test('resizes sidebar via drag and persists to localStorage', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /subscriptions/i }).click();
  const resizer = page.locator('.sidebar-resizer');
  const box = await resizer.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + box!.height / 2);
  await page.mouse.up();
  // Verify localStorage was updated
  const width = await page.evaluate(() => localStorage.getItem('categoriesSidebarWidth'));
  expect(Number(width)).toBeGreaterThan(200);
});
```

## Drag-and-Drop Testing with @dnd-kit
@dnd-kit uses pointer events. Use Playwright's mouse API:
```typescript
async function dragAndDrop(page: Page, source: Locator, target: Locator) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  // Move in steps to trigger @dnd-kit sensors
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 });
  await page.mouse.up();
}
```

## Running Tests
```bash
cd frontend
npx playwright test                          # Run all E2E tests
npx playwright test subscriptions.spec.ts    # Run one spec
npx playwright test --headed                 # Watch in browser
npx playwright test --ui                     # Interactive UI mode
npx playwright show-report                   # View HTML report
```

## Constraints
- Tests run against real Django backend + Vite dev server (full stack)
- External YouTube/Gemini API calls must be mocked (no real API calls)
- Cast hardware tests are skipped (mock Lounge API instead)
- Clean database between test suites via seed/clear fixtures
- Use `test.describe.serial()` for tests with ordering dependencies
