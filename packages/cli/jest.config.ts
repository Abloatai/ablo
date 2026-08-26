import type { Config } from 'jest';
import { transactionSourceModuleMapper } from '../transaction/sourceModuleMapper.mjs';

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
    // @abloatai/transaction (the extracted confirmation core, ADR 0013) resolves
    // to its src — jest's resolver does not follow the `@ablo/source` export
    // condition, so every subpath is derived from that package's own exports.
    ...transactionSourceModuleMapper(),
  },

  testTimeout: 10000,
};

export default config;
