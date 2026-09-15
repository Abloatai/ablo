import { describe, expect, it } from '@jest/globals';
import { defineSchema, entityRole, model, z } from '../../schema/index.js';
import {
  authorizeSourceChange,
  authorizeSourceRead,
  rethrowStrictCreateConflict,
  sourceSyncGroups,
} from '../adapters/subjectAuthorization.js';
import type { AdapterReadRequest, Row } from '../adapters/adapter.js';
import type { ChangeSet, Operation } from '../adapters/contract.js';

const schema = defineSchema({
  docs: model(
    { workspaceId: z.string().min(1), projectId: z.string().optional(), title: z.string() },
    {
      subject: { field: 'workspaceId', group: 'workspace' },
      groups: { roles: [entityRole({ kind: 'project', source: 'projectId' })] },
    },
  ),
});

const scope = { syncGroups: ['workspace:a'] } as const;
const request = (kind: 'load' | 'list'): AdapterReadRequest => kind === 'load'
  ? { kind, model: 'docs', id: 'foreign', scope }
  : { kind, model: 'docs', scope };

function change(operations: readonly Operation[]): ChangeSet {
  return {
    correlationId: 'subject-test',
    operations: [...operations],
    scope,
  };
}

describe('source adapter subject authorization', () => {
  it('makes missing and foreign point loads indistinguishable', () => {
    const rows: Row[] = [
      { id: 'own', workspaceId: 'a', title: 'own' },
      { id: 'foreign', workspaceId: 'b', title: 'foreign' },
    ];
    expect(authorizeSourceRead(schema, request('list'), rows)).toEqual([rows[0]]);
    expect(authorizeSourceRead(schema, request('load'), [rows[1]!])).toEqual([]);
    expect(authorizeSourceRead(schema, request('load'), [])).toEqual([]);
  });

  it('allows same-subject reads and hides rows without trusted groups', () => {
    const own = { id: 'own', workspaceId: 'a', title: 'own' };
    expect(authorizeSourceRead(schema, request('load'), [own])).toEqual([own]);
    expect(authorizeSourceRead(
      schema,
      { kind: 'load', model: 'docs', id: 'own' },
      [own],
    )).toEqual([]);
  });

  it('preflights every operation before the adapter transaction mutates anything', async () => {
    const current = new Map<string, Row>([
      ['own', { id: 'own', workspaceId: 'a', title: 'own' }],
      ['foreign', { id: 'foreign', workspaceId: 'b', title: 'foreign' }],
    ]);
    let loads = 0;
    const load = async (operation: Operation) => {
      loads += 1;
      return operation.id ? current.get(operation.id) ?? null : null;
    };

    await expect(authorizeSourceChange(schema, change([
      { type: 'UPDATE', model: 'docs', id: 'own', input: { title: 'would mutate' } },
      { type: 'DELETE', model: 'docs', id: 'foreign' },
    ]), load)).rejects.toMatchObject({ code: 'capability_scope_denied', httpStatus: 403 });
    expect(loads).toBe(2);
    expect(current.get('own')?.title).toBe('own');
  });

  it('denies foreign creates, subject moves, archive, and unarchive', async () => {
    const current = { id: 'own', workspaceId: 'a', title: 'own' };
    for (const operation of [
      { type: 'CREATE', model: 'docs', id: 'new', input: { workspaceId: 'b', title: 'bad' } },
      { type: 'UPDATE', model: 'docs', id: 'own', input: { workspaceId: 'b' } },
      { type: 'ARCHIVE', model: 'docs', id: 'foreign' },
      { type: 'UNARCHIVE', model: 'docs', id: 'foreign' },
    ] satisfies Operation[]) {
      await expect(authorizeSourceChange(
        schema,
        change([operation]),
        async (candidate) => candidate.id === 'foreign'
          ? { ...current, id: 'foreign', workspaceId: 'b' }
          : candidate.id === 'own' ? current : null,
      )).rejects.toMatchObject({ code: 'capability_scope_denied', httpStatus: 403 });
    }
  });

  it('derives only durable routing groups from a deleted row', () => {
    expect(sourceSyncGroups(schema, 'docs', {
      id: 'own', workspaceId: 'a', projectId: 'shared',
      title: 'sensitive body', secret: 'never retain',
    })).toEqual(['workspace:a']);
  });

  it.each(['23505', 'P2002'])('maps CREATE conflict %s without exposing a row', (code) => {
    expect(() => rethrowStrictCreateConflict(
      { code },
      { type: 'CREATE', model: 'docs', id: 'same', input: { workspaceId: 'a' } },
    )).toThrow(expect.objectContaining({ code: 'entity_already_exists', httpStatus: 409 }));
  });

  it('hides foreign CREATE collisions and reports authorized collisions', async () => {
    await expect(authorizeSourceChange(schema, change([{
      type: 'CREATE', model: 'docs', id: 'foreign',
      input: { workspaceId: 'a', title: 'collision' },
    }]), async () => ({ id: 'foreign', workspaceId: 'b', title: 'hidden' })))
      .rejects.toMatchObject({ code: 'capability_scope_denied', httpStatus: 403 });

    await expect(authorizeSourceChange(schema, change([{
      type: 'CREATE', model: 'docs', id: 'own',
      input: { workspaceId: 'a', title: 'collision' },
    }]), async () => ({ id: 'own', workspaceId: 'a', title: 'own' })))
      .rejects.toMatchObject({ code: 'entity_already_exists', httpStatus: 409 });
  });

  it('reports removed guarded targets as stale', async () => {
    await expect(authorizeSourceChange(schema, change([{
      type: 'UPDATE', model: 'docs', id: 'gone', readAt: 41,
      input: { title: 'late' },
    }]), async () => null))
      .rejects.toMatchObject({ code: 'stale_context', httpStatus: 409 });
  });
});
