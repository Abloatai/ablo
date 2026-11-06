import { describe, expect, it } from 'vitest';
import { maskSensitiveFields } from './sanitization';

describe('telemetry field sanitization', () => {
  it('redacts secrets through nested arrays while preserving input and safe values', () => {
    const input = {
      records: [{ token: 'synthetic-secret', status: 'ok' }, [null, 7, { password: 'secret' }]],
    };

    expect(maskSensitiveFields(input)).toEqual({
      records: [{ token: '[REDACTED]', status: 'ok' }, [null, 7, { password: '[REDACTED]' }]],
    });
    expect(input.records[0]).toEqual({ token: 'synthetic-secret', status: 'ok' });
  });

  it('honours custom sensitive fields inside arrays', () => {
    expect(maskSensitiveFields({ rows: [{ internalId: 'private', token: 'keep' }] }, ['internalid']))
      .toEqual({ rows: [{ internalId: '[REDACTED]', token: 'keep' }] });
  });

});
