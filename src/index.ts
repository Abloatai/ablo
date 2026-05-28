/**
 * @abloatai/ablo — The Collaboration Layer for AI and Humans
 *
 * ```ts
 * import Ablo from '@abloatai/ablo';
 *
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * await ablo.weatherReports.load({ where: { id: 'report_stockholm' } });
 * await ablo.weatherReports.update('report_stockholm', { status: 'ready' });
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
 * Consumer code should converge on `ablo.<model>.load(...)`, which routes
 * through the engine's `HydrationCoordinator` and dedupes single-flight
 * hydrations.
 *
 * ── What to import (read this first) ────────────────────────────────
 * Default path — this is all most apps and agents ever need:
 *   • `Ablo` (default export) + `AbloOptions` + the `Model*Options` bags
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
// Flat surface stays small on purpose: `AbloOptions` is what every
// consumer sees on `Ablo({...})`, and `Model*Options` are the four
// option bags you pass into `ablo.<model>.{load,list,count}`. Every
// other shape — Commit/Intent/Model/Claimed — lives under
// `Ablo.Commit.*`, `Ablo.Intent.*`, `Ablo.Model.*`, `Ablo.ClaimedOptions`.
export type {
  AbloOptions,
  ModelCountOptions,
  ModelListOptions,
  ModelListScope,
  ModelLoadOptions,
  ClaimOptions,
  ClaimedRow,
  ModelOperations,
} from './client/Ablo.js';
export type { AbloPersistence } from './client/persistence.js';
// Participant types live under `Ablo.Participant.*` —
// `Ablo.Participant.Joined`, `Ablo.Participant.Manager`,
// `Ablo.Participant.JoinOptions`, etc. Same dot-access shape as
// `Ablo.Peer`, `Ablo.Claim`, `Ablo.Turn`. No flat re-exports.

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
  ERROR_CODES,
  ERROR_CONTRACT_VERSION,
  errorCodeSpec,
  isRetryableCode,
} from './errors.js';
export type { CommitReceipt, RequiredCapability } from './errors.js';
export type { ErrorCode, WireErrorCode, ErrorCategory, ErrorCodeSpec } from './errors.js';

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
