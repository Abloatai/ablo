/**
 * The public, transport-independent facts about a claim conflict.
 *
 * A counterparty's display-safe context is deliberately separate from its raw
 * participant id. Applications can show the kind, description, and expiry
 * without treating an opaque authorization identity as a label.
 */
import { z } from 'zod';
import {
  modelTargetSchema,
  participantKindSchema,
  type ClaimRejection,
  type ModelTarget,
  type ParticipantKind,
  type WireClaimSummary,
} from '../coordination/schema.js';
import { modelTarget } from './locator.js';

export const claimConflictCounterpartySchema = z.object({
  kind: participantKindSchema.optional(),
  description: z.string().optional(),
  expiresAt: z.number().optional(),
}).readonly();

export type ClaimConflictCounterparty = z.infer<
  typeof claimConflictCounterpartySchema
>;

export const claimConflictContextSchema = z.object({
  counterparty: claimConflictCounterpartySchema.optional(),
  target: modelTargetSchema.unwrap().partial().readonly().optional(),
  claimId: z.string().optional(),
  /**
   * Opaque authorization identity of the holder. Keep it separate from the
   * display-safe counterparty block: exposing it to an end user is an
   * application privacy decision, not a formatting default.
   */
  participantId: z.string().optional(),
}).readonly();

export type ClaimConflictContext = z.infer<typeof claimConflictContextSchema>;

export interface ClaimConflictSource {
  readonly heldBy?: string;
  readonly heldByKind?: ParticipantKind;
  readonly heldByClaimId?: string;
  readonly heldByExpiresAt?: number;
  readonly heldByClaim?: WireClaimSummary;
  readonly target?: Partial<ModelTarget>;
  readonly description?: string;
  readonly expiresAt?: number;
}

/** Normalize every wire spelling into the one public conflict shape. */
export function normalizeClaimConflict(
  source: ClaimConflictSource,
): ClaimConflictContext | undefined {
  const summary = source.heldByClaim;
  const description = source.description ?? summary?.description;
  const expiresAt =
    source.expiresAt ?? source.heldByExpiresAt ?? summary?.expiresAt;
  const counterparty: ClaimConflictCounterparty = {
    ...(source.heldByKind !== undefined ? { kind: source.heldByKind } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  const target = source.target ?? (summary ? modelTarget(summary) : undefined);
  const conflict: ClaimConflictContext = {
    ...(Object.keys(counterparty).length > 0 ? { counterparty } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(source.heldByClaimId !== undefined
      ? { claimId: source.heldByClaimId }
      : summary?.claimId !== undefined
        ? { claimId: summary.claimId }
        : {}),
    ...(source.heldBy !== undefined ? { participantId: source.heldBy } : {}),
  };
  return Object.keys(conflict).length > 0 ? conflict : undefined;
}

/** Normalize the canonical WebSocket claim-rejection frame. */
export function conflictFromClaimRejection(
  rejection: ClaimRejection,
): ClaimConflictContext | undefined {
  return normalizeClaimConflict({
    ...(rejection.heldBy !== undefined ? { heldBy: rejection.heldBy } : {}),
    ...(rejection.heldByKind !== undefined
      ? { heldByKind: rejection.heldByKind }
      : {}),
    ...(rejection.heldByClaimId !== undefined
      ? { heldByClaimId: rejection.heldByClaimId }
      : {}),
    ...(rejection.heldByExpiresAt !== undefined
      ? { heldByExpiresAt: rejection.heldByExpiresAt }
      : {}),
    ...(rejection.heldByClaim !== undefined
      ? { heldByClaim: rejection.heldByClaim }
      : {}),
    ...(rejection.target !== undefined
      ? { target: modelTarget(rejection.target) }
      : {}),
  });
}
