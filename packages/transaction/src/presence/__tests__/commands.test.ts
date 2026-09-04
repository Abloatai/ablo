import { describe, expect, it } from '@jest/globals';
import {
  MAX_READ_PRESENCE_TTL_MS,
  parsePresenceCommand,
  presenceCommandSchema,
  redactPresenceActivity,
} from '../index.js';

describe('presence commands', () => {
  it('accepts only bounded client-authored read commands', () => {
    expect(parsePresenceCommand({
      type: 'read.upsert',
      activityId: 'read-1',
      target: { model: 'Document', id: 'doc-1' },
      ttlMs: 30_000,
    })).toMatchObject({ type: 'read.upsert', activityId: 'read-1' });

    expect(presenceCommandSchema.safeParse({
      type: 'claim.upsert',
      activityId: 'claim-1',
      target: { model: 'Document', id: 'doc-1' },
      ttlMs: 30_000,
    }).success).toBe(false);
    expect(presenceCommandSchema.safeParse({
      type: 'read.upsert',
      activityId: 'read-1',
      target: { model: 'Document', id: 'doc-1' },
      ttlMs: MAX_READ_PRESENCE_TTL_MS + 1,
    }).success).toBe(false);
  });

  it.each([
    ['activeClaims', []],
    ['presenceSessionId', 'session-forged'],
    ['syncGroups', ['document:doc-1']],
    ['timestamp', '2026-09-04T10:00:00.000Z'],
    ['operation', 'update'],
    ['version', 3],
  ])('rejects the server-owned %s field', (field, value) => {
    expect(presenceCommandSchema.safeParse({
      type: 'read.upsert',
      activityId: 'read-1',
      target: { model: 'Document', id: 'doc-1' },
      ttlMs: 30_000,
      [field]: value,
    }).success).toBe(false);
  });

  it('rejects the old untyped presence payload', () => {
    expect(presenceCommandSchema.safeParse({
      status: 'online',
      activity: { action: 'reading' },
      activeClaims: [{ claimId: 'forged' }],
    }).success).toBe(false);
  });

  it('redacts internal producer and routing fields from public activities', () => {
    expect(redactPresenceActivity({
      id: 'claim-1',
      version: 1,
      operation: 'claim',
      target: { model: 'Document', id: 'doc-1' },
      source: 'claim',
      startedAt: '2026-09-04T10:00:00.000Z',
      updatedAt: '2026-09-04T10:00:01.000Z',
      expiresAt: '2026-09-04T10:01:00.000Z',
      syncGroups: ['document:doc-1'],
      organizationId: 'org-1',
    })).not.toHaveProperty('syncGroups');
  });
});
