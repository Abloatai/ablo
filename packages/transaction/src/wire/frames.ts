/**
 * The write-path message shapes for the sync protocol. These cover the frames
 * a client sends to commit work — {@link CommitMessage}, a batch of raw
 * operations — and the server's {@link MutationResultMessage}
 * acknowledgement. The same frames flow over a WebSocket connection and over
 * the HTTP commit endpoint.
 *
 * Both the client and the server import these definitions from here, so the two
 * sides cannot drift. Zod schemas are the definition site and every TypeScript
 * shape is inferred from them. Changing any schema in this file changes the
 * wire contract and requires the client and server to update together.
 */
import { z } from 'zod';
// The runtime schema primitives are imported straight from the coordination
// schema module to keep this file's runtime dependencies limited to Zod.
import {
  commitOperationSchema as coordinationCommitOperationSchema,
  readDependencyListSchema,
} from '../coordination/schema.js';
import type { MutationResultMessageWire } from '../commit/contract.js';

// ── Client → Server ────────────────────────────────────────────────────────

/**
 * A single operation within a commit batch and its authoritative runtime
 * validator. Each operation is the smallest unit the server applies atomically
 * — one create, update, delete, archive, or unarchive against one model row.
 * Both commit transports — the WebSocket `commit` frame and the HTTP
 * `/v1/commits` endpoint — run this check
 * on every operation before it is applied, so a malformed operation is rejected
 * at the edge. The TypeScript type is inferred from the shared coordination
 * schema so runtime and compile-time contracts have one definition site.
 */
export const wireCommitOperationSchema = coordinationCommitOperationSchema;
export type WireCommitOperation = z.infer<typeof wireCommitOperationSchema>;

/**
 * @deprecated Renamed to {@link WireCommitOperation} — coordination/schema owns
 * the base `CommitOperation`; this is the wire-extended form, and the two are
 * different types that shared one name. Removed in 0.36.0.
 */
export type CommitOperation = WireCommitOperation;
/** @deprecated Renamed to {@link wireCommitOperationSchema}. Removed in 0.36.0. */
export const commitOperationSchema = wireCommitOperationSchema;

/**
 * The authoritative payload schema for a client-to-server commit frame. It
 * checks every field the server acts on — `operations`, `clientTxId`, and
 * `reads` — validating each operation with {@link wireCommitOperationSchema} and
 * each premise entry with the shared {@link readDependencySchema}.
 */
export const commitPayloadSchema = z.object({
  operations: z.array(wireCommitOperationSchema),
  clientTxId: z.string(),
  reads: readDependencyListSchema.nullish(),
});

/** A client-to-server frame that asks the server to commit a batch atomically. */
export const commitMessageSchema = z.object({
  type: z.literal('commit'),
  payload: commitPayloadSchema,
});
export type CommitMessage = z.infer<typeof commitMessageSchema>;

// ── Server → Client ──────────────────────────────────────────────────────

/**
 * The server's acknowledgement of a {@link CommitMessage}. Runtime shape and
 * TypeScript type are both owned by `commit/contract.ts`; HTTP, WebSocket, and
 * cached replay no longer maintain parallel receipt declarations.
 */
export type MutationResultMessage = MutationResultMessageWire;
