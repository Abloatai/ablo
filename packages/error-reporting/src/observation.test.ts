import { afterEach, describe, expect, it } from 'vitest';
import { buildWebErrorObservation } from './observation';

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ABLO_STAGE;
  delete process.env.NEXT_PUBLIC_ABLO_RELEASE;
});

describe('buildWebErrorObservation', () => {
  it('normalizes framework failures into stable correlation and tenant fields', () => {
    process.env.NEXT_PUBLIC_ABLO_STAGE = 'preview';
    process.env.NEXT_PUBLIC_ABLO_RELEASE = 'sha-test';
    const observation = buildWebErrorObservation(new Error('render failed'), {
      eventId: 'event-test',
      requestId: 'request-test',
      feature: 'react.global_error',
      action: 'render',
      handled: false,
      organizationId: 'org_test',
      projectId: 'proj_test',
      branchId: 'br_test',
    });

    expect(observation).toMatchObject({
      eventId: 'event-test',
      requestId: 'request-test',
      service: 'sync-web',
      stage: 'preview',
      release: 'sha-test',
      scope: 'react.global_error',
      operation: 'render',
      errorCode: 'internal_error',
      handled: false,
      organizationId: 'org_test',
      projectId: 'proj_test',
      branchId: 'br_test',
    });
  });

  it('sanitizes secrets in error text and diagnostic context', () => {
    const observation = buildWebErrorObservation(
      new Error('failed with sk_abcdefghijklmnop'),
      { metadata: { authorization: 'Bearer secret' } },
    );
    expect(observation.internalMessage).not.toContain('sk_abcdefghijklmnop');
    expect(observation.diagnosticContext).toEqual({ authorization: '[redacted]' });
  });

  it('bounds oversized errors instead of discarding the observation', () => {
    const observation = buildWebErrorObservation(new Error('x'.repeat(5_001)));

    expect(observation.publicMessage).toHaveLength(2_000);
    expect(observation.publicMessage.endsWith('…[truncated]')).toBe(true);
    expect(observation.internalMessage).toHaveLength(4_000);
    expect(observation.internalMessage?.endsWith('…[truncated]')).toBe(true);
    expect(observation.stack?.length).toBeLessThanOrEqual(20_000);
  });
});
