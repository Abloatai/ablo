/**
 * The slice of client configuration the HTTP transport reads.
 *
 * The composed `Ablo({ ... })` bag is assembled by the consumer and carries far
 * more than this — persistence, offline, reactivity. The transport needs only
 * the fields below, so the core declares them and stays out of the composition
 * surface (ADR 0016).
 *
 * TypeScript is structural, so a consumer's full options object satisfies this
 * without declaring `extends`; the composition root keeps owning its own type.
 */

import type { Schema, SchemaRecord } from '../schema/schema.js';
import type { AuthClientOptions } from '../auth/apiKey.js';
import type { CoordinationObservability } from '../observability.js';
import type { CommitOutboxScope } from '../transactions/settlement/commitEnvelope.js';
import type {
  DurableWriteStore,
  DurableWritesConfig,
} from '../durableWrites.js';

export interface HttpClientConfig<S extends SchemaRecord = SchemaRecord>
  // The credential fields come from the one place that defines them, so this
  // config cannot narrow away an option the resolvers still read.
  extends AuthClientOptions {
  schema: Schema<S>;
  /** Overrides where credential exchange and bootstrap are reached. */
  bootstrapBaseUrl?: string;
  fetch?: typeof fetch | undefined;
  defaultHeaders?: Record<string, string | null | undefined> | undefined;
  defaultQuery?: Record<string, string | undefined> | undefined;
  observability?: CoordinationObservability;
  /** Crash-durable writes: the outbox is sealed before a request is dispatched. */
  durableWrites?: DurableWritesConfig;
  /** Compatibility input for pre-`durableWrites` clients. */
  commitOutbox?: DurableWriteStore;
  /** Compatibility input and internal child-client identity seam. */
  commitOutboxScope?: CommitOutboxScope;
  /** Which transport carries this client's traffic. */
  transport?: 'websocket' | 'http' | undefined;
}
