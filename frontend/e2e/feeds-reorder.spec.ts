import { test, expect } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import { dndKitDrag } from './helpers/drag';
import {
  allColumnNames,
  deleteFeed,
  feedColumnNames,
  getFeeds,
  openFeedsSection,
  reorderFeeds,
  type FeedSummary,
} from './helpers/feeds';

const REORDER_URL = /\/api\/feeds\/reorder\/$/;

interface ReorderTracker {
  calls: number[][];
}

/** Records the `ordered_ids` payload of every POST /api/feeds/reorder/ the page makes. */
function trackReorderRequests(page: Page): ReorderTracker {
  const tracker: ReorderTracker = { calls: [] };
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST' || !REORDER_URL.test(new URL(request.url()).pathname)) return;
    const body = request.postDataJSON() as { ordered_ids?: number[] } | null;
    tracker.calls.push(body?.ordered_ids ?? []);
  });
  return tracker;
}

function handleFor(page: Page, name: string): Locator {
  return page.locator('.column .feed-title-handle', { hasText: name }).first();
}

test.describe('Feeds — column reordering', () => {
  let originalOrder: FeedSummary[] = [];

  test.beforeEach(async ({ request }) => {
    originalOrder = await getFeeds(request);
    test.skip(originalOrder.length < 2, 'Needs at least two feeds to exercise reordering');
  });

  test.afterEach(async ({ request }) => {
    // Remove any feed created by a test, then put the original order back.
    const current = await getFeeds(request);
    const originalIds = new Set(originalOrder.map((f) => f.id));
    for (const feed of current) {
      if (!originalIds.has(feed.id)) await deleteFeed(request, feed.id);
    }
    await reorderFeeds(request, originalOrder.map((f) => f.id));
  });

  test('reorders feed columns by dragging the title with the mouse and persists', async ({ page }) => {
    const tracker = trackReorderRequests(page);
    await openFeedsSection(page);

    const before = await feedColumnNames(page);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const [first, second] = before;

    await dndKitDrag(page, handleFor(page, first), handleFor(page, second));

    const expected = [second, first, ...before.slice(2)];
    await expect.poll(() => feedColumnNames(page)).toEqual(expected);

    const expectedIds = expected.map(
      (name) => originalOrder.find((f) => f.name === name)!.id,
    );
    await expect.poll(() => tracker.calls).toEqual([expectedIds]);

    await page.reload();
    await page.locator('.column .feed-title-handle').first().waitFor();
    await expect.poll(() => feedColumnNames(page)).toEqual(expected);
  });

  test('reorders feed columns with the keyboard (Space, ArrowRight, Space)', async ({ page }) => {
    const tracker = trackReorderRequests(page);
    await openFeedsSection(page);

    const before = await feedColumnNames(page);
    const [first, second] = before;

    const activator = page.getByRole('button', { name: first, exact: true });
    await expect(activator).toHaveAttribute('aria-roledescription', 'sortable');

    await handleFor(page, first).focus();
    await expect(handleFor(page, first)).toBeFocused();

    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');

    const expected = [second, first, ...before.slice(2)];
    await expect.poll(() => feedColumnNames(page)).toEqual(expected);

    const expectedIds = expected.map(
      (name) => originalOrder.find((f) => f.name === name)!.id,
    );
    await expect.poll(() => tracker.calls).toEqual([expectedIds]);
  });

  test('cancels a keyboard reorder with Escape without calling the API', async ({ page }) => {
    const tracker = trackReorderRequests(page);
    await openFeedsSection(page);

    const before = await feedColumnNames(page);

    await handleFor(page, before[0]).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    expect(await feedColumnNames(page)).toEqual(before);
    expect(tracker.calls).toEqual([]);
  });

  test('keeps the Queue column pinned first after a reorder', async ({ page }) => {
    await openFeedsSection(page);

    expect((await allColumnNames(page))[0]).toBe('Queue');

    const before = await feedColumnNames(page);
    await dndKitDrag(page, handleFor(page, before[0]), handleFor(page, before[1]));
    await expect.poll(() => feedColumnNames(page)).not.toEqual(before);

    const columns = await allColumnNames(page);
    expect(columns[0]).toBe('Queue');
    expect(page.locator('.column').first().locator('.feed-title-handle')).toHaveCount(0);
  });

  test('still opens the Feed modal when the Edit button is clicked', async ({ page }) => {
    await openFeedsSection(page);

    const [firstFeed] = await feedColumnNames(page);
    await page
      .locator('.column', { has: page.locator('.feed-title-handle') })
      .first()
      .locator('button[title="Edit feed"]')
      .click();

    const modal = page.locator('.modal-content');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-header h3')).toHaveText('Edit Feed');
    await expect(modal.locator('input[placeholder="Feed name"]')).toHaveValue(firstFeed);

    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toBeHidden();
  });

  test('appends a newly created feed as the last feed column', async ({ page }) => {
    await openFeedsSection(page);

    const before = await feedColumnNames(page);
    // Sorts alphabetically first, so it can only end up last if append ordering is used.
    const newName = 'AAA E2E Append Feed';

    await page.locator('button[title="New Feed"]').click();
    const modal = page.locator('.modal-content');
    await expect(modal.locator('.modal-header h3')).toHaveText('New Feed');
    await modal.locator('input[placeholder="Feed name"]').fill(newName);
    await modal.getByRole('button', { name: 'Create' }).click();
    await expect(modal).toBeHidden();

    await expect.poll(() => feedColumnNames(page)).toEqual([...before, newName]);

    await page.reload();
    await page.locator('.column .feed-title-handle').first().waitFor();
    await expect.poll(() => feedColumnNames(page)).toEqual([...before, newName]);
  });
});
