import { test as base, expect } from '@playwright/test';

// One browser identity for the whole local suite: a failed test's session is
// reattached by the next test instead of blocking it with the one-session limit.
const SHARED_SESSION = 'e2eLocalSharedBrowserSession000000000000000';

export const test = base.extend({
  page: async ({ page, context, baseURL }, use) => {
    await context.addCookies([{ name: 'pg_session', value: SHARED_SESSION, url: baseURL, httpOnly: true, sameSite: 'Strict' }]);
    await use(page);
  },
});

export { expect };

export const objective = (page, label) => page.getByRole('listitem').filter({ hasText: label });

/** Open the portal and make sure the requested mission's session is active. */
export async function startMission(page, labId, heading) {
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Mission' })).toBeEnabled({ timeout: 150_000 });
  await expect(page.getByRole('list', { name: 'Session containers' }).or(page.getByText('This session has ended'))).toBeVisible({ timeout: 150_000 });
  if (await page.getByText('This session has ended').isVisible()) {
    await page.getByRole('button', { name: 'Start a new session' }).click();
    await expect(page.getByRole('list', { name: 'Session containers' })).toBeVisible({ timeout: 150_000 });
  }
  if (!(await page.getByRole('heading', { name: heading }).isVisible())) {
    await page.getByRole('combobox', { name: 'Mission' }).selectOption(labId);
    await page.getByRole('button', { name: 'Start new session' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 150_000 });
    await expect(page.getByRole('list', { name: 'Session containers' })).toBeVisible({ timeout: 150_000 });
  }
}

export async function endSession(page) {
  await page.getByRole('button', { name: /Session/ }).click();
  await page.getByRole('menuitem', { name: /End session/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('This session has ended and its resources were removed.')).toBeVisible({ timeout: 60_000 });
}
