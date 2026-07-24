/**
 * Authoring helpers for a model's `conflict` axis — the setting that decides
 * what happens when two writers touch the same row. Instead of writing a raw
 * disposition map, you name the rules the way the rest of the schema DSL reads
 * (`relation.belongsTo()`, `field.string()`), and chain them the way a field
 * chains its own modifiers:
 *
 * ```ts
 * import { coordination } from '@abloatai/ablo/schema';
 *
 * conflict: coordination.humansOverwrite().agentsReject()
 * // → { user: 'overwrite', agent: 'reject' }  (a human's write wins, an agent's yields)
 * ```
 *
 * Each rule is named for the disposition it applies — drawn from the same
 * `overwrite | reject | notify` vocabulary the write guards use (`onStale`) —
 * and every one of them is also available as a standalone function, which
 * {@link coordination} merges when the rules are assembled dynamically rather
 * than written out:
 *
 * ```ts
 * conflict: coordination(humansOverwrite(), agentsReject())
 * ```
 *
 * Either way the result is plain, serializable data that the engine reads at
 * commit time. The `humans`/`agents` wording belongs to the author; the `user`/
 * `agent`/`system` keys belong to the wire, and this module is the one place
 * the two are mapped to each other.
 */

import type { ConflictAxis } from '../transaction/policy/types.js';

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
 * A conflict axis that is still open to more rules. Every method applies one
 * disposition and hands back a new axis, so a model's whole stance reads as a
 * single sentence and the reader never has to hold a merge in their head.
 *
 * Each method delegates to the standalone rule of the same name, so a
 * disposition map like `{ user: 'overwrite' }` is written in exactly one place
 * no matter which authoring style a schema uses. Dispositions are own
 * enumerable properties and the methods live on the prototype, so an axis
 * serializes to the same plain object the server has always received.
 */
class CoordinationAxis implements ConflictAxis {
  // Declared for their types only. A field with an initializer-less declaration
  // would still be emitted as an own property holding `undefined`, which would
  // put every unnamed kind on the wire as present-and-empty instead of absent —
  // and an unnamed kind has to stay absent to fall through to the engine
  // default. The constructor assigns only the kinds a rule actually named.
  declare readonly user?: ConflictAxis['user'];
  declare readonly agent?: ConflictAxis['agent'];
  declare readonly system?: ConflictAxis['system'];

  constructor(axis: ConflictAxis) {
    Object.assign(
      this,
      Object.fromEntries(Object.entries(axis).filter(([, mode]) => mode !== undefined))
    );
  }

  /** Apply one more rule, later winning on a repeated kind. */
  private and(rule: ConflictRule): CoordinationAxis {
    // Assigned rather than spread, and for the reason the merge form below
    // assigns too: what carries forward is the dispositions, which are own
    // enumerable properties. The chaining methods live on the prototype and the
    // constructor puts them back, so a chain accumulates nothing but data.
    return new CoordinationAxis(Object.assign({}, this, rule));
  }

  humansOverwrite(): CoordinationAxis {
    return this.and(humansOverwrite());
  }
  humansReject(): CoordinationAxis {
    return this.and(humansReject());
  }
  humansNotify(): CoordinationAxis {
    return this.and(humansNotify());
  }
  agentsOverwrite(): CoordinationAxis {
    return this.and(agentsOverwrite());
  }
  agentsReject(): CoordinationAxis {
    return this.and(agentsReject());
  }
  agentsNotify(): CoordinationAxis {
    return this.and(agentsNotify());
  }
  systemOverwrite(): CoordinationAxis {
    return this.and(systemOverwrite());
  }
  systemReject(): CoordinationAxis {
    return this.and(systemReject());
  }
  systemNotify(): CoordinationAxis {
    return this.and(systemNotify());
  }
}

/**
 * Merges coordination rules into a single {@link ConflictAxis}. Later rules win
 * on key collisions, and a committer kind you leave out falls through to the
 * engine's default at commit time.
 *
 * ```ts
 * coordination(humansOverwrite(), agentsReject())  // → { user: 'overwrite', agent: 'reject' }
 * ```
 */
function mergeRules(...rules: readonly ConflictRule[]): ConflictAxis {
  return Object.assign({}, ...rules) as ConflictAxis;
}

/**
 * The coordination vocabulary, reachable through one name. Call it to merge
 * rules you have assembled; reach through it to start a chain.
 *
 * ```ts
 * conflict: coordination.humansOverwrite().agentsReject()
 * conflict: coordination(humansOverwrite(), agentsReject())
 * ```
 */
export const coordination = Object.assign(mergeRules, {
  humansOverwrite: (): CoordinationAxis => new CoordinationAxis(humansOverwrite()),
  humansReject: (): CoordinationAxis => new CoordinationAxis(humansReject()),
  humansNotify: (): CoordinationAxis => new CoordinationAxis(humansNotify()),
  agentsOverwrite: (): CoordinationAxis => new CoordinationAxis(agentsOverwrite()),
  agentsReject: (): CoordinationAxis => new CoordinationAxis(agentsReject()),
  agentsNotify: (): CoordinationAxis => new CoordinationAxis(agentsNotify()),
  systemOverwrite: (): CoordinationAxis => new CoordinationAxis(systemOverwrite()),
  systemReject: (): CoordinationAxis => new CoordinationAxis(systemReject()),
  systemNotify: (): CoordinationAxis => new CoordinationAxis(systemNotify()),
});
