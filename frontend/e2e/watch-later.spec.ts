import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Watch Later is first, paginates, and retries at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let failWatchLater = false;
    const requestedPages: string[] = [];
    await page.route('https://www.gstatic.com/**', (route) => route.abort());
    await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
      const url = new URL(route.request().url());
      const video = (number: number) => ({
        id: number, video_id: `synthetic${number}`, playlist_item_id: `item${number}`,
        title: `Watch Later sample ${number}`, channel_id: '', channel_title: 'Sample channel',
        duration_seconds: 125, published_at: '', playback_progress: 0, thumbnail_url: '/favicon.svg',
      });
      let data: unknown = [];
      switch (url.pathname) {
        case '/api/queue/':
          data = { items: [] };
          break;
        case '/api/playlists/':
          data = [
            { id: 'WL', title: 'Watch Later', item_count: null, privacy_status: 'private', read_only: true },
            { id: 'PL_normal', title: 'Saved videos', item_count: 1, privacy_status: 'private', read_only: false },
          ];
          break;
        case '/api/playlists/WL/items/':
          if (failWatchLater) {
            await route.fulfill({ status: 502, json: { error: 'Watch Later is unavailable' } });
            return;
          }
          requestedPages.push(url.searchParams.get('page_token') || 'first');
          data = url.searchParams.has('page_token')
            ? { items: [video(21)], has_more: false, next_page_token: null, page: 2 }
            : { items: Array.from({ length: 20 }, (_, index) => video(index + 1)),
                has_more: true, next_page_token: 'synthetic-next', page: 1 };
          break;
        case '/api/playlists/PL_normal/items/':
          data = { items: [{ ...video(30), title: 'Regular playlist video' }],
            has_more: false, next_page_token: null, page: 1 };
          break;
        case '/api/auth/oauth/':
          data = { authenticated: true, in_progress: false, auth_url: null, error: null };
          break;
        case '/api/categories/':
          data = { categories: [], total_count: 0, uncategorized_count: 0 };
          break;
        case '/api/sync/status/':
          data = { running: false, phase: null, total: 0, processed: 0, errors: 0, fetched_new: 0, skipped: 0 };
          break;
      }
      await route.fulfill({ status: 200, json: data });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByText('Playlists', { exact: true }).click();
    const columns = page.locator('.column');
    await expect(columns.locator('h3')).toHaveText(['Watch Later', 'Saved videos']);
    const watchLater = columns.first();
    await expect(watchLater.locator('.video-item')).toHaveCount(20);
    await expect(watchLater.getByTitle('Delete playlist', { exact: true })).toHaveCount(0);
    await expect(watchLater.getByTitle('Remove', { exact: true })).toHaveCount(0);
    await expect(columns.nth(1).getByTitle('Delete playlist', { exact: true })).toHaveCount(1);
    await expect(watchLater.locator('img').first()).toBeVisible();
    await expect.poll(() => watchLater.locator('img').first().evaluate(
      (image) => (image as unknown as { naturalWidth: number }).naturalWidth,
    )).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`watch-later-${viewport.width}.png`) });
    await watchLater.locator('.column-body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(watchLater.locator('.video-item')).toHaveCount(21);
    await expect(watchLater.getByText('21 items', { exact: true })).toBeVisible();
    expect(requestedPages).toEqual(['first', 'synthetic-next']);

    failWatchLater = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Playlists', { exact: true }).click();
    await expect(watchLater.getByRole('alert')).toBeVisible();
    await expect(watchLater.getByText('No items', { exact: true })).toHaveCount(0);
    failWatchLater = false;
    await watchLater.getByTitle('Retry loading playlist', { exact: true }).click();
    await expect(watchLater.getByRole('alert')).toHaveCount(0);
    await expect(watchLater.locator('.video-item')).toHaveCount(20);
    expect(pageErrors).toEqual([]);
  });
}