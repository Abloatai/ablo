import type { Config } from 'jest';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const reactRoot = dirname(require.resolve('react'));
const reactDomRoot = dirname(require.resolve('react-dom'));

const config: Config = {
  testEnvironment: 'jest-environment-jsdom',

  setupFilesAfterEnv: ['<rootDir>/src/local/testing/setup/jest.setup.ts'],

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
          // ts-jest 29 still creates a legacy Node10 resolver program while
          // bootstrapping under TypeScript 6. Silence that upstream
          // deprecation so the configured bundler resolver can load tests.
          ignoreDeprecations: '6.0',
          esModuleInterop: true,
          target: 'ES2022',
          // tsconfig.json (merged underneath this inline override) enables
          // verbatimModuleSyntax for the NodeNext build + typed lint. ts-jest
          // emits CommonJS in non-ESM mode, where verbatimModuleSyntax rejects
          // all ESM syntax (TS1286) — so it must stay off for the jest program.
          verbatimModuleSyntax: false,
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
  // (__tests__/unit/server/ + jest.server.config.ts deleted 2026-07-03: the
  // pre-split mutator-stack tests imported modules that moved to
  // apps/sync-server and had been jest-ignored — dead weight, never ran.)
  testPathIgnorePatterns: ['__tests__/e2e/'],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  // NodeNext-style `.js` extensions on relative imports (required by
  // @ablo/core) need to be stripped for Jest's TS resolver to find
  // the `.ts` source file. Matches the "extensions in relative
  // specifiers" pattern recommended by ts-jest docs.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // npm may install this optional peer beneath the workspace while hoisting
    // @testing-library/react to the repository root. Keep the test resolver on
    // the package-owned React instance in either layout.
    '^react$': reactRoot,
    '^react/(.*)$': `${reactRoot}/$1`,
    '^react-dom$': reactDomRoot,
    '^react-dom/(.*)$': `${reactDomRoot}/$1`,
    // @abloatai/transaction (the extracted settlement core, ADR 0013) resolves to
    // its src — jest doesn't follow the package's `@ablo/source` export
    // condition, so map it explicitly, mirroring tsc/dep-cruiser. Directory
    // barrels need their own line: the generic pattern appends `.ts` and
    // cannot land on an `index.ts`.
    '^@abloatai/transaction/(coordination|wire|types|auth|keys|schema|source|server|webhooks|docs)$':
      '<rootDir>/../transaction/src/$1/index.ts',
    '^@abloatai/transaction/(.*)$': '<rootDir>/../transaction/src/$1.ts',
    '^@abloatai/transaction$': '<rootDir>/../transaction/src/index.ts',
    '^@abloatai/humans/react$': '<rootDir>/src/react.ts',
    '^@abloatai/humans/(.*)$': '<rootDir>/src/$1.ts',
    '^@abloatai/humans$': '<rootDir>/src/index.ts',
  },

  testTimeout: 10000,
};

export default config;
