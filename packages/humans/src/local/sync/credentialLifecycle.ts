/**
 * Moved to the confirmation core with the duplex transport (ADR 0016): keeping
 * a long-lived socket's credential fresh is connection plumbing an agent needs
 * as much as a browser does. This path re-exports it so existing importers
 * stay unchanged.
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
} from '@abloatai/transaction/transport/credentialLifecycle';
