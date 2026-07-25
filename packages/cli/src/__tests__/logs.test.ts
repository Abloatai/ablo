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
      mode: undefined,
    });
  });

  it('parses all flags', () => {
    expect(
      parseLogsArgs(['--no-follow', '-n', '100', '--since', '2h', '--model', 'task', '--op', 'create', '--json', '--mode', 'production']),
    ).toEqual({
      follow: false,
      tail: 100,
      since: '2h',
      model: 'task',
      op: 'create',
      json: true,
      mode: 'production',
    });
  });

  it('rejects an invalid --mode', () => {
    expect(() => parseLogsArgs(['--mode', 'prod'])).toThrow(/sandbox.*production/);
  });
});
