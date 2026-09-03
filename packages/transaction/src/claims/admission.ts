/** One interpretation of a rejected claim admission, shared by live callers. */
import {
  AbloClaimedError,
  AbloValidationError,
  CapabilityError,
  formatClaimedErrorMessage,
  claimTargetLabel,
} from '../errors.js';
import type { AbloError } from '../errors.js';
import type { ClaimRejection } from '../coordination/schema.js';
import { modelTarget } from './locator.js';
import { conflictFromClaimRejection } from './conflict.js';

export function claimAdmissionError(rejection: ClaimRejection): AbloError {
  const target = rejection.target
    ? claimTargetLabel({
        ...modelTarget(rejection.target),
        field: rejection.target.field,
      })
    : rejection.claimId;
  if (rejection.reason === 'capability_denied') {
    return new CapabilityError(
      'capability_scope_denied',
      rejection.message ?? `This credential may not claim ${target}.`,
    );
  }
  if (rejection.reason === 'invalid_target') {
    return new AbloValidationError(
      rejection.message ?? `Invalid claim target ${target}.`,
      { code: 'invalid_body' },
    );
  }
  return new AbloClaimedError(
    formatClaimedErrorMessage({
      targetLabel: target,
      heldBy: rejection.heldBy,
      claim: rejection.heldByClaim,
      detail: rejection.message,
      fallback: `Claim rejected for ${target}.`,
    }),
    {
      code: rejection.reason === 'conflict'
        ? 'claim_conflict'
        : 'claim_lease_unavailable',
      claims: rejection.heldByClaim ? [rejection.heldByClaim] : undefined,
      conflict: conflictFromClaimRejection(rejection),
    },
  );
}
