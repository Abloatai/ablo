/**
 * Model is the base class for the sync engine's domain models. A model is a
 * plain domain object: it holds data and business logic, tracks its own
 * property changes, and validates itself, and it returns the changes to apply
 * rather than applying them. It does not reach into stores or singletons and
 * does not perform side effects such as saving or sending notifications;
 * persistence and sync are driven by the store that owns the model.
 */

import { runInAction, isComputedProp } from 'mobx';
import { v4 as uuid } from 'uuid';
import { M1 } from './utils/mobxSetup.js';
import { getActiveRegistry, hasActiveRegistry } from './ModelRegistry.js';
import { getContext } from './context.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
/** Store interface — methods that Model subclasses can call on the store */
interface SyncStoreRef {
  getByForeignKey<T extends Model>(modelName: string, foreignKey: string, id: string): T[];
  retrieve<T extends Model>(modelClass: abstract new (...args: never[]) => T, id: string): T | undefined;
  /** Lookup a model by ID alone. Returns the pool entry regardless of type. */
  getById(id: string): Model | undefined;
  /** Persist a model (upsert). */
  save(model: Model): Promise<void>;
  /** Delete a model. */
  delete(model: Model): Promise<void>;
  /** Archive a model (soft delete). */
  archive(model: Model): Promise<void>;
  /** Unarchive a previously archived model. */
  unarchive(model: Model): Promise<void>;
}
import type { PropertyMetadata } from '@abloatai/transaction/types';

/**
 * Internal wire-hydration hint. Symbol-keyed and non-enumerable at the call
 * site, so it can never enter persistence, JSON, a mutation payload, or a
 * consumer's model fields.
 */
export const DEFER_MODEL_OBSERVABILITY = Symbol('ablo.deferModelObservability');

// Type aliases for better type safety
/** Model data type - allows any object with string keys.
 *  Mirrors `ModelData` exported from BaseSyncedStore — kept local to
 *  break the import cycle between Model and BaseSyncedStore. */
type ModelData = Record<string, unknown>;

/** Represents a property value change with old and new values */
export interface PropertyChange {
  old: unknown;
  new: unknown;
}

/** Validation rule function that returns error string or null if valid */
type ValidationRule = (value: unknown) => string | null;

/** Interface for objects that can be disposed */
interface Disposable {
  dispose(): void;
}

/** Field change information for activity tracking */
interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  fieldType: string;
}

/**
 * Validation error for model validation failures
 */
export class ValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Validation failed: ${errors.join(', ')}`);
    this.name = 'ValidationError';
  }
}

/**
 * Model changes for external processing
 */
export interface ModelChanges {
  type: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
  modelName: string;
  modelId: string;
  changes?: Map<string, PropertyChange>;
  timestamp: Date;
}

/** Shared frozen default for {@link Model.getDerivedGetterNames}. */
const EMPTY_DERIVED_GETTERS: readonly string[] = Object.freeze([]);

/**
 * How {@link Model.assignFieldsFromData} treats one key on instances of one
 * model class. Resolved once per (class, key) and cached: the decision depends
 * only on class shape — prototype getters, registry annotations, declared
 * fields — which is identical across instances of a generated model class.
 * Every write disposition is still guarded per instance by a `key in this`
 * check, so an instance that genuinely lacks the key falls back to the full
 * resolution instead of trusting the cache.
 */
type FieldDisposition = 'write' | 'write-date' | 'skip-absent' | 'skip-readonly';

const fieldWritePlans = new WeakMap<object, Map<string, FieldDisposition>>();

/**
 * The abstract base class every domain model extends. It holds the model's id
 * and timestamps, tracks in-place property changes for change detection and
 * undo, and serializes itself, while leaving persistence and sync to the store
 * that owns it.
 */
export abstract class Model {
  /** Static reference to active SyncedStore for reactive queries */
  private static store: SyncStoreRef | null = null;

  /** Unique identifier - always permanent UUID */
  id: string;

  /** Client ID - always equals id, kept for compatibility */
  clientId: string;

  /** MobX observable properties storage */
  _mobxProperties: ModelData = {};

  /**
   * True while {@link updateFromData} assigns inbound wire data. The
   * `observe()` bridge (`mobxSetup.M1`) checks it and skips the forward to
   * {@link propertyChanged} entirely: hydration writes are not user edits, and
   * the bridge's work per changed field — a nested action, map bookkeeping,
   * and a fabricated `updatedAt` stamp — was already being discarded by the
   * `modifiedProperties` swap in `updateFromData`. The swap stays as the
   * correctness backstop; this flag removes the cost.
   */
  _isHydrating = false;

  /** Referenced models cache */
  _referencedModels: Record<string, Model | null> = {};

  /** Track property changes */
  modifiedProperties = new Map<string, PropertyChange>();

  /** Track if this is a new model */
  private _isNew = true;

  /** Original data snapshot */
  private _originalData?: ModelData;

  /**
   * Whether the persisted baseline needs recapturing. Hydration and ack land
   * far more often than anything reads the baseline — an observer-only client
   * reads it never — so each of those sites marks the snapshot stale and
   * {@link getOriginalSnapshot} materializes it on first read. Correctness
   * rests on the tracking invariant: every non-hydration write is recorded in
   * `modifiedProperties` (first-old-wins), so between the stale mark and the
   * read, untracked fields still hold exactly the values an eager capture
   * would have recorded.
   */
  private _originalDataStale = false;

  /** Sync status */
  syncStatus: 'pending' | 'syncing' | 'synced' = 'pending';

  /** Timestamps */
  createdAt?: Date;
  updatedAt?: Date;
  archivedAt?: Date | null;

  /** Validation rules */
  protected validationRules: Record<string, ValidationRule[]> = {};

  /** Lifecycle state */
  private isDisposed = false;
  private disposers: (() => void)[] = [];
  /**
   * Whether MobX field instrumentation has been installed. Wire hydration can
   * deliberately defer this work until the cache hands the model to a
   * consumer; optimistic/local models still install it in their constructor.
   */
  private _observabilityReady = false;
  private _observabilityDeferred = false;

  /**
   * Track observed LazyReferenceCollections for GC prevention
   * When any collection is being observed by React, the model should not be GC'd
   * Following MobX best practice: https://mobx.js.org/lazy-observables.html
   */
  private _observedCollections = new Set<Disposable>();

  constructor(data: Partial<Model> = {}) {
    // Always generate permanent UUID on client
    this.id = data.id ?? Model.generateId();
    this.clientId = this.id; // No more temp IDs!

    // Ensure dates are Date objects, not strings
    this.createdAt = data.createdAt
      ? data.createdAt instanceof Date
        ? data.createdAt
        : new Date(data.createdAt)
      : new Date();
    // A record that arrives WITH `createdAt` but WITHOUT `updatedAt` is
    // server/IDB data whose update timestamp didn't survive the wire —
    // falling back to "now" here fabricated an edit time for every such
    // record on every bootstrap (the reports gallery sorted everything to
    // "edited just now"). Fall back to createdAt instead; only a genuinely
    // new local model (no dates at all) stamps the current time.
    this.updatedAt = data.updatedAt
      ? data.updatedAt instanceof Date
        ? data.updatedAt
        : new Date(data.updatedAt)
      : data.createdAt
        ? new Date(this.createdAt)
        : new Date();
    this.syncStatus = data.syncStatus ?? 'pending';
  }

  /**
   * Generate unique ID
   */
  static generateId(): string {
    return uuid();
  }

  /**
   * Set the active SyncedStore reference for reactive queries.
   * Called once at engine initialization.
   */
  static setStore(store: SyncStoreRef): void {
    Model.store = store;
  }

  /**
   * Get the active SyncedStore reference for reactive queries.
   *
   * Returns `null` if no store has been registered yet (e.g. during
   * bootstrap before the engine is ready). Subclasses should use this
   * instead of reaching into the private static field via bracket
   * notation — the generic parameter lets app-side Model subclasses
   * narrow the return to their concrete store type.
   *
   * @example
   *   // In a Section model getter
   *   const store = Section.getStore();
   *   if (!store) return [];
   *   return store.getByForeignKey<Block>('Block', 'sectionId', this.id);
   */
  static getStore<T extends SyncStoreRef = SyncStoreRef>(): T | null {
    return Model.store as T | null;
  }

  /**
   * Initialize MobX observability
   */
  public makeObservable(): void {
    if (this._observabilityReady) return;
    const modelName = this.getModelName();

    // Get metadata from static ModelRegistry
    const propertyMetadata = getActiveRegistry().getProperties(modelName);
    const referenceMetadata = getActiveRegistry().getReferences(modelName);

    // Use M1 for observability setup
    M1(this, propertyMetadata, referenceMetadata);
    this._observabilityReady = true;
    this._observabilityDeferred = false;
  }

  /** Mark a schema model as intentionally cold until cache exposure. */
  protected deferObservability(): void {
    if (!this._observabilityReady) this._observabilityDeferred = true;
  }

  /**
   * Activate a cold wire-hydrated model before it crosses a consumer-visible
   * cache boundary. Idempotent, so ordinary eagerly observable models pay only
   * the boolean check.
   */
  public ensureObservable(): void {
    if (this._observabilityDeferred) this.makeObservable();
  }

  /**
   * Track property changes
   */
  propertyChanged(propertyName: string, oldValue: unknown, newValue: unknown): void {
    // `createdAt` and `updatedAt` are server-managed bookkeeping, not
    // user-authored model changes. In particular, every real field change
    // advances `updatedAt` below. When a schema explicitly declares that
    // timestamp, MobX observes the assignment and calls this method again;
    // treating that callback as another edit recursively stamps `updatedAt`
    // until the stack overflows. Ignore both timestamps at this boundary so
    // they remain observable without entering the mutation payload.
    if (
      oldValue === newValue ||
      propertyName === 'createdAt' ||
      propertyName === 'updatedAt'
    ) return;

    runInAction(() => {
      // Preserve the earliest captured `old` for this field until the entry
      // is cleared (by `clearChanges` on sync-ack or by a mutator consuming
      // it). Consecutive in-place mutations between mutator invocations —
      // e.g. a drag loop writing `block.position = ...` on every frame —
      // would otherwise overwrite `.old` with each frame's predecessor,
      // destroying the pre-session baseline that `RecordingMutation`
      // relies on to record a correct undo inverse. `.new` always reflects
      // the latest value so the transaction queue's `getChanges()` keeps
      // sending the right payload to the server.
      const existing = this.modifiedProperties.get(propertyName);
      this.modifiedProperties.set(propertyName, {
        old: existing ? existing.old : oldValue,
        new: newValue,
      });
      this.updatedAt = new Date();
    });
  }

  /**
   * Get changes as object
   */
  getChanges(): ModelData {
    const changes: ModelData = {};

    for (const [propertyName, change] of this.modifiedProperties) {
      changes[propertyName] = change.new;
    }

    return changes;
  }

  /**
   * Check if model has changes
   */
  get hasChanges(): boolean {
    return this.modifiedProperties.size > 0;
  }

  /**
   * Mark model as persisted (not new)
   */
  markAsPersisted(): void {
    this._isNew = false;
    this._originalData = undefined;
    this._originalDataStale = true;
  }

  /**
   * Check if this is a new model
   */
  isNew(): boolean {
    return this._isNew;
  }

  /**
   * Return a read-only view of the snapshot taken at {@link markAsPersisted}
   * or at load time. The undo machinery uses it to recover a field's pre-edit
   * value when the field was written without first being tracked in
   * `modifiedProperties`. The returned object is the live snapshot, so callers
   * must not mutate it.
   *
   * This per-instance baseline is needed because application code can edit a
   * model in two ways that coexist: a direct property write
   * (`section.title = 'foo'`) and a recorded mutation. A design in which every
   * write went through a single recorded path would not need it, since the
   * last acknowledged state would already be the authoritative baseline.
   */
  getOriginalSnapshot(): Readonly<ModelData> | undefined {
    if (this._originalDataStale) {
      this._originalData = this.captureSnapshot();
      this._originalDataStale = false;
    }
    return this._originalData;
  }

  /**
   * Clear tracked changes
   */
  clearChanges(): void {
    runInAction(() => {
      this.modifiedProperties.clear();
      this._originalData = undefined;
      this._originalDataStale = true;
    });
  }

  /**
   * Capture a before-image for `keys` — the single source of truth for the
   * "previous value" that undo inverses are built from. Both undo paths call
   * this so they can never drift: the stream path
   * (`MutationQueue.extractPreviousData`) and the manual-record path
   * (`RecordingMutation.snapshotFields`).
   *
   * Resolution order per key:
   *   1. `modifiedProperties.get(key).old` — first-old-wins pre-session
   *      baseline, set whenever the field was mutated in place before commit.
   *   2. `getOriginalSnapshot()[key]` — the last loaded/acked row, the correct
   *      before-image for a key written without a prior in-place mutation
   *      (e.g. a `precomputedChanges` write).
   *   3. `fallbackToLive` only — the current live value. The manual-record path
   *      wants this last resort; the stream path deliberately omits unresolved
   *      keys so `buildUndoOps` drops an un-revertible inverse rather than
   *      inventing one. The flag is the one intentional difference between the
   *      two callers — do not collapse it.
   *
   * `id` is always skipped. Values are read out per-key, so the
   * `getOriginalSnapshot()` "callers must not mutate" contract is preserved.
   *
   * Invariant this relies on: a given undo scope is either stream-recorded
   * (`recordFromStream: true`) or manual (`useMutators({ undoScope })`), never
   * both — otherwise a write would be captured twice. No surface sets both.
   */
  capturePreviousValues(
    keys: Iterable<string>,
    opts?: { fallbackToLive?: boolean },
  ): ModelData {
    const out: ModelData = {};
    const modified = this.modifiedProperties;
    const original = this.getOriginalSnapshot();
    for (const key of keys) {
      if (key === 'id') continue;
      const mod = modified.get(key);
      if (mod) {
        out[key] = mod.old;
      } else if (original && key in original) {
        out[key] = original[key];
      } else if (opts?.fallbackToLive) {
        out[key] = Reflect.get(this, key);
      }
    }
    return out;
  }

  /**
   * Drop the `modifiedProperties` entries for `keys` — re-baselines a field
   * after its `.old` has been frozen into a committed transaction, so the next
   * write to the same field starts from this commit's result rather than the
   * stale pre-session `.old` that {@link propertyChanged}'s first-old-wins
   * policy preserves. Safe because the committed transaction owns its own
   * frozen `data`/`previousData`; neither re-reads `modifiedProperties`. `id`
   * is never consumed. With no `keys`, consumes every tracked field.
   */
  consumeModifiedFields(keys?: Iterable<string>): void {
    if (this.modifiedProperties.size === 0) {
      return;
    }
    const only = keys ? new Set(keys) : null;
    for (const key of [...this.modifiedProperties.keys()]) {
      if (key === 'id') continue;
      if (only && !only.has(key)) continue;
      this.modifiedProperties.delete(key);
    }
  }

  /**
   * Validate model
   */
  validate(): string[] {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot validate disposed model', {
        code: 'model_disposed',
      });
    }

    const errors: string[] = [];
    const modelName = this.getModelName();
    const properties = getActiveRegistry().getProperties(modelName);

    const json = this.toJSON();
    for (const [propName, metadata] of properties) {
      // Check required fields
      if (!metadata.nullable && !metadata.optional) {
        const value = json[propName];
        if (value == null || value === '') {
          errors.push(`${propName} is required`);
        }
      }

      // Run custom validation rules
      const rules = this.validationRules[propName];
      if (rules) {
        const value = json[propName];
        for (const rule of rules) {
          const error = rule(value);
          if (error) errors.push(error);
        }
      }
    }

    // Run model-specific validation
    const customErrors = this.customValidate();
    errors.push(...customErrors);

    return errors;
  }

  /**
   * Override for custom validation
   */
  protected customValidate(): string[] {
    return [];
  }

  /**
   * Add validation rule
   */
  protected addValidationRule(propName: string, rule: ValidationRule): void {
    this.validationRules[propName] ??= [];
    this.validationRules[propName].push(rule);
  }

  /**
   * Prepare save operation
   * Returns the changes to be saved without side effects
   */
  prepareSave(): ModelChanges | null {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot prepare save for disposed model', {
        code: 'model_disposed',
      });
    }

    // Validate first
    const errors = this.validate();
    if (errors.length > 0) {
      throw new ValidationError(errors);
    }

    if (this._isNew) {
      // New model - return create operation
      return {
        type: 'create',
        modelName: this.getModelName(), // the registered model name
        modelId: this.id,
        timestamp: new Date(),
      };
    } else if (this.hasChanges) {
      // Existing model with changes - return update operation
      return {
        type: 'update',
        modelName: this.getModelName(), // the registered model name
        modelId: this.id,
        changes: new Map(this.modifiedProperties),
        timestamp: new Date(),
      };
    }

    // No changes
    return null;
  }

  /**
   * Prepare delete operation
   */
  prepareDelete(): ModelChanges {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot prepare delete for disposed model', {
        code: 'model_disposed',
      });
    }

    this.willDelete();

    return {
      type: 'delete',
      modelName: this.getModelName(), // the registered model name
      modelId: this.id,
      timestamp: new Date(),
    };
  }

  /**
   * Prepare archive operation
   */
  prepareArchive(): ModelChanges {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot prepare archive for disposed model', {
        code: 'model_disposed',
      });
    }

    this.archivedAt = new Date();

    return {
      type: 'archive',
      modelName: this.getModelName(), // the registered model name
      modelId: this.id,
      timestamp: new Date(),
    };
  }

  /**
   * Prepare unarchive operation
   */
  prepareUnarchive(): ModelChanges {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot prepare unarchive for disposed model', {
        code: 'model_disposed',
      });
    }

    this.archivedAt = null;

    return {
      type: 'unarchive',
      modelName: this.getModelName(), // the registered model name
      modelId: this.id,
      timestamp: new Date(),
    };
  }

  /**
   * Safely assign each field of `data` onto this instance, skipping `id`,
   * unknown keys, MobX computed accessors, and getter-only (read-only)
   * properties, and coercing date fields. Shared by `updateFromData`
   * (hydration) and `applyChanges` (local user update).
   *
   * Change tracking is explicit: for every field actually
   * written, `onWrite(key, oldValue, newValue)` is invoked with the value
   * captured immediately before assignment. `applyChanges` passes a hook
   * that records the change in `modifiedProperties`; `updateFromData`
   * passes none (hydration must not generate outbound mutations).
   *
   * This is not the ONLY tracking path. `mobxSetup`'s `observe()` bridge is
   * live and forwards a DIRECT assignment (`layer.position = next`) to
   * `propertyChanged` as well — product code writes model fields directly in
   * plenty of places (keyboard nudge, formatting, AI tools), and those writes
   * have to reach the server and the undo stream too. The two paths compose:
   * a direct write establishes the first-old-wins baseline, and a later
   * `applyChanges` carrying the value the model already holds is a no-op that
   * leaves that baseline intact.
   */
  private assignFieldsFromData(
    data: ModelData,
    onWrite?: (key: string, oldValue: unknown, newValue: unknown) => void,
  ): void {
    let plan = fieldWritePlans.get(this.constructor);
    if (!plan) {
      plan = new Map();
      fieldWritePlans.set(this.constructor, plan);
    }

    for (const key in data) {
      if (key === 'id') continue;
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const raw = data[key];

      let disposition = plan.get(key);
      if (disposition === undefined) {
        disposition = this.resolveFieldDisposition(key);
        plan.set(key, disposition);
      }

      if (disposition === 'skip-readonly') continue;
      if (disposition === 'skip-absent') {
        // The plan was built from an instance that lacked this key. Re-resolve
        // for this instance without touching the cache, so heterogeneous
        // shapes stay correct at the cost of the slow path.
        if (!(key in this)) continue;
        disposition = this.resolveFieldDisposition(key);
        if (disposition === 'skip-readonly' || disposition === 'skip-absent') continue;
      } else if (!(key in this)) {
        continue;
      }

      // Handle date conversions
      const value = disposition === 'write-date' && raw
        ? new Date(raw as string | number)
        : raw;

      // Capture the pre-write value BEFORE assignment so trackers
      // (undo inverse, getChanges) see the true previous value.
      const oldValue = onWrite ? (this as Record<string, unknown>)[key] : undefined;

      // Dynamic property assignment - use indexed access
      (this as Record<string, unknown>)[key] = value;

      onWrite?.(key, oldValue, value);
    }
  }

  /**
   * The uncached decision for one key: existence on instance or prototype,
   * never a MobX computed (its setter may throw), and writability resolved
   * through the descriptor chain — a data descriptor's `writable` or an
   * accessor's setter.
   */
  private resolveFieldDisposition(key: string): FieldDisposition {
    if (!(key in this)) return 'skip-absent';

    try {
      if (isComputedProp(this, key)) {
        return 'skip-readonly';
      }
    } catch {
      // If MobX internals are unavailable for some reason, fall back to descriptor checks below
    }

    const ownDesc = Object.getOwnPropertyDescriptor(this, key);
    let desc = ownDesc;
    if (!desc) {
      let proto = Object.getPrototypeOf(this) as object | null;
      while (proto && proto !== Object.prototype && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, key);
        proto = Object.getPrototypeOf(proto) as object | null;
      }
    }

    const writable = desc
      ? ('writable' in desc && !!desc.writable) ||
        ('set' in desc && typeof desc.set === 'function')
      : true;
    if (!writable) return 'skip-readonly';

    return key === 'createdAt' || key === 'updatedAt' || key === 'archivedAt'
      ? 'write-date'
      : 'write';
  }

  /**
   * Update from raw data (hydration)
   *
   * Used for inbound server deltas and pool upserts. Change tracking is
   * deliberately suppressed: hydration writes must not land in
   * `modifiedProperties`, otherwise applying a server delta would queue a
   * brand-new outbound mutation and the record would echo forever. For a
   * local user edit, use `applyChanges` instead.
   *
   * Suppression takes two forms and BOTH are load-bearing: we pass no
   * `onWrite` hook, and we clear/restore `modifiedProperties` around the
   * assignment. The second is what catches `mobxSetup`'s `observe()` bridge,
   * which fires on the assignment itself and would otherwise record an
   * inbound delta as a local edit — queueing an outbound mutation that echoes
   * forever, and putting a collaborator's change on your undo stack. Do not
   * remove it while that bridge exists (`mobxSetup.M1`).
   */
  updateFromData(data: ModelData): void {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot update disposed model', {
        code: 'model_disposed',
      });
    }

    runInAction(() => {
      const originalTracking = this.modifiedProperties;
      this.modifiedProperties = new Map();
      this._isHydrating = true;
      try {
        // No `onWrite` → this call records nothing itself.
        this.assignFieldsFromData(data);
      } finally {
        this._isHydrating = false;
        this.modifiedProperties = originalTracking;
      }
    });

    // Mark as persisted if updating existing model
    if (!this._isNew) {
      this._originalData = undefined;
      this._originalDataStale = true;
    }

    this.didUpdate();
  }

  /**
   * Apply a local, user-initiated update from a data object — the write
   * path for `proxy.update({ id, data })`, which is the one and only way
   * application code mutates synced fields.
   *
   * Unlike `updateFromData` (hydration, untracked), this records every
   * written field in `modifiedProperties` via `propertyChanged`, so
   * `getChanges()` and the transaction queue send the edited fields to the
   * server and the undo system gets a correct pre-write baseline. Recording
   * is explicit here, through the `onWrite` hook, and does not rely on any
   * MobX `observe()` side channel.
   *
   * `_originalData` is intentionally not reset here: it stays as the
   * last-persisted baseline until `clearChanges()` runs on sync-ack.
   */
  applyChanges(data: ModelData): void {
    if (this.isDisposed) {
      throw new AbloValidationError('Cannot update disposed model', {
        code: 'model_disposed',
      });
    }

    runInAction(() => {
      this.assignFieldsFromData(data, (key, oldValue, newValue) => {
        this.propertyChanged(key, oldValue, newValue);
      });
    });

    this.didUpdate();
  }

  /**
   * Serialize to JSON
   * This method should not trigger MobX reactions since it's used for serialization
   * Returns Record<string, any> to allow subclass specialization with more specific return types
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toJSON(): Record<string, any> {
    const modelName = this.getModelName();
    const properties = getActiveRegistry().getProperties(modelName);
    const result: ModelData = {
      __class: this.getModelName(), // the registered model name for consistency
      __typename: this.getModelName(), // __typename mirrors __class as the wire type discriminator
      id: this.id,
      createdAt: this.createdAt?.toISOString(),
      updatedAt: this.updatedAt?.toISOString(),
      clientId: this.clientId,
      syncStatus: this.syncStatus,
    };

    if (this.archivedAt !== undefined) {
      result.archivedAt = this.archivedAt?.toISOString() ?? null;
    }

    const self = this as Record<string, unknown>;
    for (const [propName, metadata] of properties) {
      // Skip certain types
      if (metadata.type === 'ephemeralProperty') continue;
      if (metadata.type === 'referenceModel') continue;
      if (metadata.type === 'referenceCollection') continue;

      const value = self[propName];
      if (value !== undefined) {
        result[propName] = value;
      }
    }

    return result;
  }

  /**
   * Clone this model
   */
  clone(): this {
    const Constructor = this.constructor as new () => this;
    const clone = new Constructor();

    const data = this.toJSON();
    delete data.id; // New ID for clone
    delete data.createdAt;
    delete data.updatedAt;

    clone.updateFromData(data);
    return clone;
  }

  getModelName(): string {
    const registeredName = getActiveRegistry().getModelNameFromConstructor(this.constructor);
    if (registeredName) {
      return registeredName;
    }

    const className = this.constructor.name;
    // Use consumer-provided fallback map from config (replaces hardcoded Prisma name map)
    const fallbackMap = getContext().config.classNameFallbackMap;
    return fallbackMap[className] ?? className.replace(/Model$/, '');
  }

  /**
   * Read a field value by name. Runtime-safe dynamic field access —
   * schema-generated models store all declared fields as instance properties.
   * Use this for generic code (sort comparators, filter predicates that work
   * across model types) that reads fields by name string.
   */
  getField(name: string): unknown {
    return Reflect.get(this, name);
  }

  /**
   * Check equality
   */
  equals(other: Model): boolean {
    return this.id === other.id && this.constructor === other.constructor;
  }

  /**
   * String representation
   */
  toString(): string {
    return `${this.constructor.name}[${this.id}]`;
  }

  // ==========================================
  // MobX Observation Tracking (for GC prevention)
  // ==========================================

  /**
   * Register a LazyReferenceCollection as being observed
   * Called by LazyReferenceCollection when onBecomeObserved fires
   */
  _registerObservedCollection(collection: Disposable): void {
    this._observedCollections.add(collection);
  }

  /**
   * Unregister a LazyReferenceCollection that's no longer observed
   * Called by LazyReferenceCollection when onBecomeUnobserved fires
   */
  _unregisterObservedCollection(collection: Disposable): void {
    this._observedCollections.delete(collection);
  }

  /**
   * Check if any collection on this model is currently being observed by React
   * Used by InstanceCache GC to prevent disposing models in active use
   */
  hasObservedCollections(): boolean {
    return this._observedCollections.size > 0;
  }

  /**
   * Get count of observed collections (for debugging)
   */
  get observedCollectionCount(): number {
    return this._observedCollections.size;
  }

  /**
   * Dispose model
   */
  dispose(): void {
    if (this.isDisposed) return;

    // Clean up
    for (const disposer of this.disposers) {
      disposer();
    }
    this.disposers = [];

    this._referencedModels = {};
    this.modifiedProperties.clear();
    this._observedCollections.clear();

    // Dispose collections. Gracefully skip when no active registry
    // exists — `dispose()` is a cleanup path and must not crash when a
    // test (or a teardown during engine shutdown) calls it after the
    // registry is gone. Production flows always have one set, so the
    // collection-disposal branch still runs there.
    if (hasActiveRegistry()) {
      const modelName = this.getModelName();
      const properties = getActiveRegistry().getProperties(modelName);

      const self = this as Record<string, unknown>;
      for (const [propName, metadata] of properties) {
        if (metadata.type === 'referenceCollection') {
          const collection = self[propName] as Disposable | undefined;
          if (collection) {
            collection.dispose();
          }
        }
      }
    }

    this.isDisposed = true;
  }

  /**
   * Check if disposed
   */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Lifecycle hooks - override in subclasses
   */
  protected didUpdate(): void {}
  protected willDelete(): void {}

  /**
   * Capture snapshot for change detection
   */
  protected captureSnapshot(): ModelData {
    const snapshot: ModelData = {};
    const modelName = this.getModelName();
    const properties = getActiveRegistry().getProperties(modelName);

    const json = this.toJSON();
    for (const [propName] of properties) {
      snapshot[propName] = json[propName];
    }

    return snapshot;
  }

  /**
   * A fresh, plain row snapshot that READS every declared field through its
   * MobX observable getter. This is the reactive read surface for
   * `useReactive`/`useAblo`, and it relies on two MobX facts:
   *
   *  1. MobX tracks property *access*, not values — so reading each field here,
   *     inside the caller's tracked function, SUBSCRIBES the reaction to that
   *     field. A bare `return model` (the previous `modelAsRow`) dereferences
   *     nothing, so an in-place delta update fires no reaction and the UI never
   *     re-renders. (https://mobx.js.org/understanding-reactivity.html)
   *  2. The returned object is a NEW identity each call, so the hook's equality
   *     check detects the change — the same mutated instance would compare equal
   *     and suppress the re-render even after tracking fired.
   *
   * Unlike `toJSON()`, values keep their runtime types (a `Date` stays a `Date`,
   * a json field stays its parsed object) and wire-noise keys
   * (`__class`/`clientId`/`syncStatus`) are omitted — this is exactly the row
   * the schema's `T` describes. Computed relations (`referenceModel`/
   * `referenceCollection`) and ephemeral fields are skipped, matching `toJSON`'s
   * row projection; they're lazy/recursive and not part of the row's data.
   *
   * Schema-derived getters (`computed:` entries and `${field}Json` getters) ARE
   * materialized, as non-enumerable own values. The schema's inferred row type
   * includes them, so omitting them would make every snapshot read of a computed
   * silently `undefined` — a type-level lie. They're evaluated here, inside the
   * caller's tracked function, so the reaction subscribes to whatever fields the
   * getter reads. Non-enumerable keeps write-path parity with model instances:
   * an instance's getters sit on the prototype and never enter `{...model}`
   * spreads or `JSON.stringify`, and materialized values must not either — a
   * spread-into-update would otherwise send computed keys to the server.
   */
  toReactiveSnapshot<T = ModelData>(): T {
    const snapshot: ModelData = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    if (this.archivedAt !== undefined) snapshot.archivedAt = this.archivedAt;

    const properties = getActiveRegistry().getProperties(this.getModelName());
    const self = this as Record<string, unknown>;
    for (const [propName, metadata] of properties) {
      if (
        metadata.type === 'ephemeralProperty' ||
        metadata.type === 'referenceModel' ||
        metadata.type === 'referenceCollection'
      ) {
        continue;
      }
      // Reading through the observable getter is the point: it subscribes the
      // enclosing MobX reaction to this field.
      snapshot[propName] = self[propName];
    }

    for (const name of this.getDerivedGetterNames()) {
      Object.defineProperty(snapshot, name, {
        // Evaluated on the model instance so `${field}Json` caches stay on it
        // and the enclosing reaction tracks the fields the getter reads.
        value: self[name],
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    return snapshot as T;
  }

  /**
   * Names of schema-derived getters — `computed:` entries and `${field}Json`
   * getters — that {@link toReactiveSnapshot} materializes onto snapshots.
   * The dynamic model class built by `registerModelsFromSchema` overrides this;
   * hand-written Model subclasses default to none.
   */
  getDerivedGetterNames(): readonly string[] {
    return EMPTY_DERIVED_GETTERS;
  }

  /**
   * Get field changes for activity tracking
   */
  getFieldChanges(): FieldChange[] {
    const changes: FieldChange[] = [];

    for (const [field, change] of this.modifiedProperties) {
      changes.push({
        field,
        oldValue: change.old,
        newValue: change.new,
        fieldType: this.getFieldType(change.new),
      });
    }

    return changes;
  }

  private getFieldType(value: unknown): string {
    if (value === null || value === undefined) return 'string';
    if (typeof value === 'number') return 'number';
    if (value instanceof Date) return 'date';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string' && /^[a-fA-F0-9-]{36}$/.test(value)) return 'reference';
    return 'string';
  }

  /**
   * Create model from JSON
   */
  static fromJSON(
    data: ModelData & { __typename?: string; __class?: string; modelName?: string }
  ): Model {
    // Support both __class and __typename, and handle both old and new naming
    const modelIdentifier = data.__typename ?? data.__class ?? data.modelName;

    if (!modelIdentifier) {
      throw new AbloValidationError(
        'Model identifier (__typename, __class, or modelName) not found in data',
        { code: 'model_identifier_missing' },
      );
    }

    // Try to get model class by identifier
    const ModelClass = getActiveRegistry().getModelByName(modelIdentifier);

    if (!ModelClass) {
      throw new AbloValidationError(
        `Model class not found for: ${modelIdentifier}`,
        { code: 'model_class_not_registered' },
      );
    }

    const instance = new ModelClass(data);
    instance.markAsPersisted();
    return instance;
  }

  /**
   * Get sync status
   */
  getSyncStatus(): 'pending' | 'syncing' | 'synced' {
    return this.syncStatus;
  }

  /**
   * Mark model as synced
   */
  markAsSynced(): void {
    this.syncStatus = 'synced';
  }

  /**
   * Mark model as pending sync
   */
  markAsPending(): void {
    this.syncStatus = 'pending';
  }
}

/**
 * Project a dynamic-class `Model` instance to the schema row shape `T`.
 *
 * The runtime invariant: `createDynamicModelClass(...)` attaches every
 * field of `T` directly onto the Model prototype/instance via
 * `Object.defineProperty` and the M1 observable bridge, so a Model
 * instance structurally satisfies `T` at runtime. The static type
 * system can't see this because `T` is a free generic — there's no
 * common ancestor between `Model` (base class) and the schema row
 * interface produced by `defineSchema`.
 *
 * This is a typed boundary, not a bypass: every call site is the
 * dynamic-class duality where Model-with-extras-and-T-fields is being
 * returned to a consumer that only sees `T`. Concentrating the cast
 * here means there's one place to look when the boundary changes.
 */
export function modelAsRow<T>(model: Model): T {
  return model as Model & T;
}

/**
 * Inverse of `modelAsRow`: accept a row-shaped value (schema-derived
 * `T` with at minimum an `id`) and surface it as a `Model`. Used by
 * `BaseSyncedStore.save / delete / archive / unarchive` so consumers
 * can pass either a typed schema row or a Model instance and the
 * SDK's persistence path sees a uniform Model surface.
 *
 * Same runtime invariant as `modelAsRow`: dynamic-class instances
 * carry both the row fields and the Model methods on the same object
 * — one structural identity, two static views. The helper does no
 * runtime conversion (no allocation, no copy) — it's a pure type cast.
 */
export function rowAsModel<T extends { id: string }>(entity: T): Model {
  return entity as T & Model;
}
