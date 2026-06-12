/**
 * @abloatai/ablo — The Collaboration Layer for AI and Humans
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
 * `Ablo({ schema, apiKey })` gives typed model clients. `Ablo({ apiKey })`
 * gives the HTTP model/commit client for agents, MCP routes, and custom
 * runtimes.
 *
 * Stripe / Anthropic / OpenAI all do this: one import, model clients
 * reached via dot-access on the engine, types via namespace dots.
 *
 * Public subpaths:
 *   @abloatai/ablo/schema   — defineSchema, model, z (Zod)
 *   @abloatai/ablo/react    — <AbloProvider>, useQuery, useMutate
 *   @abloatai/ablo/testing  — test harnesses + mocks
 *
 * Reads split by where the data comes from. `ablo.<model>.retrieve({ id })` and
 * `.list({ where })` are the async **server** reads (pool → IDB → network via
 * the `HydrationCoordinator`, single-flight deduped); they're the default and
 * what hosted/stateless callers want, since their local graph starts empty.
 * `ablo.<model>.get(id)` / `.getAll(...)` / `.getCount(...)` are synchronous
 * **local-graph** snapshots with no network round-trip — for reactive React
 * selectors (`useAblo((ablo) => ablo.<model>.get(id))`) once the graph is warm.
 *
 * ── What to import (read this first) ────────────────────────────────
 * Default path — this is all most apps and agents ever need:
 *   • `Ablo` (default export) + `AbloOptions` + the `Model*Params` bags
 *   • the `Ablo*Error` classes, to discriminate failures in catch blocks
 * That's it. If you're reaching past those, you're in advanced territory.
 *
 * Advanced — opt-in, most apps never import these (each is tagged
 * "Advanced —" at its export below, with the one situation it's for):
 *   • `dataSource` / `abloSource`  — only if your own DB stays canonical
 *   • `session` / `agent`          — only for delegated agent principals
 *   • `defaultPolicy`              — only to customize conflict resolution
 *   • `defineMutators` / `createTransaction` — only for custom mutators
 * If you don't recognize one, you don't need it — the default path covers you.
 */

// ── Consumer API ──────────────────────────────────────────────────────────
// These are the only symbols external consumers should need from this path.
// Everything else is in a subpath.

// The canonical surface — `Ablo` is a function, type, and namespace under
// one name. Matches `Stripe`, `OpenAI`, `Anthropic`. Default export so
// `import Ablo from '@abloatai/ablo'` works; named export so
// `import { Ablo }` also compiles.
export { Ablo } from './client/Ablo.js';
export type { MutationExecutor } from './interfaces/index.js';
// `InternalAbloOptions` carries the full construction surface (auth + transport
// + DI + sync groups) that app shells need to build a client to hand to
// `<AbloProvider client={...}>`. `AbloOptions` is the trimmed public shape.
export type { HttpClaimApi, InternalAbloOptions } from './client/Ablo.js';
export {
  createAbloHttpClient,
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
// Flat surface stays small on purpose: `AbloOptions` is what every
// consumer sees on `Ablo({...})`, and `Model*Params` are the single
// params objects you pass into `ablo.<model>.{retrieve,create,update,delete}`. Every
// other shape — Commit/Intent/Model/Claimed — lives under
// `Ablo.Commit.*`, `Ablo.Intent.*`, `Ablo.Model.*`, `Ablo.ClaimedOptions`.
export type {
  AbloOptions,
  ModelCountOptions,
  ModelListOptions,
  ModelListScope,
  ModelLoadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  ClaimHandle,
  ModelOperations,
} from './client/Ablo.js';
export type { AbloPersistence } from './client/persistence.js';
// Participant types live under `Ablo.Participant.*` —
// `Ablo.Participant.Joined`, `Ablo.Participant.Manager`,
// `Ablo.Participant.JoinOptions`, etc. Same dot-access shape as
// `Ablo.Peer`, `Ablo.Claim`. No flat re-exports.

// Advanced — most apps never import this. Principal constructors for
// delegated agent paths (`Ablo({ kind: 'agent', as: session({...}) })`).
// The default `Ablo({ schema, apiKey })` resolves identity from the key;
// reach for these only when minting a delegated agent principal.
export { session, agent } from './principal.js';

import { Ablo } from './client/Ablo.js';
export default Ablo;

// Advanced — most apps never import this. Customer-owned storage adapter
// for Data Source mode: only when Ablo Cloud coordinates state while
// canonical rows stay in YOUR database. The default is Ablo-managed
// storage — if you haven't deliberately chosen to keep your own DB
// canonical, skip this entirely. Type counterparts live under
// `Ablo.Source.*` (`Ablo.Source.Operation`, `Ablo.Source.Commit.Params`).
export {
  dataSource,
  abloSource,
  sourceEventForOperation,
  signAbloSourceRequest,
  verifyAbloSourceRequest,
} from './source/index.js';

// Schema DSL is intentionally published from `@abloatai/ablo/schema`.
// Keeping it out of the root import preserves one clean runtime surface:
// `import Ablo from '@abloatai/ablo'`.

// Advanced — most apps never import this. Conflict policy: `defaultPolicy`
// (reject-on-stale) is already applied server-side, so you only import it
// to COMPOSE a custom policy. Leave it alone and stale writes are rejected
// safely by default. Type counterparts live under `Ablo.Conflict.*`.
export { defaultPolicy, capabilityPreemptPolicy } from './policy/index.js';

// Typed error hierarchy — Stripe-style. One import gets every class
// consumers need to discriminate failures (`e instanceof AbloX` or
// `e.type === 'AbloX'`) plus the HTTP-response translator.
export {
  SyncSessionError,
  AbloError,
  AbloAuthenticationError,
  AbloPermissionError,
  AbloRateLimitError,
  AbloIdempotencyError,
  AbloConnectionError,
  AbloValidationError,
  AbloServerError,
  AbloStaleContextError,
  AbloClaimedError,
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
export type { CommitReceipt, RequiredCapability } from './errors.js';
export type { ErrorCode, WireErrorCode, ErrorCategory, ErrorCodeSpec, RecoveryClass } from './errors.js';
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

// THE write-options contract — the one Zod schema for the option bag every
// write door accepts (`ablo.<model>.create/update/delete`, `commits.create`,
// the HTTP model routes). The SDK validates against it at each boundary;
// it's exported so consumers can validate/compose options ahead of a call
// (e.g. an agent tool's input schema). Runtime twin of `MutationOptions`,
// drift-guarded at compile time.
export {
  writeOptionsSchema,
  onStaleModeSchema,
  assertWriteOptions,
} from './client/writeOptionsSchema.js';
export type { WriteOptionsInput } from './client/writeOptionsSchema.js';
export type { WriteOptions, MutationOptions } from './interfaces/index.js';
// Storage-wedge detection — lets app shells render a recovery screen when the
// IndexedDB backing store is stuck (see core/openIDBWithTimeout.ts).
export { IDBOpenTimeoutError, isStorageOpenTimeout } from './core/openIDBWithTimeout.js';

// Type registration point. Consumers register their Schema/Presence/Intents/
// UserMeta once via module augmentation:
//   declare module '@abloatai/ablo' { interface Register { Schema: ... } }
// Exported here so that augmentation merges into the canonical declaration.
// Resolver types live under the `Ablo` namespace (`Ablo.ResolveSchema`, …).
export type { Register, DefaultSyncShape } from './types/global.js';

// Advanced — most apps never import this. Custom (Zero-style) mutators:
// `ablo.<model>.create/update/delete` already covers normal writes. Reach
// for `defineMutators` only when you need a named, multi-step mutation with
// custom undo. Type counterparts live under the `Ablo` namespace:
//   Ablo.Mutator.Fn, Ablo.Transaction
//   Ablo.Mutator.UndoEntry, Ablo.Mutator.InverseOp
//   Ablo.Query, Ablo.QueryBatch, Ablo.QueryBatchResult
export { defineMutators } from './mutators/defineMutators.js';
// `createTransaction` is exposed so non-React callers (the sandbox AI
// executor, server-side workers) can invoke `defineMutators`-style
// custom mutators without going through `useMutators`. Construct a tx
// against `ablo.schema` + `ablo._store` + `ablo.organizationId` and
// pass it as `{ tx, args }` to the mutator function.
export { createTransaction, type Transaction } from './mutators/Transaction.js';
// Undo runtime is intentionally not part of the public root surface. App code
// uses `useUndoScope` from `@abloatai/ablo/react`.
