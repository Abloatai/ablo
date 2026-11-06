import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createObservability } from './server';
import { sanitizePostHogProperties } from './posthog';

it('sends real SDK exceptions and OTLP logs with support IDs and redacted frames', async () => {
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let bytes = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
    requests.push({ path: request.url!, body: JSON.parse(bytes.toString()) });
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing collector address');
  const telemetry = createObservability('test-service', {
    host: `http://127.0.0.1:${address.port}`, projectToken: 'phc_test', environment: 'verification', release: 'test-release',
  });
  try {
    telemetry.capture(new Error('Cannot connect postgres://user:password@host/db'),
      { eventId: 'support-id', branchId: 'br_root_f106e837404aee748952c4b188adda39', authorization: 'Bearer private', handled: true, severity: 'warning' }, 'stable-fingerprint');
    telemetry.log('Expected rejection', { eventId: 'log-id', password: 'private' });
    expect(await telemetry.flush()).toBe(true);
    const exception = requests.flatMap(request => request.body.batch ?? []).find(event => event.event === '$exception');
    expect(exception.properties).toMatchObject({ eventId: 'support-id', branchId: 'br_root_f106e837404aee748952c4b188adda39', environment: 'verification',
      $exception_fingerprint: 'stable-fingerprint', $process_person_profile: false, $exception_level: 'warning' });
    expect(exception.properties.$exception_list[0].mechanism.handled).toBe(true);
    expect(exception.properties.$exception_list[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(requests.find(request => request.path === '/i/v1/logs')?.body.resourceLogs[0].scopeLogs[0].logRecords[0])
      .toMatchObject({ severityText: 'WARN', body: { stringValue: 'Expected rejection' } });
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain('user:password');
    expect(wire).not.toContain('Bearer private');
    expect(wire).not.toContain('"private"');
  } finally {
    await telemetry.client.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('preserves source-map coordinates but drops locals, source text and captured PII', () => {
  const safe = sanitizePostHogProperties({ $current_url: 'https://example.test/path?token=private#private', $ip: '192.0.2.1', $set: { email: 'person@example.com' },
    $exception_list: [{ type: 'Error', value: 'person@example.com', stacktrace: { frames: [{
      filename: '/app/index.mjs', function: 'read', lineno: 123, colno: 4, chunk_id: 'debug-id',
      vars: { secret: 'private' }, context_line: 'private source code',
    }] } }],
  });
  expect(safe.$exception_list[0].stacktrace.frames[0]).toEqual({
    filename: '/app/index.mjs', function: 'read', lineno: 123, colno: 4, chunk_id: 'debug-id',
  });
  expect(safe.$current_url).toBe('https://example.test/path');
  expect(JSON.stringify(safe)).not.toMatch(/private|person@example|192\.0\.2/);
});


it('preserves the browser SDK public ingestion token while redacting private credentials', () => {
  expect(sanitizePostHogProperties({ token: 'phc_publicProjectToken' }).token).toBe('phc_publicProjectToken');
  expect(sanitizePostHogProperties({ token: 'phx_privateApiToken' }).token).toBe('[redacted]');
  expect(sanitizePostHogProperties({ authorization: 'Bearer private' }).authorization).toBe('[redacted]');
});
