import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@ablo/execute-sandbox/runtime': fileURLToPath(
        new URL('../execute-sandbox/src/runtime/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 5_000,
    hookTimeout: 10_000,
  },
});
