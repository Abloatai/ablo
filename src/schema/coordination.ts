/**
 * Authoring helpers for a model's `conflict` axis — the setting that decides
 * what happens when two writers touch the same row. Instead of writing a raw
 * disposition map, you compose small, named functions the way the rest of the
 * schema DSL reads (`relation.belongsTo()`, `field.string()`):
 *
 * ```ts
 * import { coordination, humansOverwrite, agentsReject } from '@abloatai/ablo/schema';
 *
 * conflict: coordination(humansOverwrite(), agentsReject())
 * // → { user: 'overwrite', agent: 'reject' }  (a human's write wins, an agent's yields)
 * ```
 *
 * Each helper is named for the disposition it applies — drawn from the same
 * `overwrite | reject | notify` vocabulary the write guards use (`onStale`) —
 * and returns a partial {@link ConflictAxis}. {@link coordination} merges the
 * pieces, with later rules winning on key collisions. The result is plain,
 * serializable data that the engine reads at commit time.
 */

import type { ConflictAxis } from '../policy/types.js';

/**
 * One coordination rule: a partial {@link ConflictAxis} produced by a
 * disposition helper below. Compose with {@link coordination}.
 */
export type ConflictRule = ConflictAxis;

// ── Humans (user sessions) ──────────────────────────────────────────────
/** A human's conflicting write wins and overwrites the other; it is never blocked. Among humans this gives last-write-wins. */
export const humansOverwrite = (): ConflictRule => ({ user: 'overwrite' });
/** A human's conflicting write is rejected, yielding to a held claim or a stale snapshot. */
export const humansReject = (): ConflictRule => ({ user: 'reject' });
/** A human's stale write triggers a notification: it re-reads and re-applies rather than clobbering. */
export const humansNotify = (): ConflictRule => ({ user: 'notify' });

// ── Agents (AI) ─────────────────────────────────────────────────────────
/** An agent's conflicting write wins and overwrites the other (rarely what you want). */
export const agentsOverwrite = (): ConflictRule => ({ agent: 'overwrite' });
/** An agent's conflicting write is rejected, yielding to a held claim or a stale snapshot. */
export const agentsReject = (): ConflictRule => ({ agent: 'reject' });
/** An agent's stale write triggers a notification: it re-reads and re-applies rather than clobbering. */
export const agentsNotify = (): ConflictRule => ({ agent: 'notify' });

// ── System / automation ─────────────────────────────────────────────────
/** A system or automation write wins and overwrites the other. */
export const systemOverwrite = (): ConflictRule => ({ system: 'overwrite' });
/** A system or automation write is rejected. */
export const systemReject = (): ConflictRule => ({ system: 'reject' });
/** A system or automation stale write triggers a notification: it re-reads and re-applies. */
export const systemNotify = (): ConflictRule => ({ system: 'notify' });

/**
 * Merges coordination rules into a single {@link ConflictAxis}. Later rules win
 * on key collisions, and a committer kind you leave out falls through to the
 * engine's default at commit time.
 *
 * ```ts
 * coordination(humansOverwrite(), agentsReject())  // → { user: 'overwrite', agent: 'reject' }
 * ```
 */
export function coordination(...rules: readonly ConflictRule[]): ConflictAxis {
  return Object.assign({}, ...rules);
}
