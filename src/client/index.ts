/**
 * @abloatai/ablo/client — Consumer API
 *
 * The one-liner entry point for external consumers.
 *
 * `Ablo({ apiKey })` is the stateless HTTP API client. Add `schema`
 * when you want the realtime sync engine with typed model proxies.
 *
 * ```ts
 * import { Ablo } from '@abloatai/ablo/client';
 * import { schema } from './schema';
 *
 * const ablo = Ablo({
 *   schema,
 *   apiKey: process.env.ABLO_API_KEY,
 * });
 *
 * const reports = ablo.weatherReports.list({ where: { status: 'pending' } });
 * await ablo.weatherReports.create({ location: 'Stockholm', status: 'pending' });
 * ```
 *
 * For headless agents (workers, bots), pass the same schema and an API key
 * scoped for that server runtime:
 *
 * ```ts
 * const bot = Ablo({
 *   schema,
 *   apiKey: process.env.ABLO_API_KEY,
 * });
 * ```
 */

export {
  Ablo,
  computeFKDepthPriority,
  type AbloOptions,
  type InternalAbloOptions,
  type ClaimedOptions,
  type IfClaimedPolicy,
  type ClaimWaitOptions,
  type LocalCountOptions,
  type LocalReadOptions,
  type ModelListScope,
  type ServerReadOptions,
  type ModelOperations,
  type ModelReadOptions,
} from './Ablo.js';
export {
  ABLO_DEFAULT_BASE_URL,
  ABLO_HOSTED_API_DOMAIN,
  ABLO_HOSTED_HTTP_BASE_URL,
  normalizeAbloHostedBaseUrl,
} from './auth.js';
export type { AbloPersistence } from './persistence.js';
export type {
  AbloApi,
  AbloApiClientOptions,
  AbloApiClaims,
  Capability,
  CapabilityCreateOptions,
  CapabilityParticipantKind,
  CapabilityRecord,
  CapabilityResource,
  CapabilityRevocation,
  CapabilityScope,
} from './ApiClient.js';

export type {
  EngineParticipant,
  JoinedParticipant,
  ParticipantJoinOptions,
  ParticipantManager,
  ParticipantScope,
  ParticipantStatus,
  ScopedClaims,
  ScopedPresence,
} from '../sync/participants.js';
