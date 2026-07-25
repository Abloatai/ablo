import type { Config } from 'jest';

const config: Config = {
  // The CLI is a terminal process — node environment, no DOM polyfills.
  testEnvironment: 'jest-environment-node',

  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          target: 'ES2022',
          ignoreDeprecations: '6.0',
          // tsconfig.json enables verbatimModuleSyntax for the bundler build.
          // ts-jest emits CommonJS in non-ESM mode, where verbatimModuleSyntax
          // rejects all ESM syntax (TS1286) — so it must stay off here.
          verbatimModuleSyntax: false,
        },
      },
    ],
  },

  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Workspace packages resolve to their src — jest's runtime resolver does
    // not follow the `@ablo/source` export condition, so map them explicitly,
    // mirroring tsc. Directory barrels need their own line: the generic
    // pattern appends `.ts` and cannot land on an `index.ts`.
    '^@ablo/transaction/(coordination|wire|types|auth|keys|schema|source|server|webhooks|docs)$':
      '<rootDir>/../transaction/src/$1/index.ts',
    '^@ablo/transaction/(.*)$': '<rootDir>/../transaction/src/$1.ts',
    '^@ablo/transaction$': '<rootDir>/../transaction/src/index.ts',
  },

  testTimeout: 10000,
};

export default config;
