import { AbloError } from '@abloatai/ablo';

export type Recovery = 'reread' | 'replan' | 'reconcile' | 'retry' | 'stop';
export type Rejection = { code: string; recovery: Recovery; proposalId?: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: Rejection };

export class AcceptanceRejection extends Error {
  constructor(readonly code: string, readonly recovery: Recovery, readonly proposalId?: string) { super(code); }
}

export async function result<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof AcceptanceRejection) {
      return { ok: false, error: { code: error.code, recovery: error.recovery,
        ...(error.proposalId ? { proposalId: error.proposalId } : {}) } };
    }
    if (error instanceof AbloError) {
      const code = error.code ?? 'outcome_unknown';
      let recovery: Recovery = 'reconcile';
      if (code === 'stale_context') recovery = 'reread';
      else if (code === 'decision_contended') recovery = 'retry';
      else if (['claim_lost', 'fence_token_stale', 'claim_conflict'].includes(code)) recovery = 'replan';
      else if (error.httpStatus === 401 || error.httpStatus === 403 ||
        ['read_evidence_client_mismatch', 'write_options_invalid'].includes(code)) recovery = 'stop';
      return { ok: false, error: { code, recovery } };
    }
    // A failed broker call may already have applied externally. Never infer absence.
    return { ok: false, error: { code: 'outcome_unknown', recovery: 'reconcile' } };
  }
}
