/**
 * @ablo/sync-engine — Multiplayer Sync SDK
 *
 * Main entry. Most consumers only need this + @ablo/sync-engine/schema.
 *
 * ```ts
 * import Ablo from '@ablo/sync-engine';
 * import { schema } from './my-schema';
 *
 * const ablo = new Ablo({ schema });
 * ```
 *
 * The default export is the `Ablo` class — package-name → class-name
 * parity matching `new Stripe()`, `new OpenAI()`, `new Anthropic()`.
 * The named `createMesh` factory is still exported for functional-style
 * callers; both reach the same implementation.
 *
 * Subpaths:
 *   @ablo/sync-engine/schema  — defineSchema, model, z (Zod)
 *   @ablo/sync-engine/mesh    — mesh-only surface (advanced)
 *   @ablo/sync-engine/client  — createSyncEngine
 *   @ablo/sync-engine/react   — withSync
 *   @ablo/sync-engine/agent   — SyncAgent
 *   @ablo/sync-engine/config  — initSyncEngine, DI types (advanced)
 *   @ablo/sync-engine/core    — BaseSyncedStore, SyncClient, Model, etc. (internal)
 */

// ── Consumer API ──────────────────────────────────────────────────────────
// These are the only things external consumers should need from this path.
// Everything else is in a subpath.

// The canonical class surface — matches `new Stripe()`, `new OpenAI()`.
// Default export so `import Ablo from '@ablo/sync-engine'` works, AND
// a named export so existing `import { Ablo }` style also compiles.
export { Ablo, createMesh, session, agent } from './mesh';
export type {
  CreateMeshOptions,
  AbloClient,
  AbloClientBase,
  MeshParticipant,
  JoinOptions,
  JoinDescription,
  AgentLike,
  Principal,
  SessionRef,
  AgentRef,
  ScopeRef,
} from './mesh';

/**
 * @deprecated Use `AbloClient` / `AbloClientBase`. Retained for back-compat.
 */
export type { MeshClient, MeshClientBase } from './mesh';
import { Ablo } from './mesh';
export default Ablo;

// Re-export schema DSL for convenience
export { defineSchema, model, field, relation, z } from './schema/index';
export type { Schema, InferModel, InferCreate, InferModelNames } from './schema/schema';

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
  CapabilityError,
  translateHttpError,
} from './errors';

// Typed-global augmentation point. Consumers declare their Schema/Presence/
// Intents/UserMeta once in a `.d.ts` via `declare global { interface AbloSync
// { ... } }`; every SDK hook reads its types from these resolvers. Falls
// back to `DefaultSyncShape` when the augmentation is absent so non-opting
// consumers keep compiling.
export type {
  DefaultSyncShape,
  ResolveSchema,
  ResolvePresence,
  ResolveIntents,
  ResolveUserMeta,
  ResolveModelKey,
} from './types/global';

// Re-export client factory for convenience
export { createSyncEngine } from './client/createSyncEngine';
export type { SyncEngine, SyncEngineOptions, ModelOperations } from './client/createSyncEngine';

// Custom mutators (Zero-style). Runtime is a thin pass-through + a Transaction
// factory; the heavy lifting is type inference. The React-side invoker hook
// lives in `./react/useMutators` (exported via the `/react` subpath).
export { defineMutators } from './mutators/defineMutators';
export type { MutatorFn, MutatorDefs } from './mutators/defineMutators';
export type { Transaction, TransactionMutate } from './mutators/Transaction';

// Undo/redo infrastructure. Apps typically don't instantiate `UndoManager`
// directly — `useUndoScope` in `/react` manages it — but the classes are
// exported for testing, non-React hosts, and advanced wiring.
export { UndoManager, UndoScope } from './mutators/UndoManager';
export type { UndoEntry, InverseOp, UndoScopeOptions } from './mutators/UndoManager';

// Generic structured query transport. Consumers compose their own
// product-specific fetch helpers on top of this — the SDK stays free of
// any particular model names.
export { postQuery } from './query/client';
export type { PostQueryOptions } from './query/client';
export type {
  Query,
  QueryBatch,
  QueryBatchResult,
  WhereClause,
  WhereOp,
  WherePrimitive,
} from './query/types';

// ── Internal (backwards compat — will be removed) ─────────────────────────
// Ablo's app imports these directly. New code should use subpaths.
// TODO: migrate apps/web to @ablo/sync-engine/core, then delete these.

export { Model } from './Model';
export { LazyReferenceCollection, type LazyCollectionOptions } from './LazyReferenceCollection';
export { ModelScope } from './ObjectPool';
export type { ModelData, ModelConstructor, ConcreteModelConstructor } from './BaseSyncedStore';
// OfflineTransactionStore moved to @ablo/sync-engine/core in the headless
// audit cleanup (see docs/headless-audit.md §4.1 Task 23). It touches
// indexedDB + Web Crypto and cannot live on the main barrel if we want
// plain Node imports to succeed without browser shims. Consumers that
// need it import from @ablo/sync-engine/core.
export { probeNetwork, type ProbeResult } from './sync/NetworkProbe';
