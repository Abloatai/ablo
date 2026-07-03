// ESLint flat config for @abloatai/ablo (production doctor plan §4, Tier 3).
//
// Full typescript-eslint strictTypeChecked + stylisticTypeChecked as `error`,
// with pre-existing debt frozen via ESLint bulk suppressions
// (eslint-suppressions.json): NEW violations fail immediately; the baseline
// only ratchets down. After fixing a suppressed violation, run
//   npm run lint:eslint -- --prune-suppressions
// so the freed suppression is removed (CI fails on unpruned entries).
//
// Why parserOptions.project instead of projectService: the TS project service
// auto-discovers only files literally named tsconfig.json, and this package's
// tsconfig.json covers src/ MINUS src/cli and no __tests__/ — the project
// service would refuse to parse tests and the CLI. tsconfig.eslint.json is
// the one lint-only program that covers everything (it mirrors ts-jest's
// inline tsconfig — bundler resolution + `@abloatai/ablo` paths — because
// that's what the tests actually compile under; see its header).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import jestPlugin from 'eslint-plugin-jest';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  globalIgnores([
    'dist/**',
    'coverage/**',
    'node_modules/**',
    // Consumer-facing snippets — not compiled by any tsconfig in this package.
    'examples/**',
    'docs/**',
  ]),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', '__tests__/**/*.ts', '__tests__/**/*.tsx'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // In NO preset — missing union-member cases in switches (delta op
      // kinds, plane store variants) are exactly this codebase's bug shape.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // strictTypeChecked forbids numbers in template literals by default;
      // log lines interpolate counts/syncIds constantly and that's fine.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // The SDK's shipped hooks (useAblo & co). Only the two classic rules —
  // rules-of-hooks correctness + the exhaustive-deps hygiene the existing
  // inline disables in src/react reference (without the plugin registered,
  // those directives themselves error with "definition for rule not found").
  {
    files: ['src/react/**/*.ts', 'src/react/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Jest suites: the base unbound-method rule false-positives on
  // expect(instance.method) / jest mock plumbing — swap in the jest-aware
  // variant (same detection, test-idiom-aware).
  {
    files: ['__tests__/**/*.ts', '__tests__/**/*.tsx', 'src/**/__tests__/**/*.ts'],
    plugins: { jest: jestPlugin },
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'jest/unbound-method': 'error',
    },
  },
  // Plain JS build/docs scripts: untyped.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
