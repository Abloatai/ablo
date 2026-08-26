/**
 * Kysely wrappers for Ablo's two customer-database write transports.
 *
 * Both wrappers compose the same exported {@link createKyselyMutationCore}:
 *
 * - {@link kyselyDataSource} is the endpoint adapter. Its transaction contains
 *   row DML, the permanent idempotency ledger, and correlated outbox events. A
 *   Postgres logical marker remains optional for compatibility.
 * - {@link kyselyDirectMutation} is the engine-side direct wrapper. Its
 *   transaction contains row DML, the same ledger, and a required logical
 *   marker. It never creates, writes, or serves `ablo_outbox`.
 *
 * The ledger reservation happens before DML via `INSERT ... ON CONFLICT DO
 * NOTHING`. Postgres waits on a concurrent uncommitted owner of the same key;
 * after that owner commits, the loser reads and hash-checks its durable response.
 * If the owner rolls back, the waiter acquires the reservation and performs the
 * mutation. This gives same-key concurrency one database arbiter and one effect.
 */

import { AbloValidationError } from '../../errors.js';
import type { Schema, SchemaRecord } from '../../schema/schema.js';
import type {
  AdapterCommitResult,
  DataSourceAdapter,
  MutationAdapter,
  Row,
} from './adapter.js';
import { defineDatabaseAdapter } from './adapterFactory.js';
import { postgresAdapterProfile } from './adapterProfile.js';
import type { ChangeSet } from './contract.js';
import type { Migration } from './migration.js';
import {
  changeSetSchema,
  sourceCommitEchoMarkerSchema,
  sourceCommitEchoIntentSchema,
  type SourceCommitEchoIntent,
} from './contract.js';
import {
  assertSourceIdempotencyIntent,
  assertSourceIdempotencyRetention,
  sourceChangeIntentHash,
  SOURCE_IDEMPOTENCY_RETENTION,
} from './idempotency.js';
import {
  adapterTableMigrations,
  idempotencyLedgerMigrations,
} from './migrations.js';
import { ABLO_POSTGRES_COMMIT_ECHO_PREFIX } from '../types.js';
import {
  authorizeSourceChange,
  authorizeSourceRead,
  lockSourceSubjectCreates,
  rethrowStrictCreateConflict,
  sourceSyncGroups,
} from './subjectAuthorization.js';
import {
  decodeDatabaseOutboxEvent,
  ENDPOINT_OUTBOX_PRUNE_BATCH_SIZE,
  type EventsPage,
} from '../outbox/index.js';
import {
  createKyselyMutationCore,
  kyselyOperationRowId,
  type KyselyCompiledQuery,
  type KyselyLike,
  type KyselyMutationCore,
} from './kyselyMutationCore.js';

export {
  createKyselyMutationCore,
  kyselyOperationRowId,
  type KyselyCompiledQuery,
  type KyselyDeleteBuilder,
  type KyselyInsertBuilder,
  type KyselyInsertValuesBuilder,
  type KyselyLike,
  type KyselyMutationCore,
  type KyselyReturningExecutable,
  type KyselySelectBuilder,
  type KyselyTransactionBuilder,
  type KyselyUpdateBuilder,
  type KyselyUpdateSetBuilder,
} from './kyselyMutationCore.js';

type KyselyMutationMode = 'endpoint' | 'direct';

function rawQuery(
  queryId: string,
  sql: string,
  parameters: readonly unknown[],
): KyselyCompiledQuery {
  return {
    query: { kind: 'RawNode', sqlFragments: [sql], parameters: [] },
    queryId: { queryId },
    sql,
    parameters,
  };
}

function reserveLedgerQuery(
  correlationId: string,
  requestHash: string,
): KyselyCompiledQuery {
  return rawQuery(
    'ablo-idempotency-reserve',
    `INSERT INTO ablo_idempotency (client_tx_id, response, request_hash, expires_at)
     VALUES ($1, $2::jsonb, $3, now() + $4::interval)
     ON CONFLICT (client_tx_id) DO NOTHING
     RETURNING client_tx_id`,
    [correlationId, '[]', requestHash, SOURCE_IDEMPOTENCY_RETENTION],
  );
}

function completeLedgerQuery(
  correlationId: string,
  rows: readonly Row[],
): KyselyCompiledQuery {
  return rawQuery(
    'ablo-idempotency-complete',
    `UPDATE ablo_idempotency
        SET response = $2::jsonb
      WHERE client_tx_id = $1`,
    [correlationId, JSON.stringify(rows)],
  );
}

function postgresLogicalMarkerQuery(payload: string): KyselyCompiledQuery {
  return rawQuery(
    'ablo-postgres-logical-marker',
    'SELECT pg_logical_emit_message(true, $1::text, $2::text)',
    [ABLO_POSTGRES_COMMIT_ECHO_PREFIX, payload],
  );
}

/**
 * The two closing statements of a WAL-echo commit as ONE round trip.
 *
 * Neither result is read: the ledger update records the response, the marker
 * lets the replication echo correlate itself. Sending them separately costs a
 * second full round trip to the customer's database, which is ~6ms when Ablo
 * and that database are neighbours and ~110ms when they are on different
 * continents — paid on every write.
 *
 * A data-modifying `WITH` is the right shape rather than a coincidence: Postgres
 * runs it exactly once and to completion whether or not the primary query reads
 * its output, so the ledger update is not conditional on the marker. Ordering is
 * preserved too — the CTE executes before the main query, the same order the two
 * statements had — and both remain inside the caller's transaction, so the
 * marker is still atomic with the write it describes.
 */
function completeLedgerWithMarkerQuery(
  correlationId: string,
  rows: readonly Row[],
  payload: string,
): KyselyCompiledQuery {
  return rawQuery(
    'ablo-idempotency-complete-with-marker',
    `WITH complete AS (
       UPDATE ablo_idempotency
          SET response = $2::jsonb
        WHERE client_tx_id = $1
     )
     SELECT pg_logical_emit_message(true, $3::text, $4::text)`,
    [
      correlationId,
      JSON.stringify(rows),
      ABLO_POSTGRES_COMMIT_ECHO_PREFIX,
      payload,
    ],
  );
}

function parseCachedRows(response: unknown): Row[] {
  const parsed = typeof response === 'string' ? (JSON.parse(response) as unknown) : response;
  if (!Array.isArray(parsed)) {
    throw new AbloValidationError(
      'The source idempotency response is corrupt and cannot be replayed safely',
      { code: 'idempotency_conflict' },
    );
  }
  return parsed as Row[];
}

function markerAction(type: ChangeSet['operations'][number]['type']): 'I' | 'U' | 'D' {
  if (type === 'CREATE') return 'I';
  if (type === 'DELETE') return 'D';
  return 'U';
}

function parseEchoIntent(
  change: ChangeSet,
  markerModelFor: (operationModel: string) => string,
  required: boolean,
): SourceCommitEchoIntent | undefined {
  const payload = change.echo?.payload;
  if (!payload) {
    return undefined;
  }
  try {
    const marker = sourceCommitEchoIntentSchema.parse(JSON.parse(payload) as unknown);
    if (marker.correlationId !== change.correlationId) {
      throw new Error('marker correlation does not match the ledger key');
    }
    if (marker.operations.length !== change.operations.length) {
      throw new Error('marker operation count does not match the mutation');
    }
    for (const [index, operation] of change.operations.entries()) {
      const markerOperation = marker.operations[index];
      // The marker speaks the canonical schema TYPENAME (the vocabulary the
      // WAL consumer validates deltas against), while the mutation operation
      // carries the authoring wire key. `markerModelFor` translates the wire
      // key through the schema so the two vocabularies compare correctly.
      if (
        !markerOperation ||
        markerOperation.model !== markerModelFor(operation.model) ||
        (markerOperation.id != null && markerOperation.id !== kyselyOperationRowId(operation)) ||
        (markerOperation.id == null && operation.type !== 'CREATE') ||
        markerOperation.action !== markerAction(operation.type) ||
        markerOperation.transactionId !== operation.transactionId
      ) {
        throw new Error(`marker operation ${index} does not match the mutation`);
      }
    }
    return marker;
  } catch (error) {
    if (error instanceof AbloValidationError) throw error;
    if (!required) return undefined;
    throw new AbloValidationError(
      `The direct Postgres logical marker is invalid: ${error instanceof Error ? error.message : 'unknown marker error'}`,
      { code: 'source_adapter_misconfigured' },
    );
  }
}

function resolveEchoMarker(
  intent: SourceCommitEchoIntent,
  rows: readonly Row[],
) {
  return sourceCommitEchoMarkerSchema.parse({
    ...intent,
    operations: intent.operations.map((operation, index) => {
      const returnedId = rows[index]?.id;
      const id = operation.id ?? returnedId;
      if (typeof id !== 'string' || id.length === 0) {
        throw new AbloValidationError(
          `source operation ${index} did not return a canonical id for WAL correlation`,
          { code: 'source_adapter_misconfigured' },
        );
      }
      if (returnedId != null && String(returnedId) !== id) {
        throw new AbloValidationError(
          `source operation ${index} returned an id that does not match its WAL correlation`,
          { code: 'source_adapter_misconfigured' },
        );
      }
      return { ...operation, id };
    }),
  });
}

/**
 * Build the shared transaction policy around one Kysely mutation core. Exported
 * for engine integrations that need to inject a prebuilt core while retaining
 * the exact same ledger and mapping semantics as the endpoint adapter.
 */
export interface KyselyMutationAdapterOptions {
  /**
   * Translate a mutation operation's authoring model key into the canonical
   * marker vocabulary (the schema typename). Direct wrappers must supply the
   * schema-backed translation; identity is only correct when a schema's
   * typenames equal its keys.
   */
  readonly markerModelFor?: (operationModel: string) => string;
  /** Schema required to enforce row/subject authorization in this adapter. */
  readonly schema?: Schema;
}

export function createKyselyMutationAdapter(
  db: KyselyLike,
  core: KyselyMutationCore,
  mode: KyselyMutationMode,
  options: KyselyMutationAdapterOptions = {},
): MutationAdapter {
  const markerModelFor = options.markerModelFor ?? ((model: string) => model);
  return defineDatabaseAdapter({
    profile: postgresAdapterProfile(
      'kysely',
      mode === 'direct' ? 'postgres-wal' : 'transactional-outbox',
    ),
    capabilities: {
      transactions: true,
      propose: false,
      schemaIntrospection: true,
      postgresWalEcho: true,
      outboxEvents: mode === 'endpoint',
    },

    migrations(): readonly Migration[] {
      return mode === 'endpoint'
        ? adapterTableMigrations()
        : idempotencyLedgerMigrations();
    },

    async read(request) {
      const rows = await core.read(request);
      return options.schema ? authorizeSourceRead(options.schema, request, rows) : rows;
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      const request = changeSetSchema.parse(change);
      if (mode === 'direct' && !request.echo) {
        throw new AbloValidationError(
          'A direct Kysely mutation requires a transactional Postgres logical marker',
          { code: 'source_adapter_misconfigured' },
        );
      }
      const echoIntent = parseEchoIntent(request, markerModelFor, mode === 'direct');

      const requestHash = sourceChangeIntentHash(request);
      return db.transaction().execute(async (transaction) => {
        const reservation = await transaction.executeQuery(
          reserveLedgerQuery(request.correlationId, requestHash),
        );

        if (reservation.rows.length === 0) {
          const cached = await transaction
            .selectFrom('ablo_idempotency')
            .selectAll()
            .where('client_tx_id', '=', request.correlationId)
            .limit(1)
            .execute();
          const cachedRow = cached[0];
          if (!cachedRow) {
            throw new AbloValidationError(
              'The source idempotency reservation disappeared during replay',
              { code: 'idempotency_conflict' },
            );
          }
          assertSourceIdempotencyIntent(cachedRow.request_hash, requestHash);
          assertSourceIdempotencyRetention(cachedRow.expires_at);
          return { rows: parseCachedRows(cachedRow.response) };
        }

        if (options.schema) {
          await lockSourceSubjectCreates(options.schema, request, async (_operation, key) => {
            await transaction.executeQuery(rawQuery(
              'subject-create-lock',
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              [key],
            ));
          });
          await authorizeSourceChange(options.schema, request, async (operation) => {
            if (!operation.id) return null;
            const rows = await core.read(
              { kind: 'load', model: operation.model, id: operation.id },
              transaction,
              { forUpdate: true },
            );
            return rows[0] ?? null;
          });
        }

        // Direct mode dispatches every operation before awaiting any of them, so
        // the driver pipelines them into one trip instead of paying a full
        // round trip per row. Postgres still executes them IN ORDER on the
        // connection, so nothing about their semantics moves: a later operation
        // still sees an earlier one's write, and two operations on the same row
        // remain well-defined last-write-wins — which a multi-CTE batch would
        // have made undefined. Each statement also keeps its own error, so
        // "which operation failed" survives.
        //
        // Endpoint mode stays sequential: its outbox row is built FROM the
        // returned row, so operation i+1's write cannot be dispatched before
        // operation i has answered.
        const rows: Row[] = [];
        const applyStrict = async (operation: ChangeSet['operations'][number]): Promise<Row> => {
          try {
            return await core.applyOperation(transaction, operation);
          } catch (error) {
            if (operation.type === 'CREATE') rethrowStrictCreateConflict(error, operation);
            throw error;
          }
        };
        if (mode === 'direct') {
          const dispatched = request.operations.map((operation) =>
            applyStrict(operation),
          );
          // Settle every dispatch before inspecting, so a later rejection is
          // never an unhandled rejection, then surface the FIRST failure in
          // operation order — the one the caller's request actually tripped on.
          const settled = await Promise.allSettled(dispatched);
          const failure = settled.find((outcome) => outcome.status === 'rejected');
          if (failure && failure.status === 'rejected') throw failure.reason;
          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') rows.push(outcome.value);
          }
        } else {
          for (const [index, operation] of request.operations.entries()) {
            const row = await applyStrict(operation);
            rows.push(row);

            const entityId = String(row.id ?? kyselyOperationRowId(operation));
            await transaction
              .insertInto('ablo_outbox')
              .values({
                id: `${request.correlationId}:${index}`,
                model: operation.model,
                entity_id: entityId,
                type: operation.type,
                data: operation.type === 'DELETE' ? null : JSON.stringify(row),
                event_version: 2,
                sync_groups: options.schema
                  ? sourceSyncGroups(options.schema, operation.model, row)
                  : [],
                correlation_id: request.correlationId,
                transaction_id: operation.transactionId ?? null,
                occurred_at: Date.now(),
              })
              .execute();
          }
        }

        if (request.echo?.kind === 'postgres-wal') {
          const payload = echoIntent
            ? JSON.stringify(resolveEchoMarker(echoIntent, rows))
            : request.echo.payload;
          // One round trip, not two — see `completeLedgerWithMarkerQuery`.
          await transaction.executeQuery(
            completeLedgerWithMarkerQuery(request.correlationId, rows, payload),
          );
        } else {
          await transaction.executeQuery(
            completeLedgerQuery(request.correlationId, rows),
          );
        }
        return { rows };
      });
    },
  });
}

/** Endpoint wrapper: mutation + ledger + outbox, with an optional marker. */
export function kyselyDataSource<S extends SchemaRecord>(
  db: KyselyLike,
  schema: Schema<S>,
): DataSourceAdapter {
  const mutation = createKyselyMutationAdapter(
    db,
    createKyselyMutationCore(db, schema),
    'endpoint',
    { schema },
  );

  return defineDatabaseAdapter({
    ...mutation,
    capabilities: { ...mutation.capabilities, outboxEvents: true },

    async acknowledgeEvents(acknowledgedThrough: string): Promise<void> {
      await db.transaction().execute(async (transaction) => {
        await transaction.executeQuery(
          rawQuery(
            'ablo-outbox-prune-acknowledged',
            `DELETE FROM ablo_outbox
              WHERE cursor IN (
                SELECT cursor FROM ablo_outbox
                 WHERE cursor <= $1 ORDER BY cursor ASC LIMIT $2
            )`,
            [acknowledgedThrough, ENDPOINT_OUTBOX_PRUNE_BATCH_SIZE],
          ),
        );
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const rows = await db
        .selectFrom('ablo_outbox')
        .selectAll()
        .where('cursor', '>', cursor ?? '0')
        .orderBy('cursor', 'asc')
        .limit(limit)
        .execute();
      const events = rows.map(decodeDatabaseOutboxEvent);
      return { events, nextCursor: events.at(-1)?.cursor ?? null };
    },
  });
}

/** Direct wrapper: mutation + ledger + required logical marker, never outbox. */
export function kyselyDirectMutation<S extends SchemaRecord>(
  db: KyselyLike,
  schema: Schema<S>,
): MutationAdapter {
  const markerModels = new Map<string, string>();
  for (const [key, definition] of Object.entries(schema.models)) {
    const typename = definition.typename || key;
    markerModels.set(key, typename);
    markerModels.set(key.toLowerCase(), typename);
    markerModels.set(typename, typename);
    markerModels.set(typename.toLowerCase(), typename);
  }
  return createKyselyMutationAdapter(
    db,
    createKyselyMutationCore(db, schema),
    'direct',
    {
      markerModelFor: (operationModel) =>
        markerModels.get(operationModel) ??
        markerModels.get(operationModel.toLowerCase()) ??
        operationModel,
      schema,
    },
  );
}
