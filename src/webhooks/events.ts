/**
 * `@abloatai/ablo/webhooks` — the WEBHOOK EVENT CATALOG and the
 * `delta → typed event` mapping.
 *
 * This is the ONLY part of webhook delivery that's Ablo-specific: turning a
 * committed transaction-log delta into a customer-facing, Stripe-style event.
 * Everything else is the ecosystem — Svix delivers/signs/retries, and the
 * customer verifies with the open Standard Webhooks library
 * (`new Webhook(secret).verify(body, headers)`).
 *
 * The event carries `syncId` — the monotonic transaction-log position — which
 * is BETTER than Stripe: the customer can both dedupe (skip a `syncId` already
 * processed) AND apply in order (`syncId` is the order), instead of Stripe's
 * "tolerate out-of-order + refetch."
 */
import type { SyncDeltaAction } from '../schema/sync-delta-wire.js';

/**
 * The customer-facing verb per delta action. Only the CRUD-ish actions become
 * webhook events; `C`overing / `G`roupAdded / `S`groupRemoved are internal sync
 * mechanics (permission/visibility), NOT customer events → no webhook.
 */
const ACTION_VERB: Partial<Record<SyncDeltaAction, string>> = {
  I: 'created',
  U: 'updated',
  D: 'deleted',
  A: 'archived',
  V: 'unarchived',
};

/**
 * A Stripe-style webhook event delivered to the customer's endpoint. Verified
 * (via the Standard Webhooks library) before the customer reads it.
 */
export interface AbloWebhookEvent {
  /** Stable event id = `String(syncId)`. Dedupe by this (idempotency). */
  readonly id: string;
  /** `<model>.<verb>`, e.g. `"slide.updated"` — switch on this. */
  readonly type: string;
  /** Wire model name, e.g. `"Slide"`. */
  readonly model: string;
  /** The changed row's id. */
  readonly objectId: string;
  /** Monotonic transaction-log position. ORDER by this (and dedupe). */
  readonly syncId: number;
  /** The post-change row (the object), or `null` on a delete. Like Stripe's
   *  `event.data.object`. */
  readonly data: Record<string, unknown> | null;
  /** ISO timestamp the change was committed. */
  readonly createdAt: string;
}

/** The minimal delta shape the mapping reads (a `ServerSyncDelta` satisfies it). */
export interface WebhookSourceDelta {
  readonly id: number;
  readonly actionType: string;
  readonly modelName: string;
  readonly modelId: string;
  /** `jsonb` — parsed object, raw JSON string, or null. */
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
 * Map a committed delta to a customer-facing webhook event. Returns `null` for
 * internal sync deltas (permission/group changes) that aren't customer events —
 * the caller skips those (no webhook emitted). Pure: the `syncId` and timestamp
 * come from the delta, so the mapping is deterministic.
 */
export function deltaToWebhookEvent(delta: WebhookSourceDelta): AbloWebhookEvent | null {
  const verb = ACTION_VERB[delta.actionType as SyncDeltaAction];
  if (!verb) return null; // C / G / S — internal sync mechanics, not a customer event

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
