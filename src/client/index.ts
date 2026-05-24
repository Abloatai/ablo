/**
 * @ablo/sync-engine/client — Consumer API
 *
 * The one-liner entry point for external consumers.
 *
 * `Ablo({ apiKey })` is the stateless HTTP API client. Add `schema`
 * when you want the realtime sync engine with typed model proxies.
 *
 * ```ts
 * import { Ablo } from '@ablo/sync-engine/client';
 * import { schema } from './schema';
 *
 * const ablo = Ablo({
 *   schema,
 *   apiKey: process.env.ABLO_API_KEY,
 * });
 *
 * const tasks = ablo.tasks.list({ where: { status: 'todo' } });
 * await ablo.tasks.create({ title: 'New task' });
 * ```
 *
 * For headless agents (workers, bots), pass `kind: 'agent'` plus a
 * Biscuit `capabilityToken`:
 *
 * ```ts
 * const bot = Ablo({
 *   schema,
 *   apiKey: process.env.ABLO_API_KEY,
 *   kind: 'agent',
 * });
 * ```
 */

export {
  Ablo,
  computeFKDepthPriority,
  type AbloOptions,
  type InternalAbloOptions,
  type BusyOptions,
  type BusyPolicy,
  type IntentWaitOptions,
  type ModelCountOptions,
  type ModelListOptions,
  type ModelListScope,
  type ModelLoadOptions,
  type ModelOperations,
  type ResourceReadOptions,
} from './Ablo.js';
export type { AbloPersistence } from './persistence.js';
export type {
  AbloApi,
  AbloApiClientOptions,
  AbloApiIntents,
  Agent,
  AgentIntentInput,
  AgentIntentOptions,
  AgentOptions,
  AgentResourceClient,
  AgentResourceReadOptions,
  AgentResourceMutationOptions,
  AgentRunContext,
  AgentRunDone,
  AgentRunFailed,
  AgentRunCancelled,
  AgentRunOptions,
  AgentRunResult,
  AgentRunStatus,
  Capability,
  CapabilityCreateOptions,
  CapabilityParticipantKind,
  CapabilityRecord,
  CapabilityResource,
  CapabilityRevocation,
  CapabilityScope,
  Task,
  TaskCloseOptions,
  TaskCloseResult,
  TaskCreateOptions,
  TaskResource,
} from './ApiClient.js';

export type {
  EngineParticipant,
  JoinedParticipant,
  ParticipantJoinOptions,
  ParticipantManager,
  ParticipantScope,
  ParticipantStatus,
  ScopedIntents,
  ScopedPresence,
} from '../sync/participants.js';
