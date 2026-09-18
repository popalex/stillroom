import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', workers: 1, timeout: 60_000, fullyParallel: false,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec tsx tests/e2e/start-server.ts',
    url: 'http://localhost:4173/api/status', timeout: 30_000, reuseExistingServer: false,
  },
});
