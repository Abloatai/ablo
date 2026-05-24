/**
 * @ablo/sync-engine — The Collaboration Layer for AI and Humans
 *
 * ```ts
 * import Ablo from '@ablo/sync-engine';
 *
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * await ablo.tasks.load({ where: { id: 'task_123' } });
 * await ablo.tasks.update('task_123', { title: 'Fix bug' });
 *
 * type Entry = Ablo.Peer;
 * ```
 *
 * `Ablo({ schema, apiKey })` gives typed model resources. `Ablo({ apiKey })`
 * gives the lower-level Resource / Intent / Commit client for agents,
 * MCP routes, and custom runtimes.
 *
 * Stripe / Anthropic / OpenAI all do this: one import, resources
 * reached via dot-access on the engine, types via namespace dots.
 *
 * Public subpaths:
 *   @ablo/sync-engine/schema   — defineSchema, model, z (Zod)
 *   @ablo/sync-engine/react    — <AbloProvider>, useQuery, useMutate
 *   @ablo/sync-engine/testing  — test harnesses + mocks
 *
 * Consumer code should converge on `ablo.<model>.load(...)`, which routes
 * through the engine's `HydrationCoordinator` and dedupes single-flight
 * hydrations.
 */

// ── Consumer API ──────────────────────────────────────────────────────────
// These are the only symbols external consumers should need from this path.
// Everything else is in a subpath.

// The canonical surface — `Ablo` is a function, type, and namespace under
// one name. Matches `Stripe`, `OpenAI`, `Anthropic`. Default export so
// `import Ablo from '@ablo/sync-engine'` works; named export so
// `import { Ablo }` also compiles.
export { Ablo } from './client/Ablo.js';
// Flat surface stays small on purpose: `AbloOptions` is what every
// consumer sees on `Ablo({...})`, and `Model*Options` are the four
// option bags you pass into `ablo.<model>.{load,list,count}`. Every
// other shape — Commit/Intent/Resource/Busy — lives under
// `Ablo.Commit.*`, `Ablo.Intent.*`, `Ablo.Resource.*`, `Ablo.BusyOptions`.
export type {
  AbloOptions,
  ModelCountOptions,
  ModelListOptions,
  ModelListScope,
  ModelLoadOptions,
  ModelEditHandle,
  ModelEditOptions,
  ModelOperations,
} from './client/Ablo.js';
export type { AbloPersistence } from './client/persistence.js';
// Participant types live under `Ablo.Participant.*` —
// `Ablo.Participant.Joined`, `Ablo.Participant.Manager`,
// `Ablo.Participant.JoinOptions`, etc. Same dot-access shape as
// `Ablo.Peer`, `Ablo.Claim`, `Ablo.Turn`. No flat re-exports.

// Principal constructors — explicit factories for delegation paths
// (`Ablo({ kind: 'agent', as: session({...}) })`). Function exports
// because they're constructors, not types.
export { session, agent } from './principal.js';

import { Ablo } from './client/Ablo.js';
export default Ablo;

// Customer-owned storage adapter. Used only when Ablo Cloud coordinates
// state while canonical rows remain in the customer's database. Runtime
// helpers ship flat; type counterparts live under `Ablo.Source.*`
// (`Ablo.Source.Operation`, `Ablo.Source.Commit.Params`, etc.).
export {
  dataSource,
  abloSource,
  signAbloSourceRequest,
  verifyAbloSourceRequest,
} from './source/index.js';

// Schema DSL is intentionally published from `@ablo/sync-engine/schema`.
// Keeping it out of the root import preserves one clean runtime surface:
// `import Ablo from '@ablo/sync-engine'`.

// Conflict policy — `defaultPolicy` (the rejecting default) is a value
// callers reference if they want to compose. The type counterparts
// (`Conflict`, `ConflictPolicy`, etc.) live under `Ablo.Conflict`,
// `Ablo.Conflict.Policy` on the namespace.
export { defaultPolicy } from './policy/index.js';

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
  AbloBusyError,
  CapabilityError,
  translateHttpError,
} from './errors.js';
export type { CommitReceipt, RequiredCapability } from './errors.js';

// Typed-global augmentation point. Consumers declare their Schema/Presence/
// Intents/UserMeta once in a `.d.ts` via `declare global { interface AbloSync
// { ... } }`. Resolver types live under the `Ablo` namespace —
// `Ablo.ResolveSchema`, `Ablo.ResolvePresence`, etc. — pure type-level.

// Custom mutators — runtime entry point only.
// Type counterparts moved to the `Ablo` namespace:
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
// uses `useUndoScope` from `@ablo/sync-engine/react`.
