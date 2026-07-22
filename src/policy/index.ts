/**
 * Pluggable conflict resolution.
 *
 * The engine detects a conflict; a policy decides what to do about it. You
 * implement {@link ConflictPolicy} and register it with the engine on your
 * server. The example below allows writes from a cosmetic "linter" writer and
 * defers everything else to {@link defaultPolicy}.
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
  ConflictAxis,
  ConflictDecision,
  ConflictKind,
  ConflictOperation,
  ConflictPolicy,
  StaleContextConflict,
  ClaimHeldConflict,
} from '../transaction/policy/types.js';
export { defaultPolicy, capabilityPreemptPolicy, interpretConflictAxis } from '../transaction/policy/types.js';
