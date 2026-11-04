import { test as base, expect } from '@playwright/test';

export const viewports = [
  { name: 'desktop-1440', width: 1440, height: 900, layout: 'desktop' },
  { name: 'desktop-1024', width: 1024, height: 768, layout: 'desktop' },
  { name: 'tablet-768', width: 768, height: 1024, layout: 'compact' },
  { name: 'mobile-390', width: 390, height: 844, layout: 'compact' },
  { name: 'narrow-320', width: 320, height: 700, layout: 'compact' },
];

/**
 * Every demo test runs against the static production build with all
 * non-origin network traffic blocked, proving the demo has no backend.
 */
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL).origin;
    const blocked = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith('/api')) {
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await use(page);
    expect(blocked, 'demo mode must not request a backend').toEqual([]);
  },
});

export async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, 'page must not scroll horizontally').toBeLessThanOrEqual(overflow.clientWidth);
}

export { expect };
