/**
 * What the DATASOURCE routes answer with — the connect surface you reach
 * through `ablo connect` and its verbs: `POST /v1/datasources` (register),
 * `POST /v1/datasources/validate` (readiness from Ablo's own network),
 * `POST /v1/datasources/locate` (which plane holds a database),
 * `GET /v1/datasources` (this plane's registrations), and
 * `DELETE /v1/datasources` (deregister).
 *
 * These are the shapes the server, the CLI, and the dashboard have to agree
 * on. Before this module each consumer spelled them out again — the server
 * inline in `c.json({ … })`, the CLI in three separate hand-rolled decoders —
 * so a renamed field surfaced as `undefined` in a success message, and a
 * warning the server attached (a replication slot still holding the customer's
 * write-ahead log) was silently dropped by a reader that never knew the key
 * existed.
 *
 * Reader stance: fields beyond each response's core verdict are OPTIONAL here
 * even where today's server always sends them. The CLI dials deployments that
 * skew across releases, and a strict parse would refuse a run that succeeded —
 * the worst failure class this surface has. The parse still fails loudly on a
 * body that is not the response at all (a proxy's HTML page, another route's
 * answer), which is the drift this module exists to catch.
 */

import { z } from 'zod';

/**
 * The readiness vocabulary — every invariant the engine's preflights can name
 * in a failure. ONE definition site: the server's probes type their `item`
 * against {@link ReadinessItem}, so an item outside this list cannot compile,
 * and the CLI's plain-language renderer is total over it, so an item added
 * here fails the CLI build until it has a label. That closed loop is what
 * stops the vocabulary drifting apart in three files again — the CLI shipped
 * without a label for `server_version` for exactly that reason.
 *
 * On the WIRE `item` stays an open string (see {@link readinessFailureSchema})
 * so an older reader survives a newer server; this list is the closed set
 * producers may emit, not a parse constraint.
 */
export const READINESS_ITEMS = [
  'server_version',
  'wal_level',
  'publication',
  'replication_role',
  'replication_slot_capacity',
  'replica_identity',
  'table_select',
  'snapshot_row_security',
  'write_role',
  'row_security',
  'database_privileges',
  'schema_privileges',
  'table_ownership',
  'idempotency_ledger',
  'table_privileges',
  'logical_marker',
  'publication_drift',
] as const;
export type ReadinessItem = (typeof READINESS_ITEMS)[number];

const READINESS_ITEM_SET: ReadonlySet<string> = new Set(READINESS_ITEMS);

/** Whether a wire `item` is one this build's vocabulary knows — the reader's
 *  branch between a labelled rendering and the raw-name fallback. */
export function isReadinessItem(item: string): item is ReadinessItem {
  return READINESS_ITEM_SET.has(item);
}

/** The advisory vocabulary — recommendations that never block a registration. */
export const READINESS_ADVISORY_ITEMS = ['slot_failover'] as const;
export type ReadinessAdvisoryItem = (typeof READINESS_ADVISORY_ITEMS)[number];

/**
 * One failing readiness invariant, with its fix in hand. `item` names the
 * invariant — see {@link READINESS_ITEMS} for the set a producer may emit,
 * and why the wire keeps it open here. `fix` carries the exact statement or
 * step that resolves it; `actual` the observed value, when one exists.
 */
export const readinessFailureSchema = z.object({
  item: z.string(),
  actual: z.string().optional(),
  fix: z.string(),
});
export type ReadinessFailure = z.infer<typeof readinessFailureSchema>;

/** A recommendation that rides beside the verdict without changing it. */
export const readinessAdvisorySchema = z.object({
  item: z.string(),
  recommendation: z.string(),
});
export type ReadinessAdvisory = z.infer<typeof readinessAdvisorySchema>;

/**
 * One registration, as the routes report it — the credential-free projection
 * of a data source. This is the row of `GET /v1/datasources` and the success
 * body of `POST /v1/datasources`. Everything here is safe to display: the
 * credential is decomposed at registration and never returns.
 */
export const datasourceSummarySchema = z
  .object({
    /** Asserted when present; optional because an older deployment may omit
     *  the discriminator, and refusing its answer would refuse a run that
     *  succeeded. */
    object: z.literal('datasource').optional(),
    id: z.string().optional(),
    /** How writes reach the database: Ablo's own scoped role, or the signed
     *  endpoint fallback. Unknown future kinds degrade to absent rather than
     *  failing the parse. */
    connection: z.enum(['direct', 'endpoint']).optional().catch(undefined),
    /** host:port of the connection — safe to display. */
    host: z.string().optional(),
    database: z.string().optional(),
    schema: z.string().optional(),
    display_name: z.string().optional(),
    status: z.string().optional(),
    livemode: z.boolean().optional(),
  })
  .loose();
export type DatasourceSummary = z.infer<typeof datasourceSummarySchema>;

/** `GET /v1/datasources` — every registration on the calling key's plane. */
export const datasourceListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(datasourceSummarySchema).readonly(),
});
export type DatasourceListResponse = z.infer<typeof datasourceListResponseSchema>;

/**
 * `POST /v1/datasources/validate` — replication readiness as judged from
 * Ablo's own network, the network replication actually runs from.
 *
 * `reachable` and `ready` are the verdict and always present; `reason` carries
 * the driver's words when the engine couldn't reach the host either; `failures`
 * is the checklist, each entry with its fix.
 */
export const datasourceValidationResponseSchema = z.object({
  object: z.literal('datasource_validation').optional(),
  connection: z.enum(['direct', 'endpoint']).optional().catch(undefined),
  reachable: z.boolean(),
  ready: z.boolean(),
  /**
   * A direct connection is not fully readable until Ablo has copied the rows
   * that predate its replication slot into the sync log. Optional so an older
   * server remains readable by a newer CLI.
   */
  initial_snapshot: z
    .object({
      status: z.enum(['loading', 'retrying', 'complete']),
      detail: z.string().optional(),
    })
    .optional(),
  reason: z.string().optional(),
  failures: z.array(readinessFailureSchema).readonly(),
  advisories: z.array(readinessAdvisorySchema).readonly().optional(),
});
export type DatasourceValidationResponse = z.infer<typeof datasourceValidationResponseSchema>;

/** `POST /v1/datasources/resnapshot` — accepted reset of the direct source's
 * initial load. The replacement snapshot completes asynchronously. */
export const datasourceResnapshotResponseSchema = z.object({
  object: z.literal('datasource_resnapshot'),
  initial_snapshot: z.object({ status: z.literal('loading') }),
  replication_slot: z
    .object({
      slot: z.string(),
      released: z.boolean(),
      detail: z.string().optional(),
      remove_with: z.string().optional(),
    })
    .optional(),
});
export type DatasourceResnapshotResponse = z.infer<typeof datasourceResnapshotResponseSchema>;

/**
 * `POST /v1/datasources/locate` — which plane already holds a database.
 * A targeted lookup, not an enumeration: the caller must hold the connection
 * string, and the answer is only the holding plane. `held: null` means no
 * other plane holds it and a registration would not conflict.
 */
export const datasourceLocationResponseSchema = z.object({
  object: z.literal('datasource_location').optional(),
  /** False with held=null means another organization owns the binding. */
  available: z.boolean().optional(),
  held: z
    .object({
      project: z.string().nullable(),
      branch: z.string(),
    })
    .nullable(),
});
export type DatasourceLocationResponse = z.infer<typeof datasourceLocationResponseSchema>;

/**
 * `DELETE /v1/datasources` — what the deregistration let go of.
 *
 * `replication_slot` is the part a reader must not drop: when Ablo stopped
 * reading but the slot survived (`released: false`), that slot is still on the
 * customer's database holding their write-ahead log, and `remove_with` carries
 * the statement that removes it. Nothing else will ever release it.
 */
export const datasourceDisconnectedResponseSchema = z.object({
  object: z.literal('datasource_disconnected').optional(),
  organization_id: z.string().optional(),
  environment: z.string().optional(),
  cleared: z.object({
    direct: z.boolean(),
    endpoints: z.number(),
  }),
  replication_slot: z
    .object({
      slot: z.string(),
      released: z.boolean(),
      detail: z.string().optional(),
      remove_with: z.string().optional(),
      warning: z.string().optional(),
    })
    .optional(),
});
export type DatasourceDisconnectedResponse = z.infer<typeof datasourceDisconnectedResponseSchema>;
