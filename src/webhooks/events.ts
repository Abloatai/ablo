/**
 * Translates a committed change from the transaction log into a typed webhook
 * event your customers can consume. This module holds the event catalog and the
 * delta-to-event mapping; it does not deliver, sign, retry, or verify events.
 * Delivery and signing are handled by your webhook infrastructure, and the
 * recipient verifies the signature with an off-the-shelf Standard Webhooks
 * library.
 *
 * Every event carries a `syncId`, the position of the change in the transaction
 * log, which increases monotonically. A recipient uses it two ways at once: to
 * skip a change it has already processed, and to apply changes in the order they
 * were committed.
 */
import type { SyncDeltaAction } from '../wire/delta.js';

/**
 * Maps each delta action code to the verb that appears in an event type. Only
 * the row-level create, update, delete, archive, and unarchive actions produce a
 * webhook. The remaining action codes describe internal permission and
 * visibility changes and are deliberately absent, so {@link deltaToWebhookEvent}
 * returns `null` for them.
 */
const ACTION_VERB: Partial<Record<SyncDeltaAction, string>> = {
  I: 'created',
  U: 'updated',
  D: 'deleted',
  A: 'archived',
  V: 'unarchived',
};

/**
 * A webhook event delivered to a customer's endpoint, representing a single
 * committed change to a row. {@link deltaToWebhookEvent} produces it, and the
 * recipient verifies the delivery signature before trusting its contents.
 */
export interface AbloWebhookEvent {
  /** A stable, unique event identifier equal to `String(syncId)`. Use it to
   *  deduplicate deliveries. */
  readonly id: string;
  /** The event type, formatted as `<model>.<verb>`, such as `"slide.updated"`.
   *  Branch on this to route the event. */
  readonly type: string;
  /** The name of the model whose row changed, such as `"Slide"`. */
  readonly model: string;
  /** The identifier of the row that changed. */
  readonly objectId: string;
  /** The change's position in the transaction log, increasing monotonically.
   *  Order events by this value. */
  readonly syncId: number;
  /** The row as it stands after the change, or `null` when the change was a
   *  delete. */
  readonly data: Record<string, unknown> | null;
  /** The time the change was committed, as an ISO 8601 timestamp. */
  readonly createdAt: string;
}

/** The minimal delta shape {@link deltaToWebhookEvent} reads; a full server-side
 *  delta record satisfies it. */
export interface WebhookSourceDelta {
  readonly id: number;
  readonly actionType: string;
  readonly modelName: string;
  readonly modelId: string;
  /** The row payload: an already-parsed object, a raw JSON string, or `null`. */
  readonly data: Record<string, unknown> | string | null;
  readonly createdAt: string;
}

function parseRow(data: WebhookSourceDelta['data']): Record<string, unknown> | null {
  if (data == null) return null;
  if (typeof data === 'string') {
    return data === '' ? null : (JSON.parse(data) as Record<string, unknown>);
  }
  return data;
}

/**
 * Converts a committed delta into an {@link AbloWebhookEvent}. Returns `null`
 * when the delta records an internal permission or group change rather than a
 * row-level change, in which case the caller emits no webhook. The mapping is
 * deterministic: the event id and timestamp come directly from the delta.
 */
export function deltaToWebhookEvent(delta: WebhookSourceDelta): AbloWebhookEvent | null {
  const verb = ACTION_VERB[delta.actionType as SyncDeltaAction];
  if (!verb) return null; // an internal permission or group change, not a customer event

  return {
    id: String(delta.id),
    type: `${delta.modelName.toLowerCase()}.${verb}`,
    model: delta.modelName,
    objectId: delta.modelId,
    syncId: delta.id,
    data: parseRow(delta.data),
    createdAt: delta.createdAt,
  };
}
