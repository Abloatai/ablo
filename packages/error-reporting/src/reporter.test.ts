import { expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { ErrorReporter } from './reporter';
import { sanitizePostHogProperties } from './posthog';

vi.mock('posthog-js', () => ({ default: { __loaded: true, captureException: vi.fn() } }));

it('preserves chunk lookup URLs until the SDK parses them, then removes query data before export', () => {
  const url = 'https://example.test/main.js?dpl=dpl_publicDeployment&token=private';
  const error = new Error('Failed with sk_abcdefghijklmnop');
  error.stack = `Error: ${error.message}\n    at render (${url}:2:40)`;
  const eventId = ErrorReporter.captureError(error, { feature: 'render' });
  const [captured, properties] = vi.mocked(posthog.captureException).mock.calls.at(-1)!;

  expect(eventId).toBeTruthy();
  expect(captured).toBeInstanceOf(Error);
  expect((captured as Error).stack).toContain(url);
  expect((captured as Error).message).not.toContain('sk_abcdefghijklmnop');
  expect(JSON.stringify(properties)).not.toContain('token=private');
  const exported = sanitizePostHogProperties({ $exception_list: [{ stacktrace: { frames: [{
    filename: url, lineno: 2, colno: 40, chunk_id: 'matching-chunk',
  }] } }] });
  expect(exported.$exception_list[0].stacktrace.frames[0]).toEqual({
    filename: 'https://example.test/main.js', lineno: 2, colno: 40, chunk_id: 'matching-chunk',
  });
});
