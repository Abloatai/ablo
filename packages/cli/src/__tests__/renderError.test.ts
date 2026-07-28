import { renderCliError } from '../renderError';
import { AbloError } from '@abloatai/transaction/errors';

/** Strip ANSI so assertions match regardless of picocolors' TTY detection. */
const clean = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

/** Render to an in-memory sink; restore process.exitCode so tests don't leak it. */
function capture(err: unknown, verbose = false): string {
  const prev = process.exitCode;
  const lines: string[] = [];
  renderCliError(err, { write: (l) => lines.push(l), verbose });
  process.exitCode = prev;
  return clean(lines.join('\n'));
}

describe('renderCliError', () => {
  it('renders an AbloError as a structured block — code, message, field, docs, ref — and NO stack', () => {
    const err = new AbloError('Your API key is invalid.', {
      code: 'apikey_invalid',
      httpStatus: 401,
      param: 'apiKey',
      requestId: 'req_abc123',
    });
    const out = capture(err);

    expect(out).toContain('[apikey_invalid]');
    expect(out).toContain('Your API key is invalid.');
    expect(out).toContain('apiKey');
    expect(out).toContain('https://docs.abloatai.com/errors#apikey_invalid');
    expect(out).toContain('req_abc123');
    // The whole point: no stack frames, no raw object dump.
    expect(out).not.toMatch(/\n\s+at /);
    expect(out).not.toContain('requestBodyValues');
  });

  it('sets process.exitCode = 1', () => {
    const prev = process.exitCode;
    renderCliError(new AbloError('boom', { code: 'apikey_invalid' }), { write: () => {} });
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
  });

  it('shows the stack only under verbose', () => {
    const err = new AbloError('boom', { code: 'apikey_invalid' });
    expect(capture(err, false)).not.toMatch(/\n\s+at /);
    expect(capture(err, true)).toMatch(/at /);
  });

  it('renders a plain Error as one line with a verbose hint, never a dump', () => {
    const out = capture(new Error('something broke'));
    expect(out).toContain('something broke');
    expect(out).toContain('Run with --verbose');
    expect(out).not.toMatch(/\n\s+at /);
  });

  it('brands every error block with `ablo` so it is clearly ours', () => {
    // The plain-Error path has no docs URL, so `ablo` can only come from the brand marker.
    expect(capture(new Error('something broke'))).toContain('ablo');
    expect(capture(new AbloError('boom', { code: 'apikey_invalid' }))).toContain('ablo');
  });

  it('renders known details (missingIds, retryAfter) compactly, not as a JSON dump', () => {
    const err = new AbloError('Some rows were not found.', {
      code: 'apikey_invalid',
      details: { missingIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    });
    const out = capture(err);
    expect(out).toContain('a, b, c, d, e');
    expect(out).toContain('(+2 more)');
    // not the raw array dump
    expect(out).not.toContain('"missingIds"');
  });
});

describe('renderCliError — machine mode (--json / ABLO_JSON=1)', () => {
  function captureJson(err: unknown): string {
    const prev = process.exitCode;
    const lines: string[] = [];
    renderCliError(err, { write: (l) => lines.push(l), json: true });
    process.exitCode = prev;
    return lines.join('\n');
  }

  it('emits the canonical error envelope as one parseable line — the shape the API serves', () => {
    const out = captureJson(
      new AbloError('Your API key is invalid.', {
        code: 'apikey_invalid',
        httpStatus: 401,
        requestId: 'req_abc123',
        details: { retryAfterSeconds: 5 },
      })
    );
    expect(out.split('\n')).toHaveLength(1);
    const body = JSON.parse(out) as Record<string, unknown>;
    // The fields an agent branches on, structured — nothing to scrape from
    // colored text. Details spread flat, matching AbloError.toJSON.
    expect(body).toMatchObject({
      type: 'AbloError',
      code: 'apikey_invalid',
      message: 'Your API key is invalid.',
      doc_url: 'https://docs.abloatai.com/errors#apikey_invalid',
      request_id: 'req_abc123',
      retryAfterSeconds: 5,
    });
  });

  it('coerces a plain throw into the same envelope, keeping its message', () => {
    const body = JSON.parse(captureJson(new Error('something broke'))) as Record<string, unknown>;
    expect(body.message).toBe('something broke');
    expect(typeof body.type).toBe('string');
  });

  it('sets process.exitCode = 1 in machine mode too', () => {
    const prev = process.exitCode;
    renderCliError(new AbloError('boom', { code: 'apikey_invalid' }), {
      write: () => {},
      json: true,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
  });
});

describe('AbloError.toString()', () => {
  it('is a single leak-proof line: name [code]: message (see docs) [request_id]', () => {
    const err = new AbloError('Your API key is invalid.', {
      code: 'apikey_invalid',
      requestId: 'req_xyz',
      details: { secret: 'should-not-appear' },
    });
    const s = err.toString();
    expect(s).toBe(
      'AbloError [apikey_invalid]: Your API key is invalid. (see https://docs.abloatai.com/errors#apikey_invalid) [request_id: req_xyz]',
    );
    expect(s).not.toContain('should-not-appear');
    expect(s).not.toContain('\n');
  });
});
