/**
 * The input a queued mutation carries, derived from a local model.
 *
 * Six small rules that answer one question: given a model and what changed on
 * it, what does the commit actually send? They sat as private methods on
 * `MutationQueue` because that is where they were called, which is how a queue
 * ends up also owning the payload vocabulary.
 *
 * The before-image rule is the one worth reading twice, and it is stated in
 * `previousDataFor` rather than here.
 */

import type { LocalModel } from '../../localModelContract.js';
import type { RuntimeContext } from '../../RuntimeContext.js';
import { projectCommitPayload, type MutationInput } from './commitPayload.js';

/** A queued transaction's local identity, unique per process and monotonic enough to sort. */
export function generateTransactionId(): string {
  return `tx_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/** Local values win: they are the edit the caller made, remote is the base. */
export function mergeMutationData(
  local: MutationInput | undefined,
  remote: MutationInput | undefined,
): MutationInput {
  return { ...(remote ?? {}), ...(local ?? {}) };
}

/** A create sends the whole row, `undefined` included, so absence is explicit. */
export function createDataFor(model: LocalModel, runtime?: RuntimeContext): MutationInput {
  return projectCommitPayload(model.getModelName(), model.toJSON(), { dropUndefined: false }, runtime);
}

/** An arbitrary change set, projected the way an update is. */
export function changesToInput(
  modelName: string,
  changes: Record<string, unknown>,
  runtime?: RuntimeContext,
): MutationInput {
  return projectCommitPayload(modelName, changes, { dropUndefined: true }, runtime);
}

/** An update sends only what changed. */
export function updateDataFor(model: LocalModel, runtime?: RuntimeContext): MutationInput {
  return projectCommitPayload(model.getModelName(), model.getChanges(), { dropUndefined: true }, runtime);
}

/**
 * The before-image an undo reverts to.
 *
 * When the update's written keys are known, capture a before-image for exactly
 * those keys, so the recorded undo inverse reverts them and nothing else — a
 * full-row inverse would clobber concurrent edits to unrelated fields.
 * `fallbackToLive: false` makes `Model.capturePreviousValues` omit any key it
 * cannot resolve, and `buildUndoOps` then drops an un-revertible inverse rather
 * than inventing one. With no `updateInput` (a full extract) it falls back to
 * every tracked field.
 *
 * Model-specific special cases do not belong here: a model that needs to
 * surface previous state beyond `modifiedProperties` should expose a typed
 * `getPreviousData()` accessor for this to call.
 */
export function previousDataFor(model: LocalModel, updateInput?: MutationInput): MutationInput {
  const keys = updateInput
    ? Object.keys(updateInput)
    : [...(model.modifiedProperties instanceof Map ? model.modifiedProperties.keys() : [])];
  return { id: model.id, ...model.capturePreviousValues(keys, { fallbackToLive: false }) };
}
