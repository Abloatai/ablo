import { parseLogsArgs, resolveSince } from '../logs';

describe('resolveSince', () => {
  it('parses relative durations', () => {
    const ago = Date.parse(resolveSince('15m')!);
    expect(Math.abs(Date.now() - 15 * 60_000 - ago)).toBeLessThan(2000);
    const twoHours = Date.parse(resolveSince('2h')!);
    expect(Math.abs(Date.now() - 2 * 3600_000 - twoHours)).toBeLessThan(2000);
  });

  it('passes through an ISO timestamp', () => {
    const iso = '2026-05-01T00:00:00.000Z';
    expect(resolveSince(iso)).toBe(iso);
  });

  it('returns undefined for missing or garbage input', () => {
    expect(resolveSince(undefined)).toBeUndefined();
    expect(resolveSince('not-a-date')).toBeUndefined();
  });
});

describe('parseLogsArgs', () => {
  it('defaults to follow + tail 50', () => {
    expect(parseLogsArgs([])).toEqual({
      follow: true,
      tail: 50,
      since: undefined,
      model: undefined,
      op: undefined,
      json: false,
    });
  });

  it('parses all flags', () => {
    expect(
      parseLogsArgs(['--no-follow', '-n', '100', '--since', '2h', '--model', 'task', '--op', 'create', '--json']),
    ).toEqual({
      follow: false,
      tail: 100,
      since: '2h',
      model: 'task',
      op: 'create',
      json: true,
    });
  });

  it('explains that branch selection replaced --mode', () => {
    expect(() => parseLogsArgs(['--mode', 'production'])).toThrow(/branch bound to ABLO_API_KEY/);
  });
});
