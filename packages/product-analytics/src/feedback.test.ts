import { describe, expect, it } from 'vitest';
import {
  agentFeedbackSchema,
  feedbackClusterKey,
  MAX_FEEDBACK_SUMMARY_LENGTH,
} from './feedback';

function feedback(overrides: Partial<Parameters<typeof feedbackClusterKey>[0]> = {}) {
  return {
    kind: 'bug' as const,
    summary: 'push failed',
    context: {},
    ...overrides,
  };
}

describe('feedback cluster key', () => {
  it('groups two reports of one wall that differ only in the identifiers', () => {
    const first = feedbackClusterKey(feedback({ summary: 'model order_2 was not found' }));
    const second = feedbackClusterKey(feedback({ summary: 'model order_37 was not found' }));

    expect(first).toBe(second);
  });

  it('groups reports whose quoted fragment differs', () => {
    const first = feedbackClusterKey(feedback({ summary: 'field "createdBy" is required' }));
    const second = feedbackClusterKey(feedback({ summary: 'field "teamId" is required' }));

    expect(first).toBe(second);
  });

  it('groups reports carrying different request ids', () => {
    const first = feedbackClusterKey(
      feedback({ summary: 'commit rejected 0198a785-77d3-7397-aa80-3a69fa9a895a' })
    );
    const second = feedbackClusterKey(
      feedback({ summary: 'commit rejected 0198a785-77d3-7397-aa80-3a69fa9a895b' })
    );

    expect(first).toBe(second);
  });

  it('separates the same wording under different error codes', () => {
    const first = feedbackClusterKey(
      feedback({ summary: 'push failed', context: { errorCode: 'schema_unknown_model' } })
    );
    const second = feedbackClusterKey(
      feedback({ summary: 'push failed', context: { errorCode: 'cli_api_key_missing' } })
    );

    expect(first).not.toBe(second);
  });

  it('separates the same wording reported as different kinds', () => {
    expect(feedbackClusterKey(feedback({ kind: 'bug' }))).not.toBe(
      feedbackClusterKey(feedback({ kind: 'docs' }))
    );
  });

  it('separates genuinely different walls', () => {
    const first = feedbackClusterKey(feedback({ summary: 'push failed on an enum field' }));
    const second = feedbackClusterKey(feedback({ summary: 'the docs never mention claims' }));

    expect(first).not.toBe(second);
  });

  it('is stable across runs', () => {
    expect(feedbackClusterKey(feedback())).toBe(feedbackClusterKey(feedback()));
  });
});

describe('agent feedback schema', () => {
  const valid = {
    feedbackVersion: 1,
    submissionId: '0198a785-77d3-7397-aa80-3a69fa9a895a',
    occurredAt: '2026-08-18T12:00:00.000Z',
    kind: 'friction',
    summary: 'connecting took four commands that could have been one',
  };

  it('defaults the context so a reporter that knows nothing can still report', () => {
    const parsed = agentFeedbackSchema.parse(valid);

    expect(parsed.context).toEqual({});
  });

  it('refuses a summary longer than one line', () => {
    const result = agentFeedbackSchema.safeParse({
      ...valid,
      summary: 'x'.repeat(MAX_FEEDBACK_SUMMARY_LENGTH + 1),
    });

    expect(result.success).toBe(false);
  });

  it('refuses an unknown field rather than dropping it silently', () => {
    const result = agentFeedbackSchema.safeParse({ ...valid, repositoryContents: 'everything' });

    expect(result.success).toBe(false);
  });

  it('refuses an empty summary', () => {
    expect(agentFeedbackSchema.safeParse({ ...valid, summary: '   ' }).success).toBe(false);
  });
});
