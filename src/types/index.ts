/**
 * Linear Sync Engine - Core Types
 *
 * Foundational type definitions for the model-driven sync architecture.
 * These types define how properties are tracked, loaded, and synchronized.
 */

import type { FieldMeta } from '../schema/field.js';

/**
 * Model Scope - lifecycle filter for queries.
 * Controls whether live, archived, or all entities are returned.
 */
export enum ModelScope {
  live = 'live',
  archived = 'archived',
  all = 'all',
}

/**
 * Property Types - EXACTLY 7 types as per Linear Sync Engine
 * These define how model properties behave in the sync system
 */
export enum PropertyType {
  /** Standard observable property - owned by model, persisted and synced */
  property = 'property',

  /** Property that doesn't persist or sync - runtime only */
  ephemeralProperty = 'ephemeralProperty',

  /** Foreign key reference - stores ID only */
  reference = 'reference',

  /** Lazy-loaded model reference - getter/setter for model based on ID */
  referenceModel = 'referenceModel',

  /** Collection of related models - one-to-many relationship */
  referenceCollection = 'referenceCollection',

  /** Back-reference computed property - inverse relationship */
  backReference = 'backReference',

  /** Array of foreign key references - many-to-many relationship */
  referenceArray = 'referenceArray',
}

/**
 * Load Strategies - EXACTLY 5 strategies as per Linear Sync Engine
 * Controls when and how model data is loaded from the server
 */
export enum LoadStrategy {
  /** Load immediately into ObjectPool during bootstrap - for critical models */
  instant = 'instant',

  /** Load all at once when first needed - for secondary models */
  lazy = 'lazy',

  /** Load on demand in subsets - for large collections */
  partial = 'partial',

  /** Only load when explicitly requested - for optional data */
  explicitlyRequested = 'explicitlyRequested',

  /** Never sync with server, local only - for client-side state */
  local = 'local',
}

/**
 * Property Metadata - Configuration for decorated properties
 */
export interface PropertyMetadata {
  type: PropertyType;
  indexed?: boolean;
  optional?: boolean;
  nullable?: boolean;
  defaultValue?: unknown;
  loadStrategy?: LoadStrategy;
  /**
   * MobX observability annotation for this property. Controls how deeply
   * MobX wraps the value when `M1` registers the model.
   *
   * - `'deep'` (default): full recursive observability. Every nested
   *   object/array becomes its own atom. Correct for scalar fields and
   *   small structured values where consumers subscribe to inner
   *   properties.
   * - `'shallow'`: track the reference and array/map/set operations, but
   *   do NOT recurse into element internals. Right for collections whose
   *   elements are replaced wholesale.
   * - `'ref'`: track ONLY reassignment. Right for opaque JSON blobs
   *   (chart specs, ProseMirror docs, style maps) that are treated as
   *   immutable values — consumers always read the whole blob and pass
   *   it to a renderer. Deep enhancement on these produces a microtask
   *   storm with no benefit.
   *
   * Schema-driven registration auto-sets this to `'ref'` for fields with
   * wire type `'json'`, which is the right default for the blob pattern.
   */
  observability?: 'deep' | 'shallow' | 'ref';
}

/** Model constructor type for reference metadata */
type ModelConstructor = abstract new (...args: never[]) => unknown;

/**
 * Reference Metadata - Configuration for reference properties
 */
export interface ReferenceMetadata {
  referencedModel: () => ModelConstructor;
  backReference?: string;
  indexed?: boolean;
  nullable?: boolean;
}

/**
 * Model Metadata - Configuration for model classes
 */
export interface ModelMetadata {
  loadStrategy: LoadStrategy;
  syncGroup?: string;
  tableName?: string;
  partialLoadMode?: 'full' | 'regular' | 'lowPriority';
  usedForPartialIndexes?: boolean;
  schemaVersion?: number;
  /**
   * Schema-declared fields for this model, keyed by field name. Drives
   * commit payload projection (filter to declared fields + stringify
   * JSON-typed values) inside the transaction queue.
   *
   * Populated by `registerModelsFromSchema`. Each entry carries the
   * sync-engine type tag (the canonical {@link FieldMeta.type} union),
   * which tells the wire serializer how to handle the value. Missing →
   * projection becomes identity pass-through (back-compat for models
   * registered outside the schema path).
   *
   * Narrowed to the canonical union via `Pick` rather than re-declared —
   * a hand-rolled copy silently drifts when a new field type lands.
   */
  fields?: Readonly<Record<string, Pick<FieldMeta, 'type'>>>;
  /**
   * Fields to back-fill from the sync client identity when missing
   * during IndexedDB self-healing. Populated from
   * `ModelOptions.autoFill` in the schema. Each entry maps a field on
   * this model to one of the identity values held by `SyncClient`
   * (`organizationId` or `userId`).
   *
   * Used by `SyncClient.healModelRecord` to keep the engine
   * product-neutral: the engine no longer hardcodes which models carry
   * `organizationId` / `createdBy` — the consumer's schema declares it.
   */
  autoFill?: ReadonlyArray<{ field: string; from: 'organizationId' | 'userId' }>;
  /**
   * Fields whose absence makes a stored row orphaned. When healing
   * encounters a record missing any of these fields, it returns `null`
   * to signal the caller to skip the row. Populated from
   * `ModelOptions.requiredFields` in the schema.
   */
  requiredFields?: readonly string[];
}

/**
 * Model Options - Options for @ClientModel decorator
 */
export interface ModelOptions {
  loadStrategy: LoadStrategy;
  syncGroup?: string;
  tableName?: string;
}

/**
 * Property Options - Options for @Property decorator
 */
export interface PropertyOptions {
  indexed?: boolean;
  optional?: boolean;
  defaultValue?: unknown;
  ephemeral?: boolean;
}

/**
 * Reference Options - Options for @Reference decorator
 */
export interface ReferenceOptions {
  indexed?: boolean;
  nullable?: boolean;
}

/**
 * GraphQL Mutation Interface
 */
export interface GraphQLMutation {
  mutationText: string;
  variables: Record<string, unknown>;
}

/**
 * Load Request Interface
 */
export interface LoadRequest {
  modelName: string;
  indexedKey: string;
  keyValue: string;
  resolve?: (value: unknown[]) => void;
}

/**
 * Sync Action Types - Complete Linear specification
 */
export type SyncActionType = 'I' | 'U' | 'A' | 'D' | 'C' | 'G' | 'S' | 'V';
// I - Insert
// U - Update
// A - Archive
// D - Delete
// C - Cover
// G - Change sync groups
// S - Change sync groups (variant)
// V - Unarchive (reVive)

/**
 * Sync Action Interface - Linear format
 */
export interface SyncAction {
  id: number; // The sync ID (global version)
  modelName: string;
  modelId: string;
  action: SyncActionType;
  data: unknown;
  __class: 'SyncAction'; // Linear format marker
}

/**
 * Delta Packet - Array of sync actions
 */
export type DeltaPacket = SyncAction[];

/**
 * Bootstrap Types
 */
export type BootstrapType = 'full' | 'partial' | 'local';

/**
 * Bootstrap Metadata
 */
export interface BootstrapMetadata {
  lastSyncId: number;
  subscribedSyncGroups: string[];
}

/**
 * Database Metadata - Sync engine state tracking
 */
export interface DatabaseMetadata {
  lastSyncId: number; // Current sync version
  firstSyncId: number; // Sync version at bootstrap
  backendDatabaseVersion: number;
  subscribedSyncGroups: string[]; // Or userSyncGroups in newer versions
  updatedAt: Date;
}

/**
 * Mutation operation types for batch mutations.
 */
export enum MutationOperationType {
  ARCHIVE = 'ARCHIVE',
  CREATE = 'CREATE',
  DELETE = 'DELETE',
  UNARCHIVE = 'UNARCHIVE',
  UPDATE = 'UPDATE',
}

/**
 * Partial Index Information - For complex querying
 */
export interface PartialIndexInfo {
  modelName: string;
  indexKey: string;
  depth: number; // 1-3 levels deep
  path: string[];
}

// Re-export stream + snapshot + principal types for the engine surface
// (PresenceStream,
// ClaimStream, Snapshot, etc.) consumed by `Ablo({...}).presence`,
// `.claims`, `.snapshot()`.
export * from "./streams.js";
