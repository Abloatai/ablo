/**
 * Glob → regex translation used by every in-memory backend.
 *
 * Semantics matching minimatch/picomatch:
 * - `*`        — any chars except `/`
 * - `?`        — single non-`/` char
 * - `/**\/`    — zero or more directories (so `/x/**\/y` matches `/x/y` AND `/x/a/y`)
 * - `/**$`     — anything (including nothing) at end of pattern
 */
export function globToRegex(pattern: string): RegExp {
  let processed = pattern
    .replace(/\/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\/\*\*$/g, '__GLOBSTAR_END__');

  processed = processed.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  processed = processed
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  processed = processed
    .replace(/__GLOBSTAR_SLASH__/g, '(?:/[^/]+)*/')
    .replace(/__GLOBSTAR_END__/g, '(?:/.*)?');

  return new RegExp(`^${processed}$`);
}
