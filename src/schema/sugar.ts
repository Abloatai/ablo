/**
 * A concise, claim-first way to declare a model. Each verb is shorthand for a
 * {@link model} call with two decisions already made, so a reader learns the two
 * facts that matter most about an entity before scanning its fields:
 *
 *   - Writability: `mutable.*` lets clients send create, update, and delete
 *     operations over the commit protocol. `readOnly.*` means the server owns the
 *     model — its changes stream to clients as deltas, but clients cannot mutate it.
 *   - Load strategy: `.instant` loads the model at bootstrap, `.lazy` loads it on
 *     first access, and `.manual` loads it only when you query it explicitly.
 *
 * The two-token form (`mutable.lazy({...})`) states the safety claim in the first
 * token and the load shape in the second. The plain {@link model} factory remains
 * available; these verbs are a convenience layered over it.
 *
 * @example
 * ```ts
 * tasks: mutable.lazy({ title: z.string() }, {
 *   typename: 'Task', tableName: 'tasks',
 *   relations: { ... },
 *   computed: tasksComputed,
 * }),
 * ```
 */

import type { z } from 'zod';
import {
  model,
  type ModelDef,
  type ModelOptions,
  type ComputedRecord,
  type RelationRecord,
} from '../transaction/schema/model.js';

/**
 * Options accepted by every sugar verb. A strict subset of
 * {@link ModelOptions} — anything the verb infers (`mutable`, `load`,
 * `lazyObservable`) is deliberately absent so the call site can't
 * contradict its verb.
 */
export interface SugarOptions<
  R extends RelationRecord = RelationRecord,
  C extends ComputedRecord = ComputedRecord,
> {
  /** Relations to other models. Same shape as `model()`'s second arg. */
  relations?: R;
  /** Computed getters installed on the model class prototype. */
  computed?: C;
  /**
   * Wire `__typename` (PascalCase, e.g. `'Task'`). Defaults to the schema
   * key via `defineSchema` — override when the wire shape differs from
   * the camelCase schema key.
   */
  typename?: string;
  /**
   * The physical table name. Override it when the table name differs from the
   * snake_case of the typename — for example, a `Member` type stored in a table
   * named `'member'` rather than `'members'`.
   */
  tableName?: string;
  /**
   * The row-access policy for tenant isolation — the rule deciding who may read a
   * row. A discriminated union on `by` (`column`, `parent`, or `none`). See
   * {@link ModelOptions.policy}.
   */
  policy?: ModelOptions['policy'];
  /**
   * Sync-group routing — which delta *channels* a row fans into
   * (`root` / `grants` / `roles`). See {@link ModelOptions.groups}.
   */
  groups?: ModelOptions['groups'];
  /** Max rows loaded during bootstrap. Only applies to `.instant`. */
  bootstrapLimit?: number;
  /** Bootstrap sort order (e.g. `'created_at DESC'`). */
  bootstrapOrderBy?: string;
  /** IndexedDB persistence hints — see {@link ModelOptions.persist}. */
  persist?: ModelOptions['persist'];
  /**
   * Defer MobX observability to first access. Override the verb's
   * default when a `.lazy` model is small enough that eager MobX setup
   * is fine, or a `.instant` model is hot enough to justify deferral.
   */
  lazyObservable?: boolean;
}

/** Internal helper — builds a ModelDef with baseline safety+load flags applied. */
function build<
  Shape extends z.ZodRawShape,
  R extends RelationRecord,
  C extends ComputedRecord,
>(
  shape: Shape,
  opts: SugarOptions<R, C> | undefined,
  baseline: Pick<ModelOptions, 'mutable' | 'load' | 'lazyObservable'>,
): ModelDef<Shape, R, C> {
  return model(shape, { relations: (opts?.relations ?? {}) as R, mutable: baseline.mutable,
    load: baseline.load,
    lazyObservable: opts?.lazyObservable ?? baseline.lazyObservable,
    typename: opts?.typename,
    tableName: opts?.tableName,
    policy: opts?.policy,
    groups: opts?.groups,
    bootstrapLimit: opts?.bootstrapLimit,
    bootstrapOrderBy: opts?.bootstrapOrderBy,
    persist: opts?.persist,
    computed: opts?.computed, });
}

/**
 * Client-writable entities. `mutable.*` is the opt-in signal for wire
 * mutations via `commit` — equivalent to setting
 * `{ mutable: true, load: X }` on `model()`.
 *
 * Pick the load suffix by data-access pattern:
 *   - `.instant`  — small, always-needed (Theme, Layout, StatusGroup)
 *   - `.lazy`     — large collections fetched on first query
 *     (Block, Message, Task)
 */
export const mutable = {
  instant: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    // Reactive by default (see readonly.instant note): opt out with
    // `lazyObservable: false` only for very large read-only list models.
    build(shape, opts, { mutable: true, load: 'instant', lazyObservable: true }),

  lazy: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: true, load: 'lazy', lazyObservable: true }),
};

/**
 * Server-managed entities. `readOnly.*` means clients subscribe to
 * deltas but cannot emit mutations — any `commit` op for this model
 * is rejected at the server with "Unknown model."
 *
 * Use for:
 *   - Server-written state: `sync_deltas`, `presence`, version vectors
 *   - Ingestion pipelines: digest entries, filing jobs
 *   - Audit surfaces: anything where clients watch but only the server
 *     writes
 */
export const readOnly = {
  instant: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    // Reactive by default, like every variant: a remote delta that mutates a row
    // in place must re-render reactive reads. Opt out per-model with
    // `lazyObservable: false` for very large read-only lists where per-field
    // atoms cost more than the QueryView's entry-replaced reactivity.
    build(shape, opts, { mutable: false, load: 'instant', lazyObservable: true }),

  lazy: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: false, load: 'lazy', lazyObservable: true }),

  /**
   * Internal-only: kept out of bootstrap and never written by clients. The
   * strongest safety posture — use for tables the SDK must know about (for type
   * inference) but that no client should be able to write. Rows still reach a
   * client that reads the model, so this is a write boundary, not a read one.
   */
  internal: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: false, load: 'lazy', lazyObservable: true }),
};
