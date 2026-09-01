/**
 * `Ablo` — the one-call entry point to the sync engine client. It hides the
 * internal wiring — the object pool, local database, sync client, WebSocket,
 * bootstrap, and offline queue — behind a single function that returns a typed
 * client with one property per model in your schema.
 *
 * Usage:
 *   import { Ablo } from '@abloatai/humans';
 *   import { schema } from './schema';
 *
 *   const sync = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 *
 *   const reports = sync.reports.list({ where: { status: 'todo' } });
 *   await sync.reports.create({ data: { title: 'Fix bug' } });
 *   await sync.reports.update({
 *     id: reportId,
 *     data: { status: 'ready' },
 *   });
 *   await sync.reports.delete({ id: reportId });
 *
 * This module is the composition root and the merge point, and only those.
 * `Ablo` is three declarations sharing one name — the factory, the client
 * type, and the `Ablo.*` namespace — and TypeScript merges declarations only
 * within a single file, so the three have to sit together. Their bodies do
 * not: the client's shape is `./abloClient`, the pass over the options bag is
 * `./clientPrelude`, and the client this dispatches to is `./reactiveEngine`.
 */

import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { SyncWebSocket, type DefaultCollaborationEvents } from './local/sync/SyncWebSocket.js';
// Both halves of the plugin lifecycle: `resolvePlugins` turns the declared list
// into a surface, `layerPluginSurface` merges that surface onto the built client.
import {
  layerPluginSurface,
  resolvePlugins,
  type AbloPlugin,
  type MergedSurface,
} from '@abloatai/humans/plugin';
import { humans, type HumansSurface } from './humans.js';
import { kStoreCluster } from './local/client/storeCluster.js';
import { buildReactiveEngine } from './local/client/reactiveEngine.js';
import { resolveClientPrelude } from './local/client/clientPrelude.js';

// ── Supporting modules ────────────────────────────────────────────────────
// The option types, the client's public shape, the pass over the options bag,
// the resource-type surface, and the default WebSocket mutation executor each
// live in their own module. The type-only ones (`options`, `abloClient`,
// `resourceTypes`) carry no runtime imports, which lets the HTTP client
// reference the client types without importing this factory back and creating
// an import cycle.
import type { AbloOptions } from './local/client/options.js';
// `AbloReads` is named by `Ablo.Reads` in the namespace below as well as
// re-exported, so it needs the import too — same reason as `AbloOptions`.
import type { AbloClient, AbloReads } from './client.js';

// `AbloOptions` is named in the signatures below as well as re-exported, so it
// needs the import above in addition to this line — `export … from` re-exports
// a name without binding it locally.
export type {
  CredentialProvider,
  AbloOptions,
  InternalAbloOptions,
} from './local/client/options.js';
export type { AbloReads } from './client.js';
// `ModelTarget` (the model/id locator) and `ModelClaim` (the resolved claim
// view) are defined once in the confirmation core, derived from a single zod
// schema so the typed client, the HTTP client, and the server share one
// definition. They reach consumers through `./resourceTypes` with the rest of
// the resource surface; re-exported here so `ablo.ModelTarget` and
// `ablo.ModelClaim` stay stable.
export type { ModelTarget, ModelClaim } from './local/client/resourceTypes.js';

/**
 * The typed sync engine client — one property per model in the schema.
 *
 * The shape itself is declared in `./abloClient`; this alias is what merges
 * with the factory and the namespace under the one `Ablo` name.
 */
export type Ablo<S extends SchemaRecord> = AbloClient<S>;

// ── The factory ───────────────────────────────────────────────────────────

/**
 * Create a sync engine client in one call.
 *
 * ```ts
 * const sync = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 *
 * const reports = sync.weatherReports.list({ where: { status: 'pending' } });
 * await sync.weatherReports.create({ location: 'Stockholm', status: 'pending' });
 * ```
 *
 * In the browser (or any client that shouldn't hold a secret key), point
 * `session.endpoint` at your session-mint route instead — the SDK fetches it, keeps the
 * short-lived token fresh, and re-mints on expiry:
 *
 * ```ts
 * const ablo = Ablo({ schema, session: { endpoint: '/api/ablo-session' } });
 * ```
 *
 * Server-side agents, workers, and services use `@abloatai/transaction`.
 */
export function Ablo<
  const S extends SchemaRecord,
  const P extends readonly AbloPlugin[],
>(
  options: AbloOptions<S> & { plugins: P },
): Ablo<S> & MergedSurface<P>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S> {
  // 1. One pass over the options bag settles the credential and its refresh
  //    resolver, the base URL, the logger, and this participant's identity —
  //    and fails on a misconfiguration before anything is constructed.
  const prelude = resolveClientPrelude(options);
  const { internalOptions, authCredentials, logger, url, participantId, kind } = prelude;

  // 2. The connection, built here in the composition root — before the plugin
  //    list resolves, so `PluginContext.transport` carries the instance a
  //    plugin holds for the client's lifetime. It holds no socket until
  //    `connect()`, and `deferConnect` keeps even that closed until the store
  //    has seeded identity and read scope during `ready()` — the late-bound
  //    values (`kind`, the credential, `syncGroups`, the resume cursor) are
  //    seeded there, not here. Whether to build it is read off what the
  //    listed plugins DECLARE — a plugin that requires a duplex transport
  //    gets one to attach to — never off a plugin's name.
  const pluginList: readonly AbloPlugin[] = options.plugins ?? [humans()];
  const transport = pluginList.some((plugin) => plugin.requires?.duplex === true)
    ? new SyncWebSocket<DefaultCollaborationEvents>({
        baseUrl: url,
        kind,
        getAuthToken: authCredentials.getAuthToken,
        collaborationEvents: [...(internalOptions.collaborationEvents ?? [])],
        syncGroups: [...(internalOptions.syncGroups ?? [])],
        deferConnect: true,
      })
    : null;

  // Resolve the capability list before anything heavy is constructed
  // (ADR 0016). The two configuration gates — a duplicate id, a transport
  // mismatch — fire here, while the stack still points at the caller's own
  // setup. With no list given, the reactive local store is installed.
  // The context carries the host's resolved values — url,
  // credential source, identity — so `humans().init` constructs the store
  // cluster right here, during resolution.
  const installedPlugins: Record<string, unknown> = resolvePlugins(
    pluginList,
    { duplex: true },
    {
      logger,
      observability: internalOptions.observability,
      // The raw options bag plus the host's resolved values, so plugins
      // read configuration without re-deriving identity.
      options,
      ...(transport ? { transport } : {}),
      participant: { id: participantId, kind },
      syncGroups: internalOptions.syncGroups ?? [],
      url,
      auth: authCredentials,
    },
  );
  const humansSurface = installedPlugins.humans as HumansSurface | undefined;
  if (!humansSurface) {
    throw new AbloValidationError(
      'The humans client requires the humans() materializer plugin.',
      { code: 'invalid_options', param: 'plugins' },
    );
  }
  if (!humansSurface.presence) {
    // A foreign plugin is squatting on the reserved 'humans' id — its surface
    // is not the one this client is built from.
    throw new AbloValidationError(
      "The 'humans' plugin id is reserved for the SDK's own humans() plugin. " +
        'Rename the custom plugin.',
      { code: 'invalid_options', param: 'plugins' },
    );
  }

  if (!transport) {
    // Unreachable: the humans surface exists only when the list contained
    // 'humans', which is exactly the condition the transport was built under.
    throw new AbloValidationError(
      'The reactive client was selected but no connection was constructed.',
      { code: 'invalid_options', param: 'plugins' },
    );
  }

  const cluster = humansSurface[kStoreCluster];
  if (!cluster) {
    // Unreachable on this path: the context above carries everything the
    // cluster needs (connection, url, credential source, schema). A missing
    // cluster means the context and the plugin disagree — say so rather
    // than building a client with no store.
    throw new AbloValidationError(
      'The reactive client was selected but no store was constructed.',
      { code: 'invalid_options', param: 'plugins' },
    );
  }

  // The reactive engine is the humans() capability: `init` constructed the
  // store cluster (runtime, component graph, store) from the widened
  // context; what remains here builds in `./reactiveEngine.ts`, fed the
  // prelude plus the plugin's contributions. The host owns assembly;
  // plugins declare and construct their own parts. A plugin surface that
  // hands back a whole-client constructor inverts that relationship —
  // tried and rejected (ADR 0016, follow-up 3b).
  return layerPluginSurface(buildReactiveEngine<S>({
    ...prelude,
    options,
    transport,
    presence: humansSurface.presence,
    cluster,
  }), installedPlugins);
}

// ─────────────────────────────────────────────────────────────────────
//  Ablo namespace — type access via `Ablo.X` for the modern SDK shape
// ─────────────────────────────────────────────────────────────────────
//
// One default import, with types hung underneath via namespace dots:
// `import { Ablo } from "@abloatai/humans"` gets the factory, its return type, and
// every type a typical consumer references (`Ablo.Peer`,
// and so on) — all purely type-level, with zero runtime cost.
//
// The types still live in their canonical homes (`types/streams`, `principal`,
// this file); the namespace re-exports them as a convenience path. Named imports
// continue to work for callers who prefer them.

import type * as _Streams from '@abloatai/transaction/types/streams';
import type * as _Mutators from './local/mutators/defineMutators.js';
import type * as _Tx from './local/mutators/Transaction.js';
import type * as _Undo from './local/mutators/UndoManager.js';
import type * as _SchemaTypes from '@abloatai/transaction/schema/schema';
import type * as _Global from '@abloatai/transaction/types/global';

/**
 * The canonical type namespace.
 *
 * Rules applied uniformly to every addition:
 *
 *   1. Flat by default. `Ablo.X`. Fewest dots wins.
 *   2. Sub-namespace only when (a) four or more types share a single conceptual
 *      prefix and (b) the names read better with it (`Conflict.Kind` over
 *      `ConflictKind`). If the cluster is heterogeneous (streams, data, handles),
 *      keep it flat.
 *   3. Only types a consumer would write `: Ablo.X` for. Inferred-only types stay
 *      unexported.
 *   4. Wire shapes never appear on `Ablo.*` — engine vocabulary only.
 *   5. Advanced or framework-integration types stay internal unless they graduate
 *      into one of the public subpaths.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Ablo {
  // ── Factory options ────────────────────────────────────────────────
  export type Options<S extends SchemaRecord = SchemaRecord> = AbloOptions<S>;
  /**
   * The read view of the client that `useAblo` selectors receive: model reads
   * typed as reactive rows (data fields + computeds, no relation accessors).
   */
  export type Reads<S extends SchemaRecord = SchemaRecord> = AbloReads<S>;
  // Claimed-state options stay flat — same concept reused by claims and models.
  export type IfClaimedPolicy = import('./local/client/resourceTypes.js').IfClaimedPolicy;
  export type ClaimedOptions = import('./local/client/resourceTypes.js').ClaimedOptions;

  // ── Entity pointers (flat — input shapes used everywhere) ─────────
  export type ClaimTarget = _Streams.ClaimTarget;
  export type PresenceTarget = _Streams.PresenceTarget;
  export type Duration = _Streams.Duration;

  // ── Real-time multiplayer (flat — heterogeneous cluster) ──────────
  export type PresenceStream = _Streams.PresenceStream;
  export type ClaimStream = _Streams.ClaimStream;
  export type Peer = _Streams.Peer;
  export type Activity = _Streams.Activity;
  export type Claim = _Streams.Claim;
  export type ClaimRejection = _Streams.ClaimRejection;
  export type ClaimLost = _Streams.ClaimLost;

  // ── Long-running work (flat — the async surface of a claim) ───────
  // Work that outlives a claim's crash-cleanup TTL holds its lease by
  // BEATING (`held.heartbeat()` / `claim({ heartbeat: true })`). The beat's
  // answer carries the extended expiry and the queue pressure behind the
  // lease; a beat on a lapsed lease rejects with `AbloClaimedError` — for a
  // socketless worker, the failed beat IS the loss notification.
  export type ClaimHeartbeat = _Streams.ClaimHeartbeat;
  export type ClaimHeartbeatOptions = _Streams.ClaimHeartbeatOptions;

  // ── Auth (sub-namespace — actor attribution) ──────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Auth {
    export type Actor = _Streams.ParticipantRef;
  }

  // ── Schema (type + sub-namespace via declaration merge) ───────────
  export type Schema<S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord> = _SchemaTypes.Schema<S>;
  /**
   * The schema this program has registered via `interface Register { Schema }`
   * (falls back to a loose shape when unregistered). Use it where shared code
   * needs "this app's schema" without importing a specific one —
   * `Ablo<Ablo.ResolveSchema['models']>` resolves to whatever the consuming
   * app registered, so one component types correctly across apps that bind
   * different schemas.
   */
  export type ResolveSchema = _Global.ResolveSchema;
  /**
   * `ResolveSchema` guaranteed to satisfy the `Schema` bound. `ResolveSchema`
   * falls back to a loose `{ models }` shape when nothing is registered, which
   * doesn't extend the branded `Schema` type — so generics bounded by `Schema`
   * (mutator anchors, `Transaction<S>`) can't take `ResolveSchema` directly.
   * `RegisteredSchema` collapses that fallback to `Schema`, so shared mutator
   * code can anchor "this app's schema" and stay assignable at the consumer,
   * which reads the same `Register`. Both resolve in lockstep per app.
   */
  export type RegisteredSchema = _Global.ResolveSchema extends _SchemaTypes.Schema
    ? _Global.ResolveSchema
    : _SchemaTypes.Schema;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Schema {
    export type Model<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.Model<S, K>;
    export type InferCreate<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferCreate<S, K>;
    /**
     * The reactive-row companion to {@link Model}: data fields + computed
     * getters, no relation accessors, no model methods — the shape `useAblo`
     * reads return.
     */
    export type InferRow<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferRow<S, K>;
    export type InferModelNames<S extends _SchemaTypes.Schema> = _SchemaTypes.InferModelNames<S>;
  }

  // ── Commit (sub-namespace — write-side cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Commit {
    export type Wait = import('./local/client/resourceTypes.js').CommitWait;
    export type OperationAction = import('./local/client/resourceTypes.js').ModelOperationAction;
    export type OperationInput = import('./local/client/resourceTypes.js').CommitOperationInput;
    export type CreateOptions = import('./local/client/resourceTypes.js').CommitCreateOptions;
    export type Receipt = import('./local/client/resourceTypes.js').CommitReceipt;
    export type Client = import('./local/client/resourceTypes.js').CommitResource;
  }

  // ── Claim (sub-namespace — peer-claim cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Claim {
    export type Handle = import('./local/client/resourceTypes.js').Claim;
    export type Held<T = Record<string, unknown>> = import('@abloatai/transaction/types/streams').HeldClaim<T>;
    export type CreateOptions = import('./local/client/resourceTypes.js').ClaimCreateOptions;
    export type WaitOptions = import('./local/client/resourceTypes.js').ClaimWaitOptions;
    export type ContentionOptions =
      import('@abloatai/transaction/client/resources/modelOperations').ClaimContentionOptions;
    export type AttemptEvent =
      import('@abloatai/transaction/client/resources/modelOperations').ClaimAttemptEvent;
    export type QueueView =
      import('@abloatai/transaction/client/resources/modelOperations').ClaimQueueView;
    export type Client = import('./local/client/resourceTypes.js').ClaimResource;
  }

  // ── Model (sub-namespace — typed-row read/write cohort) ───────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Model {
    export type Target = import('./local/client/resourceTypes.js').ModelTarget;
    export type Claim = import('./local/client/resourceTypes.js').ModelClaim;
    export type Operations<T, CreateInput = T> = import('./local/client/createModelOperations.js').ModelOperations<
      T,
      CreateInput
    >;
    export type ClaimOptions<T = Record<string, unknown>> =
      import('./local/client/createModelOperations.js').ClaimOptions<T>;
    export type ClaimParams<T = Record<string, unknown>> =
      import('./local/client/createModelOperations.js').ClaimParams<T>;
    export type ClaimLookupParams<T = Record<string, unknown>> =
      import('./local/client/createModelOperations.js').ClaimLookupParams<T>;
    export type ClaimReorderParams<T = Record<string, unknown>> =
      import('./local/client/createModelOperations.js').ClaimReorderParams<T>;
    export type MutationOptions = import('./local/client/resourceTypes.js').ModelMutationOptions;
  }

  // ── Source (sub-namespace — customer-owned storage adapter) ──────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Source {
    export type Operation = import('@abloatai/transaction/source').SourceOperation;
    export type Event = import('@abloatai/transaction/source').SourceEvent;
    export type EventForOperationOptions =
      import('@abloatai/transaction/source').SourceEventForOperationOptions;
    export type EventsResult = import('@abloatai/transaction/source').SourceEventsResult;
    export type Scope = import('@abloatai/transaction/source').SourceScope;
    export type ApiKey = import('@abloatai/transaction/source').SourceApiKey;
    export type Options<
      S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord,
      TAuth = unknown,
    > = import('@abloatai/transaction/source').DataSourceOptions<S, TAuth>;
    export type ModelHandlers<
      Row,
      CreateInput,
      TAuth = unknown,
    > = import('@abloatai/transaction/source').SourceModelHandlers<Row, CreateInput, TAuth>;
    export type SignatureVerificationResult =
      import('@abloatai/transaction/source').SourceSignatureVerificationResult;

    // Commit sub-cohort — params/result pair.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Commit {
      export type Params<TAuth = unknown> =
        import('@abloatai/transaction/source').SourceCommitParams<TAuth>;
      export type Result<Row = Record<string, unknown>> =
        import('@abloatai/transaction/source').SourceCommitResult<Row>;
    }
  }

  // ── Mutator (sub-namespace — 5 names including undo) ──────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Mutator {
    export type Fn<S extends _SchemaTypes.Schema, TArgs, TResult = void> =
      _Mutators.MutatorFn<S, TArgs, TResult>;
    export type Transaction<S extends _SchemaTypes.Schema> = _Tx.Transaction<S>;
    export type UndoEntry = _Undo.UndoEntry;
    export type UndoScope<S extends _SchemaTypes.Schema = _SchemaTypes.Schema> = _Undo.UndoScope<S>;
    export type InverseOp = _Undo.InverseOp;
  }
}
