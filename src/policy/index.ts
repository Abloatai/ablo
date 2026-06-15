/**
 * @abloatai/ablo/policy — pluggable conflict resolution.
 *
 * The engine detects conflicts; the policy decides. Customer code
 * implements `ConflictPolicy` and registers it at the sync-server.
 *
 * ```ts
 * import { type ConflictPolicy, defaultPolicy } from '@abloatai/ablo/policy';
 *
 * export const myPolicy: ConflictPolicy = (ctx) => {
 *   if (ctx.committer.id.startsWith('linter:')) {
 *     return { action: 'allow', note: 'cosmetic writer' };
 *   }
 *   return defaultPolicy(ctx);
 * };
 * ```
 */

export type {
  Conflict,
  ConflictDecision,
  ConflictKind,
  ConflictOperation,
  ConflictPolicy,
  StaleContextConflict,
  ClaimHeldConflict,
} from './types.js';
export { defaultPolicy, capabilityPreemptPolicy } from './types.js';
