/**
 * In-memory reference Data Source adapter — the canonical correct implementation
 * of the adapter interface. It is the test double for the bridge/handler AND the thing the
 * conformance suite runs against to prove the suite itself is real (same role as
 * the server's `memoryTenantDirectory`). A new ORM adapter is "done" when it
 * passes the same suite this one passes.
 *
 * It models the real semantics minimally but faithfully: one canonical row store
 * per model, an idempotency ledger keyed by `clientTxId`, and a monotonic outbox.
 */

import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from '../adapter.js';
import type { ChangeSet, EventsPage, Migration, Operation, OutboxEvent } from '../contract.js';

function rowId(op: Operation): string {
  const id = op.id ?? (op.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`operation on "${op.model}" requires an id`);
  }
  return id;
}

export function memoryDataSource(): DataSourceAdapter {
  /** model → (id → row). */
  const store = new Map<string, Map<string, Row>>();
  /** clientTxId → the rows that commit returned (idempotency ledger). */
  const idempotency = new Map<string, Row[]>();
  /** Append-only outbox; `cursor` is the 1-based index as a string. */
  const outbox: OutboxEvent[] = [];

  const modelStore = (model: string): Map<string, Row> => {
    let m = store.get(model);
    if (!m) {
      m = new Map();
      store.set(model, m);
    }
    return m;
  };

  const applyOperation = (op: Operation): Row => {
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

  return {
    capabilities: { transactions: true, propose: false, schemaIntrospection: false },

    migrations(): readonly Migration[] {
      // In-memory: no table-creation SQL. A real ORM adapter ships ablo_idempotency + ablo_outbox here.
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
      // Idempotency: a duplicate clientTxId returns the original rows, no re-apply.
      const cached = idempotency.get(change.clientTxId);
      if (cached) return { rows: cached };

      const rows: Row[] = [];
      for (const [index, op] of change.operations.entries()) {
        const row = applyOperation(op);
        rows.push(row);
        // Transactional outbox: one event per op, monotonic cursor.
        outbox.push({
          id: `${change.clientTxId}:${index}`,
          model: op.model,
          entityId: String(row.id ?? rowId(op)),
          type: op.type,
          data: op.type === 'DELETE' ? null : row,
          clientTxId: change.clientTxId,
          cursor: String(outbox.length + 1),
        });
      }
      idempotency.set(change.clientTxId, rows);
      return { rows };
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ? Number(cursor) : 0;
      const page = outbox.filter((e) => Number(e.cursor) > after).slice(0, limit);
      return {
        events: page,
        nextCursor: page.length > 0 ? page[page.length - 1].cursor : null,
      };
    },
  };
}
