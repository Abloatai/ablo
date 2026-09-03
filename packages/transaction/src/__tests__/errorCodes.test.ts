import { errorCodeSpec } from '../errorCodes';

describe('error observability policy', () => {
  it('treats a stopped localhost connector as handled operational telemetry', () => {
    expect(errorCodeSpec('source_connector_not_attached')?.observability).toMatchObject({
      severity: 'warning',
      sentry: 'log',
      pagingEligible: false,
    });
  });
});
