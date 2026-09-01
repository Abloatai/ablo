/**
 * `Ablo` — the entry point to the coordination layer.
 *
 * The factory constructs the headless client: typed model resources, commits,
 * and claims. API-key clients use request/response HTTP.
 * Session clients use one reconnecting WebSocket by default; the session is
 * the scoped identity and outlives any individual socket connection.
 *
 * ```ts
 * import { Ablo } from '@abloatai/ablo';
 * import { schema } from '../schema';
 *
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * await ablo.items.update({ id: itemId, data: { status: 'done' } });
 * ```
 *
 * The reactive materialiser — local store, live queries, presence rendering —
 * is provided by `@abloatai/humans`, which layers
 * above this one and shares the same `ablo.<model>` surface (ADR 0016).
 */

import {
  createAbloHttpClient,
  type AbloHttpClient,
  type AbloWebSocketClient,
} from '../transport/http/client.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { PublicAbloOptions } from './surface.js';
import type * as _Streams from '../types/streams.js';
import type * as _SchemaTypes from '../schema/schema.js';
import type * as _Global from '../types/global.js';
import type * as _Http from './resources/httpResources.js';

/**
 * Create a coordination-layer client in one call.
 *
 * Transport follows identity by default: API keys use HTTP and sessions use a
 * reconnecting WebSocket without changing the model, commit, or claim API.
 */
export function Ablo<const S extends SchemaRecord>(
  options: PublicAbloOptions<S> & { readonly transport: 'websocket' },
): AbloWebSocketClient<S>;
export function Ablo<const S extends SchemaRecord>(
  options: PublicAbloOptions<S> & {
    readonly session: NonNullable<PublicAbloOptions<S>['session']>;
    readonly transport?: undefined;
  },
): AbloWebSocketClient<S>;
export function Ablo<const S extends SchemaRecord>(
  options: PublicAbloOptions<S>,
): AbloHttpClient<S>;
export function Ablo<const S extends SchemaRecord>(
  options: PublicAbloOptions<S>,
): AbloHttpClient<S> | AbloWebSocketClient<S> {
  return createAbloHttpClient(options);
}

// ─────────────────────────────────────────────────────────────────────
//  Ablo namespace — type access via namespace dots for headless callers
// ─────────────────────────────────────────────────────────────────────
//
// The headless subset of the type namespace the reactive package hangs off
// its own `Ablo` export: every entry a consumer of THIS client would write
// out (`Ablo.Activity`, `Ablo.Commit.Receipt`, and so on), and nothing that
// needs a store or a socket behind it. The
// types live in their canonical homes (`types/streams`, `claims/policy`,
// `client/resources/httpResources`, `schema/schema`); the namespace is a convenience
// path, not a second definition.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Ablo {
  // ── Entity pointers (flat — input shapes used everywhere) ─────────
  export type ClaimTarget = _Streams.ClaimTarget;
  export type PresenceTarget = _Streams.PresenceTarget;
  export type Duration = _Streams.Duration;

  // ── Coordination (flat — the surface a contending caller reads) ───
  export type Peer = _Streams.Peer;
  export type Activity = _Streams.Activity;
  export type Claim = _Streams.Claim;
  export type ClaimHeartbeat = _Streams.ClaimHeartbeat;
  export type ClaimHeartbeatOptions = _Streams.ClaimHeartbeatOptions;

  // ── Claim (sub-namespace — the durable-lease cohort) ──────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Claim {
    export type Held<
      T = Record<string, unknown>,
      M = _Global.ResolveClaimMeta,
    > = _Streams.HeldClaim<T, M>;
    export type WaitOptions = _Streams.ClaimWaitOptions;
    export type LeaseOptions = _Streams.ClaimLeaseOptions;
  }

  // ── Schema (type + sub-namespace via declaration merge) ───────────
  export type Schema<S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord> =
    _SchemaTypes.Schema<S>;
  /**
   * The schema this program has registered via `interface Register { Schema }`
   * (falls back to a loose shape when unregistered). Use it where shared code
   * needs "this app's schema" without importing a specific one.
   */
  export type ResolveSchema = _Global.ResolveSchema;
  /**
   * The claim metadata shape this program has registered via
   * `interface Register { ClaimMeta }` (falls back to a loose record when
   * unregistered). Every claim surface reads `target.meta` as this.
   */
  export type ResolveClaimMeta = _Global.ResolveClaimMeta;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Schema {
    export type Model<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.Model<S, K>;
    export type InferCreate<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferCreate<S, K>;
    export type InferRow<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferRow<S, K>;
    export type InferModelNames<S extends _SchemaTypes.Schema> =
      _SchemaTypes.InferModelNames<S>;
  }

  // ── Commit (sub-namespace — write-side cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Commit {
    export type Wait = _Http.CommitWait;
    export type OperationAction = _Http.ModelOperationAction;
    export type OperationInput = _Http.CommitOperationInput;
    export type CreateOptions = _Http.CommitCreateOptions;
    export type Receipt = _Http.CommitReceipt;
    export type Client = _Http.CommitResource;
  }
}
