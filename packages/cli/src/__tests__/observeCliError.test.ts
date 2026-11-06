import { expect, it } from '@jest/globals';
import { CliFailureExit, observeCliError } from '../observeCliError';
it('preserves the original failure without telemetry configuration', () => {
  const error = new CliFailureExit(2);
  expect(error.exitCode).toBe(2);
  expect(() => observeCliError(error)).not.toThrow();
});
