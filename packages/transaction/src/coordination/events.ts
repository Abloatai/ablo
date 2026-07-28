/**
 * In-process observation events emitted by the transaction layer's
 * coordination protocol. The wire claim and stale-write contracts live in
 * `coordination/schema.ts`; these two projections are the stable event shapes
 * an observer receives after those frames have been interpreted.
 */

import type { ParticipantKind } from '../types/participant.js';

export type { ClaimEventReason } from './schema.js';
import type { ClaimEventReason } from './schema.js';

/** The participant that blocked a claim — present on `rejected`. */
export interface ClaimCounterparty {
  /** Who holds it. */
  actor?: string;
  /**
   * Whether the holder is a person, an agent, or the system — the distinction
   * a caller acts on, since yielding to a person and queueing behind an agent
   * are different decisions. It lives here rather than on the event because
   * only a counterparty has a kind worth reporting: on an acquisition the
   * participant is you, and you already know what you are.
   */
  participantKind?: ParticipantKind;
  /** The lease they hold, so a caller can poll or wait on it by id. */
  claimId?: string;
  /** When their lease lapses without a heartbeat. */
  expiresAt?: number;
  /** What they said they were doing — prose, for a person to read. */
  description?: string;
}

/** A single state transition in the lifecycle of a claim. */
export interface ClaimEvent {
  phase:
    | 'acquired'
    | 'queued'
    | 'granted'
    | 'lost'
    | 'rejected'
    | 'expired';
  claimId?: string;
  model?: string;
  id?: string;
  field?: string;
  actor?: string;
  position?: number;
  /**
   * What this claim's holder said they were doing — prose, written for a
   * person. Separate from {@link ClaimEvent.reason}, which is machine-readable
   * and only ever says why a claim ended. One field used to carry both, so an
   * `acquired` event's "reason" was really a description and a `rejected`
   * event's was really a cause.
   */
  description?: string;
  /** Why the claim ended or was refused. Absent while it is simply alive. */
  reason?: ClaimEventReason;
  /**
   * A policy's own words when a policy decided the outcome — free text by
   * nature, and kept beside the closed {@link ClaimEvent.reason} rather than
   * collapsed into it.
   */
  policyReason?: string;
  /**
   * Who blocked this claim. Present on `rejected`, where the wire already
   * carried the holder and this projection used to discard it.
   */
  heldBy?: ClaimCounterparty;
}

/** A committed notify-instead-of-abort stale-write collision. */
export interface ConflictEvent {
  clientTxId: string;
  rows: readonly {
    model: string;
    id: string;
    fields: readonly string[];
    writtenBy?: ParticipantKind;
    /**
     * The group premise this row breached, when the conflict was found at group
     * grain. `model`/`id` stay the row that actually moved, so a log line can
     * say which row moved AND which premise it broke — the two used to be the
     * same field, and a group conflict logged its group key as the row.
     */
    group?: string;
    /** How the row reached `group` — `self`, `parent`, or `transitive`. */
    via?: string;
  }[];
}

/** The narrow behavior a transaction-layer coordination observer implements. */
export interface CoordinationObserver {
  captureClaim(event: ClaimEvent): void;
  captureConflict(event: ConflictEvent): void;
}
