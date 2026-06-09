/**
 * Per-model client factory.
 *
 * Mirrors Anthropic SDK's per-endpoint module pattern: each model client
 * has its own file, and the root client just instantiates
 * one per model. Extracted from `Ablo.ts` so the proxy logic is
 * testable in isolation and the constructor doesn't carry it.
 *
 * Each schema model gets one `ModelOperations<T, CreateInput>` —
 * exposes the async server reads `retrieve` / `list`, the synchronous
 * local-graph snapshots `get` / `getAll` / `getCount`, the writes
 * `create` / `update` / `delete`, the coordination namespace `claim`
 * (`claim({ id })` plus `claim.state` / `claim.queue` / `claim.release` /
 * `claim.reorder`), and `onChange`. The factory returns a plain object; the
 * client assembles the `ablo.<model>` lookup table from these.
 */

import { autorun } from 'mobx';
import {
  AbloClaimedError,
  AbloStaleContextError,
  AbloValidationError,
  toAbloError,
} from '../errors.js';
import type { MutationOptions } from '../interfaces/index.js';
import { Model, modelAsRow } from '../Model.js';
import { assertWriteOptions } from './writeOptionsSchema.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { ObjectPool } from '../ObjectPool.js';
import type { SyncClient } from '../SyncClient.js';
import type { HydrationCoordinator } from '../sync/HydrationCoordinator.js';
import type { LoadWhere } from '../query/types.js';
import { ModelScope } from '../types/index.js';
import type {
  Duration,
  Intent,
  IntentWaitOptions,
  Snapshot,
  TargetRange,
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
   * `list()` calls and union — the wire protocol is AND-only.
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

/** Options for the single-row async server read `retrieve({ id })`. A subset of
 *  {@link ModelLoadOptions} — `where`/`limit`/`orderBy` are fixed by the id. */
export type ModelRetrieveOptions = Pick<ModelLoadOptions<unknown>, 'type' | 'expand'>;

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
      path?: string;
      range?: TargetRange;
      meta?: Record<string, unknown>;
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

export interface ClaimTargetOptions<T = Record<string, unknown>> {
  /** Phase shown to observers while held. Defaults to `'editing'`. */
  action?: string;
  /** Peer-visible explanation of the work being performed. */
  description?: string;
  /** Field-level target, for fine-grained claimed-state badges. */
  field?: string;
  /** Optional path for document/file-like targets. */
  path?: string;
  /** Optional range for document/file-like targets. */
  range?: TargetRange;
  /** App-defined structured metadata. */
  meta?: Record<string, unknown>;
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

/** Options for `claim({ id, ... })`. */
export interface ClaimParams<T = Record<string, unknown>>
  extends ClaimTargetOptions<T> {
  readonly id: string;
}

export interface ClaimLookupParams<T = Record<string, unknown>> {
  readonly id: string;
  readonly field?: string;
}

export interface ClaimReorderParams<T = Record<string, unknown>>
  extends ClaimLookupParams<T> {
  readonly order: readonly Intent[];
}

/**
 * A claim handle: the held entity data plus an explicit release hook, so
 *
 * ```ts
 * const claim = await ablo.weatherReports.claim({
 *   id: 'report_stockholm',
 *   action: 'forecasting',
 *   description: 'Fetching current weather before writing the forecast.',
 * });
 * try {
 *   await ablo.weatherReports.update({
 *     id: claim.target.id,
 *     data: { status: 'ready' },
 *     claim,
 *   });
 * } finally {
 *   await claim.release();
 * }
 * ```
 *
 * `data` is a snapshot taken after the lease is held. Write through the flat
 * `ablo.<model>.update({ id, data, claim })` verb — the handle carries the
 * lease id and snapshot watermark for attribution + stale protection.
 */
export interface ClaimHandle<T = Record<string, unknown>> extends AsyncDisposable {
  readonly object: 'claim';
  readonly claimId: string;
  /**
   * Sync watermark of the held snapshot (`data` was read at this stamp).
   * Writes that carry the handle — `update({ id, data, claim })` or
   * `commits.create({ claim, ... })` — use it as the `readAt` stale guard,
   * so a concurrent commit between snapshot and write is rejected instead
   * of clobbered. Optional for wire/duck-type compat with externally
   * constructed handles.
   */
  readonly readAt?: number;
  readonly target: {
    readonly model: string;
    readonly id: string;
    readonly field?: string;
    readonly path?: string;
    readonly range?: TargetRange;
    readonly meta?: Record<string, unknown>;
  };
  readonly action: string;
  readonly description?: string;
  readonly data: T;
  release(): Promise<void>;
  revoke(): void;
}

export type ClaimOptions<T = Record<string, unknown>> = ClaimTargetOptions<T>;

/**
 * The coordination surface for a model, exposed as a callable namespace.
 *
 * Most callers do not need this namespace directly. Put `claim: { ... }` on a
 * write and the SDK acquires/releases around that one mutation:
 *
 * ```ts
 * await ablo.tasks.update({
 *   id,
 *   data: { title },
 *   claim: {
 *     field: 'title',
 *     action: 'renaming',
 *     description: 'Renaming the task to match the project brief.',
 *   },
 * });
 * ```
 *
 * Use `claim({ id, ... })` when a tool spans multiple writes and needs one
 * handle. `state`, `queue`, and `reorder` are coordination reads/scheduler
 * controls for UI and operators.
 */
export interface ClaimApi<T> {
  /** Take a claim and get an explicit held-work handle back. */
  (params: ClaimParams<T>): Promise<ClaimHandle<T>>;

  /**
   * Current holder for a row, or `null` when free. Use this for UI badges and
   * preflight checks, not for the normal write path.
   */
  state(params: ClaimLookupParams<T>): Intent | null;

  /**
   * FIFO wait line behind the current holder. Advanced: useful for operator
   * UIs and schedulers.
   */
  queue(params: ClaimLookupParams<T>): { readonly object: 'list'; readonly data: readonly Intent[] };

  /**
   * Re-rank the wait line. Advanced and permission-gated.
   */
  reorder(params: ClaimReorderParams<T>): void;

  /** Release a manual claim handle early. Single-write claims auto-release. */
  release(params: ClaimLookupParams<T> | ClaimHandle<T>): Promise<void>;
}

export interface ModelRetrieveParams extends ModelRetrieveOptions {
  readonly id: string;
}

export interface ModelCreateParams<T, CreateInput>
  extends MutationOptions {
  readonly data: CreateInput;
  readonly id?: string | null;
  readonly claim?: ClaimHandle<T> | ClaimTargetOptions<T> | null;
}

export interface ModelUpdateParams<T>
  extends MutationOptions {
  readonly id: string;
  readonly data: Partial<T>;
  readonly claim?: ClaimHandle<T> | ClaimTargetOptions<T> | null;
}

export interface ModelDeleteParams<T>
  extends MutationOptions {
  readonly id: string;
  readonly claim?: ClaimHandle<T> | ClaimTargetOptions<T> | null;
}

export interface ModelOperations<T, CreateInput> {
  /**
   * Read a single entity by id from the **server** — async. Resolves through
   * the 3-tier lookup (local pool → IndexedDB → network `POST /sync/query`)
   * and lands the row in the local graph. Resolves to `undefined` when no
   * such row exists.
   *
   * This is the default "get me this entity" read and the one hosted /
   * stateless callers want, since their local graph starts empty. For a
   * synchronous read of an already-warm graph (a React selector) use
   * `get(id)`.
   *
   * Mirrors `stripe.customers.retrieve({ id })` — network-backed.
   */
  retrieve(params: ModelRetrieveParams): Promise<T | undefined>;

  /**
   * List entities matching a filter from the **server** — async. Same 3-tier
   * lookup + graph hydration as `retrieve`; single-flight deduped. Returns the
   * matched rows.
   *
   * Mirrors `stripe.customers.list({...})` — network-backed. For a synchronous
   * read of the local graph use `getAll(...)`.
   */
  list(options?: ModelLoadOptions<T>): Promise<T[]>;

  /**
   * Synchronous snapshot of a single entity from the **local graph** — no
   * network. Returns `undefined` when the row isn't resident (cold hosted
   * client, or a `lazy` model not yet loaded). Pairs with reactive selectors:
   * `useAblo((ablo) => ablo.<model>.get(id))`.
   */
  get(id: string): T | undefined;

  /**
   * Synchronous snapshot of a filtered collection from the **local graph** —
   * no network round-trip. Empty until `retrieve`/`list`/bootstrap has warmed
   * the graph.
   */
  getAll(options?: ModelListOptions<T>): T[];

  /** Count entities in the **local graph** (synchronous, no network). */
  getCount(options?: ModelCountOptions<T>): number;

  /**
   * Create a new entity — **optimistic, offline-first**. Resolves once
   * the mutation is queued locally, not when the server confirms.
   * Server rejection rolls back automatically; watch `sync.syncStatus`.
   */
  create(params: ModelCreateParams<T, CreateInput>): Promise<T>;

  /** Update an entity by id — optimistic, offline-first (see `create`). */
  update(params: ModelUpdateParams<T>): Promise<T>;

  /** Delete an entity by id — optimistic, offline-first (see `create`). */
  delete(params: ModelDeleteParams<T>): Promise<void>;

  /**
   * Claim a row so other writers wait or are rejected until you're done, and
   * inspect or manage that coordination through the same namespace. Call it to
   * take a claim handle; reach for its members to observe and steer the wait line:
   *
   * - `claim.state({ id })` — who holds the row now, or `null` when free
   * - `claim.queue({ id })` — who's lined up behind the holder
   * - `claim.release({ id })` — drop a claim early (usually implicit on scope exit)
   * - `claim.reorder({ id, order })` — re-rank the wait line
   *
   * ```ts
   * const claim = await ablo.weatherReports.claim({
   *   id: 'report_stockholm',
   *   action: 'forecasting',
   *   description: 'Fetching fresh weather before updating the report.',
   * });
   * const weather = await getWeather(claim.data.location);
   * await ablo.weatherReports.update({
   *   id: claim.target.id,
   *   data: { forecast: weather },
   *   claim,
   * });
   * await claim.release();
   *
   * const holder = ablo.weatherReports.claim.state({ id: 'report_stockholm' });
   * ```
   */
  claim: ClaimApi<T>;

  /** Listen for changes (callback called on every change). */
  onChange(
    callback: (entities: T[]) => void,
    options?: ModelListOptions<T>,
  ): () => void;

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

  // Last-line guarantee for the public surface: any rejection from a lower
  // layer (transport timeout, IndexedDB failure, a third-party throw) is
  // coerced to an AbloError before it reaches the consumer. The SDK's
  // contract is that callers only ever catch tagged errors — `instanceof
  // AbloError` / `e.type` always hold. Internal helpers stay unwrapped; only
  // the methods exposed on `operations` are guarded.
  const guard = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        throw toAbloError(err);
      }
    };
  };

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
  // `release({ id })` and `update({ id, data })` find the lease + snapshot a `claim({ id })`
  // took — no per-call handle. Released on dispose, explicit release, or TTL.
  const activeClaims = new Map<
    string,
    { lease: IntentLeaseHandle; snapshot: Snapshot }
  >();

  const isClaimHandle = (value: unknown): value is ClaimHandle<T> =>
    typeof value === 'object' &&
    value !== null &&
    (value as { object?: unknown }).object === 'claim' &&
    typeof (value as { claimId?: unknown }).claimId === 'string' &&
    typeof (value as { release?: unknown }).release === 'function';

  const claimMeta = (
    options: ClaimTargetOptions<T> | undefined,
  ): Record<string, unknown> | undefined => {
    if (!options?.description) return options?.meta;
    return { ...(options.meta ?? {}), description: options.description };
  };

  const mutationOptions = (
    params:
      | ModelCreateParams<T, C>
      | ModelUpdateParams<T>
      | ModelDeleteParams<T>,
  ): MutationOptions => {
    const { id: _id, data: _data, claim: _claim, ...rest } =
      params as unknown as Record<string, unknown>;
    // THE write-options schema — runtime twin of the compile-time params.
    // Catches plain-JS callers (`onStale: 'rejct'`) at the call site with
    // a typed error instead of a silent no-op or a server 400.
    assertWriteOptions(rest, `${schemaKey} write`);
    return rest as MutationOptions;
  };

  const releaseClaim = async (id: string): Promise<void> => {
    const held = activeClaims.get(id);
    if (!held) return;
    activeClaims.delete(id);
    await held.lease.release();
  };

  const takeClaim = async (
    params: ClaimParams<T>,
  ): Promise<ClaimHandle<T>> => {
    if (!collaboration) {
      throw new AbloValidationError(
        `Model "${schemaKey}" cannot claim a row without collaboration wiring.`,
        { code: 'model_claim_not_configured' },
      );
    }
    const { id, ...options } = params;
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
        ...(options?.path ? { path: options.path } : {}),
        ...(options?.range ? { range: options.range } : {}),
        ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
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
    const target = {
      model: schemaKey,
      id,
      ...(options?.field ? { field: options.field } : {}),
      ...(options?.path ? { path: options.path } : {}),
      ...(options?.range ? { range: options.range } : {}),
      ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
    };
    const release = () => releaseClaim(id);
    return {
      object: 'claim',
      claimId: lease.id,
      readAt: snapshot.stamp,
      target,
      action: options?.action ?? 'editing',
      ...(options?.description ? { description: options.description } : {}),
      data: modelAsRow<T>(model),
      release,
      revoke: () => {
        void release();
      },
      [Symbol.asyncDispose]: release,
    };
  };

  const claim = (params: ClaimParams<T>): Promise<ClaimHandle<T>> =>
    takeClaim(params);

  // `claim` is a callable namespace: invoke it to take a claim, reach its
  // members to read/steer the coordination plane. Attach the readers to the
  // guarded callable so `ablo.<model>.claim(...)` and `ablo.<model>.claim.state(...)`
  // are the same object.
  const claimApi: ClaimApi<T> = Object.assign(guard(claim) as typeof claim, {
    state(params: ClaimLookupParams<T>): Intent | null {
      return collaboration?.observe({ model: schemaKey, id: params.id }) ?? null;
    },

    queue(params: ClaimLookupParams<T>): { readonly object: 'list'; readonly data: readonly Intent[] } {
      return {
        object: 'list',
        data: collaboration?.queue({ model: schemaKey, id: params.id }) ?? [],
      };
    },

    reorder(params: ClaimReorderParams<T>): void {
      collaboration?.reorder({ model: schemaKey, id: params.id }, params.order);
    },

    release: guard((params: ClaimLookupParams<T> | ClaimHandle<T>): Promise<void> =>
      releaseClaim(isClaimHandle(params) ? params.target.id : params.id),
    ),
  });

  const operations: ModelOperations<T, C> = {
    retrieve: guard(
      async (params: ModelRetrieveParams): Promise<T | undefined> => {
        const rows = await load({
          ...params,
          where: { id: params.id } as unknown as LoadWhere<T>,
          limit: 1,
        });
        return rows[0];
      },
    ),

    list: guard(load),

    get(id: string): T | undefined {
      return objectPool.get(id) as T | undefined;
    },

    getAll(options): T[] {
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

    getCount(options): number {
      return this.getAll(options).length;
    },

    create: guard(async (params: ModelCreateParams<T, C>): Promise<T> => {
      const id = params.id ?? Model.generateId();
      const opts = mutationOptions(params);
      const claim = params.claim;
      let autoLease: IntentLeaseHandle | undefined;
      if (claim && !isClaimHandle(claim)) {
        if (!collaboration) {
          throw new AbloValidationError(
            `Model "${schemaKey}" cannot claim a row without collaboration wiring.`,
            { code: 'model_claim_not_configured' },
          );
        }
        autoLease = await collaboration.createIntent({
          target: {
            model: schemaKey,
            id,
            ...(claim.field ? { field: claim.field } : {}),
            ...(claim.path ? { path: claim.path } : {}),
            ...(claim.range ? { range: claim.range } : {}),
            ...(claimMeta(claim) ? { meta: claimMeta(claim) } : {}),
          },
          action: claim.action ?? 'creating',
          ttl: claim.ttl,
          queue: claim.wait !== false,
          maxQueueDepth: claim.maxQueueDepth,
        });
      }

      // Default `organizationId` from the client's identity exactly like the
      // mutator path (`buildModelForCreate`) — without this, a caller that
      // omits it creates an org-unscoped row on one write door but not the
      // other. An explicit value in `data` still wins via the spread.
      const orgDefault =
        (params.data as Record<string, unknown>).organizationId ??
        syncClient.getOrganizationId();
      const model = new ModelClass({
        id,
        ...(orgDefault != null ? { organizationId: orgDefault } : {}),
        ...(params.data as Record<string, unknown>),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const effective: MutationOptions = {
        ...opts,
        ...(autoLease ? { intent: autoLease } : {}),
        ...(isClaimHandle(claim) ? { intent: { id: claim.claimId } } : {}),
      };
      try {
        syncClient.add(model, effective);
        await waitForMutation(model, effective);
        return modelAsRow<T>(model);
      } finally {
        await autoLease?.release().catch(() => {});
      }
    }),

    update: guard(
      async (params: ModelUpdateParams<T>): Promise<T> => {
        const autoClaim =
          params.claim && !isClaimHandle(params.claim) ? params.claim : null;
        if (autoClaim) {
          const handle = await takeClaim({ ...autoClaim, id: params.id });
          try {
            return await operations.update({ ...params, claim: handle });
          } finally {
            await handle.release();
          }
        }
        const { id } = params;
        const model = objectPool.get(id);
        if (!model)
          throw new AbloValidationError(
            `Entity not found: ${registeredModelName}/${id}`,
            { code: 'entity_not_found' },
          );
        // If we hold a claim on this row, guard the write with its snapshot
        // watermark + lease so it's stale-rejected and attributed to the claim.
        const claimed = activeClaims.get(id);
        const opts = mutationOptions(params);
        const handle = isClaimHandle(params.claim) ? params.claim : undefined;
        const effective: MutationOptions | undefined = claimed
          ? {
              wait: 'confirmed',
              readAt: claimed.snapshot.stamp,
              onStale: 'reject',
              intent: claimed.lease,
              ...opts,
            }
          : {
              // A carried handle engages the same stale guard as a claim this
              // proxy took itself — the watermark rides on the handle, so it
              // works across clients (HTTP-minted handles included).
              ...(handle?.readAt !== undefined
                ? {
                    wait: 'confirmed' as const,
                    readAt: handle.readAt,
                    onStale: 'reject' as const,
                  }
                : {}),
              ...opts,
              ...(handle ? { intent: { id: handle.claimId } } : {}),
            };
        // Local user update: `applyChanges` keeps change tracking ON so
        // the edited fields land in `modifiedProperties` and actually get
        // sent to the server. (`updateFromData` is the hydration path and
        // would discard the tracking → empty `input: {}` no-op mutation.)
        model.applyChanges(params.data as Record<string, unknown>);
        syncClient.update(model, effective);
        await waitForMutation(model, effective);
        return modelAsRow<T>(model);
      },
    ),

    delete: guard(async (params: ModelDeleteParams<T>): Promise<void> => {
      const autoClaim =
        params.claim && !isClaimHandle(params.claim) ? params.claim : null;
      if (autoClaim) {
        const handle = await takeClaim({ ...autoClaim, id: params.id });
        try {
          await operations.delete({ ...params, claim: handle });
        } finally {
          await handle.release();
        }
        return;
      }
      const { id } = params;
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      const claimed = activeClaims.get(id);
      const opts = mutationOptions(params);
      const handle = isClaimHandle(params.claim) ? params.claim : undefined;
      const effective: MutationOptions | undefined = claimed
        ? {
            wait: 'confirmed',
            readAt: claimed.snapshot.stamp,
            onStale: 'reject',
            intent: claimed.lease,
            ...opts,
          }
        : {
            ...(handle?.readAt !== undefined
              ? {
                  wait: 'confirmed' as const,
                  readAt: handle.readAt,
                  onStale: 'reject' as const,
                }
              : {}),
            ...opts,
            ...(handle ? { intent: { id: handle.claimId } } : {}),
          };
      syncClient.delete(model, effective);
      await waitForMutation(model, effective);
    }),

    // `claim` is a callable namespace (take a claim) carrying the coordination
    // readers (`claim.state` / `claim.queue` / `claim.release` / `claim.reorder`).
    claim: claimApi,

    onChange(callback, options): () => void {
      return autorun(() => {
        const entities = this.getAll(options);
        callback(entities);
      });
    },
  };

  modelClientMeta.set(operations, {
    key: schemaKey,
    typename: registeredModelName,
  });

  return operations;
}
