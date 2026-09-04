/** Transport-neutral presence contracts and projection rules. */
export {
  presenceActivitySchema,
  presenceActivitySourceSchema,
  presenceOperationSchema,
  presenceParticipantSchema,
  presenceSessionSchema,
  presenceTargetSchema,
} from './contract.js';
export type {
  PresenceActivity,
  PresenceActivitySource,
  PresenceOperation,
  PresenceParticipant,
  PresenceSession,
  PresenceTarget,
} from './contract.js';

export {
  MAX_READ_PRESENCE_TTL_MS,
  MIN_READ_PRESENCE_TTL_MS,
  presenceCommandSchema,
  readPresenceRefreshCommandSchema,
  readPresenceRemoveCommandSchema,
  readPresenceUpsertCommandSchema,
} from './commands.js';
export type {
  PresenceCommand,
  ReadPresenceRefreshCommand,
  ReadPresenceRemoveCommand,
  ReadPresenceUpsertCommand,
} from './commands.js';

export {
  presenceActivityTombstoneSchema,
  presencePatchSchema,
  presenceSnapshotSchema,
} from './projections.js';
export type {
  PresenceActivityTombstone,
  PresencePatch,
  PresenceSnapshot,
} from './projections.js';

export {
  applyPresencePatch,
  applyPresenceSnapshot,
  presenceForModel,
  presenceForRecord,
} from './projection.js';

export {
  parsePresenceCommand,
  parsePresencePatch,
  parsePresenceSnapshot,
  redactPresenceActivity,
} from './protocol.js';

export {
  PRESENCE_SESSION_HEADER,
  WS_PRESENCE_SESSION_SUBPROTOCOL_PREFIX,
  createPresenceSessionSource,
  presenceSessionEstablishedSchema,
  presenceSessionIdSchema,
} from './session.js';
export type {
  PresenceSessionEstablished,
  PresenceSessionSource,
} from './session.js';

export {
  createPresenceProjection,
} from './store.js';
export type {
  PresenceProjection,
  PresenceProjectionEvents,
  PresenceView,
} from './store.js';
