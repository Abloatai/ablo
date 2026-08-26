/**
 * The in-memory reference implementation of {@link DataSourceAdapter}. It is the
 * simplest correct adapter: a stand-in you can commit to and read from in tests
 * without a database, and the fixture the conformance suite runs against to confirm
 * the suite exercises real behavior. An adapter for a given object-relational
 * mapper is complete when it passes the same suite this one passes.
 *
 * It models the semantics minimally but faithfully: one row store per model, an
 * idempotency ledger keyed by scoped correlation, and an acknowledgement-pruned
 * outbox with a monotonic cursor.
 */

import { AbloValidationError } from '../../errors.js';
import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from './adapter.js';
import { defineDatabaseAdapter } from './adapterFactory.js';
import { memoryAdapterProfile } from './adapterProfile.js';
import type { ChangeSet, Operation } from './contract.js';
import type { Migration } from './migration.js';
import type { EventsPage, OutboxEvent } from '../outbox/index.js';
import {
  assertSourceIdempotencyIntent,
  sourceChangeIntentHash,
} from './idempotency.js';

function rowId(op: Operation): string {
  const id = op.id ?? (op.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new AbloValidationError(`operation on "${op.model}" requires an id`, { code: 'source_operation_id_required' });
  }
  return id;
}

export function memoryDataSource(): DataSourceAdapter {
  /** model → (id → row). */
  const store = new Map<string, Map<string, Row>>();
  /** Permanent correlationId → intent hash + original response ledger. */
  const idempotency = new Map<
    string,
    { readonly requestHash: string; readonly rows: Row[] }
  >();
  /** Acknowledgement-pruned outbox with a monotonic cursor. */
  const outbox: OutboxEvent[] = [];
  let nextOutboxCursor = 1;

  const modelStore = (model: string): Map<string, Row> => {
    let m = store.get(model);
    if (!m) {
      m = new Map();
      store.set(model, m);
    }
    return m;
  };

  const applyOperation = (op: Operation): Row => {
    if (op.where) {
      throw new AbloValidationError('The memory adapter does not support conditional operations', {
        code: 'source_adapter_misconfigured',
      });
    }
    const m = modelStore(op.model);
    const id = rowId(op);
    switch (op.type) {
      case 'CREATE': {
        const row: Row = { id, ...(op.input ?? {}) };
        m.set(id, row);
        return row;
      }
      case 'UPDATE':
      case 'ARCHIVE':
      case 'UNARCHIVE': {
        const prev = m.get(id) ?? { id };
        const row: Row = {
          ...prev,
          ...(op.input ?? {}),
          ...(op.type === 'ARCHIVE' ? { archivedAt: Date.now() } : {}),
          ...(op.type === 'UNARCHIVE' ? { archivedAt: null } : {}),
        };
        m.set(id, row);
        return row;
      }
      case 'DELETE': {
        const prev = m.get(id) ?? { id };
        m.delete(id);
        return prev;
      }
    }
  };

  return defineDatabaseAdapter({
    profile: memoryAdapterProfile(),
    capabilities: {
      transactions: true,
      propose: false,
      schemaIntrospection: false,
      postgresWalEcho: false,
      outboxEvents: true,
    },

    migrations(): readonly Migration[] {
      // Nothing to create in memory. A database-backed adapter returns the SQL for its ablo_idempotency and ablo_outbox tables here.
      return [];
    },

    async read(req: AdapterReadRequest): Promise<readonly Row[]> {
      const m = store.get(req.model);
      if (!m) return [];
      if (req.kind === 'load') {
        const row = m.get(req.id);
        return row ? [row] : [];
      }
      let rows = [...m.values()];
      const limit = req.query?.limit;
      if (typeof limit === 'number') rows = rows.slice(0, limit);
      return rows;
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      if (change.echo) {
        throw new AbloValidationError(
          'memoryDataSource cannot emit a Postgres WAL commit echo',
        );
      }
      // Idempotency: a duplicate scoped correlation returns the original rows.
      const requestHash = sourceChangeIntentHash(change);
      const cached = idempotency.get(change.correlationId);
      if (cached) {
        assertSourceIdempotencyIntent(cached.requestHash, requestHash);
        return { rows: cached.rows };
      }

      const rows: Row[] = [];
      for (const [index, op] of change.operations.entries()) {
        const row = applyOperation(op);
        rows.push(row);
        // Transactional outbox: one event per op, monotonic cursor.
        outbox.push({
          version: 2,
          id: `${change.correlationId}:${index}`,
          model: op.model,
          entityId: String(row.id ?? rowId(op)),
          type: op.type,
          data: op.type === 'DELETE' ? null : row,
          syncGroups: [],
          correlationId: change.correlationId,
          ...(op.transactionId ? { transactionId: op.transactionId } : {}),
          cursor: String(nextOutboxCursor++),
        });
      }
      idempotency.set(change.correlationId, { requestHash, rows });
      return { rows };
    },

    async acknowledgeEvents(acknowledgedThrough: string): Promise<void> {
      const after = Number(acknowledgedThrough);
      let acknowledgedCount = 0;
      while (
        acknowledgedCount < outbox.length &&
        Number(outbox[acknowledgedCount]?.cursor) <= after
      ) {
        acknowledgedCount += 1;
      }
      if (acknowledgedCount > 0) outbox.splice(0, acknowledgedCount);
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ? Number(cursor) : 0;
      const page = outbox.filter((e) => Number(e.cursor) > after).slice(0, limit);
      return {
        events: page,
        nextCursor: page.at(-1)?.cursor ?? null,
      };
    },
  });
}
