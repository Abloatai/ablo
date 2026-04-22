/**
 * Linear Sync Engine - Core Types
 *
 * Foundational type definitions for the model-driven sync architecture.
 * These types define how properties are tracked, loaded, and synchronized.
 */

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
   * sync-engine type tag (`'string' | 'number' | 'boolean' | 'date' |
   * 'enum' | 'json'`), which tells the wire serializer how to handle
   * the value. Missing → projection becomes identity pass-through
   * (back-compat for models registered outside the schema path).
   */
  fields?: Readonly<Record<string, { type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'json' }>>;
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
