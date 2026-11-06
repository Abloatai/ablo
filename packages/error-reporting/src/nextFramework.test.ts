import { expect, it, vi } from 'vitest';
const captureException = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { __loaded: true, captureException } }));
import { captureGlobalError } from './nextFramework';
it('captures one normalized render failure with a support ID and redacted message', () => {
  expect(captureGlobalError(new Error('postgres://user:password@host/db'), { eventId: 'support-id' })).toBe('support-id');
  expect(captureException).toHaveBeenCalledOnce();
  expect(captureException.mock.calls[0]?.[1]).toMatchObject({ eventId: 'support-id', handled: false, scope: 'react.global_error' });
  expect(JSON.stringify(captureException.mock.calls)).not.toContain('user:password');
});
it('does not replace a render error when telemetry throws', () => {
  captureException.mockImplementationOnce(() => { throw new Error('Transport unavailable'); });
  expect(() => captureGlobalError(new Error('Render failed'))).not.toThrow();
});
