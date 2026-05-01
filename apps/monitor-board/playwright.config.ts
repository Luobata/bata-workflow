import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4199',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'MONITOR_GATEWAY_PORT=18787 pnpm dev --port 4199',
    port: 4199,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
