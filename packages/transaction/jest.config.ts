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
          verbatimModuleSyntax: false,
          ignoreDeprecations: '6.0',
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@ablo/transaction/(coordination|wire|types|auth|keys|schema|source|server|webhooks)$':
      '<rootDir>/src/$1/index.ts',
    '^@ablo/transaction/(.*)$': '<rootDir>/src/$1.ts',
    '^@ablo/transaction$': '<rootDir>/src/index.ts',
  },
  testTimeout: 10000,
};

export default config;
