/**
 * The shared session subsystem owns renewal for both browser and agent
 * sessions. This local boundary keeps the reactive store pointed downward at
 * that one lifecycle implementation.
 */

export {
  DEFAULT_PREROLL_INTERVAL_MS,
  MIN_PREROLL_DELAY_MS,
  computePrerollDelayMs,
  CredentialLifecycle,
  type CredentialRefreshOutcome,
  type CredentialRecoveryOutcome,
  type CredentialRefreshResult,
  type CredentialRefresher,
  type CredentialLifecycleContext,
} from '@abloatai/transaction/sessions';
