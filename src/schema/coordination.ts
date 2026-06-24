/**
 * Coordination authoring helpers for the model `conflict` axis.
 *
 * Composable disposition functions + a `cn`/`cx`-style combinator, so a model
 * declares conflict behaviour the way the rest of the DSL reads
 * (`relation.belongsTo()`, `field.string()`) — and the way modern libraries
 * compose config (Better Auth's `plugins: [admin(), twoFactor()]`, shadcn's
 * `cx(a, b)`) — instead of a raw disposition map:
 *
 * ```ts
 * import { coordination, humansOverwrite, agentsReject } from '@abloatai/ablo/schema';
 *
 * conflict: coordination(humansOverwrite(), agentsReject())
 * // → { user: 'overwrite', agent: 'reject' }  (a human's write wins, an agent's yields)
 * ```
 *
 * Each helper is named for the exact disposition it applies — the same
 * `overwrite | reject | notify` vocabulary used by write guards (`onStale`) —
 * and returns a partial {@link ConflictAxis}. {@link coordination} merges them
 * (later rules win on key collisions). The result is plain, serializable data —
 * the engine interpreter and schema round-trip are unchanged; this is only a
 * nicer authoring surface.
 */

import type { ConflictAxis } from '../policy/types.js';

/**
 * One coordination rule: a partial {@link ConflictAxis} produced by a
 * disposition helper below. Compose with {@link coordination}.
 */
export type ConflictRule = ConflictAxis;

// ── Humans (user sessions) ──────────────────────────────────────────────
/** A human's conflicting write OVERWRITES — wins; never blocked (LWW among humans). */
export const humansOverwrite = (): ConflictRule => ({ user: 'overwrite' });
/** A human's conflicting write is REJECTED — yields to a held claim / stale snapshot. */
export const humansReject = (): ConflictRule => ({ user: 'reject' });
/** A human's stale write NOTIFIES — re-reads & re-applies instead of clobbering. */
export const humansNotify = (): ConflictRule => ({ user: 'notify' });

// ── Agents (AI) ─────────────────────────────────────────────────────────
/** An agent's conflicting write OVERWRITES — wins (rarely wanted). */
export const agentsOverwrite = (): ConflictRule => ({ agent: 'overwrite' });
/** An agent's conflicting write is REJECTED — yields to a held claim / stale snapshot. */
export const agentsReject = (): ConflictRule => ({ agent: 'reject' });
/** An agent's stale write NOTIFIES — re-reads & re-applies instead of clobbering. */
export const agentsNotify = (): ConflictRule => ({ agent: 'notify' });

// ── System / automation ─────────────────────────────────────────────────
/** A system/automation conflicting write OVERWRITES. */
export const systemOverwrite = (): ConflictRule => ({ system: 'overwrite' });
/** A system/automation conflicting write is REJECTED. */
export const systemReject = (): ConflictRule => ({ system: 'reject' });
/** A system/automation stale write NOTIFIES (re-read & re-apply). */
export const systemNotify = (): ConflictRule => ({ system: 'notify' });

/**
 * Merge coordination rules into one {@link ConflictAxis} — the `cn`/`cx` of
 * conflict policy. Later rules win on key collisions; an omitted committer kind
 * falls through to the engine default at commit time.
 *
 * ```ts
 * coordination(humansOverwrite(), agentsReject())  // → { user: 'overwrite', agent: 'reject' }
 * ```
 */
export function coordination(...rules: readonly ConflictRule[]): ConflictAxis {
  return Object.assign({}, ...rules);
}
