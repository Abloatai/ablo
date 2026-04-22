/**
 * Jest config for @ablo/sync-engine/server tests.
 *
 * Uses node environment (no jsdom, no browser globals) and skips the
 * default setupFilesAfterSetup which references document.visibilityState.
 * Server-side code must not depend on browser APIs.
 */
import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',

  // NO setupFilesAfterSetup — the default jest.setup.ts uses `document`
  // which doesn't exist in Node. Server tests are headless by design.
  setupFilesAfterEnv: [],

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          target: 'ES2022',
        },
      },
    ],
  },

  testMatch: [
    '<rootDir>/__tests__/unit/server/**/*.test.ts',
  ],
};

export default config;
