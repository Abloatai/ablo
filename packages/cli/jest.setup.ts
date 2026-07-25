/**
 * Jest setup for @abloatai/cli tests.
 *
 * CLI tests run without a network: any fetch a test does not explicitly mock
 * rejects loudly instead of escaping to the real thing.
 */

if (typeof globalThis.fetch === 'undefined') {
  (globalThis as Record<string, unknown>).fetch = jest.fn();
} else {
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    jest.fn(() => Promise.reject(new Error('fetch not mocked for this test')))
  );
}
