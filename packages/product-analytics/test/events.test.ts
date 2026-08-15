import { describe, expect, it } from 'vitest';

import {
  MAX_PRODUCT_EVENT_BATCH_SIZE,
  productEventBatchSchema,
  productEventSchema,
} from '../src/events';

const validEvent = {
  producerEventId: '0198a785-77d3-7397-aa80-3a69fa9a895a',
  eventVersion: 1,
  occurredAt: '2026-08-13T12:00:00.000Z',
  eventName: 'cli_init_started',
  properties: {
    cliVersion: '0.51.0',
    nodeMajorVersion: 24,
    os: 'darwin',
    architecture: 'arm64',
    interactive: true,
    source: 'direct',
  },
} as const;

describe('product event contract', () => {
  it('accepts a known event with only allowlisted properties', () => {
    expect(productEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('rejects unknown event names', () => {
    expect(() => productEventSchema.parse({ ...validEvent, eventName: 'npm_install' })).toThrow();
  });

  it('rejects unknown properties', () => {
    expect(() =>
      productEventSchema.parse({
        ...validEvent,
        properties: { ...validEvent.properties, workingDirectory: '/secret' },
      })
    ).toThrow();
  });

  it('does not accept trusted scope from a client', () => {
    expect(() => productEventSchema.parse({ ...validEvent, organizationId: 'org_123' })).toThrow();
  });

  it('caps ingest batch size', () => {
    expect(() =>
      productEventBatchSchema.parse({
        events: Array.from({ length: MAX_PRODUCT_EVENT_BATCH_SIZE + 1 }, () => validEvent),
      })
    ).toThrow();
  });
});
