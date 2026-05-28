/**
 * Per-model client factory.
 *
 * Mirrors Anthropic SDK's per-endpoint module pattern: each model client
 * has its own file, and the root client just instantiates
 * one per model. Extracted from `Ablo.ts` so the proxy logic is
 * testable in isolation and the constructor doesn't carry it.
 *
 * Each schema model gets one `ModelOperations<T, CreateInput>` —
 * exposes `retrieve`, `list`, `count`, `create`, `update`, `delete`,
 * `claim`, `claimState`, `queue`, `release`, `subscribe`, and `load`.
 * The factory returns a plain object; the client assembles the
 * `ablo.<model>` lookup table from these.
 */

import { autorun } from 'mobx';
import { AbloClaimedError, AbloStaleContextError, AbloValidationError } from '../errors.js';
import type { MutationOptions } from '../interfaces/index.js';
import { Model, modelAsRow } from '../Model.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { ObjectPool } from '../ObjectPool.js';
import type { SyncClient } from '../SyncClient.js';
import type { HydrationCoordinator } from '../sync/HydrationCoordinator.js';
import type { LoadWhere } from '../query/types.js';
import { ModelScope } from '../types/index.js';
import type {
  Duration,
  Intent,
  IntentStatus,
  IntentWaitOptions,
  Snapshot,
} from '../types/streams.js';

export interface ModelClientMeta {
  readonly key: string;
  readonly typename: string;
}

const modelClientMeta = new WeakMap<object, ModelClientMeta>();

export function getModelClientMeta(modelClient: unknown): ModelClientMeta | undefined {
  if (typeof modelClient !== 'object' || modelClient === null) return undefined;
  return modelClientMeta.get(modelClient);
}

export type ModelListScope = ModelScope | 'live' | 'archived' | 'all';

export interface ModelListOptions<T> {
  where?: Partial<T>;
  /** Arbitrary local predicate. Applied after `where`. */
  filter?: (entity: T) => boolean;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Lifecycle filter — `live` (default), `archived`, or `all`. Named `state`
   *  (GitHub's open/closed/all precedent) so it doesn't collide with the
   *  sync-group `scope`. */
  state?: ModelListScope;
}

export type ModelCountOptions<T> = Pick<
  ModelListOptions<T>,
  'where' | 'filter' | 'state'
>;

export interface ModelLoadOptions<T> {
  /**
   * Filter for the lookup. Accepts:
   *   - object form: `{ name: 'foo' }` (equality, array values → `IN`)
   *   - tuple form: `[['name', 'ILIKE', '%Goldman%']]` for operators
   *
   * See `LoadWhere<T>` in `query/types.ts`. For OR semantics, run two
   * `load()` calls and union — the wire protocol is AND-only.
   */
  where?: LoadWhere<T>;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  /**
   * `complete` waits for the server. `unknown` returns whatever is local
   * immediately and refreshes in the background.
   */
  type?: 'complete' | 'unknown';
  /**
   * Schema-declared relation names to hydrate alongside the primary
   * rows. The server's compiler resolves each name via the schema's
   * relation metadata (`relation.belongsTo` / `relation.hasMany`)
   * and emits the JOIN.
   */
  expand?: readonly string[];
}

export interface IntentLeaseHandle {
  readonly id: string;
  release(): Promise<void>;
  revoke(): void;
}

export interface ModelCollaboration<T> {
  createIntent(options: {
    target: {
      model: string;
      id: string;
      field?: string;
    };
    action: string;
    ttl?: Duration;
    /**
     * Block on the server's fair FIFO queue when the target is held, rather
     * than failing. Resolves only once the lease is genuinely ours (the head
     * of the line). `takeClaim` sets this so writers serialize on contention.
     */
    queue?: boolean;
    /** Reject (don't wait) if the queue is already this deep when we join. */
    maxQueueDepth?: number;
  }): Promise<IntentLeaseHandle>;
  createSnapshot(modelKey: string, id: string): Snapshot;
  /**
   * Current coordination state on a target — who (if anyone) holds it.
   * Synchronous reactive snapshot read off the presence/intent stream;
   * `null` when the target is free. The wiring site computes it because
   * only it knows the local participant id (needed to distinguish "I
   * hold it" from "someone else holds it").
   */
  observe(target: { model: string; id: string }): Intent | null;
  /**
   * The reactive wait queue on a target — the FIFO line of queued intents
   * behind the holder. Synchronous snapshot off the synced intent stream.
   */
  queue(target: { model: string; id: string }): readonly Intent[];
  /**
   * Re-rank the wait queue on a target (privileged — server-gated). `order` is
   * the desired front-of-line ordering, taken from `queue(target)`.
   */
  reorder(target: { model: string; id: string }, order: readonly Intent[]): void;
  /**
   * Resolve once no participant holds an active intent on the target.
   * The contender's "wait until it's free" — delegates to the intent
   * stream's `waitFor`.
   */
  waitFor(
    target: { model: string; id: string },
    options?: IntentWaitOptions,
  ): Promise<void>;
  /**
   * The local participant's id. Used to distinguish "I already hold this"
   * from "someone else holds it" in `claimOrWait`.
   */
  readonly selfParticipantId: string;
}

/** Options for `claim(id, …)`. */
export interface ClaimOptions {
  /** Phase shown to observers while held. Defaults to `'editing'`. */
  action?: string;
  /** Field-level target, for fine-grained claimed-state badges. */
  field?: string;
  /** Crash-cleanup TTL — the claim auto-releases if the holder dies. */
  ttl?: Duration;
  /**
   * On contention: `true` (default) queues behind the current holder and
   * resolves once it's yours (claim-or-wait). `false` is fail-fast — if
   * another participant already holds the row, reject immediately with
   * `AbloClaimedError` instead of waiting (claim-or-skip). Use `false` for
   * work-distribution dedup ("if someone else has this job, skip it") where
   * waiting would mean double-processing.
   */
  wait?: boolean;
  /**
   * Backpressure: willing to queue, but not behind too many. If the server
   * reports `position >= maxQueueDepth` when we join the line, reject with
   * `AbloClaimedError('queue_too_deep')` instead of waiting. Omit to wait
   * however deep the queue is.
   */
  maxQueueDepth?: number;
}

/**
 * A claimed row: the entity's data plus an async-dispose hook, so
 *
 * ```ts
 * await ablo.weatherReports.claim('report_stockholm', async (report) => {
 *   await ablo.weatherReports.update(report.id, { status: 'ready' });
 * });
 * ```
 *
 * releases the claim when the callback returns or throws. Read it like any row
 * (`report.location`); write it through the flat `ablo.<model>.update(report.id, …)`
 * verb — there is no method chaining on the claim.
 */
export type ClaimedRow<T> = T & AsyncDisposable;

export interface ModelOperations<T, CreateInput> {
  /**
   * Retrieve a single entity by id from the local pool. Synchronous.
   * Returns `undefined` when the entity isn't loaded yet — use
   * `load({where: {id}})` if you want to lazy-hydrate from storage/network.
   *
   * Mirrors `stripe.customers.retrieve(id)`.
   */
  retrieve(id: string): T | undefined;

  /**
   * List entities matching a filter from the local pool. Synchronous.
   * No network round-trip — use `load()` for hydration.
   *
   * Mirrors `stripe.customers.list({...})`.
   */
  list(options?: ModelListOptions<T>): T[];

  /** Count entities matching a filter (synchronous, from local pool). */
  count(options?: ModelCountOptions<T>): number;

  /**
   * Create a new entity — **optimistic, offline-first**. Resolves once
   * the mutation is queued locally, not when the server confirms.
   * Server rejection rolls back automatically; watch `sync.syncStatus`.
   */
  create(data: CreateInput, options?: MutationOptions): Promise<T>;

  /** Update an entity by id — optimistic, offline-first (see `create`). */
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;

  /** Delete an entity by id — optimistic, offline-first (see `create`). */
  delete(id: string, options?: MutationOptions): Promise<void>;

  /**
   * Claim a row so other writers wait or are rejected until you're done.
   * Reads stay open by default. Prefer the callback form for ordinary held
   * work; it releases when the callback returns or throws. The `await using`
   * form is also available for wider lexical scopes.
   *
   * ```ts
   * await ablo.weatherReports.claim('report_stockholm', async (report) => {
   *   const weather = await getWeather(report.location);
   *   await ablo.weatherReports.update(report.id, { forecast: weather });
   * });
   * ```
   */
  claim(id: string, options?: ClaimOptions): Promise<ClaimedRow<T>>;
  claim<R>(
    id: string,
    work: (row: ClaimedRow<T>) => Promise<R> | R,
    options?: ClaimOptions,
  ): Promise<R>;

  /**
   * Read who's coordinating on a row — the current holder (who, phase,
   * until when), or `null` when free. Synchronous and reactive; for
   * observers/UI. Never blocks.
   */
  claimState(id: string): Intent | null;

  /**
   * The wait queue on a row — who's lined up behind the holder and what each
   * intends. Reactive snapshot (synced from the server, like `activity`);
   * returns a Stripe-style list envelope, FIFO order, empty when no one waits.
   *
   * ```ts
   * const { data } = ablo.decks.queue('deck_1');
   * // → [{ heldBy: 'agent:summarizer', action: 'editing', position: 0 }, …]
   * ```
   */
  queue(id: string): { readonly object: 'list'; readonly data: readonly Intent[] };

  /**
   * Re-rank the wait queue on a record — move waiters to the front in the
   * given order. Pass the `Intent[]` from `queue(id).data`, reordered. A
   * privileged operation: the server gates it (the caller needs the
   * `intent.reorder` capability), so it's fire-and-forget — the new order
   * arrives reactively through `queue(id)`.
   *
   * ```ts
   * const { data } = ablo.decks.queue('deck_1');
   * ablo.decks.reorder('deck_1', [data[2], data[0], data[1]]); // promote #2
   * ```
   */
  reorder(id: string, order: readonly Intent[]): void;

  /** Release a claim you hold early. Usually implicit (scope exit). */
  release(id: string): Promise<void>;

  /** Listen for changes (callback called on every change). */
  onChange(
    callback: (entities: T[]) => void,
    options?: ModelListOptions<T>,
  ): () => void;

  /**
   * Load matching rows into the local graph if they are not already
   * present. Single-flight: concurrent calls with the same args share
   * one in-flight request. Default `type: 'complete'` waits for the
   * server; `type: 'unknown'` returns local + refreshes async.
   */
  load(options?: ModelLoadOptions<T>): Promise<T[]>;
}

export function createModelProxy<T, C>(
  schemaKey: string,
  registeredModelName: string,
  objectPool: ObjectPool,
  syncClient: SyncClient,
  registry: ModelRegistry,
  hydration: HydrationCoordinator,
  collaboration?: ModelCollaboration<T>,
): ModelOperations<T, C> {
  const ModelClass = registry.getModelByName(registeredModelName);
  if (!ModelClass) {
    throw new AbloValidationError(
      `Ablo: schema model "${schemaKey}" resolved to "${registeredModelName}", ` +
        'but no matching constructor was registered.',
      { code: 'model_not_registered' },
    );
  }

  const load = async (options?: ModelLoadOptions<T>): Promise<T[]> => {
    const rows = await hydration.fetch<T>(schemaKey, options);
    // The coordinator returns Model instances. ModelOperations is
    // typed against the schema-inferred row shape (`T`), which is
    // structurally what the model exposes through its property
    // accessors — cast at the boundary.
    return rows as unknown as T[];
  };

  const waitForMutation = async (
    model: Model,
    options?: MutationOptions,
  ): Promise<void> => {
    if (options?.wait !== 'confirmed') return;
    await syncClient.syncNow();
    await syncClient.waitForConfirmation(model.getModelName(), model.id);
  };

  // Claims this proxy currently holds, keyed by entity id. Lets the flat
  // `release(id)` and `update(id)` find the lease + snapshot a `claim(id)`
  // took — no per-call handle. Released on dispose, explicit release, or TTL.
  const activeClaims = new Map<
    string,
    { lease: IntentLeaseHandle; snapshot: Snapshot }
  >();

  const releaseClaim = async (id: string): Promise<void> => {
    const held = activeClaims.get(id);
    if (!held) return;
    activeClaims.delete(id);
    await held.lease.release();
  };

  const takeClaim = async (
    id: string,
    options?: ClaimOptions,
  ): Promise<ClaimedRow<T>> => {
    if (!collaboration) {
      throw new AbloValidationError(
        `Model "${schemaKey}" cannot claim a row without collaboration wiring.`,
        { code: 'model_claim_not_configured' },
      );
    }
    // Is someone ELSE already on this target? Read the local coordination
    // snapshot up front — it decides whether we'll need to re-read after the
    // claim (a free / already-mine target can't have changed under us).
    const held = collaboration.observe({ model: schemaKey, id });
    const contended = !!held && held.heldBy !== collaboration.selfParticipantId;
    const failFast = options?.wait === false;

    // Fail-fast (`wait: false`): if another participant already holds it,
    // reject now instead of queuing. Best-effort at the client (a racing
    // claim not yet synced into our snapshot slips through here) — the
    // commit-time intent guard is the authoritative backstop that rejects
    // the loser's first write. For work-distribution dedup that's exactly
    // right: don't wait (that would double-process), skip.
    if (failFast && contended) {
      throw new AbloClaimedError(
        `${registeredModelName}/${id} is held by ${held?.heldBy ?? 'another participant'}.`,
        { code: 'entity_claimed' },
      );
    }

    // Ensure the row exists locally before claiming.
    let model = objectPool.get(id);
    if (!model) {
      await load({ where: { id } as unknown as LoadWhere<T> });
      model = objectPool.get(id);
    }
    if (!model) {
      throw new AbloValidationError(
        `Entity not found: ${registeredModelName}/${id}`,
        { code: 'entity_not_found' },
      );
    }

    // Acquire the lease. Default (`wait` !== false) goes through the server's
    // fair FIFO queue — `queue: true` resolves only once the lease is genuinely
    // ours, blocking behind any current holder, with no TOCTOU gap (the server
    // orders contenders). Fail-fast skips the queue: we already rejected an
    // observed conflict above, so this just records our lease.
    const lease = await collaboration.createIntent({
      target: {
        model: schemaKey,
        id,
        ...(options?.field ? { field: options.field } : {}),
      },
      action: options?.action ?? 'editing',
      ttl: options?.ttl,
      queue: !failFast,
      maxQueueDepth: options?.maxQueueDepth,
    });

    // Only when we actually waited behind another holder can the row have
    // changed underneath us — re-read so the claimed snapshot reflects what
    // they committed before releasing.
    if (contended && !failFast) {
      await load({ where: { id } as unknown as LoadWhere<T> });
      model = objectPool.get(id) ?? model;
    }

    const snapshot = collaboration.createSnapshot(schemaKey, id);
    activeClaims.set(id, { lease, snapshot });
    const row = modelAsRow<T>(model) as ClaimedRow<T>;
    // `await using` calls this on scope exit; releases the claim.
    Object.defineProperty(row, Symbol.asyncDispose, {
      value: () => releaseClaim(id),
      enumerable: false,
      configurable: true,
    });
    return row;
  };

  // Overloaded: scoped `await using` form, or callback form.
  function claim(id: string, options?: ClaimOptions): Promise<ClaimedRow<T>>;
  function claim<R>(
    id: string,
    work: (row: ClaimedRow<T>) => Promise<R> | R,
    options?: ClaimOptions,
  ): Promise<R>;
  function claim(
    id: string,
    a?: ClaimOptions | ((row: ClaimedRow<T>) => unknown),
    b?: ClaimOptions,
  ): Promise<unknown> {
    if (typeof a === 'function') {
      return (async () => {
        const row = await takeClaim(id, b);
        try {
          return await a(row);
        } finally {
          await releaseClaim(id);
        }
      })();
    }
    return takeClaim(id, a);
  }

  const operations: ModelOperations<T, C> = {
    retrieve(id: string): T | undefined {
      return objectPool.get(id) as T | undefined;
    },

    list(options): T[] {
      const all = objectPool.getByType(
        ModelClass,
        (options?.state ?? ModelScope.live) as ModelScope,
      ) as T[];
      let result = all;

      if (options?.where) {
        const where = options.where as Record<string, unknown>;
        result = result.filter((item) => {
          for (const [key, value] of Object.entries(where)) {
            if ((item as Record<string, unknown>)[key] !== value) return false;
          }
          return true;
        });
      }

      if (options?.filter) {
        result = result.filter(options.filter);
      }

      if (options?.orderBy) {
        const [field, dir] = Object.entries(options.orderBy)[0];
        result = [...result].sort((a, b) => {
          const av = (a as Record<string, unknown>)[field];
          const bv = (b as Record<string, unknown>)[field];
          if (av == null || bv == null) return 0;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }

      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);

      return result;
    },

    count(options): number {
      return this.list(options).length;
    },

    async create(data: C, options?: MutationOptions): Promise<T> {
      // TODO(options-persistence): stash `options` alongside the
      // queued transaction so idempotencyKey survives offline flush.
      const model = new ModelClass({
        id: Model.generateId(),
        ...(data as Record<string, unknown>),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      syncClient.add(model, options);
      await waitForMutation(model, options);
      return modelAsRow<T>(model);
    },

    async update(
      id: string,
      data: Partial<T>,
      options?: MutationOptions,
    ): Promise<T> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      // If we hold a claim on this row, guard the write with its snapshot
      // watermark + lease so it's stale-rejected and attributed to the claim.
      const claimed = activeClaims.get(id);
      const effective: MutationOptions | undefined = claimed
        ? {
            wait: 'confirmed',
            readAt: claimed.snapshot.stamp,
            onStale: 'reject',
            intent: claimed.lease,
            ...options,
          }
        : options;
      model.updateFromData(data as Record<string, unknown>);
      syncClient.update(model, effective);
      await waitForMutation(model, effective);
      return modelAsRow<T>(model);
    },

    async delete(id: string, options?: MutationOptions): Promise<void> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      syncClient.delete(model, options);
      await waitForMutation(model, options);
    },

    claim,

    claimState(id: string): Intent | null {
      return collaboration?.observe({ model: schemaKey, id }) ?? null;
    },

    queue(id: string): { readonly object: 'list'; readonly data: readonly Intent[] } {
      return {
        object: 'list',
        data: collaboration?.queue({ model: schemaKey, id }) ?? [],
      };
    },

    reorder(id: string, order: readonly Intent[]): void {
      collaboration?.reorder({ model: schemaKey, id }, order);
    },

    release(id: string): Promise<void> {
      return releaseClaim(id);
    },

    onChange(callback, options): () => void {
      return autorun(() => {
        const entities = this.list(options);
        callback(entities);
      });
    },

    load,
  };

  modelClientMeta.set(operations, {
    key: schemaKey,
    typename: registeredModelName,
  });

  return operations;
}
