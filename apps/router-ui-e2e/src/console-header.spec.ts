import { expect, type Page, test } from '@playwright/test';
import { CONSOLE_OPERATIONS } from './evidence-fixtures';
import { signIn } from './fixtures';

/**
 * SUP-263: the header leads with the Super Protocol logo, the tab carries its
 * favicon, and the appearance menu offers the theme only — the mockup's accent
 * switcher is gone, along with whatever accent a viewer had saved while it existed.
 */

/** The production build compiles oklch tokens to `lab()`, so compare computed values, not source literals. */
function brandOf(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
}

test.describe('console header', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`leads with the Super Protocol logo in ${theme} mode, without changing the header height`, async ({
      page,
      baseURL,
    }) => {
      await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
      await page.goto('/models');

      const header = page.getByRole('banner');
      const home = header.getByRole('link', { name: 'Super Protocol — console home' });
      await expect(home).toBeVisible();
      await expect(home.locator('svg')).toBeVisible();

      // Leading: left of the breadcrumb trail.
      const logoBox = await home.boundingBox();
      const trailBox = await header.getByRole('navigation', { name: 'breadcrumb' }).boundingBox();
      expect(logoBox && trailBox && logoBox.x + logoBox.width <= trailBox.x).toBeTruthy();

      // No layout jump: the header keeps its 52px.
      expect((await header.boundingBox())?.height).toBe(52);

      // Mono: white on dark, near-black on light — the foreground colour either way.
      const [fill, foreground] = await home
        .locator('svg')
        .evaluate((svg) => [getComputedStyle(svg).fill, getComputedStyle(document.body).color]);
      expect(fill).toBe(foreground);

      await home.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    });
  }

  test('the appearance menu offers the theme and nothing else', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
    await page.goto('/');

    await page.getByRole('button', { name: 'Appearance' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Light', 'Dark', 'System']);
    await expect(menu.getByText('Accent')).toHaveCount(0);
  });

  test('an accent saved by an earlier console is purged and the default indigo applies', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
    await page.addInitScript(() => window.localStorage.setItem('cr-accent', 'lime'));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('cr-accent'))).toBeNull();
    expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBeUndefined();

    // The same brand colour a browser that never saw the switcher gets.
    const fresh = await page.context().newPage();
    await fresh.goto('/');
    await expect(fresh.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect(await brandOf(page)).toBe(await brandOf(fresh));
  });

  test('the tab carries the Super Protocol favicon, PNG plus an .ico fallback', async ({ page, request }) => {
    // Signed out on purpose: the sign-in page is the first tab a visitor sees.
    await page.goto('/login');
    await expect(page.locator('link[rel="icon"][href="/favicon.png"]')).toHaveAttribute('type', 'image/png');
    await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);

    const png = await request.get('/favicon.png');
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toContain('image/png');
    const body = await png.body();
    // 64×64, the landing's own size (IHDR width and height).
    expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([64, 64]);

    const ico = await request.get('/favicon.ico');
    expect(ico.status()).toBe(200);
    // The .ico wraps the very same PNG.
    expect((await ico.body()).subarray(22).equals(body)).toBe(true);
  });
});
