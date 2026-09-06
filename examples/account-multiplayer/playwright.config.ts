import { defineConfig } from '@playwright/test';
export default defineConfig({
  timeout: 180_000, expect: { timeout: 15_000 },
  testDir: './tests', testMatch: '**/*.spec.ts', workers: 1,
  use: { baseURL: 'http://localhost:5173' },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: false },
});
