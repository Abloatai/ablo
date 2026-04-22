import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'jest-environment-jsdom',

  setupFilesAfterEnv: ['<rootDir>/src/testing/setup/jest.setup.ts'],

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          target: 'ES2022',
        },
      },
    ],
  },

  transformIgnorePatterns: [
    'node_modules/(?!(mobx|mobx-react-lite)/)',
  ],

  testMatch: [
    '<rootDir>/__tests__/unit/**/*.test.ts(x)?',
    '<rootDir>/__tests__/integration/**/*.test.ts(x)?',
    '<rootDir>/__tests__/contract/**/*.test.ts(x)?',
    '<rootDir>/__tests__/property/**/*.test.ts(x)?',
    '<rootDir>/src/**/__tests__/**/*.test.ts(x)?',
  ],

  // E2E tests excluded — run via jest.e2e.config.ts
  // Server tests excluded — run via jest.server.config.ts (Node env, no jsdom)
  testPathIgnorePatterns: ['__tests__/e2e/', '__tests__/unit/server/'],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  // NodeNext-style `.js` extensions on relative imports (required by
  // @ablo/core) need to be stripped for Jest's TS resolver to find
  // the `.ts` source file. Matches the "extensions in relative
  // specifiers" pattern recommended by ts-jest docs.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  testTimeout: 10000,
};

export default config;
