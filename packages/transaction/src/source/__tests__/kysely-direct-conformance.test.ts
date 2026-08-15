import { field } from '@abloatai/transaction/schema/field';
import { model } from '@abloatai/transaction/schema/model';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import type { Row } from '../adapter.js';
import { runMutationTests } from '../conformance.js';
import type { ChangeSet, Operation } from '../contract.js';
import { sourceOperationsIntentHash } from '../idempotency.js';
import {
  kyselyDirectMutation,
  type KyselyCompiledQuery,
  type KyselyDeleteBuilder,
  type KyselyInsertBuilder,
  type KyselyLike,
  type KyselyReturningExecutable,
  type KyselySelectBuilder,
  type KyselyUpdateBuilder,
} from '../adapters/kysely.js';

const schema = defineSchema({
  item: model({
    title: field.string().optional(),
    n: field.number().optional(),
  }),
});

interface LedgerRow extends Row {
  response: string;
  request_hash: string;
  expires_at: 'infinity';
}

/** Stateful transaction-serial fake used to run the shared contract through direct. */
class DirectKyselyFake implements KyselyLike {
  private readonly items = new Map<string, Row>();
  private readonly ledger = new Map<string, LedgerRow>();
  private transactionTail: Promise<void> = Promise.resolve();

  private rowsFor(
    table: string,
    wheres: readonly [string, string, unknown][],
    limit: number | undefined,
  ): readonly Row[] {
    const [where] = wheres;
    let rows: Row[];
    if (table === 'item') {
      rows = [...this.items.values()];
    } else if (table === 'ablo_idempotency') {
      rows = [...this.ledger.entries()].map(([client_tx_id, row]) => ({
        client_tx_id,
        ...row,
      }));
    } else {
      rows = [];
    }
    if (where) {
      const [column, operator, value] = where;
      if (operator !== '=') throw new Error(`unsupported fake operator ${operator}`);
      rows = rows.filter((row) => row[column] === value);
    }
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  selectFrom(table: string): KyselySelectBuilder {
    const wheres: [string, string, unknown][] = [];
    let limit: number | undefined;
    const builder: KyselySelectBuilder = {
      selectAll: () => builder,
      where: (column, operator, value) => {
        wheres.push([column, operator, value]);
        return builder;
      },
      orderBy: () => builder,
      limit: (value) => {
        limit = value;
        return builder;
      },
      execute: () => Promise.resolve(this.rowsFor(table, wheres, limit)),
    };
    return builder;
  }

  insertInto(table: string): KyselyInsertBuilder {
    return {
      values: (row) => {
        const execute = (): Promise<readonly Row[]> => {
          if (table !== 'item') throw new Error(`unexpected insert into ${table}`);
          const id = String(row.id);
          this.items.set(id, { ...row });
          return Promise.resolve([{ ...row }]);
        };
        const returning: KyselyReturningExecutable = { execute };
        return {
          returningAll: () => returning,
          execute,
        };
      },
    };
  }

  updateTable(table: string): KyselyUpdateBuilder {
    return {
      set: (patch) => {
        let id: string | undefined;
        const returning: KyselyReturningExecutable = {
          execute: () => {
            if (table !== 'item' || !id) return Promise.resolve([]);
            const row = { ...(this.items.get(id) ?? { id }), ...patch };
            this.items.set(id, row);
            return Promise.resolve([row]);
          },
        };
        const builder = {
          where: (column: string, operator: string, value: unknown) => {
            if (column !== 'id' || operator !== '=') {
              throw new Error('unsupported fake update predicate');
            }
            id = String(value);
            return builder;
          },
          returningAll: () => returning,
        };
        return builder;
      },
    };
  }

  deleteFrom(table: string): KyselyDeleteBuilder {
    let id: string | undefined;
    const returning: KyselyReturningExecutable = {
      execute: () => {
        if (table !== 'item' || !id) return Promise.resolve([]);
        const row = this.items.get(id);
        this.items.delete(id);
        return Promise.resolve(row ? [row] : []);
      },
    };
    const builder: KyselyDeleteBuilder = {
      where: (column, operator, value) => {
        if (column !== 'id' || operator !== '=') {
          throw new Error('unsupported fake delete predicate');
        }
        id = String(value);
        return builder;
      },
      returningAll: () => returning,
    };
    return builder;
  }

  executeQuery(query: KyselyCompiledQuery): Promise<{ readonly rows: readonly Row[] }> {
    if (query.sql.startsWith('INSERT INTO ablo_idempotency')) {
      const correlationId = String(query.parameters[0]);
      if (this.ledger.has(correlationId)) return Promise.resolve({ rows: [] });
      this.ledger.set(correlationId, {
        response: '[]',
        request_hash: String(query.parameters[2]),
        expires_at: 'infinity',
      });
      return Promise.resolve({ rows: [{ client_tx_id: correlationId }] });
    }
    if (query.sql.startsWith('UPDATE ablo_idempotency')) {
      const correlationId = String(query.parameters[0]);
      const row = this.ledger.get(correlationId);
      if (!row) throw new Error('missing ledger reservation');
      row.response = String(query.parameters[1]);
      return Promise.resolve({ rows: [] });
    }
    if (query.sql.includes('pg_logical_emit_message')) {
      return Promise.resolve({ rows: [] });
    }
    throw new Error(`unexpected raw query: ${query.sql}`);
  }

  transaction() {
    return {
      execute: async <T>(work: (transaction: KyselyLike) => Promise<T>): Promise<T> => {
        let release: (() => void) | undefined;
        const previous = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await work(this);
        } finally {
          release?.();
        }
      },
    };
  }
}

function actionFor(operation: Operation): 'I' | 'U' | 'D' {
  if (operation.type === 'CREATE') return 'I';
  if (operation.type === 'DELETE') return 'D';
  return 'U';
}

function withDirectMarker(change: ChangeSet): ChangeSet {
  const operations = change.operations.map((operation, index) => ({
    ...operation,
    transactionId: operation.transactionId ?? `${change.correlationId}:op:${index}`,
  }));
  return {
    ...change,
    operations,
    intentHash: change.intentHash ?? sourceOperationsIntentHash(operations),
    echo: {
      kind: 'postgres-wal',
      payload: JSON.stringify({
        version: 1,
        correlationId: change.correlationId,
        operations: operations.map((operation) => ({
          model: operation.model,
          id: operation.id,
          action: actionFor(operation),
          transactionId: operation.transactionId,
        })),
      }),
    },
  };
}

describe('kyselyDirectMutation shared mutation conformance', () => {
  runMutationTests(
    () => kyselyDirectMutation(new DirectKyselyFake(), schema),
    it,
    { prepareChange: withDirectMarker },
  );
});
