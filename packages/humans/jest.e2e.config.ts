import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          target: 'ES2022',
          // tsconfig.json (merged underneath this inline override) enables
          // verbatimModuleSyntax; ts-jest emits CommonJS in non-ESM mode,
          // where that flag rejects all ESM syntax (TS1286) — keep it off.
          verbatimModuleSyntax: false,
        },
      },
    ],
  },

  transformIgnorePatterns: [
    'node_modules/(?!(mobx|mobx-react-lite)/)',
  ],

  testMatch: [
    '<rootDir>/__tests__/e2e/**/*.test.ts(x)?',
  ],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  testTimeout: 30000,
};

export default config;
