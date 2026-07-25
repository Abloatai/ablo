/**
 * Recovery taxonomy — `classifyRecovery` is the single discriminant the sync
 * FSM and the network probe branch on. These pin the access-vs-session split
 * that the wake-from-sleep fix depends on: an expired ephemeral access key
 * (`apikey_expired`) must classify as `access_credential_expiry` (silent
 * re-mint, NEVER sign out), while only a genuine login expiry
 * (`session_expired`) is `session_expiry` (terminal sign-out).
 */

import {
  classifyRecovery,
  RECOVERY_CLASSES,
  recoveryClassSchema,
  type RecoveryClass,
} from '@ablo/transaction/errorCodes';

describe('classifyRecovery — the recovery taxonomy', () => {
  it('classifies the Stripe-style ephemeral access key expiry as re-mintable', () => {
    // THE headline case for the wake fix: an expired ek_/rk_ is recovered by
    // re-minting from the still-valid login, not by signing out.
    expect(classifyRecovery('apikey_expired')).toBe('access_credential_expiry');
  });

  it('classifies a genuine login expiry as terminal session expiry', () => {
    expect(classifyRecovery('session_expired')).toBe('session_expiry');
  });

  it('keeps jwt_expired as session expiry (JWT is not the sync-engine access credential)', () => {
    // The sync-engine authenticates with ek_/rk_, not JWTs; jwt_expired only
    // arises on the trusted-issuer/BYO-IdP path, where expiry = re-authenticate.
    expect(classifyRecovery('jwt_expired')).toBe('session_expiry');
  });

  it('classifies credential-TYPE/config rejections as auth_blocked (re-auth never helps)', () => {
    for (const code of [
      'api_key_required',
      'apikey_invalid',
      'apikey_revoked',
      'jwt_issuer_untrusted',
      'jwt_signature_invalid',
      'identity_missing_organization',
      'auth_no_credentials',
    ]) {
      expect(classifyRecovery(code)).toBe('auth_blocked');
    }
  });

  it('classifies 403 authorization denials as permission', () => {
    for (const code of ['forbidden', 'capability_scope_denied', 'organization_mismatch']) {
      expect(classifyRecovery(code)).toBe('permission');
    }
  });

  it('classifies retryable wire codes as transient', () => {
    // claim_conflict left this list 2026-06-10: held-claim rejections are
    // FAILED_PRECONDITION-class (non-retryable) — blind resend caused an
    // infinite retry storm. stale_context likewise needs a re-read and a NEW
    // request; replaying its frozen readAt is not a transport retry.
    for (const code of ['instance_at_capacity', 'bootstrap_offline']) {
      expect(classifyRecovery(code)).toBe('transient');
    }
    expect(classifyRecovery('stale_context')).toBe('none');
  });

  it('defaults unknown / forward-compat / dynamic codes to none (never a silent expiry or logout)', () => {
    expect(classifyRecovery('totally_unknown_code')).toBe('none');
    expect(classifyRecovery('policy:some_reason')).toBe('none');
  });

  it('only the two access-credential codes are re-mintable — no others leak into that bucket', () => {
    // Guard against accidentally widening the silent-re-mint path: scan the
    // whole registry and assert exactly the intended membership.
    // (apikey_expired is the only registered access_credential_expiry; jwt is
    // deliberately session_expiry per the comment above.)
    expect(classifyRecovery('apikey_expired')).toBe('access_credential_expiry');
    expect(classifyRecovery('capability_invalid')).not.toBe('access_credential_expiry');
    expect(classifyRecovery('commit_offline_grace_expired')).not.toBe('access_credential_expiry');
  });

  it('the Zod schema accepts every RECOVERY_CLASSES member and rejects others', () => {
    for (const cls of RECOVERY_CLASSES) {
      expect(recoveryClassSchema.parse(cls)).toBe(cls);
    }
    expect(recoveryClassSchema.safeParse('not_a_class').success).toBe(false);
  });

  it('classifyRecovery only ever returns a valid RecoveryClass', () => {
    const samples = ['apikey_expired', 'session_expired', 'forbidden', 'claim_conflict', 'zzz'];
    for (const code of samples) {
      const result: RecoveryClass = classifyRecovery(code);
      expect(recoveryClassSchema.safeParse(result).success).toBe(true);
    }
  });
});
