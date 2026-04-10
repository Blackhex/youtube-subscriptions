import type { APIRequestContext, Page } from '@playwright/test';

export interface FeedSummary {
  id: number;
  name: string;
  sort_order: number;
}

export async function getFeeds(api: APIRequestContext): Promise<FeedSummary[]> {
  const res = await api.get('/api/feeds/');
  if (!res.ok()) throw new Error(`GET /api/feeds/ failed: ${res.status()}`);
  return res.json();
}

export async function reorderFeeds(api: APIRequestContext, orderedIds: number[]) {
  const res = await api.post('/api/feeds/reorder/', { data: { ordered_ids: orderedIds } });
  if (!res.ok()) throw new Error(`POST /api/feeds/reorder/ failed: ${res.status()}`);
}

export async function deleteFeed(api: APIRequestContext, id: number) {
  await api.delete(`/api/feeds/${id}/`);
}

/** Feed column titles in rendered order — the Queue column has no drag handle, so it is excluded. */
export async function feedColumnNames(page: Page): Promise<string[]> {
  return page.locator('.column .feed-title-handle').allTextContents();
}

/** Titles of every `.column`, Queue included, in rendered order. */
export async function allColumnNames(page: Page): Promise<string[]> {
  return page.locator('.column .column-header h3').allInnerTexts();
}

export async function openFeedsSection(page: Page) {
  await page.goto('/');
  // Feeds is the default section; wait until at least one feed column is mounted.
  await page.locator('.column .feed-title-handle').first().waitFor();
}
