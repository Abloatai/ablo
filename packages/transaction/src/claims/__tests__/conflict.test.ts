import { describe, expect, it } from '@jest/globals';
import { AbloClaimedError, translateHttpError } from '../../errors.js';
import { claimAdmissionError } from '../admission.js';

const heldByClaim = {
  entityType: 'slides',
  entityId: 'slide-4',
  claimId: 'holder-claim',
  description: 'Updating slide 4',
  declaredAt: 1_000,
  expiresAt: 31_000,
};

describe('claim conflict boundaries', () => {
  it('preserves normalized conflict context through error JSON and HTTP reconstruction', () => {
    const admitted = claimAdmissionError({
      claimId: 'waiting-claim',
      reason: 'conflict',
      target: { entityType: 'slides', entityId: 'slide-4' },
      heldBy: 'agent:research-task',
      heldByKind: 'agent',
      heldByClaimId: heldByClaim.claimId,
      heldByExpiresAt: heldByClaim.expiresAt,
      heldByClaim,
    });

    expect(admitted).toBeInstanceOf(AbloClaimedError);
    expect(admitted.toJSON()).toMatchObject({
      code: 'claim_conflict',
      claims: [heldByClaim],
      conflict: {
        counterparty: {
          kind: 'agent',
          description: 'Updating slide 4',
          expiresAt: 31_000,
        },
        target: { model: 'slides', id: 'slide-4' },
        claimId: 'holder-claim',
        participantId: 'agent:research-task',
      },
    });

    const reconstructed = translateHttpError(409, admitted.toJSON());
    expect(reconstructed).toBeInstanceOf(AbloClaimedError);
    expect((reconstructed as AbloClaimedError).conflict).toEqual(
      (admitted as AbloClaimedError).conflict,
    );
    expect((reconstructed as AbloClaimedError).claims).toEqual([heldByClaim]);
  });

  it('normalizes the legacy flat HTTP rejection fields without parsing participant ids', () => {
    const reconstructed = translateHttpError(409, {
      code: 'claim_conflict',
      message: 'held',
      heldBy: 'opaque-holder-id',
      heldByKind: 'system',
      heldByClaimId: heldByClaim.claimId,
      heldByExpiresAt: heldByClaim.expiresAt,
      heldByClaim,
      target: { model: 'slides', id: 'slide-4' },
    });

    expect(reconstructed).toMatchObject({
      conflict: {
        counterparty: {
          kind: 'system',
          description: 'Updating slide 4',
          expiresAt: 31_000,
        },
        participantId: 'opaque-holder-id',
        claimId: 'holder-claim',
        target: { model: 'slides', id: 'slide-4' },
      },
    });
  });
});
