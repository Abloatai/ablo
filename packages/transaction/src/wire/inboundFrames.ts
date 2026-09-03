/**
 * Every frame the server can send, in one list.
 *
 * Before this existed, "what frames are there" was answerable only by reading
 * the dispatch table, the transport's event map, and each handler's defensive
 * narrowing together — three places that agreed by convention. This registry is
 * the single answer, and it carries how each frame's payload is validated.
 *
 * A frame is validated one of two ways. Most carry a `payload` schema and are
 * parsed here, before the handler runs, so a handler receives a value whose
 * shape is already proven. The rest are marked `handler` because their
 * validation is genuinely load-bearing elsewhere — a delta is checked once
 * downstream against the schema the materialiser holds, and a commit receipt
 * has to tolerate an older server's spelling before it can be parsed. Each of
 * those says where its check lives, so `handler` is a citation and never an
 * excuse.
 *
 * A frame type absent from this registry is rejected. That is deliberate: the
 * server and this package ship from one repository, so an unrecognised frame
 * means the two have drifted, and failing loudly beats materialising a change
 * nobody validated. Application-level collaboration events are the exception —
 * they are registered by the consumer at construction time, not by the
 * protocol, and are dispatched separately.
 */

import { z } from 'zod';
import { commitReceiptSchema } from '../commit/contract.js';
import { clientSyncDeltaSchema } from '../observation/contract.js';
import {
  claimAcquiredSchema,
  claimAbandonAckPayloadSchema,
  claimGrantedSchema,
  claimHeartbeatAckPayloadSchema,
  claimLostSchema,
  claimQueuedSchema,
  claimQueueSchema,
  claimRejectionSchema,
  presenceUpdateSchema,
  subscriptionAckPayloadSchema,
} from '../coordination/schema.js';

/**
 * The envelope itself: a type and a payload. `catchall` keeps the extra keys,
 * because the oldest delta form puts a delta's own fields at the top level
 * instead of under `payload`, and the dispatcher still has to recognise it.
 */
export const wsInboundEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .catchall(z.unknown());
export type WsInboundEnvelope = z.infer<typeof wsInboundEnvelopeSchema>;

/** How one frame's payload is checked. */
export type InboundFrameContract =
  /** Parsed against `payload` before the handler runs. */
  | { readonly validation: 'schema'; readonly payload: z.ZodType }
  /**
   * Checked inside the handler. `where` says which handler, and `checkedBy`
   * names the schema it parses with — as the schema itself, not its name in
   * prose, so renaming or deleting it fails the build here instead of leaving
   * a citation pointing at nothing. Frames whose check is a hand-narrowing or
   * lives in another package have no symbol to point at and carry only `where`.
   */
  | {
      readonly validation: 'handler';
      readonly where: string;
      readonly checkedBy?: z.ZodType;
    };

/**
 * The protocol's inbound surface. Adding a frame to the server means adding it
 * here, which is the point — the compiler cannot enforce that, but the throw on
 * an unrecognised type does.
 */
export const WS_INBOUND_FRAMES = {
  // ── Keepalive ──────────────────────────────────────────────────────────
  ping: { validation: 'handler', where: 'dispatchWsFrame — ignored, no payload' },
  pong: { validation: 'handler', where: 'dispatchWsFrame — ignored, no payload' },

  // ── Materialisation ────────────────────────────────────────────────────
  delta: {
    validation: 'handler',
    // Not parsed at dispatch because a delta frame carries a batch: each entry
    // is validated on its own so one malformed delta is dropped rather than
    // sinking the batch around it.
    where: 'the materialiser parses each delta as it applies it',
    checkedBy: clientSyncDeltaSchema,
  },
  sync_response: {
    validation: 'handler',
    // No `checkedBy`: the schema lives in the reactive engine
    // (`sync/schemas.ts`), which consumes this package. The core cannot name a
    // symbol from its own consumer, and inverting the dependency to make this
    // citation checkable would put materialisation vocabulary in the core —
    // the exact thing the seam exists to keep out.
    where: 'the reactive engine validates it while advancing its resume cursor',
  },
  bootstrap_response: {
    validation: 'handler',
    // No `checkedBy`, for the same reason as `sync_response` above.
    where: 'the reactive engine validates the bootstrap payload as it applies it',
  },

  // ── Commit ─────────────────────────────────────────────────────────────
  mutation_result: {
    validation: 'handler',
    where: 'handleMutationResult — it validates missingIds alongside the payload before this can parse',
    checkedBy: commitReceiptSchema,
  },

  // ── Requests we made ───────────────────────────────────────────────────
  subscription_ack: {
    validation: 'handler',
    // Not parsed at dispatch because the handler must first claim the oldest
    // pending request: a payload that failed here would otherwise leave that
    // request hanging until its timeout instead of being rejected with a cause.
    where: 'handleSubscriptionAck',
    checkedBy: subscriptionAckPayloadSchema,
  },

  // ── Coordination ───────────────────────────────────────────────────────
  presence_update: { validation: 'schema', payload: presenceUpdateSchema },
  claim_rejected: { validation: 'schema', payload: claimRejectionSchema },
  claim_acquired: { validation: 'schema', payload: claimAcquiredSchema },
  claim_abandon_ack: {
    validation: 'schema',
    payload: claimAbandonAckPayloadSchema,
  },
  claim_queued: { validation: 'schema', payload: claimQueuedSchema },
  claim_granted: { validation: 'schema', payload: claimGrantedSchema },
  claim_lost: { validation: 'schema', payload: claimLostSchema },
  claim_queue: { validation: 'schema', payload: claimQueueSchema },
  claim_heartbeat_ack: {
    validation: 'schema',
    payload: claimHeartbeatAckPayloadSchema,
  },
} as const satisfies Record<string, InboundFrameContract>;

/** Every frame type the protocol declares. */
export type InboundFrameType = keyof typeof WS_INBOUND_FRAMES;

/**
 * The validated payload type of each schema-checked frame, read straight off
 * the registry. A handler that takes one of these gets the shape the
 * dispatcher proved, with no second declaration to keep in step and no cast at
 * the point of use.
 */
export type InboundFramePayload = {
  [K in InboundFrameType]: (typeof WS_INBOUND_FRAMES)[K] extends {
    readonly payload: infer P extends z.ZodType;
  }
    ? z.infer<P>
    : never;
};

/** The frame types the dispatcher parses before calling a handler. */
export type SchemaValidatedFrameType = {
  [K in InboundFrameType]: (typeof WS_INBOUND_FRAMES)[K] extends {
    readonly validation: 'schema';
  }
    ? K
    : never;
}[InboundFrameType];

/** Whether the protocol declares this frame type at all. */
export function isKnownInboundFrame(type: string): type is InboundFrameType {
  return Object.prototype.hasOwnProperty.call(WS_INBOUND_FRAMES, type);
}

/**
 * Whether this frame's payload is parsed before dispatch. Declared as a
 * predicate, and declared here, because the fact it asserts is a fact about the
 * registry directly above it: the two cannot be edited apart.
 */
export function isSchemaValidatedFrame(
  type: InboundFrameType,
): type is SchemaValidatedFrameType {
  return WS_INBOUND_FRAMES[type].validation === 'schema';
}
