/**
 * @ablo/sync-engine/policy — pluggable conflict resolution.
 *
 * The engine detects conflicts; the policy decides. Customer code
 * implements `ConflictPolicy` and registers it at the sync-server.
 *
 * ```ts
 * import { type ConflictPolicy, defaultPolicy } from '@ablo/sync-engine/policy';
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
  IntentHeldConflict,
} from './types.js';
export { defaultPolicy } from './types.js';
