export * from '@abloatai/transaction/coordination';

/**
 * Coordination vocabulary that the streams module declares.
 *
 * A caller that holds a claim needs these names, and coordination is where
 * they belong — so they are
 * surfaced here rather than leaving callers to reach into the type module.
 */
export type { Claim, ClaimTarget } from '@abloatai/transaction/types/streams';
