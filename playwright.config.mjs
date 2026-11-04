import { defineConfig, devices } from '@playwright/test';

const DEMO_URL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: DEMO_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'demo',
      testMatch: /demo\/.*\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run preview --workspace @devops-playground/web',
    url: DEMO_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
