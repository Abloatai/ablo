import type { TargetRange } from './schema.js';
import type { ClaimTargetDetails } from './locator.js';

/**
 * Whether two claims on the same entity collide — the single most consequential
 * predicate in the claim protocol, and the one rule that decides whether a
 * second writer is granted a lease or made to wait.
 *
 * It lived in two files for as long as there were two claim authorities: the
 * Redis lease store, which is authoritative wherever Redis is wired, and the
 * in-process presence store, which answers when it is not. Both spelled the
 * rule out in full, byte for byte, so a change to the granularity semantics had
 * two places to land and no way to notice when it landed in one. It is one
 * definition here, and both authorities import it.
 *
 * It lives in the settlement core rather than the server because it is the rule
 * itself, not a deployment of it: a claim authority running against a
 * developer's own database has to answer this question exactly the same way,
 * and a client that wants to predict a refusal before paying for the round trip
 * reads the same predicate. Nothing about it needs a socket, a store, or a
 * screen.
 *
 * Entity identity is NOT part of this comparison. Callers reach this predicate
 * having already narrowed to a single `(organization, environment, entityType,
 * entityId)` bucket — the lease store through its key, the presence store
 * through its per-entity scan — so what remains to decide is only whether the
 * two sub-targets within that entity overlap.
 *
 * **The bias is deliberate: when in doubt, conflict.** A false conflict costs a
 * writer a wait. A missed conflict hands two writers the same target and loses
 * one of their updates with no error anywhere, which is the failure this
 * predicate exists to prevent.
 */

/**
 * The named parts a claim covers, as one set.
 *
 * `field` and `fields` are the same idea at two cardinalities, so the rule
 * reads both through here and never has to ask which one a caller used. Names
 * are lowercased for the same reason the single-field comparison always
 * lowercased them.
 */
function fieldSet(target: ClaimTargetDetails | undefined): Set<string> {
  const named = [
    ...(target?.field !== undefined ? [target.field] : []),
    ...(target?.fields ?? []),
  ];
  // A path names a part too: `/content/3` addresses a position inside the
  // `content` field, so a claim on it covers that field and nothing else.
  //
  // Deriving it here is what stops a path from reading as EVERY field. A
  // target that named no field left this set empty, and an empty set means
  // "all of them" — so a claim on one paragraph blocked a write to `status`
  // on the same row. It also makes the exclusion honest in the other
  // direction: a write of the whole `content` field does conflict with a
  // claim on part of it, because nothing can write only that part.
  //
  // Only when no field was named outright — an explicit `field`/`fields`
  // beside a path is the caller being specific, and is not second-guessed.
  // A bare `range` derives nothing: it names a span without saying of what,
  // so it stays the conservative whole-row answer.
  const rootOfPath =
    named.length === 0 && target?.path !== undefined
      ? target.path.split('/').filter(Boolean)[0]
      : undefined;
  const names = rootOfPath !== undefined ? [...named, rootOfPath] : named;
  return new Set(names.map((n) => n.toLowerCase()));
}

/** Whether a claim narrows below the whole entity at all. */
function hasSubtarget(target: ClaimTargetDetails | undefined): boolean {
  return Boolean(
    target?.path ||
      target?.field ||
      (target?.fields && target.fields.length > 0) ||
      target?.range,
  );
}

function rangesOverlap(a: TargetRange, b: TargetRange): boolean {
  // Line-level overlap is the stable default. Columns can be layered
  // in by policy later, but line ranges are what code/editor agents
  // can reliably produce across tools.
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export function targetsConflict(
  held: ClaimTargetDetails,
  incoming: ClaimTargetDetails | undefined,
): boolean {
  // Whole-entity claims are conservative: they conflict with any
  // narrower path/field/range claim under the same entity.
  if (!hasSubtarget(held) || !hasSubtarget(incoming)) return true;

  // A claim is only as fine as the smallest thing the write path can address,
  // and today that is a field: nothing writes part of a value. So two paths
  // into the SAME field contend, and this rule used to grant them both — by
  // comparing paths for containment and answering "disjoint" for `/content/3`
  // against `/content/7`. Both holders were then blocked at their first write,
  // each by the other, which is a wait dressed as concurrency and resolves
  // only when someone releases.
  //
  // Both are answered below instead, through the field a path names: same
  // field, conflict; different fields, disjoint. Path containment returns when
  // a field can declare a smaller write unit than its whole value — an
  // operation rather than a value — because that is what makes two positions
  // inside one field separately writable and the disjointness real.

  // A claim that names no field covers every field, so it conflicts with any
  // claim under the same path. Two that both name fields conflict only where
  // their sets intersect.
  const heldFields = fieldSet(held);
  const incomingFields = fieldSet(incoming);
  const fieldConflicts =
    heldFields.size === 0 ||
    incomingFields.size === 0 ||
    [...heldFields].some((name) => incomingFields.has(name));
  const rangeConflicts =
    !held.range ||
    !incoming?.range ||
    rangesOverlap(held.range, incoming.range);

  return fieldConflicts && rangeConflicts;
}
