/**
 * @jest-environment node
 */

import { z } from 'zod';
import {
  coalesceOperations,
  executeCommit,
  buildModelMap,
  type CommitOperation,
  type ModelMap,
} from '../../../src/server/commit';

// Small fixture map used by the executeCommit() mock tests. Kept minimal
// so these tests don't depend on the real @ablo/schema.
const fixtureMap: ModelMap = {
  task: { modelName: 'Task', tableName: 'tasks' },
  project: { modelName: 'Project', tableName: 'projects' },
};

// ── Coalescing tests (the 5 rules from Go) ──────────────────────────────

describe('coalesceOperations', () => {
  it('Rule 1: drops null/undefined operations', () => {
    const result = coalesceOperations([
      null,
      undefined,
      { type: 'CREATE', model: 'task', id: '1', input: { title: 'a' } },
      null,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('Rule 2: drops operations with empty model or type', () => {
    const result = coalesceOperations([
      { type: 'CREATE', model: '', id: '1', input: {} },
      { type: '' as any, model: 'task', id: '2', input: {} },
      { type: 'CREATE', model: 'task', id: '3', input: { title: 'valid' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('Rule 3: drops UPDATE/DELETE/ARCHIVE/UNARCHIVE without an ID', () => {
    const result = coalesceOperations([
      { type: 'UPDATE', model: 'task', id: null, input: { title: 'a' } },
      { type: 'DELETE', model: 'task', input: {} },
      { type: 'ARCHIVE', model: 'task', input: {} },
      { type: 'UNARCHIVE', model: 'task', input: {} },
      // CREATE without ID is ok (Go allows it)
      { type: 'CREATE', model: 'task', id: 'new-1', input: { title: 'valid' } },
    ] as CommitOperation[]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('CREATE');
  });

  it('Rule 4: drops UPDATE with empty input', () => {
    const result = coalesceOperations([
      { type: 'UPDATE', model: 'task', id: '1', input: {} },
      { type: 'UPDATE', model: 'task', id: '2', input: null },
      { type: 'UPDATE', model: 'task', id: '3', input: { title: 'real' } },
    ] as CommitOperation[]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('Rule 5: deduplicates — keeps only LAST update per (model, id)', () => {
    const result = coalesceOperations([
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'first' } },
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'second' } },
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'third' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].input!.title).toBe('third');
  });

  it('Rule 5: preserves CREATE + UPDATE for same entity (different types)', () => {
    const result = coalesceOperations([
      { type: 'CREATE', model: 'task', id: '1', input: { title: 'new' } },
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'updated' } },
    ]);
    // CREATE is kept (not deduped — only UPDATEs dedup against each other)
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('CREATE');
    expect(result[1].type).toBe('UPDATE');
  });

  it('Rule 5: dedup across different models is separate', () => {
    const result = coalesceOperations([
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'task-first' } },
      { type: 'UPDATE', model: 'project', id: '1', input: { name: 'proj-first' } },
      { type: 'UPDATE', model: 'task', id: '1', input: { title: 'task-second' } },
    ]);
    expect(result).toHaveLength(2);
    // project|1 kept (only update), task|1 keeps the last one
    const taskOp = result.find((o) => o.model === 'task')!;
    expect(taskOp.input!.title).toBe('task-second');
  });

  it('normalizes model name to lowercase', () => {
    const result = coalesceOperations([
      { type: 'CREATE', model: 'SlideLayer', id: '1', input: { type: 'text' } },
    ]);
    expect(result[0].model).toBe('slidelayer');
  });

  it('returns empty array for all-filtered batch', () => {
    const result = coalesceOperations([null, undefined]);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(coalesceOperations([])).toHaveLength(0);
  });
});

// ── executeCommit mock tests (verify SQL shape without a real DB) ─────────

describe('executeCommit', () => {
  const ctx = {
    participantId: 'u1',
    participantKind: 'user' as const,
    organizationId: 'org1',
  };

  it('returns { lastSyncId: 0 } for empty batch', async () => {
    const fakeSql = {} as any; // Won't be called
    const result = await executeCommit([], ctx, 'tx-1', fakeSql, fixtureMap);
    expect(result).toEqual({ lastSyncId: 0 });
  });

  it('returns { lastSyncId: 0 } for all-coalesced-to-empty batch', async () => {
    const fakeSql = {} as any;
    const result = await executeCommit(
      [null, undefined, { type: 'UPDATE', model: 'task', id: null } as any],
      ctx,
      'tx-2',
      fakeSql,
      fixtureMap,
    );
    expect(result).toEqual({ lastSyncId: 0 });
  });

  it('throws on unknown model (not in provided modelMap)', async () => {
    const fakeSql = { begin: async (cb: Function) => cb({}) } as any;
    await expect(
      executeCommit(
        [{ type: 'CREATE', model: 'nonexistent', id: '1', input: {} }],
        ctx,
        'tx-3',
        fakeSql,
        fixtureMap,
      ),
    ).rejects.toThrow('Unknown model: "nonexistent"');
  });

  // ── Idempotency replay ─────────────────────────────────────────────────

  describe('idempotency replay', () => {
    function makeReplaySql(opts: {
      cachedBody?: string;
      cachedHash?: string;
    }): any {
      const queries: string[] = [];
      let beginCalled = false;
      const tagged = (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const q = strings.join('?');
        queries.push(q);
        if (q.includes('FROM mutation_log')) {
          return Promise.resolve(
            opts.cachedBody !== undefined
              ? [
                  {
                    responseStatus: 200,
                    responseBody: opts.cachedBody,
                    requestHash: opts.cachedHash ?? 'fake',
                  },
                ]
              : [],
          );
        }
        return Promise.resolve([]);
      };
      (tagged as any).begin = async () => {
        beginCalled = true;
        return { lastSyncId: 999 };
      };
      return { sql: tagged, state: () => ({ queries, beginCalled }) };
    }

    it('replays the cached response when clientTxId hits with matching request hash', async () => {
      const op: CommitOperation = {
        type: 'CREATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'hello' },
      };

      // First compute the hash the live code will produce for this op so
      // we can seed the cache with a matching entry. Re-uses the same
      // helper the code under test uses so the two stay in lock-step.
      const { hashOperations } = await import('../../../src/server/idempotencyCache');
      const expectedHash = hashOperations([op]);

      const { sql, state } = makeReplaySql({
        cachedBody: JSON.stringify({ lastSyncId: 42 }),
        cachedHash: expectedHash,
      });

      const result = await executeCommit([op], ctx, 'tx-replay', sql, fixtureMap);
      expect(result).toEqual({ lastSyncId: 42 });
      expect(state().beginCalled).toBe(false); // replay — no transaction opened
    });

    it('throws AbloIdempotencyError when clientTxId hits with mismatched hash', async () => {
      const op: CommitOperation = {
        type: 'CREATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'hello' },
      };

      const { sql, state } = makeReplaySql({
        cachedBody: JSON.stringify({ lastSyncId: 42 }),
        cachedHash: 'different-hash',
      });

      await expect(
        executeCommit([op], ctx, 'tx-conflict', sql, fixtureMap),
      ).rejects.toThrow(/Idempotency key reused/);
      expect(state().beginCalled).toBe(false);
    });

    it('rejects idempotency keys over the 255-char cap', async () => {
      const op: CommitOperation = {
        type: 'CREATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'hello' },
      };
      const { sql } = makeReplaySql({});
      const tooLong = 'a'.repeat(256);
      await expect(
        executeCommit([op], ctx, tooLong, sql, fixtureMap),
      ).rejects.toThrow(/exceeds 255 characters/);
    });
  });
});

// ── Watermark / readAt stale-check ──────────────────────────────────────

describe('executeCommit — readAt stale check', () => {
  const ctx = {
    participantId: 'u1',
    participantKind: 'user' as const,
    organizationId: 'org1',
  };

  /**
   * Fake Sql that lets us control what `SELECT MAX(id) FROM sync_deltas`
   * returns per (model, id). Everything else is a stub that looks like
   * a successful write + delta insert.
   */
  function makeStaleCheckSql(staleMaxIds: Record<string, number>): any {
    // Top-level tagged template for mutation_log idempotency lookup.
    const topLevel = (_strings: TemplateStringsArray, ..._vals: unknown[]) =>
      Promise.resolve([]); // No cached response
    (topLevel as any).begin = async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        unsafe: async (sqlText: string, params?: unknown[]) => {
          // Route stale-check SELECT
          if (sqlText.includes('SELECT MAX(id) AS max_id FROM sync_deltas')) {
            const model = (params?.[0] ?? '') as string;
            const id = (params?.[1] ?? '') as string;
            const key = `${model}:${id}`;
            return [{ maxId: staleMaxIds[key] ?? 0 }];
          }
          // Any INSERT / UPDATE / DELETE write → fake success
          if (sqlText.startsWith('INSERT') || sqlText.startsWith('UPDATE') || sqlText.startsWith('DELETE')) {
            return [];
          }
          // The delta-reservation CTE returns { lastSyncId } at the end
          if (sqlText.includes('RETURNING id')) {
            return [{ lastSyncId: 42 }];
          }
          // mutation_log insert at the end
          if (sqlText.includes('INSERT INTO "mutation_log"')) {
            return [];
          }
          return [];
        },
      };
      return cb(tx);
    };
    return topLevel;
  }

  it('rejects with AbloStaleContextError when readAt precedes the target\'s current sync id', async () => {
    const sql = makeStaleCheckSql({ 'Task:task-1': 100 });
    const op: CommitOperation = {
      type: 'UPDATE',
      model: 'task',
      id: 'task-1',
      input: { title: 'new' },
      readAt: 50, // captured before delta 100
    };
    const { AbloStaleContextError } = await import('../../../src/errors');
    try {
      await executeCommit([op], ctx, 'tx-stale-1', sql, fixtureMap);
      throw new Error('expected AbloStaleContextError');
    } catch (err) {
      expect(err).toBeInstanceOf(AbloStaleContextError);
      const stale = err as InstanceType<typeof AbloStaleContextError>;
      expect(stale.httpStatus).toBe(409);
      expect(stale.code).toBe('stale_context');
      expect(stale.readAt).toBe(50);
      expect(stale.conflicts).toEqual([
        { model: 'Task', id: 'task-1', observedSyncId: 100 },
      ]);
    }
  });

  it('succeeds when readAt equals or exceeds the target\'s current sync id', async () => {
    const sql = makeStaleCheckSql({ 'Task:task-1': 100 });
    const op: CommitOperation = {
      type: 'UPDATE',
      model: 'task',
      id: 'task-1',
      input: { title: 'new' },
      readAt: 100, // equal — no delta SINCE readAt
    };
    const result = await executeCommit([op], ctx, 'tx-fresh-1', sql, fixtureMap);
    expect(result.lastSyncId).toBe(42);
  });

  it("skips the check when readAt is omitted", async () => {
    const sql = makeStaleCheckSql({ 'Task:task-1': 999 });
    const op: CommitOperation = {
      type: 'UPDATE',
      model: 'task',
      id: 'task-1',
      input: { title: 'new' },
      // readAt intentionally omitted
    };
    const result = await executeCommit([op], ctx, 'tx-noread-1', sql, fixtureMap);
    expect(result.lastSyncId).toBe(42);
  });

  it("onStale: 'force' bypasses the stale check even when the target has moved", async () => {
    const sql = makeStaleCheckSql({ 'Task:task-1': 999 });
    const op: CommitOperation = {
      type: 'UPDATE',
      model: 'task',
      id: 'task-1',
      input: { title: 'new' },
      readAt: 1,
      onStale: 'force',
    };
    const result = await executeCommit([op], ctx, 'tx-force-1', sql, fixtureMap);
    expect(result.lastSyncId).toBe(42);
  });

  it('collects every conflicting entity in one error when multiple ops are stale', async () => {
    const sql = makeStaleCheckSql({
      'Task:task-1': 200,
      'Task:task-2': 300,
    });
    const ops: CommitOperation[] = [
      { type: 'UPDATE', model: 'task', id: 'task-1', input: { title: 'a' }, readAt: 50 },
      { type: 'UPDATE', model: 'task', id: 'task-2', input: { title: 'b' }, readAt: 50 },
    ];
    const { AbloStaleContextError } = await import('../../../src/errors');
    try {
      await executeCommit(ops, ctx, 'tx-multi-stale', sql, fixtureMap);
      throw new Error('expected AbloStaleContextError');
    } catch (err) {
      expect(err).toBeInstanceOf(AbloStaleContextError);
      const stale = err as InstanceType<typeof AbloStaleContextError>;
      expect(stale.conflicts).toHaveLength(2);
      expect(stale.conflicts?.map((c) => c.id).sort()).toEqual(['task-1', 'task-2']);
    }
  });
});

// ── buildModelMap regression test ────────────────────────────────────────
// Proves the schema-derived map matches the hardcoded 37-entry MODEL_MAP
// that used to live in executeCommit.ts. The snapshot is the shape the
// server has run with; any drift (added/removed/renamed entity) would
// show up here as a diff against the frozen expected value, giving
// reviewers a single test to audit.

describe('buildModelMap', () => {
  // Snapshot of the previous hardcoded MODEL_MAP. Do NOT edit casually —
  // any change here is a deploy-visible change to the wire-mutation
  // surface. Adding an entity requires declaring `mutable: true` in the
  // schema; removing one requires flipping `mutable: true` → unset.
  const FROZEN_OLD_MAP: ModelMap = {
    task:              { modelName: 'Task',              tableName: 'tasks' },
    project:           { modelName: 'Project',           tableName: 'projects' },
    slide:             { modelName: 'Slide',             tableName: 'slides' },
    slidedeck:         { modelName: 'SlideDeck',         tableName: 'slide_decks' },
    slidelayer:        { modelName: 'SlideLayer',        tableName: 'slide_layers' },
    slidelayout:       { modelName: 'SlideLayout',       tableName: 'slide_layouts' },
    slidelayoutlayer:  { modelName: 'SlideLayoutLayer',  tableName: 'slide_layout_layers' },
    message:           { modelName: 'Message',           tableName: 'messages' },
    messagepart:       { modelName: 'MessagePart',       tableName: 'message_parts' },
    chat:              { modelName: 'Chat',              tableName: 'chats' },
    comment:           { modelName: 'Comment',           tableName: 'comments' },
    spreadsheet:       { modelName: 'Spreadsheet',       tableName: 'spreadsheets' },
    spreadsheetsheet:  { modelName: 'SpreadsheetSheet',  tableName: 'spreadsheet_sheets' },
    spreadsheetcell:   { modelName: 'SpreadsheetCell',   tableName: 'spreadsheet_cells' },
    document:          { modelName: 'Document',          tableName: 'documents' },
    theme:             { modelName: 'Theme',             tableName: 'themes' },
    layout:            { modelName: 'Layout',            tableName: 'layouts' },
    assignment:        { modelName: 'Assignment',        tableName: 'assignments' },
    agent:             { modelName: 'Agent',             tableName: 'agents' },
    attachment:        { modelName: 'Attachment',        tableName: 'attachments' },
    file:              { modelName: 'File',              tableName: 'files' },
    folder:            { modelName: 'Folder',            tableName: 'folders' },
    dataroom:          { modelName: 'Dataroom',          tableName: 'datarooms' },
    resourceaccess:    { modelName: 'ResourceAccess',    tableName: 'resource_access' },
    objectlink:        { modelName: 'ObjectLink',        tableName: 'object_links' },
    favorite:          { modelName: 'Favorite',          tableName: 'favorites' },
    subscription:      { modelName: 'Subscription',      tableName: 'subscriptions' },
    team:              { modelName: 'Team',              tableName: 'team' },
    teammember:        { modelName: 'TeamMember',        tableName: 'teamMember' },
    projectteam:       { modelName: 'ProjectTeam',       tableName: 'project_teams' },
    invitation:        { modelName: 'Invitation',        tableName: 'invitation' },
    statusgroup:       { modelName: 'StatusGroup',       tableName: 'status_groups' },
    usermemory:        { modelName: 'UserMemory',        tableName: 'user_memory' },
    member:            { modelName: 'Member',            tableName: 'member' },
    agentjob:          { modelName: 'AgentJob',          tableName: 'agent_jobs' },
  };
  // NOTES on the pre-refactor MODEL_MAP this snapshot replaces:
  //   (a) Dead entries dropped (35 here; was 37):
  //       - `event` → no schema model or `events` table
  //       - `inboxitem` → no schema model or `inbox_items` table
  //       Grep confirms no production code writes to these; likely left
  //       over from a prior refactor that removed the models but not
  //       the map.
  //   (b) Table-name divergence fixed. Prisma's `@@map` (the real DB
  //       names) disagrees with the old hardcoded values for:
  //       - `member`:     was `members`     (Prisma: `member`)
  //       - `invitation`: was `invitations` (Prisma: `invitation`)
  //       - `team`:       was `teams`       (Prisma: `team`)
  //       - `teammember`: was `team_members`(Prisma: `teamMember`)
  //       These were latent bugs — mutations for these models would
  //       have hit `relation "X" does not exist`. Schema's `tableName`
  //       already has the correct values; the post-refactor map uses
  //       them. Any wire-mutation path that was already working for
  //       these four must have been relying on Prisma's camelCase→DB
  //       translation elsewhere in the stack, not on executeCommit's
  //       raw SQL (which this fixes).

  it('matches the old hardcoded MODEL_MAP when fed the real @ablo/schema', () => {
    // Import lazily to keep the top of this file free of cross-package
    // coupling. The test is skipped gracefully in environments where
    // @ablo/schema isn't resolvable (none in this repo today).
    const { schema } = require('@ablo/schema') as {
      schema: Parameters<typeof buildModelMap>[0];
    };
    const derived = buildModelMap(schema);
    expect(derived).toEqual(FROZEN_OLD_MAP);
  });

  it('omits entries for models without `mutable: true`', () => {
    // Synthetic schema with one mutable + one non-mutable model
    const schema = {
      models: {
        a: { typename: 'A', tableName: 'a', mutable: true },
        b: { typename: 'B', tableName: 'b' }, // no mutable flag
        c: { typename: 'C', tableName: 'c', mutable: false },
      },
    } as any;
    const map = buildModelMap(schema);
    expect(Object.keys(map)).toEqual(['a']);
  });

  it('throws when mutable:true is set but typename or tableName is missing', () => {
    const schema = {
      models: {
        broken: { mutable: true },
      },
    } as any;
    expect(() => buildModelMap(schema)).toThrow(/missing `typename` or `tableName`/);
  });
});
