/**
 * Internal compatibility entrypoint for the stateless hosted protocol client.
 *
 * Use this build for serverless functions, scripts, and backends that want
 * model reads/writes and commits over HTTP without the realtime sync runtime.
 */

export {
  createProtocolClient,
  createProtocolClient as Ablo,
  type AbloApi,
  type AbloApiClientOptions,
  type AbloApiClaims,
  type Capability,
  type CapabilityCreateOptions,
  type CapabilityParticipantKind,
  type CapabilityRecord,
  type CapabilityResource,
  type CapabilityRevocation,
  type CapabilityScope,
} from '../client/ApiClient.js';

export type {
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitWait,
  ClaimCreateOptions,
  ClaimHandle,
  ClaimWaitOptions,
  ClaimedOptions,
  IfClaimedPolicy,
  ModelClient,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  ModelRead,
  ModelTarget,
} from '../client/Ablo.js';

import { createProtocolClient } from '../client/ApiClient.js';

export default createProtocolClient;
