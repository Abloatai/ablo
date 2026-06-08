/**
 * Customer-side Data Source endpoint.
 *
 * This file is what a customer running their own backend writes. It
 * holds the canonical data — in production it's their Postgres,
 * Mongo, or whatever — and exposes one handler that Ablo Cloud calls
 * over HTTP for `load`, `list`, `commit`, and `events`.
 *
 * `dataSource(...)` returns `(req: Request) => Promise<Response>` —
 * a Fetch-API handler. Drop it into Next.js (`export const POST`),
 * Hono, Cloudflare Workers, or a thin `http.createServer` wrapper.
 *
 * This example uses an in-memory `Map` as the "database" so it runs
 * with zero setup. A real customer swaps the Map calls for ORM calls
 * inside a transaction. The shape of the handlers stays identical.
 */

import Ablo, { dataSource, sourceEventForOperation } from '@abloatai/ablo';
import { schema } from './schema';

type TaskRow = {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  assignee?: string;
};

// Stand-in for the customer's real database. Map keyed by row id.
const taskStore = new Map<string, TaskRow>();

// Outbox table. In production this is a `tasks_outbox` Postgres table
// populated in the same transaction as the app-row write. Ablo polls `events`
// to fan out changes that bypassed Ablo, and to repair SDK-origin writes if
// Ablo's immediate post-commit append failed.
const outbox: Ablo.Source.Event[] = [];
let outboxSequence = 0;

// Seed one row so the example's first `load` returns something.
taskStore.set('task_seed', {
  id: 'task_seed',
  title: 'Seeded by customer database',
  status: 'todo',
});

/**
 * The full Data Source handler. One symbol exposes load/list/commit/
 * events for every model the schema declares.
 *
 * In Next.js:
 *
 * ```ts
 * // app/api/ablo/source/route.ts
 * export const POST = handleAbloSource;
 * ```
 *
 * In Hono / Cloudflare Workers:
 *
 * ```ts
 * app.post('/api/ablo/source', (c) => handleAbloSource(c.req.raw));
 * ```
 */
export const handleAbloSource = dataSource({
  schema,

  // The API key pairs with what Ablo Cloud is configured with.
  // Wrong key -> 401 with `source_signature_invalid`. Passing a
  // function (instead of the env value directly) re-reads the key
  // on every request and is required by the
  // example because `run.ts` configures the env after this module is
  // imported.
  apiKey: () => {
    const apiKey = process.env.ABLO_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ABLO_API_KEY is not set — refusing to accept unsigned requests',
      );
    }
    return apiKey;
  },

  // `authorize` runs before any handler. Use it to map the signed
  // request to your tenant/user context. The returned value lands on
  // `context.auth` inside every model handler. This example just
  // returns `{}` since the in-memory store is single-tenant.
  authorize() {
    return {};
  },

  tasks: {
    load({ id }) {
      return taskStore.get(id) ?? null;
    },

    list({ query }) {
      const all = Array.from(taskStore.values());
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      const page = all.slice(start, start + limit);
      return {
        rows: page,
        nextCursor:
          start + page.length < all.length
            ? String(start + page.length)
            : undefined,
      };
    },

    // The commit handler applies every operation in the customer's
    // own transaction. The example uses a synchronous in-memory
    // update; the surrounding `apply` helper shows where you would
    // open `db.transaction(async (tx) => { ... })`.
    commit({ operations, clientTxId }) {
      const rows: TaskRow[] = [];
      for (const op of operations) {
        const row = applyOperation(op, clientTxId);
        if (row) rows.push(row);
      }
      return { rows };
    },
  },

  // `events` lets Ablo learn about writes that bypassed Ablo —
  // cron jobs, dashboards, batch imports. Each call drains a batch
  // from the outbox and reports the cursor to resume from.
  events({ cursor, limit }) {
    const start = cursor ? Number(cursor) : 0;
    const cap = limit ?? 100;
    const slice = outbox.slice(start, start + cap);
    const nextCursor =
      start + slice.length < outbox.length
        ? String(start + slice.length)
        : undefined;
    return {
      events: slice,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  },
});

function applyOperation(
  op: Ablo.Source.Operation,
  clientTxId: string | undefined,
): TaskRow | null {
  if (op.model !== 'tasks') return null;
  const id = op.id ?? `task_${Math.random().toString(36).slice(2, 10)}`;

  if (op.type === 'CREATE') {
    const row: TaskRow = {
      id,
      title: String(op.input?.title ?? ''),
      status:
        (op.input?.status as TaskRow['status'] | undefined) ?? 'todo',
      ...(op.input?.assignee
        ? { assignee: String(op.input.assignee) }
        : {}),
    };
    taskStore.set(id, row);
    appendOutbox({ operation: op, entityId: id, data: row, clientTxId });
    return row;
  }

  if (op.type === 'UPDATE') {
    const existing = taskStore.get(id);
    if (!existing) return null;
    const next: TaskRow = { ...existing, ...(op.input as Partial<TaskRow>) };
    taskStore.set(id, next);
    appendOutbox({ operation: op, entityId: id, data: next, clientTxId });
    return next;
  }

  if (op.type === 'DELETE') {
    const existing = taskStore.get(id);
    if (!existing) return null;
    taskStore.delete(id);
    appendOutbox({ operation: op, entityId: id, data: null, clientTxId });
    return existing;
  }

  return null;
}

function appendOutbox(input: {
  operation: Ablo.Source.Operation;
  entityId: string;
  data: TaskRow | null;
  clientTxId: string | undefined;
}): void {
  outboxSequence += 1;
  outbox.push(
    sourceEventForOperation({
      eventId: `evt_${outboxSequence}`,
      operation: input.operation,
      entityId: input.entityId,
      data: input.data,
      ...(input.clientTxId ? { clientTxId: input.clientTxId } : {}),
    }),
  );
}

// Exposed for the orchestrator's `run.ts`. A real customer doesn't
// need this — it's a back door for the demo to verify state.
export function _inspectStore(): {
  rows: TaskRow[];
  outboxSize: number;
} {
  return {
    rows: Array.from(taskStore.values()),
    outboxSize: outbox.length,
  };
}
