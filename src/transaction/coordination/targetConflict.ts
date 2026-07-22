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
  const names = [
    ...(target?.field !== undefined ? [target.field] : []),
    ...(target?.fields ?? []),
  ];
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

function lower(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

/**
 * Whether two paths address overlapping parts of a document.
 *
 * Paths are hierarchical, so equality is the wrong test: `/content` contains
 * `/content/3`, and a writer holding the parent is holding the child too.
 * Comparing them as opaque strings reported no conflict and granted both
 * leases — the parent's writer and the child's writer would then both write,
 * and one update would vanish with nothing raised anywhere.
 *
 * Containment is checked on a separator boundary so `/content` contains
 * `/content/3` but not `/contentious`, which is the same trap as any
 * prefix match over structured names.
 */
function pathsOverlap(a: string, b: string): boolean {
  const x = lower(a) ?? '';
  const y = lower(b) ?? '';
  if (x === y) return true;
  const contains = (parent: string, child: string): boolean =>
    child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  return contains(x, y) || contains(y, x);
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

  if (held.path && incoming?.path && !pathsOverlap(held.path, incoming.path)) {
    return false;
  }

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
