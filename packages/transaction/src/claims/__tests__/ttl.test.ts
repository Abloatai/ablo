import { claimHeartbeatRequestSchema, claimRequestSchema } from '../contract.js';

describe('claim duration boundaries', () => {
  it.each([
    0, -1, '0s', '0ms', '00h', '0.0m', 1e30, 1e308,
    `${'9'.repeat(310)}h`, '2147483648ms', 2_147_483.648,
    'garbage', '.5s', '1.s', `0.${'0'.repeat(330)}1ms`,
  ])('refuses invalid or unsafe ttl %s at both HTTP boundaries', ttl => {
    expect(claimRequestSchema.safeParse({ ttl }).success).toBe(false);
    expect(claimHeartbeatRequestSchema.safeParse({ ttl }).success).toBe(false);
  });

  it.each([undefined, null, '0.5ms', '24h', '2147483647ms', 2_147_483.647])(
    'preserves valid ttl %s', ttl => {
      expect(claimRequestSchema.safeParse({ ttl }).success).toBe(true);
      expect(claimHeartbeatRequestSchema.safeParse({ ttl }).success).toBe(true);
    },
  );
});
