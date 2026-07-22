/**
 * `Ablo` — the one-call entry point to the sync engine client. It hides the
 * internal wiring — the object pool, local database, sync client, WebSocket,
 * bootstrap, and offline queue — behind a single function that returns a typed
 * client with one property per model in your schema.
 *
 * Usage:
 *   import { Ablo } from '@abloatai/ablo';
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

import type { SchemaRecord } from '../transaction/schema/schema.js';
import type { MutationExecutor } from '../interfaces/index.js';
import { AbloValidationError } from '../transaction/errors.js';
import { SyncWebSocket, type DefaultCollaborationEvents } from '../sync/SyncWebSocket.js';
// Value import is cycle-safe: httpClient.js and httpTransport.js take the client
// types from the `options`/`resourceTypes` leaves, never from this module.
import {
  createAbloHttpClient,
  type AbloHttpClient,
  type AbloHttpClientOptions,
} from '../transaction/transport/httpClient.js';
// Both halves of the plugin lifecycle: `resolvePlugins` turns the declared list
// into a surface, `layerPluginSurface` merges that surface onto the built client.
import {
  layerPluginSurface,
  resolvePlugins,
  type AbloPlugin,
  type PluginById,
  type MergedSurface,
} from '../transaction/plugin.js';
import { noopLogger } from '../transaction/logger.js';
import { humans, type HumansSurface } from './humans.js';
import { createCoreClient, type AbloCoreClient } from './coreClient.js';
import { buildReactiveEngine } from './reactiveEngine.js';
import { resolveClientPrelude } from './clientPrelude.js';

// ── Supporting modules ────────────────────────────────────────────────────
// The option types, the client's public shape, the pass over the options bag,
// the resource-type surface, and the default WebSocket mutation executor each
// live in their own module. The type-only ones (`options`, `abloClient`,
// `resourceTypes`) carry no runtime imports, which lets the HTTP client and the
// session-mint helpers reference the client types without importing this
// factory back and creating an import cycle.
import type { AbloOptions } from './options.js';
// `AbloReads` is named by `Ablo.Reads` in the namespace below as well as
// re-exported, so it needs the import too — same reason as `AbloOptions`.
import type { AbloClient, AbloReads } from './abloClient.js';
import { createDefaultMutationExecutor } from './wsMutationExecutor.js';

// `AbloOptions` is named in the signatures below as well as re-exported, so it
// needs the import above in addition to this line — `export … from` re-exports
// a name without binding it locally.
export type { ApiKeySetter, AbloOptions, InternalAbloOptions } from './options.js';
export type { AbloReads } from './abloClient.js';
// `ModelTarget` (the model/id locator) and `ModelClaim` (the resolved claim
// view) are defined once in the settlement core, derived from a single zod
// schema so the typed client, the HTTP client, and the server share one
// definition. They reach consumers through `./resourceTypes` with the rest of
// the resource surface; re-exported here so `ablo.ModelTarget` and
// `ablo.ModelClaim` stay stable.
export type { ModelTarget, ModelClaim } from './resourceTypes.js';

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
 * `authEndpoint` at your session-mint route instead — the SDK fetches it, keeps the
 * short-lived token fresh, and re-mints on expiry:
 *
 * ```ts
 * const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
 * ```
 *
 * Pass `transport: 'http'` for the stateless server-side client (agents,
 * workers, serverless) — same `ablo.<model>` surface, no socket:
 *
 * ```ts
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, transport: 'http' });
 * await ablo.tasks.update({ id, data: { status: 'done' } });
 * ```
 *
 * Pass `plugins: []` for the core client — the same stateless surface plus
 * the live feed (pushed deltas, presence, claim grants and losses), and no
 * local copy of anything:
 *
 * ```ts
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, plugins: [] });
 * await ablo.connect();
 * ablo.subscribe('claim_granted', (grant) => { ... });
 * ```
 */
export function Ablo<
  const S extends SchemaRecord,
  const P extends readonly AbloPlugin[] = readonly [],
>(
  options: AbloHttpClientOptions<S> & {
    transport: 'http';
    plugins?: P;
  },
): AbloHttpClient<S> & MergedSurface<P>;
export function Ablo<
  const S extends SchemaRecord,
  const P extends readonly AbloPlugin[],
>(
  options: AbloOptions<S> & { plugins: P },
): PluginById<P, 'humans'> extends never
  ? AbloCoreClient<S> & MergedSurface<P>
  : Ablo<S>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S> | AbloHttpClient<S> | AbloCoreClient<S> {
  if (options.transport === 'http') {
    // Capabilities are declared above transport (ADR 0016): the plugin list
    // is checked against the selected transport before anything is built, so
    // a duplex-requiring plugin — humans() — on a request-response client
    // fails right here, with a typed error naming the plugin, rather than as
    // a subscription that never delivers.
    const surface = resolvePlugins(options.plugins ?? [], { duplex: false }, {
      logger: noopLogger,
      options,
    });
    return layerPluginSurface(
      createAbloHttpClient(options as AbloHttpClientOptions<S>),
      surface,
    );
  }

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
  //    seeded there, not here. Built only for the reactive path: the core
  //    client (`plugins: []`) constructs its own feed, and no plugin runs on
  //    that path to read this one.
  const pluginList: readonly AbloPlugin[] = options.plugins ?? [humans()];
  const transport = pluginList.some((plugin) => plugin.id === 'humans')
    ? new SyncWebSocket<DefaultCollaborationEvents>({
        baseUrl: url,
        kind,
        getAuthToken: authCredentials.getAuthToken,
        collaborationEvents: [...(internalOptions.collaborationEvents ?? [])],
        syncGroups: [...(internalOptions.syncGroups ?? [])],
        deferConnect: true,
      })
    : null;

  //    The default mutation executor sends `{ type: 'commit', ... }` over
  //    that connection; before it opens, sends reject with the diagnosed
  //    not-ready error and the MutationQueue owns the retry. Caller-supplied
  //    executors are still honored for advanced cases (test mocks,
  //    alternative transports).
  const executor: MutationExecutor =
    internalOptions.mutationExecutor ?? createDefaultMutationExecutor(() => transport);

  // Resolve the capability list before anything heavy is constructed
  // (ADR 0016). The two configuration gates — a duplicate id, a transport
  // mismatch — fire here, while the stack still points at the caller's own
  // setup. With no list given, the reactive materialiser is installed:
  // today's default client. (Flipping the bare default to the stateless core
  // is the mirror-flip step, decided with the published version identity —
  // not here.)
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
    },
  );
  const humansSurface = installedPlugins.humans as HumansSurface | undefined;
  if (!humansSurface) {
    // No materialiser requested. The empty list is the core client — the
    // stateless surface plus the live feed, nothing else. A non-empty list
    // without humans() has asked for a composition that does not exist yet
    // (no other plugin is published), so it fails rather than guessing.
    if ((options.plugins ?? []).length === 0) {
      return layerPluginSurface(
        createCoreClient({
          options,
          baseUrl: url,
          participantId,
          kind,
          syncGroups: internalOptions.syncGroups ?? [],
          getAuthToken: authCredentials.getAuthToken,
          logger,
          observability: internalOptions.observability,
        }),
        installedPlugins,
      );
    }
    throw new AbloValidationError(
      'Add humans() to the plugins list, pass an empty list for the core client, ' +
        'or leave plugins out to get the default.',
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

  // The reactive engine is the humans() capability: everything from here on
  // — runtime context, store, streams, model proxies, resources — builds in
  // `./reactiveEngine.ts`, fed the prelude plus the plugin's contribution
  // (the presence stream). The host owns construction; plugins declare and
  // contribute. A plugin surface that hands back a whole-client constructor
  // inverts that relationship — tried and rejected (ADR 0016, follow-up 3b).
  return layerPluginSurface(buildReactiveEngine<S>({
    ...prelude,
    options,
    executor,
    transport,
    presence: humansSurface.presence,
    createSibling: (siblingOptions) => Ablo(siblingOptions),
  }), installedPlugins);
}

// ─────────────────────────────────────────────────────────────────────
//  Ablo namespace — type access via `Ablo.X` for the modern SDK shape
// ─────────────────────────────────────────────────────────────────────
//
// One default import, with types hung underneath via namespace dots:
// `import Ablo from "@abloatai/ablo"` gets the factory, its return type, and
// every type a typical consumer references (`Ablo.Peer`, `Ablo.Snapshot<S, K>`,
// and so on) — all purely type-level, with zero runtime cost.
//
// The types still live in their canonical homes (`types/streams`, `principal`,
// this file); the namespace re-exports them as a convenience path. Named imports
// continue to work for callers who prefer them.

import type * as _Streams from '../transaction/types/streams.js';
import type * as _Participants from '../sync/participants.js';
import type * as _Policy from '../transaction/policy/types.js';
import type * as _Mutators from '../mutators/defineMutators.js';
import type * as _Tx from '../mutators/Transaction.js';
import type * as _Undo from '../mutators/UndoManager.js';
import type * as _SchemaTypes from '../transaction/schema/schema.js';
import type * as _Global from '../transaction/types/global.js';

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
  export type IfClaimedPolicy = import('./resourceTypes.js').IfClaimedPolicy;
  export type ClaimedOptions = import('./resourceTypes.js').ClaimedOptions;

  // ── Entity pointers (flat — input shapes used everywhere) ─────────
  export type ClaimTarget = _Streams.ClaimTarget;
  export type PresenceTarget = _Streams.PresenceTarget;
  export type TargetRange = _Streams.TargetRange;
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

  // ── Singletons (flat — no cohort) ─────────────────────────────────
  export type Snapshot<
    TSchema extends _SchemaTypes.Schema = _SchemaTypes.Schema,
    K extends keyof TSchema['models'] = keyof TSchema['models'],
  > = _Streams.Snapshot<TSchema, K>;

  // ── Auth (sub-namespace — actor attribution) ──────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Auth {
    export type Actor = _Streams.ParticipantRef;
  }

  // ── Participant (sub-namespace — 5 names, shared concept) ─────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Participant {
    export type Manager = _Participants.ParticipantManager;
    export type Joined = _Participants.JoinedParticipant;
    export type Scope = _Participants.ParticipantScope;
    export type Status = _Participants.ParticipantStatus;
    export type JoinOptions = _Participants.ParticipantJoinOptions;
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

  // ── Conflict (type + sub-namespace via declaration merge) ─────────
  export type Conflict = _Policy.Conflict;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Conflict {
    export type Kind = _Policy.ConflictKind;
    export type Operation = _Policy.ConflictOperation;
    export type Decision = _Policy.ConflictDecision;
    export type Policy = _Policy.ConflictPolicy;
    export type Axis = _Policy.ConflictAxis;
  }

  // ── Commit (sub-namespace — write-side cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Commit {
    export type Wait = import('./resourceTypes.js').CommitWait;
    export type OperationAction = import('./resourceTypes.js').ModelOperationAction;
    export type OperationInput = import('./resourceTypes.js').CommitOperationInput;
    export type CreateOptions = import('./resourceTypes.js').CommitCreateOptions;
    export type Receipt = import('./resourceTypes.js').CommitReceipt;
    export type Client = import('./resourceTypes.js').CommitResource;
  }

  // ── Claim (sub-namespace — peer-claim cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Claim {
    export type Handle = import('./resourceTypes.js').Claim;
    export type Held<T = Record<string, unknown>> = import('../transaction/types/streams.js').HeldClaim<T>;
    export type CreateOptions = import('./resourceTypes.js').ClaimCreateOptions;
    export type WaitOptions = import('./resourceTypes.js').ClaimWaitOptions;
    export type Client = import('./resourceTypes.js').ClaimResource;
  }

  // ── Model (sub-namespace — typed-row read/write cohort) ───────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Model {
    export type Target = import('./resourceTypes.js').ModelTarget;
    export type Claim = import('./resourceTypes.js').ModelClaim;
    export type Operations<T, CreateInput = T> = import('./createModelProxy.js').ModelOperations<
      T,
      CreateInput
    >;
    export type ClaimOptions<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimOptions<T>;
    export type ClaimParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimParams<T>;
    export type ClaimLookupParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimLookupParams<T>;
    export type ClaimReorderParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimReorderParams<T>;
    export type MutationOptions = import('./resourceTypes.js').ModelMutationOptions;
  }

  // ── Source (sub-namespace — customer-owned storage adapter) ──────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Source {
    export type Operation = import('../source/index.js').SourceOperation;
    export type Event = import('../source/index.js').SourceEvent;
    export type EventForOperationOptions =
      import('../source/index.js').SourceEventForOperationOptions;
    export type EventsResult = import('../source/index.js').SourceEventsResult;
    export type Scope = import('../source/index.js').SourceScope;
    export type ApiKey = import('../source/index.js').SourceApiKey;
    export type Options<
      S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord,
      TAuth = unknown,
    > = import('../source/index.js').DataSourceOptions<S, TAuth>;
    export type ModelHandlers<
      Row,
      CreateInput,
      TAuth = unknown,
    > = import('../source/index.js').SourceModelHandlers<Row, CreateInput, TAuth>;
    export type SignatureVerificationResult =
      import('../source/index.js').SourceSignatureVerificationResult;

    // Commit sub-cohort — params/result pair.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Commit {
      export type Params<TAuth = unknown> =
        import('../source/index.js').SourceCommitParams<TAuth>;
      export type Result<Row = Record<string, unknown>> =
        import('../source/index.js').SourceCommitResult<Row>;
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
