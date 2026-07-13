/**
 * @abloatai/ablo — the collaboration layer for AI agents and people.
 *
 * ```ts
 * import Ablo from '@abloatai/ablo';
 *
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });
 * await ablo.weatherReports.update({
 *   id: 'report_stockholm',
 *   data: { status: 'ready' },
 * });
 *
 * type Entry = Ablo.Peer;
 * ```
 *
 * `Ablo({ schema, apiKey })` returns typed model clients. Server-side agents,
 * MCP route handlers, and workers select `transport: 'http'`; both transports
 * keep the same `ablo.<model>` application surface.
 *
 * The whole package reaches you through one name: `Ablo` is at once a factory
 * function, a type, and a namespace. You call model clients with dot access on
 * the instance (`ablo.reports.retrieve(...)`) and reach every supporting type
 * through the namespace (`Ablo.Peer`, `Ablo.Claim`).
 *
 * Related surfaces live on their own import subpaths:
 *   @abloatai/ablo/schema   — defineSchema, model, z (Zod)
 *   @abloatai/ablo/react    — <AbloProvider>, useQuery, useMutate
 *   @abloatai/ablo/testing  — test harnesses and fixtures
 *
 * Reads come in two flavors, distinguished by where the data is fetched from.
 * `ablo.<model>.retrieve({ id })` and `.list({ where })` are asynchronous reads
 * that consult the local cache first and fall back to the network, de-duplicating
 * concurrent requests for the same row. They are the default, and the right
 * choice for stateless callers whose local graph starts empty.
 * `ablo.<model>.get(id)`, `.getAll(...)`, and `.getCount(...)` are synchronous
 * snapshots of the already-loaded local graph with no network round-trip — use
 * them in reactive React selectors (`useAblo((ablo) => ablo.<model>.get(id))`)
 * once the graph is warm.
 *
 * What to import, in short:
 *   • `Ablo` (the default export), `AbloOptions`, and the `Model*Params` option
 *     bags cover what most applications and agents ever need.
 *   • the `Ablo*Error` classes let you discriminate failures in catch blocks.
 *
 * A handful of exports are for advanced use and are marked "Advanced" at their
 * declaration below, each with the one situation it is for:
 *   • `dataSource`                 — when your own database stays canonical.
 *   • `defaultPolicy`              — when you customize conflict resolution.
 *   • `defineMutators` / `createTransaction` — when you write custom mutators.
 * If you don't recognize one of these, you don't need it.
 */

// ── Consumer API ──────────────────────────────────────────────────────────
// These are the only symbols external consumers should need from this path.
// Everything else is in a subpath.

// The primary surface. `Ablo` is a function, a type, and a namespace sharing
// one name. It is the default export, so `import Ablo from '@abloatai/ablo'`
// works, and a named export, so `import { Ablo }` compiles too.
export { Ablo } from './client/Ablo.js';
export type { MutationExecutor } from './interfaces/index.js';
// The functional-update surface: `ablo.<model>.update(id, current => next)`.
export type { ModelUpdater, ContentionOptions } from './client/functionalUpdate.js';
export { DEFAULT_CONTENTION_RETRIES } from './client/functionalUpdate.js';
// The reactive-read view of the client: model reads typed as reactive rows
// (data fields + computeds, no relation accessors) — what `useAblo` selectors
// receive.
export type { AbloReads } from './client/Ablo.js';
// The stateless HTTP client is constructed through `Ablo({ transport: 'http' })`.
// There is no separate constructor to import; annotate values with the
// `AbloHttpClient` type, which is the return type of that call.
export {
  type AbloHttpClientOptions,
  type AbloHttpClient,
  type HttpModelClient,
} from './client/httpClient.js';
export {
  ABLO_DEFAULT_BASE_URL,
  ABLO_HOSTED_API_DOMAIN,
  ABLO_HOSTED_HTTP_BASE_URL,
  normalizeAbloHostedBaseUrl,
} from './client/auth.js';
// The flat surface is deliberately small: `AbloOptions` is what every caller
// sees on `Ablo({...})`, and the `Model*Params` types are the option objects
// you pass to `ablo.<model>.{retrieve,create,update,delete}`. Every other
// shape — Commit, Claim, Model, Claimed — is reached through the namespace, as
// `Ablo.Commit.*`, `Ablo.Claim.*`, `Ablo.Model.*`, and `Ablo.ClaimedOptions`.
export type {
  AbloOptions,
  LocalCountOptions,
  LocalReadOptions,
  ModelListScope,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
} from './client/Ablo.js';
/**
 * @deprecated Use `Ablo.Claim.Held`. This compatibility export remains until
 * the next major release because it was explicitly documented in 0.20.1.
 */
export type { HeldClaim } from './client/Ablo.js';
export type { AbloPersistence } from './client/persistence.js';
export {
  durableWritesConfigSchema,
  durableWriteStoreSchema,
  pendingWriteSchema,
} from './transactions/durableWriteStore.js';
export type {
  DurableWritesConfig,
  DurableWriteStore,
  PendingWrite,
} from './transactions/durableWriteStore.js';
/* eslint-disable @typescript-eslint/no-deprecated -- public compatibility aliases through the next major release */
export type {
  CommitOutboxRecord,
  CommitOutboxStore,
} from './transactions/commitOutboxStore.js';
/* eslint-enable @typescript-eslint/no-deprecated */
export {
  durableCommitEnvelopeSchema,
} from './transactions/commitEnvelope.js';
export type {
  CommitOutboxScope,
  DurableCommitEnvelope,
} from './transactions/commitEnvelope.js';
export {
  durableHttpCommitEnvelopeSchema,
} from './transactions/httpCommitEnvelope.js';
export type {
  DurableHttpCommitEnvelope,
} from './transactions/httpCommitEnvelope.js';
// Participant types live under `Ablo.Participant.*` —
// `Ablo.Participant.Joined`, `Ablo.Participant.Manager`,
// `Ablo.Participant.JoinOptions`, etc. Same dot-access shape as
// `Ablo.Peer`, `Ablo.Claim`. No flat re-exports.

import { Ablo } from './client/Ablo.js';
export default Ablo;

// Advanced, and rarely imported. The storage adapter for Data Source mode,
// where Ablo coordinates state while the canonical rows stay in your own
// database. The default is Ablo-managed storage; reach for this only when you
// have deliberately chosen to keep your database canonical. The matching types
// live under `Ablo.Source.*` (`Ablo.Source.Operation`, `Ablo.Source.Commit.Params`).
export {
  dataSource,
  sourceEventForOperation,
  signAbloSourceRequest,
  verifyAbloSourceRequest,
} from './source/index.js';

// Serves the Data Source `commit`, `load`, and `list` operations over an
// outbound WebSocket, so a database with no public inbound URL (running on a
// developer's machine or inside a locked-down network) can still be reached by
// dialing out to Ablo rather than accepting an inbound connection.
export {
  createSourceConnector,
  type SourceConnector,
  type SourceConnectorOptions,
  type ConnectorStatus,
} from './source/connector.js';

// Schema DSL is intentionally published from `@abloatai/ablo/schema`.
// Keeping it out of the root import preserves one clean runtime surface:
// `import Ablo from '@abloatai/ablo'`.

// Advanced, and rarely imported. The default conflict policy rejects writes
// premised on stale data and is already applied on the server, so import
// `defaultPolicy` only to build a custom policy on top of it. Leave it be and
// stale writes are rejected safely. The matching types live under `Ablo.Conflict.*`.
export { defaultPolicy, capabilityPreemptPolicy, interpretConflictAxis } from './policy/index.js';

// The typed error hierarchy. One import brings in every class you need to
// tell failures apart — by `e instanceof AbloX` or `e.type === 'AbloX'` — along
// with the helper that translates an HTTP response into the right class.
export {
  SyncSessionError,
  AbloError,
  AbloAuthenticationError,
  AbloPermissionError,
  AbloRateLimitError,
  AbloIdempotencyError,
  AbloConnectionError,
  AbloValidationError,
  AbloNotFoundError,
  AbloServerError,
  AbloStaleContextError,
  AbloClaimedError,
  AbloContentionError,
  CapabilityError,
  translateHttpError,
  hasWireCode,
  errorFromWire,
  toAbloError,
  ERROR_CODES,
  ERROR_CONTRACT_VERSION,
  errorCodeSpec,
  isRetryableCode,
  classifyRecovery,
  recoveryClassSchema,
  RECOVERY_CLASSES,
} from './errors.js';
export type { RequiredCapability } from './errors.js';
export type { ErrorCode, WireErrorCode, ErrorCategory, ErrorCodeSpec, RecoveryClass } from './errors.js';
// The wire contract for errors, with no dependencies: the JSON envelope shape
// plus the table mapping each AbloError subclass to an HTTP status. A server
// that returns Ablo errors can assert against these so its responses never
// drift from what the client expects.
export { errorEnvelope, statusForType } from './wire/errorEnvelope.js';
export type { ErrorEnvelope } from './wire/errorEnvelope.js';
export { WS_BEARER_SUBPROTOCOL_PREFIX, WS_SYNC_SUBPROTOCOL } from './auth/credentialSource.js';
export {
  ENVIRONMENTS,
  environmentSchema,
  normalizeEnvironment,
  environmentFromKeyPrefix,
  environmentToKeyPrefix,
  isSandboxEnvironment,
} from './environment.js';
export type { Environment, KeyPrefixEnvironment } from './environment.js';

// The write-options contract: the single Zod schema for the option bag every
// write accepts (`ablo.<model>.create/update/delete`, `commits.create`, and the
// HTTP model routes). The SDK validates against it at each boundary, and it is
// exported so you can validate or assemble options before a call — for example,
// as the input schema of an agent tool. It is the runtime counterpart of the
// `MutationOptions` type.
export {
  writeOptionsSchema,
  onStaleModeSchema,
  assertWriteOptions,
} from './client/writeOptionsSchema.js';
export type { WriteOptionsInput } from './client/writeOptionsSchema.js';
export type { WriteOptions, MutationOptions } from './interfaces/index.js';

// The value handed back to a writer whose change hit a stale-context conflict
// under `onStale: 'notify'`. Instead of throwing, the commit succeeds and
// returns this notification so the caller can reconcile against the current
// value and retry rather than discard its work.
export { staleNotificationSchema, readDependencySchema } from './coordination/schema.js';
export type { StaleNotification, ReadDependency } from './coordination/schema.js';
// Collects claim events and stale-write collisions into an ordered list you can
// print to inspect coordination, or read through `collisions()` to assert on in
// tests. Pass `new ClaimLog()` as `Ablo({ observability })`.
export { ClaimLog, formatClaim, formatConflict } from './coordination/trace.js';
export type { ClaimLogEntry } from './coordination/trace.js';
export type {
  ClaimEvent,
  ConflictEvent,
  SyncObservabilityProvider,
} from './interfaces/index.js';
// Spread this to provide a custom `observability` that overrides only the hooks
// you care about (e.g. captureClaim) and no-ops the rest.
export { noopObservability } from './SyncEngineContext.js';
// Detects a stuck local store: use these to recognize when the browser's
// IndexedDB backing store fails to open in time, so your app can show a
// recovery screen instead of hanging.
export { IDBOpenTimeoutError, isStorageOpenTimeout } from './core/openIDBWithTimeout.js';

// A machine-readable manifest of the SDK's public verb and option names, bound
// at compile time to the real types so the lists can never name a method or
// option the API doesn't have. Useful for generating documentation or tooling
// that needs to enumerate the surface.
export {
  PUBLIC_MODEL_VERBS,
  PUBLIC_LIST_OPTION_KEYS,
  PUBLIC_ABLO_OPTION_KEYS,
} from './surface.js';
export type { ModelVerb, ListOptionKey, AbloOptionKey } from './surface.js';

// The type-registration point. Register your Schema and UserMeta once through
// module augmentation:
//   declare module '@abloatai/ablo' { interface Register { Schema: ... } }
// The augmentation merges into this declaration, and the resolved types are
// then available under the `Ablo` namespace (`Ablo.ResolveSchema`, and so on).
export type { Register, DefaultSyncShape } from './types/global.js';

// Advanced, and rarely imported. Custom mutators. Ordinary writes go through
// `ablo.<model>.create/update/delete`; reach for `defineMutators` only when you
// need a named, multi-step mutation with its own undo behavior. The matching
// types live under the `Ablo` namespace:
//   Ablo.Mutator.Fn, Ablo.Transaction
//   Ablo.Mutator.UndoEntry, Ablo.Mutator.InverseOp
//   Ablo.Query, Ablo.QueryBatch, Ablo.QueryBatchResult
export { defineMutators } from './mutators/defineMutators.js';
// `createTransaction` lets callers outside React — server-side workers, agent
// runtimes — run custom mutators without the `useMutators` hook. Build a
// transaction from the client's schema, store, and organization id, then pass
// it to your mutator function as `{ tx, args }`.
export { createTransaction, type Transaction } from './mutators/Transaction.js';
// Undo runtime is intentionally not part of the public root surface. App code
// uses `useUndoScope` from `@abloatai/ablo/react`.

// JSON comparison helpers. A `field.json()` value stored in a Postgres `jsonb`
// column can come back with its object keys reordered, because jsonb does not
// preserve key order. A naive `JSON.stringify(a) === JSON.stringify(b)` check
// then reports a difference that isn't real — a common trap when reconciling an
// Ablo row against external editor state. These compare independent of key
// order, so use them instead.
export { deepEqual, stableStringify } from './utils/json.js';
