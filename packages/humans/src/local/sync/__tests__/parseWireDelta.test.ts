/**
 * Contract-equivalence test pinning `parseWireDelta` against the canonical
 * `clientSyncDeltaSchema.safeParse` (+ SyncWebSocket's receive-boundary
 * server-compat normalization) across 50+ valid, invalid, and edge-case
 * fixtures.
 */

import { describe, expect, it } from '@jest/globals';
import { clientSyncDeltaSchema, type ClientSyncDelta } from '@abloatai/transaction/observation';
import { parseWireDelta } from '../parseWireDelta.js';
import { isRecord } from '../wsFrameHandlers.js';

/** Reference implementation: exact previous SyncWebSocket.parseWireDelta logic. */
function referenceParseWireDelta(raw: unknown): ClientSyncDelta | null {
  let candidate: unknown = raw;
  if (isRecord(raw)) {
    const normalized: Record<string, unknown> = { ...raw };
    if (typeof normalized.id !== 'number') {
      const coerced = Number(normalized.id);
      normalized.id = Number.isFinite(coerced) ? coerced : 0;
    }
    if (normalized.transactionId === null) delete normalized.transactionId;
    if (normalized.createdBy !== undefined && typeof normalized.createdBy !== 'string') {
      delete normalized.createdBy;
    }
    candidate = normalized;
  }
  const parsed = clientSyncDeltaSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function validBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    actionType: 'U',
    modelName: 'Issue',
    modelId: 'issue-1',
    data: { id: 'issue-1', title: 'hello' },
    syncGroups: ['org:org-1'],
    createdAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

class CustomInstance {
  id = 'custom-1';
  title = 'not a plain object';
}

const VALID_FIXTURES: { name: string; input: unknown }[] = [
  { name: 'minimal valid update delta', input: validBase() },
  { name: 'action I (insert)', input: validBase({ actionType: 'I' }) },
  { name: 'action D (delete with null data)', input: validBase({ actionType: 'D', data: null }) },
  { name: 'action A (archive)', input: validBase({ actionType: 'A' }) },
  { name: 'action V (revive)', input: validBase({ actionType: 'V' }) },
  { name: 'action C (covering)', input: validBase({ actionType: 'C' }) },
  {
    name: 'action G (group added with string data)',
    input: validBase({ id: 0, actionType: 'G', data: '{"addedGroups":["g1"]}' }),
  },
  {
    name: 'action S (group removed with string data)',
    input: validBase({ actionType: 'S', data: '{"group":"g1","userId":"u1"}' }),
  },
  { name: 'empty syncGroups array', input: validBase({ syncGroups: [] }) },
  { name: 'multi syncGroups array', input: validBase({ syncGroups: ['org:1', 'team:2', 'user:3'] }) },
  { name: 'id zero', input: validBase({ id: 0 }) },
  { name: 'negative numeric id', input: validBase({ id: -5 }) },
  { name: 'floating point numeric id', input: validBase({ id: 12.5 }) },
  { name: 'string BIGINT id coerced to number', input: validBase({ id: '9007199254740991' }) },
  { name: 'non-numeric string id coerced to 0', input: validBase({ id: 'not-a-num' }) },
  { name: 'undefined id coerced to 0', input: validBase({ id: undefined }) },
  { name: 'null id coerced to 0', input: validBase({ id: null }) },
  { name: 'boolean id coerced to 1', input: validBase({ id: true }) },
  { name: 'string Infinity id coerced to 0', input: validBase({ id: 'Infinity' }) },
  { name: 'server-shaped transactionId: null normalized to absent', input: validBase({ transactionId: null }) },
  { name: 'valid string transactionId preserved', input: validBase({ transactionId: 'tx-123' }) },
  { name: 'empty string transactionId preserved', input: validBase({ transactionId: '' }) },
  { name: 'nested ParticipantRef createdBy normalized to absent', input: validBase({ createdBy: { kind: 'user', id: 'u1' } }) },
  { name: 'null createdBy normalized to absent', input: validBase({ createdBy: null }) },
  { name: 'numeric createdBy normalized to absent', input: validBase({ createdBy: 123 }) },
  { name: 'string createdBy preserved', input: validBase({ createdBy: 'user-1' }) },
  {
    name: 'server-only extra fields stripped',
    input: validBase({
      projectId: 'proj-1',
      actor: { kind: 'user', id: 'u1' },
      onBehalfOf: null,
      capabilityId: 'cap-1',
      confirmationState: 'auto',
      unknownFutureField: { nested: true },
    }),
  },
  { name: 'previousData plain object', input: validBase({ previousData: { title: 'old' } }) },
  { name: 'previousData null', input: validBase({ previousData: null }) },
  { name: 'previousData string', input: validBase({ previousData: '{"old":1}' }) },
  { name: 'metadata plain object', input: validBase({ metadata: { reason: 'sync' } }) },
  { name: 'metadata null', input: validBase({ metadata: null }) },
  { name: 'metadata string', input: validBase({ metadata: 'meta-str' }) },
  { name: 'clientMutationId string', input: validBase({ clientMutationId: 'mut-99' }) },
  { name: 'correlationId min length 1', input: validBase({ correlationId: 'c' }) },
  { name: 'correlationId max length 255', input: validBase({ correlationId: 'x'.repeat(255) }) },
  {
    name: 'valid text operation reference',
    input: validBase({
      operation: { id: 'op-1', kind: 'text', field: 'body', epoch: 'ep-1', version: 1 },
    }),
  },
  {
    name: 'valid counter operation reference at MAX_SAFE_INTEGER',
    input: validBase({
      operation: {
        id: 'a'.repeat(255),
        kind: 'counter',
        field: 'votes',
        epoch: 'e'.repeat(255),
        version: Number.MAX_SAFE_INTEGER,
      },
    }),
  },
  { name: 'Object.create(null) as data', input: validBase({ data: Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }) }) },
  { name: 'empty createdAt string', input: validBase({ createdAt: '' }) },
  {
    name: 'explicit undefined optional fields',
    input: validBase({
      previousData: undefined,
      operation: undefined,
      transactionId: undefined,
      correlationId: undefined,
      createdBy: undefined,
      metadata: undefined,
      clientMutationId: undefined,
    }),
  },
];

const INVALID_FIXTURES: { name: string; input: unknown }[] = [
  { name: 'null top-level', input: null },
  { name: 'undefined top-level', input: undefined },
  { name: 'primitive number top-level', input: 42 },
  { name: 'primitive string top-level', input: 'delta' },
  { name: 'array top-level', input: [validBase()] },
  { name: 'NaN numeric id', input: validBase({ id: Number.NaN }) },
  { name: 'Infinity numeric id', input: validBase({ id: Number.POSITIVE_INFINITY }) },
  { name: '-Infinity numeric id', input: validBase({ id: Number.NEGATIVE_INFINITY }) },
  { name: 'invalid actionType string', input: validBase({ actionType: 'X' }) },
  { name: 'lowercase actionType', input: validBase({ actionType: 'u' }) },
  { name: 'multi-char actionType', input: validBase({ actionType: 'INSERT' }) },
  { name: 'missing actionType', input: validBase({ actionType: undefined }) },
  { name: 'empty modelName', input: validBase({ modelName: '' }) },
  { name: 'non-string modelName', input: validBase({ modelName: 123 }) },
  { name: 'empty modelId', input: validBase({ modelId: '' }) },
  { name: 'null modelId', input: validBase({ modelId: null }) },
  { name: 'undefined data', input: validBase({ data: undefined }) },
  { name: 'numeric data', input: validBase({ data: 123 }) },
  { name: 'array data', input: validBase({ data: [1, 2] }) },
  { name: 'Date instance data', input: validBase({ data: new Date() }) },
  { name: 'Map instance data', input: validBase({ data: new Map() }) },
  { name: 'Set instance data', input: validBase({ data: new Set() }) },
  { name: 'RegExp instance data', input: validBase({ data: /abc/ }) },
  { name: 'class instance data', input: validBase({ data: new CustomInstance() }) },
  { name: 'non-array syncGroups', input: validBase({ syncGroups: 'org:1' }) },
  { name: 'syncGroups with number element', input: validBase({ syncGroups: ['org:1', 2] }) },
  { name: 'syncGroups with null element', input: validBase({ syncGroups: [null] }) },
  { name: 'missing createdAt', input: validBase({ createdAt: undefined }) },
  { name: 'numeric createdAt', input: validBase({ createdAt: 1700000000 }) },
  { name: 'invalid previousData (Date)', input: validBase({ previousData: new Date() }) },
  { name: 'invalid previousData (array)', input: validBase({ previousData: [] }) },
  { name: 'invalid previousData (number)', input: validBase({ previousData: 5 }) },
  { name: 'non-string transactionId (number)', input: validBase({ transactionId: 42 }) },
  { name: 'non-string transactionId (object)', input: validBase({ transactionId: {} }) },
  { name: 'empty correlationId', input: validBase({ correlationId: '' }) },
  { name: 'correlationId > 255 chars', input: validBase({ correlationId: 'x'.repeat(256) }) },
  { name: 'numeric correlationId', input: validBase({ correlationId: 123 }) },
  { name: 'invalid metadata (Map)', input: validBase({ metadata: new Map() }) },
  { name: 'invalid metadata (boolean)', input: validBase({ metadata: false }) },
  { name: 'invalid clientMutationId (number)', input: validBase({ clientMutationId: 99 }) },
  { name: 'operation null', input: validBase({ operation: null }) },
  { name: 'operation array', input: validBase({ operation: [] }) },
  {
    name: 'operation empty id',
    input: validBase({ operation: { id: '', kind: 'text', field: 'body', epoch: 'e1', version: 1 } }),
  },
  {
    name: 'operation id > 255',
    input: validBase({ operation: { id: 'a'.repeat(256), kind: 'text', field: 'body', epoch: 'e1', version: 1 } }),
  },
  {
    name: 'operation invalid kind',
    input: validBase({ operation: { id: 'op1', kind: 'list', field: 'body', epoch: 'e1', version: 1 } }),
  },
  {
    name: 'operation empty field',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: '', epoch: 'e1', version: 1 } }),
  },
  {
    name: 'operation empty epoch',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: '', version: 1 } }),
  },
  {
    name: 'operation epoch > 255',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e'.repeat(256), version: 1 } }),
  },
  {
    name: 'operation version 0 (must be positive)',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: 0 } }),
  },
  {
    name: 'operation negative version',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: -1 } }),
  },
  {
    name: 'operation float version',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: 1.5 } }),
  },
  {
    name: 'operation version > MAX_SAFE_INTEGER',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: Number.MAX_SAFE_INTEGER + 1 } }),
  },
  {
    name: 'operation extra unrecognized key (strictObject)',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: 1, extra: true } }),
  },
  {
    name: 'operation extra undefined key (strictObject)',
    input: validBase({ operation: { id: 'op1', kind: 'text', field: 'body', epoch: 'e1', version: 1, extra: undefined } }),
  },
];

describe('parseWireDelta contract equivalence with clientSyncDeltaSchema', () => {
  it.each(VALID_FIXTURES)('accepts and matches Zod output: $name', ({ input }) => {
    const expected = referenceParseWireDelta(input);
    const actual = parseWireDelta(input);

    expect(expected).not.toBeNull();
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expect(actual.data).toEqual(expected);
      // Verify unknown server keys are actually absent, not merely undefined.
      expect(Object.keys(actual.data).sort()).toEqual(
        Object.keys(expected ?? {}).filter((k) => (expected as Record<string, unknown>)[k] !== undefined).sort(),
      );
    }
  });

  it.each(INVALID_FIXTURES)('rejects identically to Zod: $name', ({ input }) => {
    const expected = referenceParseWireDelta(input);
    const actual = parseWireDelta(input);

    expect(expected).toBeNull();
    expect(actual.ok).toBe(false);
    if (!actual.ok) {
      expect(actual.issue.length).toBeGreaterThan(0);
    }
  });
});
