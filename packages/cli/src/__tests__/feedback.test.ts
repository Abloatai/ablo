/**
 * `ablo feedback` argument parsing.
 *
 * The reporter here is usually an agent that has just failed at something else,
 * writing this command from the usage text and one guess. So the cases that
 * matter are the ones where a strict parser would throw away a real report over
 * shell syntax — an unquoted summary, a kind in the wrong slot — and the ones
 * where accepting silently would be worse, like an option nobody defined.
 */

import { parseFeedbackArgs } from '../feedback';

describe('feedback arguments', () => {
  it('reads the kind and the summary', () => {
    const args = parseFeedbackArgs(['docs', 'no page explains claims']);

    expect(args.kind).toBe('docs');
    expect(args.summary).toBe('no page explains claims');
  });

  it('keeps a summary written without quotes', () => {
    const args = parseFeedbackArgs(['bug', 'push', 'failed', 'on', 'an', 'enum']);

    expect(args.summary).toBe('push failed on an enum');
  });

  it('reads the context flags an agent attaches after a failure', () => {
    const args = parseFeedbackArgs([
      'bug',
      'push rejected a valid schema',
      '--command',
      'push',
      '--error-code',
      'schema_unknown_model',
      '--from',
      'claude-code',
      '--yes',
      '--json',
    ]);

    expect(args).toMatchObject({
      command: 'push',
      errorCode: 'schema_unknown_model',
      from: 'claude-code',
      yes: true,
      json: true,
    });
  });

  it('refuses a kind outside the taxonomy, naming the ones that exist', () => {
    expect(() => parseFeedbackArgs(['complaint', 'everything is broken'])).toThrow(
      /bug, docs, feature, friction/
    );
  });

  it('refuses a report with no summary', () => {
    expect(() => parseFeedbackArgs(['bug'])).toThrow(/one line/);
  });

  it('refuses a flag that swallowed the next flag as its value', () => {
    expect(() => parseFeedbackArgs(['bug', 'it broke', '--detail', '--json'])).toThrow(
      /needs a value/
    );
  });

  it('refuses an option nobody defined rather than dropping it', () => {
    expect(() => parseFeedbackArgs(['bug', 'it broke', '--attach', 'src/index.ts'])).toThrow(
      /not an option/
    );
  });

  it('points a long summary at --detail instead of truncating it', () => {
    expect(() => parseFeedbackArgs(['bug', 'x'.repeat(201)])).toThrow(/--detail/);
  });
});
