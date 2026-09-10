import { sanitizeCliEvent } from '../observeCliError';

describe('CLI Sentry events', () => {
  it('preserves typed exception frames and release identity while redacting secrets', () => {
    const event = sanitizeCliEvent({
      type: undefined,
      release: '@abloatai/cli@0.64.4',
      exception: { values: [{
        type: 'CliFailureExit',
        value: 'Cannot connect to postgres://user:password@host/db',
        stacktrace: { frames: [{
          filename: '/app/cli.cjs', function: 'runCheck', lineno: 123, colno: 4,
          in_app: true,
          pre_context: ['const token = "sk_live_abcdefghijklmnop";'],
          context_line: 'process.exit(1);',
          post_context: ['// contact person@example.com'],
        }] },
      }] },
      request: { headers: { authorization: 'Bearer private-value' } },
    });
    expect(event.release).toBe('ablo-cli-0.64.4');
    expect(event.exception?.values?.[0]?.value).toBe('Cannot connect to [redacted]');
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: '/app/cli.cjs', function: 'runCheck', lineno: 123, colno: 4,
      in_app: true, pre_context: ['const token = "[redacted]";'],
      context_line: 'process.exit(1);', post_context: ['// contact [redacted]'],
    });
    expect(event.request?.headers?.authorization).toBe('[redacted]');
  });
});
