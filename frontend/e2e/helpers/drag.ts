import type { Locator, Page } from '@playwright/test';

/**
 * @dnd-kit's PointerSensor ignores Playwright's `locator.dragTo()`: it needs a real
 * pointer-down, several intermediate moves that clear the 5px activation distance,
 * and a separate frame for the drop so the sortable transform settles.
 */
export async function dndKitDrag(page: Page, handle: Locator, target: Locator) {
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('dndKitDrag: source or target has no bounding box');

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Clear the 5px activation constraint with small discrete moves — a single jump
  // is coalesced by the browser and dnd-kit never starts the drag.
  const direction = Math.sign(endX - startX) || 1;
  for (const dx of [3, 8, 16, 32]) {
    await page.mouse.move(startX + dx * direction, startY);
    await page.waitForTimeout(20);
  }

  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(100);
  // Settle on the target so dnd-kit's collision detection registers the final `over`.
  await page.mouse.move(endX, endY);
  await page.waitForTimeout(100);

  await page.mouse.up();
}
