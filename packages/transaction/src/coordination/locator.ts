/**
 * The locator — what a claim points at, in every spelling it travels under.
 *
 * A target has two halves. The sub-entity half (`path`, `range`, `field`,
 * `fields`, `meta`) is spelled identically everywhere; the entity half is not.
 * It is `entityType`/`entityId` on the wire, `model`/`id` on the HTTP DTO and
 * the SDK's model surface, and `type`/`id` on the claim handle and the wait
 * line. The three coexist deliberately — unifying them changes every surface at
 * once, and that is scheduled behind the protocol version — but while they
 * coexist, the translation between them belongs in one place.
 *
 * It was copied member by member at more than twenty sites instead, which is
 * how `fields` came to be added to the schema and to the conflict rule while
 * several hops quietly dropped it: the rule learned to compare field sets while
 * no path carried one, so the fix looked complete and changed nothing. Widening
 * the locator again should touch this module and the schema, not every hop.
 */

import type { ClaimPart, ModelTarget, TargetRef, WireClaim } from './schema.js';
import {
  fieldSelection,
  type FieldRef,
  type FieldSelector,
} from '../schema/fieldRef.js';
import { partName } from './schema.js';
import type { ClaimTarget, PresenceTarget } from '../types/streams.js';
import type { ResolveClaimMeta } from '../types/global.js';
// The one declared→wire conversion for claim metadata; `declaredMeta` is its
// counterpart, called by the decodes that build a public claim.
import { wireMeta } from './claimMeta.js';

/**
 * The part of a claim that narrows it below the whole entity. A claim with none
 * of these set is a claim on the entity itself.
 *
 * `meta` is carried because it travels with the target everywhere else, not
 * because the rule reads it: application metadata is opaque to coordination and
 * never decides a conflict.
 */
export type ClaimTargetDetails = Pick<
  WireClaim,
  'field' | 'fields' | 'meta'
>;

/**
 * A locator as a *caller* may hold it — identical to {@link ClaimTargetDetails}
 * except that `meta` may already be the shape the program registered on
 * `Register`'s `ClaimMeta` slot, which an `interface` registration makes
 * distinct from the wire's open record.
 *
 * A projection that only accepted the wire spelling would push the conversion
 * back out to every call site that starts from a public target — the claim
 * handle, the model surface, the HTTP claim params — which is the same
 * member-by-member copying this module exists to end.
 */
export type ClaimTargetSource<T = Record<string, unknown>> =
  Omit<ClaimTargetDetails, 'meta' | 'field' | 'fields'> & {
  /** A schema field reference, wire name, or low-level app-defined part. */
  readonly field?: string | ClaimPart | FieldRef;
  readonly fields?:
    | readonly (string | ClaimPart | FieldRef)[]
    | FieldSelector<T>;
  readonly meta?: ClaimTargetDetails['meta'] | ResolveClaimMeta;
};

/**
 * Copy the sub-entity part of a locator from one target shape to another.
 *
 * These five members are spelled identically wherever a target appears, so this
 * owns all of them and the entity half is handled by its own projections below.
 *
 * Absent members are omitted rather than set to `undefined`, so a projected
 * target can be spread into an object under `exactOptionalPropertyTypes`.
 *
 * The result is wire-shaped, `meta` included: this is the projection every path
 * out of the SDK goes through, so it is also the single declared→wire crossing
 * for claim metadata. The way back is {@link declaredMeta}, at the two decodes
 * that build a public claim.
 */
export function subTarget<T = Record<string, unknown>>(
  // `null` as well as absent, because the claim body declares its target
  // nullish and the projection is most useful exactly where that body is read.
  source: ClaimTargetSource<T> | null | undefined,
  model?: string,
): ClaimTargetDetails {
  if (!source) return {};
  const selection =
    typeof source.fields === 'function'
      ? source.fields(fieldSelection(model ?? ''))
      : source.fields;
  const selectedFields =
    selection === undefined
      ? undefined
      : Array.isArray(selection)
        ? selection
        : [selection];
  return {
    // Part names cross to their wire spelling here — the one declared→wire
    // seam — so a `part('B2')` object never leaks into a frame or a URL.
    ...(source.field !== undefined ? { field: partName(source.field) } : {}),
    ...(selectedFields !== undefined ? { fields: selectedFields.map(partName) } : {}),
    ...(source.meta !== undefined ? { meta: wireMeta(source.meta) } : {}),
  };
}

/**
 * Whether a target was given in the `[type, id]` shorthand rather than the
 * object form.
 *
 * A predicate rather than an assertion, because `Array.isArray` leaves a
 * readonly tuple in both branches and the alternative — asserting the object
 * form — describes the locator by hand at every call site that resolves one.
 */
export function isTargetTuple(
  target: PresenceTarget,
): target is readonly [type: string, id: string] {
  return Array.isArray(target);
}

/**
 * An entity named in any of the three spellings a claim travels under.
 *
 * The union is discriminated by which key is present, and `{ model, id }` and
 * `{ type, id }` share `id` — so the read below tests `entityType` first, then
 * `model`, and falls through to `type`. A source carrying both `model` and
 * `type` is not expressible here and does not occur; it would take the earlier
 * branch if it did.
 */
export type EntityLocator =
  | Pick<TargetRef, 'entityType' | 'entityId'>
  | Pick<ModelTarget, 'model' | 'id'>
  | Pick<ClaimTarget, 'type' | 'id'>;

/** The entity as a name and an identifier, whichever spelling named it. */
function entityOf(source: EntityLocator): readonly [string, string] {
  if ('entityType' in source) return [source.entityType, source.entityId];
  if ('model' in source) return [source.model, source.id];
  return [source.type, source.id];
}

/** The entity half in the wire's spelling — claim frames, presence activity. */
export function wireTarget(
  source: EntityLocator,
): Pick<TargetRef, 'entityType' | 'entityId'> {
  const [entityType, entityId] = entityOf(source);
  return { entityType, entityId };
}

/** The entity half in the spelling SDK callers and the HTTP routes read. */
export function modelTarget(
  source: EntityLocator,
): Pick<ModelTarget, 'model' | 'id'> {
  const [model, id] = entityOf(source);
  return { model, id };
}

/** The entity half as the claim handle and the wait line carry it. */
export function streamTarget(
  source: EntityLocator,
): Pick<ClaimTarget, 'type' | 'id'> {
  const [type, id] = entityOf(source);
  return { type, id };
}

/**
 * A batch claim's grant: its fencing token, and the one row it was granted over.
 *
 * A claim's `readAt` generalises across a batch; its token does not. The token
 * is evidence of one row's place in the grant order, so it belongs only on the
 * operation writing the row the claim covers. Presented anywhere else the server
 * refuses it, because a token that travels is a fence any writer can raise.
 */
export type BatchFence = Pick<ModelTarget, 'model' | 'id'> & {
  readonly token: number;
};

/** The batch's grant, or nothing when there is no claim, or none with a token. */
export function batchFence(
  source: EntityLocator | null | undefined,
  token: number | null | undefined,
): BatchFence | null {
  return source == null || token == null
    ? null
    : { ...modelTarget(source), token };
}

/**
 * The token an operation carries: its own if it names one, the batch's when it
 * writes the claimed row, otherwise none.
 */
export function fenceTokenFor(
  fence: BatchFence | null,
  model: string,
  id: string | null,
): number | null {
  if (fence === null || id === null) return null;
  return model.toLowerCase() === fence.model.toLowerCase() && id === fence.id
    ? fence.token
    : null;
}

/**
 * The claim identity an operation carries when it writes the row named by a
 * held claim. Like the fence token, a claim id cannot travel to another row.
 */
export function claimIdFor(
  source: EntityLocator | null | undefined,
  claimId: string | null | undefined,
  model: string,
  id: string | null,
): string | null {
  if (source == null || claimId == null || id === null) return null;
  const target = modelTarget(source);
  return model.toLowerCase() === target.model.toLowerCase() && id === target.id
    ? claimId
    : null;
}
