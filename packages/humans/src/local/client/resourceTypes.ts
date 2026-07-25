/**
 * The interactive resource-type surface.
 *
 * The transport-facing half of these types moved down into the settlement core
 * (ADR 0016). This module keeps the
 * consumer-facing import path intact and rejoins it with the model-proxy types
 * that stay here — `ModelOperations` chief among them, because it returns the
 * live participant handle.
 */

export * from '@abloatai/transaction/resources/httpResources';

// The request contract for `ablo.<model>` — also core, re-joined here so this
// module stays the single import path for the whole resource surface.
export type {
  LocalCountOptions,
  LocalReadOptions,
  ModelListScope,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
  HeldLease,
} from '@abloatai/transaction/resources/modelOperations';

// `ModelOperations` binds the request contract to reactive model instances, so
// it lives with the factory that builds it rather than with the core.
export type { ModelOperations } from './createModelProxy.js';
