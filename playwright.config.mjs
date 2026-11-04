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
    {
      // Real local Docker through the packaged portal (started by scripts/e2e-local.js).
      name: 'local',
      testMatch: /local\/.*\.spec\.mjs/,
      fullyParallel: false,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${process.env.PLAYGROUND_PORT ?? 3001}` },
    },
  ],
  // The static preview serves the demo project; the local project targets the packaged portal.
  webServer: process.env.PLAYGROUND_E2E_LOCAL ? undefined : {
    command: 'npm run preview --workspace @devops-playground/web',
    url: DEMO_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
