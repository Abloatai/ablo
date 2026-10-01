/**
 * `trimTrailingSlashes` — the one trailing-slash trim every base URL goes
 * through. The time bound is the point: `/\/+$/` retried from each slash in a
 * run and took seconds on the input below.
 */

import { trimTrailingSlashes } from '../baseUrl.js';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://api.example/api///')).toBe('https://api.example/api');
    expect(trimTrailingSlashes('https://api.example/a//b')).toBe('https://api.example/a//b');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays linear on a long run of slashes that does not end the string', () => {
    const hostile = `https://x${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
