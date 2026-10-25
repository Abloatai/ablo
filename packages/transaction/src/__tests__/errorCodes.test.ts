import { classifyRecovery, errorCodeSpec } from '../errorCodes';
import { AbloError, AbloIdempotencyError, errorFromWire } from '../errors';

describe('error observability policy', () => {
  it('treats a stopped localhost connector as handled operational telemetry', () => {
    expect(errorCodeSpec('source_connector_not_attached')?.observability).toMatchObject({
      severity: 'warning',
      sentry: 'log',
      pagingEligible: false,
    });
  });
});

describe('decision contention', () => {
  it('stays retryable without becoming an idempotency conflict at the wire boundary', () => {
    const error = errorFromWire('Another transaction is evaluating the same decision rows.', {
      code: 'decision_contended',
      httpStatus: 409,
    });

    expect(error).toBeInstanceOf(AbloError);
    expect(error).not.toBeInstanceOf(AbloIdempotencyError);
    expect(error).toMatchObject({ code: 'decision_contended', retryable: true });
  });
});

describe('change subscription recovery', () => {
  it('retries interrupted delivery without treating it as credential expiry', () => {
    expect(classifyRecovery('subscription_delivery_unavailable')).toBe('transient');
    const error = errorFromWire('Subscription delivery is reconnecting.', {
      code: 'subscription_delivery_unavailable',
      httpStatus: 503,
    });
    expect(error).toMatchObject({ code: 'subscription_delivery_unavailable', retryable: true });
  });
});
