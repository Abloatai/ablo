import { describe, expect, it } from '@jest/globals';
import { ephemeralKeyRequestSchema } from '../../wire/auth.js';
import { EphemeralKeyResponseSchema } from '../schemas.js';

describe('ephemeralKeyRequestSchema', () => {
  it('accepts a concrete non-empty operation grant', () => {
    expect(
      ephemeralKeyRequestSchema.parse({
        user: { id: 'user-1' },
        operations: ['item.read', 'item.update'],
      }),
    ).toMatchObject({
      user: { id: 'user-1' },
      operations: ['item.read', 'item.update'],
    });
  });

  it.each([
    { user: { id: 'user-1' } },
    { user: { id: 'user-1' }, operations: [] },
    { user: { id: 'user-1' }, operations: ['*.*'] },
    { userId: 'user-1', operations: ['item.read'] },
  ])('rejects an absent, empty, or wildcard grant: %o', (request) => {
    expect(ephemeralKeyRequestSchema.safeParse(request).success).toBe(false);
  });

  it('requires shared-schema coordinates as one atomic pair', () => {
    expect(
      ephemeralKeyRequestSchema.safeParse({
        user: { id: 'user-1' },
        operations: ['item.read'],
        schemaProjectId: 'project-1',
      }).success,
    ).toBe(false);
  });

  it('accepts the control-plane-only grant form on its own', () => {
    expect(
      ephemeralKeyRequestSchema.parse({
        user: { id: 'user-1' },
        controlPlaneOnly: true,
      }),
    ).toMatchObject({ user: { id: 'user-1' }, controlPlaneOnly: true });
  });

  it.each([
    { user: { id: 'user-1' }, controlPlaneOnly: true, operations: ['item.read'] },
    { user: { id: 'user-1' }, controlPlaneOnly: true, activeSchemaOperations: ['read'] },
    { user: { id: 'user-1' }, controlPlaneOnly: false },
  ])('rejects control-plane-only combined with a data grant, or false: %o', (request) => {
    expect(ephemeralKeyRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('EphemeralKeyResponseSchema', () => {
  const base = {
    id: 'ek_key_1',
    token: 'ek_test_secret',
    expiresAt: '2026-07-28T00:00:00.000Z',
    organizationId: 'org-1',
    participantId: 'user-1',
    syncGroups: ['org:org-1'],
  };

  it('accepts a control-plane-only echo with no operations', () => {
    expect(
      EphemeralKeyResponseSchema.safeParse({
        ...base,
        operations: [],
        controlPlaneOnly: true,
      }).success,
    ).toBe(true);
  });

  it('rejects a data session echoed with an empty grant', () => {
    expect(
      EphemeralKeyResponseSchema.safeParse({ ...base, operations: [] }).success,
    ).toBe(false);
  });
});
