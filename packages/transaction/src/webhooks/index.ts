/**
 * The public entry point for webhooks. Import {@link AbloWebhookEvent} to type
 * your event handler, and use {@link deltaToWebhookEvent} to turn a committed
 * change from the transaction log into an event to deliver. This module does not
 * verify signatures and ships no cryptography; recipients verify deliveries with
 * a standard webhooks library.
 */
export {
  deltaToWebhookEvent,
  type AbloWebhookEvent,
  type WebhookSourceDelta,
} from './events.js';
