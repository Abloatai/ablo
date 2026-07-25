# Postgres replication: internal architecture

> **Status: wired and covered by unit and real-Postgres journeys.** This is server-internal code under `apps/sync-server/src/replication/postgres/`; it is not an SDK surface.

## Why this exists

Ablo observes a customer's Postgres through a publication and logical-replication slot. The customer owns the schema and write path. Ablo decodes committed changes, appends them to its control-plane log, and serves sync from that log. The low-level decoder and lifecycle draw on Zero and PowerSync patterns; ADR 0002 governs the product boundary.

## The one job

**Postgres `pgoutput` messages → `PreparedDelta[]` + a confirmed LSN.** The consumer writes through `appendExternalDeltas`; deltas land in the control-plane `sync_deltas` log and use the normal fan-out pipeline.

## Module map (`apps/sync-server/src/replication/postgres/`)

| file                                                     | role                                                       | provenance                    |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| `binaryReader.ts`                                        | big-endian protocol reader                                 | modeled on Zero               |
| `pgoutputTypes.ts`, `pgoutput.ts`                        | typed `pgoutput` messages and decoder                      | modeled on Zero               |
| `lsn.ts`                                                 | `LSN` string ↔ `bigint` (`toBigInt`/`fromBigInt`)          | ported subset ← Zero `lsn.ts` |
| `connection.ts`, `stream.ts`, `streamAdapter.ts`         | dedicated query/replication connections and stream adapter | Zero/PowerSync patterns       |
| `assembler.ts`                                           | buffers a transaction and maps changes to `PreparedDelta`  | Ablo adapter                  |
| `consumer.ts`                                            | persist-before-ack consume loop with retry                 | PowerSync/Ablo patterns       |
| `slot.ts`, `slotLease.ts`, `backfill.ts`, `watermark.ts` | slot ownership, initial snapshot, and durable progress     | Ablo                          |
| `sources.ts`, `fleet.ts`, `start.ts`                     | registry resolution, reconciliation, start/stop lifecycle  | Ablo                          |
| `preflight.ts`, `readiness.ts`, `publicationDrift.ts`    | registration checks and runtime diagnostics                | Ablo                          |

## Data flow

```
registered Postgres source
  → replication slot + initial snapshot
  → pgoutput stream
  → TransactionAssembler
  → WalConsumer
  → appendExternalDeltas(controlSql, deltas, context)
  → persist watermark
  → acknowledge commit LSN
```

### Mapping (in `TransactionAssembler`, mirrors `events.ts:eventsToDeltas`)

- `actionType`: `insert→'I'`, `update→'U'`, `delete→'D'` (the 1:1 pgoutput↔Ablo coincidence).
- `modelName`: `mapping.tableToModel(schema, table)` — `null` skips the change.
- `modelId`: `mapping.rowToModelId(key)` over the replica-identity key.
- `data`: the row bound as an **object, never pre-stringified** (the jsonb double-encode trap at `deltaAppend.ts`).
- `transactionId`: `String(xid)`.

## Load-bearing invariants

- **Persist-before-ack** (`WalConsumer`): `appendExternalDeltas` and the watermark transaction resolve before `ack(commitLsn)`. A crash between them replays work instead of losing it.
- **Keepalive watermark** (`streamAdapter.ts`, `stream.ts`): every reply carries the last confirmed LSN, never the server's live position — the timed status update included.
- **Liveness off the socket** (`stream.ts`): a status update goes out every 75% of the upstream's `wal_sender_timeout` whether or not the consumer is reading, so backpressure cannot get the connection terminated for silence; inbound silence on a stream we are reading for twice that long destroys it and falls into the per-source backoff. A `wal_sender_timeout` of 0 runs untimed.
- **Failover-capable slot** (`slot.ts`): from PostgreSQL 17 the slot is created with `FAILOVER true`, so a customer failover leaves our position intact instead of forcing the re-snapshot path. It only takes effect where the standby has `sync_replication_slots = on`, which the preflight recommends and never requires.
- **Fresh subscription per retry** (`WalConsumer`): every backoff iteration opens a new subscription so a half-dead socket / stale relation cache never carries into the retry.
- **Per-source isolation** (`start.ts`, `fleet.ts`): one broken source reports and retries without stopping healthy sources.
- **Runtime reconciliation** (`fleet.ts`): registrations, removals, schema changes, and secret rotations converge without a server restart.

## Tests

Unit tests live beside the implementation in `replication/postgres/__tests__`. Real-Postgres coverage is grouped under `src/__journeys__/postgres-replication-*.journey.test.ts`: registration, registry migration, backfill, live streaming, source changes, bootstrap, query serving, read cutover, and customer-database isolation.

## Operations

Registration is the enable signal. `startPostgresReplication` starts the fleet after the server begins listening; `postgresReplicationReady` is drained during graceful shutdown. Use `docs/runbooks/connect-customer-database-postgres-replication.md` for source setup and live verification.
