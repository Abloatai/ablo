/**
 * `@abloatai/ablo/webhooks` — the webhook event catalog + delta mapping.
 *
 * Customers import {@link AbloWebhookEvent} to type their handler; the server
 * uses {@link deltaToWebhookEvent} to turn transaction-log deltas into events
 * for Svix to deliver. Signature verification is NOT here — the customer uses
 * the open Standard Webhooks library (`svix` / `standardwebhooks`), so Ablo
 * ships no crypto.
 */
export {
  deltaToWebhookEvent,
  type AbloWebhookEvent,
  type WebhookSourceDelta,
} from './events.js';
