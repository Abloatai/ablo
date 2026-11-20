import type { Config } from 'jest';
import { transactionSourceModuleMapper } from './sourceModuleMapper.mjs';

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
          verbatimModuleSyntax: false,
          ignoreDeprecations: '6.0',
        },
      },
    ],
    // uuid 12+ ships ESM only. Compile it to CommonJS like our own sources.
    '^.+/node_modules/uuid/.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, verbatimModuleSyntax: false } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!uuid/)'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Every subpath, derived from this package's own `@ablo/source` exports.
    ...transactionSourceModuleMapper(),
  },
  testTimeout: 10000,
};

export default config;
