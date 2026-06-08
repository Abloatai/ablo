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
  type AbloApiIntents,
  type Agent,
  type AgentIntentInput,
  type AgentIntentOptions,
  type AgentOptions,
  type AgentModelClient,
  type AgentModelReadOptions,
  type AgentModelMutationOptions,
  type AgentRunContext,
  type AgentRunDone,
  type AgentRunFailed,
  type AgentRunCancelled,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunStatus,
  type Capability,
  type CapabilityCreateOptions,
  type CapabilityParticipantKind,
  type CapabilityRecord,
  type CapabilityResource,
  type CapabilityRevocation,
  type CapabilityScope,
  type Task,
  type TaskCloseOptions,
  type TaskCloseResult,
  type TaskCreateOptions,
  type TaskResource,
} from '../client/ApiClient.js';

export type {
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitWait,
  IntentCreateOptions,
  IntentHandle,
  IntentWaitOptions,
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
