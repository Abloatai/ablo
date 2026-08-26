/**
 * Core type definitions for the model-driven sync layer.
 *
 * These types describe how a model's properties are declared, when their data
 * is loaded, and how changes are represented on the wire as they synchronize.
 */

import type { FieldMeta } from '../schema/field.js';
// Bound locally as well as re-exported below: a bare `export … from` forwards
// the name to consumers without binding it in this module, so the annotations
// further down would not resolve.
import { LoadStrategy } from '../schema/loadStrategy.js';

/**
 * A lifecycle filter for queries: whether to return live entities, archived
 * ones, or both.
 */
export enum ModelScope {
  live = 'live',
  archived = 'archived',
  all = 'all',
}

/**
 * The kinds of property a model can declare. Each kind determines how the
 * property behaves in the sync system — whether it is persisted, how it relates
 * to other models, and how it is loaded.
 */
export enum PropertyType {
  /** A standard observable field owned by the model, both persisted and synced. */
  property = 'property',

  /** A runtime-only field that is neither persisted nor synced. */
  ephemeralProperty = 'ephemeralProperty',

  /** A foreign-key reference that stores only the related model's id. */
  reference = 'reference',

  /** A single related model resolved on demand from its id, exposed as a getter and setter. */
  referenceModel = 'referenceModel',

  /** A collection of related models — the many side of a one-to-many relationship. */
  referenceCollection = 'referenceCollection',

  /** A computed field that follows a relationship in the inverse direction. */
  backReference = 'backReference',

  /** An array of foreign-key ids — a many-to-many relationship. */
  referenceArray = 'referenceArray',
}

// When and how a model's data is loaded from the server. Defined in
// `../schema/loadStrategy.ts`, which the authoring surface reads from too.
export { LoadStrategy };

/**
 * The resolved configuration for a single model property.
 */
export interface PropertyMetadata {
  type: PropertyType;
  indexed?: boolean;
  optional?: boolean;
  nullable?: boolean;
  defaultValue?: unknown;
  loadStrategy?: LoadStrategy;
  /**
   * How deeply the reactivity layer wraps this property's value when the model
   * is registered. The engine uses MobX, so the choice maps directly to MobX's
   * observability modes.
   *
   * - `'deep'` (the default): full recursive observability, where every nested
   *   object or array becomes its own reactive node. Correct for scalar fields
   *   and small structured values whose inner properties are read directly.
   * - `'shallow'`: track the reference and array, map, and set operations, but
   *   do not recurse into element internals. Right for collections whose
   *   elements are replaced wholesale.
   * - `'ref'`: track only reassignment of the value. Right for opaque JSON
   *   blobs — chart specs, rich-text documents, style maps — that are treated
   *   as immutable values and always read whole before being handed to a
   *   renderer. Deep-wrapping these produces many needless reactions for no
   *   benefit.
   *
   * Schema-driven registration sets this to `'ref'` automatically for fields
   * whose wire type is `'json'`, the right default for the blob pattern.
   */
  observability?: 'deep' | 'shallow' | 'ref';
}

/** The constructor type of a model class, used by reference metadata to point at the related model. */
type ModelConstructor = abstract new (...args: never[]) => unknown;

/**
 * The configuration for a reference property — which model it points to and how
 * the relationship behaves.
 */
export interface ReferenceMetadata {
  referencedModel: () => ModelConstructor;
  backReference?: string;
  indexed?: boolean;
  nullable?: boolean;
}

/**
 * The resolved configuration for a model class.
 */
export interface ModelMetadata {
  loadStrategy: LoadStrategy;
  syncGroup?: string;
  tableName?: string;
  schemaVersion?: number;
  /**
   * The schema-declared fields for this model, keyed by field name. When a
   * change is committed, the transaction queue uses this to project the payload
   * down to the declared fields and to serialize JSON-typed values.
   *
   * Each entry carries the field's {@link FieldMeta.type} tag, which tells the
   * wire serializer how to encode the value. When this is absent — a model
   * registered without a schema — the payload is passed through unchanged.
   */
  fields?: Readonly<Record<string, Pick<FieldMeta, 'type'>>>;
  /**
   * Fields to fill in from the signed-in identity when they are missing from a
   * stored row during self-healing. Each entry maps a field on this model to
   * one of the identity values the client holds — `organizationId` or `userId`.
   * Declaring it in the schema keeps the engine product-neutral: it does not
   * assume which models carry an organization or owner field.
   */
  autoFill?: readonly { field: string; from: 'organizationId' | 'userId' }[];
  /**
   * Fields a stored row must have to be usable. During self-healing, a row
   * missing any of these is treated as orphaned and skipped rather than loaded.
   */
  requiredFields?: readonly string[];
}

/**
 * The options accepted when declaring a model — its load strategy, optional
 * sync group, and optional table name.
 */
export interface ModelOptions {
  loadStrategy: LoadStrategy;
  syncGroup?: string;
  tableName?: string;
}

/**
 * The options accepted when declaring a model property.
 */
export interface PropertyOptions {
  indexed?: boolean;
  optional?: boolean;
  defaultValue?: unknown;
  ephemeral?: boolean;
}

/**
 * The options accepted when declaring a reference property.
 */
export interface ReferenceOptions {
  indexed?: boolean;
  nullable?: boolean;
}

/**
 * A request to load model rows by an indexed key. When the load completes,
 * `resolve` is called with the matching rows.
 */
export interface LoadRequest {
  modelName: string;
  indexedKey: string;
  keyValue: string;
  resolve?: (value: unknown[]) => void;
}

/**
 * How a session establishes its baseline state at startup.
 *
 * 'full' — Fetch a complete snapshot from the server, clear the local store,
 *   load the snapshot, and adopt its `lastSyncId`.
 *
 * 'partial' — Fetch only the deltas since the stored `lastSyncId` and apply
 *   them on top of the existing local data.
 *
 * 'local' — Skip the server entirely: hydrate the instance cache from the local
 *   store, connect the WebSocket with the stored `lastSyncId`, and receive
 *   deltas from there onward. Used when offline with valid local data.
 */
export type BootstrapType = 'full' | 'partial' | 'local';

/**
 * The metadata returned with a bootstrap: the last sync id seen and the sync
 * groups the client is subscribed to.
 */
export interface BootstrapMetadata {
  lastSyncId: number;
  subscribedSyncGroups: string[];
}

/**
 * The locally tracked sync state that lets a client resume where it left off.
 */
export interface DatabaseMetadata {
  lastSyncId: number; // Current sync version
  firstSyncId: number; // Sync version captured at bootstrap
  backendDatabaseVersion: number;
  subscribedSyncGroups: string[]; // Sync groups this client is subscribed to
  updatedAt: Date;
}

/**
 * The operation a batch mutation performs on a model row.
 */
export enum MutationOperationType {
  ARCHIVE = 'ARCHIVE',
  CREATE = 'CREATE',
  DELETE = 'DELETE',
  UNARCHIVE = 'UNARCHIVE',
  UPDATE = 'UPDATE',
}

/**
 * Describes a partial index used to load subsets of a large model.
 */
export interface PartialIndexInfo {
  modelName: string;
  indexKey: string;
  depth: number; // 1-3 levels deep
  path: string[];
}

// Re-export the stream and coordination types that make up the engine's public
// surface, reached through `Ablo({...}).presence` and `.claims`.
//
// The list is written out by name rather than `export *` so that adding a
// symbol here is always a deliberate decision, and new types don't become
// public API by accident.
export type {
  // Coordination wire shapes, defined in `../coordination/schema` and
  // re-exported through streams.ts.
  WireClaim,
  ClaimRejection,
  PresenceKind,
  ParticipantKind,
  // Participant identity, defined in `./participant.ts`.
  ParticipantRef,
  // Streams' own types.
  JsonValue,
  ConfirmationState,
  Delta,
  AgentDelta,
  ClaimTarget,
  PresenceTarget,
  PresenceStream,
  Activity,
  Peer,
  PresenceUpdatePayload,
  ClaimLeaseOptions,
  Duration,
  ClaimOptions,
  ClaimStream,
  ClaimLost,
  ClaimStatus,
  ClaimWaitOptions,
  Claim,
  HeldClaim,
} from './streams.js';
