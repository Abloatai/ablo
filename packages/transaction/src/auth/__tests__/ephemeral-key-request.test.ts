import { describe, expect, it } from '@jest/globals';
import { ephemeralKeyRequestSchema } from '../../wire/auth.js';

describe('ephemeralKeyRequestSchema', () => {
  it('accepts a concrete non-empty operation grant', () => {
    expect(
      ephemeralKeyRequestSchema.parse({
        user: { id: 'user-1' },
        operations: ['task.read', 'task.update'],
      }),
    ).toMatchObject({
      user: { id: 'user-1' },
      operations: ['task.read', 'task.update'],
    });
  });

  it.each([
    { user: { id: 'user-1' } },
    { user: { id: 'user-1' }, operations: [] },
    { user: { id: 'user-1' }, operations: ['*.*'] },
    { userId: 'user-1', operations: ['task.read'] },
  ])('rejects an absent, empty, or wildcard grant: %o', (request) => {
    expect(ephemeralKeyRequestSchema.safeParse(request).success).toBe(false);
  });

  it('requires shared-schema coordinates as one atomic pair', () => {
    expect(
      ephemeralKeyRequestSchema.safeParse({
        user: { id: 'user-1' },
        operations: ['task.read'],
        schemaProjectId: 'project-1',
      }).success,
    ).toBe(false);
  });
});
