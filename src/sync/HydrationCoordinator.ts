/**
 * HydrationCoordinator — the lazy-load lane of the sync engine.
 *
 * Bridges "I need this entity but bootstrap didn't fetch it" → pool
 * hydration. Replaces the per-app loader files (documentLoaders,
 * slideLayerLoaders, layoutLoaders, ensureVaultFiles, ensureDataroomFiles)
 * with one engine-level path.
 *
 * Lookup order on `fetch(modelName, where)`:
 *   1. ObjectPool — if rows already match the where, return them (cheap).
 *   2. IndexedDB — if matching rows exist locally, hydrate pool, return.
 *   3. Network — `postQuery` against `/sync/query`, hydrate pool + IDB.
 *
 * Single-flight dedup: concurrent calls with the same query key share
 * one in-flight promise. Prevents the loader anti-pattern where N
 * components mount and fire N identical hydrations on first paint.
 *
 * The coordinator does NOT replace bootstrap (full sync of `instant`
 * models) or live deltas (WS push). It only fills the gap for `lazy`
 * models accessed by id/where after the engine is ready.
 */

import type { ObjectPool } from '../ObjectPool.js';
import { ModelScope } from '../ObjectPool.js';
import type { Database } from '../Database.js';
import type { Model } from '../Model.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import { postQuery } from '../query/client.js';
import type { LoadWhere, Query, WhereClause, WhereOp, WherePrimitive } from '../query/types.js';
import type { Schema } from '../schema/schema.js';

export interface HydrationCoordinatorOptions {
  readonly objectPool: ObjectPool;
  readonly database: Database;
  readonly registry: ModelRegistry;
  readonly schema: Schema;
  /** Bootstrap base URL (without trailing slash), e.g. `https://api.example.com/api`. */
  readonly baseUrl: string;
  /**
   * Lazy getter for the active capability token. Resolved per-request
   * so cap refreshes propagate without re-instantiating the coordinator.
   * Optional: browser consumers ride session cookies and can omit this;
   * Node consumers (agent-worker) must wire it through or HTTP queries
   * fail with 401 because cookies aren't available.
   */
  readonly getCapabilityToken?: () => string | null;
}

export interface FetchOptions<T> {
  /**
   * Filter clauses for the lookup. Accepts either the equality-object
   * form (`{ id: 'abc' }` → `WHERE id = 'abc'`, array values → `IN`)
   * or the explicit tuple form (`[['name', 'ILIKE', '%Goldman%']]`)
   * matching the wire `WhereClause[]` 1:1. Multiple entries AND
   * together. See `LoadWhere` in `../query/types.ts` for the full shape.
   */
  readonly where?: LoadWhere<T>;
  readonly orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  readonly limit?: number;
  /**
   * `'complete'` (default): wait for network round-trip even if local
   * data exists, so the caller observes server-confirmed state.
   * `'unknown'`: return whatever's in the pool/IDB immediately and
   * fire the network in the background.
   */
  readonly type?: 'complete' | 'unknown';
  /**
   * Schema-declared relation names to hydrate alongside the primary
   * rows. Each related entity is hydrated into its own typed pool
   * via the same path as the primary fetch (network → pool + IDB).
   */
  readonly expand?: readonly string[];
}

/** Equality-object shape accepted on input. Mixed with tuple form via `LoadWhere`. */
type WhereLike = Record<string, unknown>;

export class HydrationCoordinator {
  private readonly inFlight = new Map<string, Promise<Model[]>>();
  private capabilityTokenProvider: (() => string | null) | null = null;

  constructor(private readonly opts: HydrationCoordinatorOptions) {
    this.capabilityTokenProvider = opts.getCapabilityToken ?? null;
  }

  /**
   * Late-bind the capability token getter. Used by `Ablo.ts` to wire
   * the token closure after the coordinator is constructed (the token
   * isn't known until auth resolves, which happens after component
   * construction). Browser consumers ride session cookies and don't
   * need this; Node consumers (agent-worker) MUST call it or HTTP
   * queries fail with 401 because cookies aren't available.
   */
  setCapabilityTokenProvider(provider: () => string | null): void {
    this.capabilityTokenProvider = provider;
  }

  private resolveToken(): string | undefined {
    return this.capabilityTokenProvider?.() ?? undefined;
  }

  /**
   * Fetch matching rows for a model, hydrating the pool from IDB or
   * network if not already present. Idempotent and single-flight
   * deduped on the (modelName, where, orderBy, limit) tuple.
   */
  async fetch<T>(
    modelName: string,
    options?: FetchOptions<T>,
  ): Promise<Model[]> {
    const typename = this.resolveTypename(modelName);
    const ModelClass = this.opts.registry.getModelByName(typename)
      ?? this.opts.registry.getModelByName(modelName);
    if (!ModelClass) {
      throw new Error(
        `HydrationCoordinator.fetch: unknown model "${modelName}" — ` +
          `not registered in the schema.`,
      );
    }

    const clauses = normalizeWhere(options?.where);
    const queryKey = stableKey(modelName, clauses, options?.orderBy, options?.limit);

    // Single-flight: an identical hydration is already in flight.
    const inFlight = this.inFlight.get(queryKey);
    if (inFlight) return inFlight;

    const work = this.runFetch(modelName, typename, ModelClass, clauses, options);
    this.inFlight.set(queryKey, work);
    work.finally(() => {
      this.inFlight.delete(queryKey);
    });
    return work;
  }

  private async runFetch(
    modelName: string,
    typename: string,
    ModelClass: typeof Model,
    clauses: readonly WhereClause[],
    options: FetchOptions<unknown> | undefined,
  ): Promise<Model[]> {
    const wantsComplete = (options?.type ?? 'complete') === 'complete';

    // Step 1 — pool hit. Skip when caller asked for complete:
    // they want server-confirmed state, not a stale pool snapshot.
    if (!wantsComplete) {
      const fromPool = scanPool<Model>(this.opts.objectPool, ModelClass, clauses);
      if (fromPool.length > 0) return applyLimit(fromPool, options?.limit);
    }

    // Step 2 — IndexedDB. Survives reload + offline.
    const fromIdb = await scanIdb(this.opts.database, typename, clauses);
    const idbModels = fromIdb
      .map((raw) => this.hydrateOne(raw, typename))
      .filter((m): m is Model => m !== null);
    if (idbModels.length > 0) {
      this.opts.objectPool.addBatch(idbModels, ModelScope.live);
      if (!wantsComplete) return applyLimit(idbModels, options?.limit);
    }

    // Step 3 — network. Last resort. Always runs when wantsComplete.
    const networkRows = await this.queryNetwork(modelName, clauses, options);
    const networkModels = networkRows
      .map((raw) => this.hydrateOne(raw, typename))
      .filter((m): m is Model => m !== null);

    if (networkModels.length > 0) {
      this.opts.objectPool.addBatch(networkModels, ModelScope.live);
      // Background IDB write — don't block the caller.
      void this.persistToIdb(modelName, networkRows);
    }

    return applyLimit(networkModels.length > 0 ? networkModels : idbModels, options?.limit);
  }

  private hydrateOne(raw: unknown, typename?: string): Model | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== 'string') return null;
    if (this.opts.objectPool.has(obj.id)) {
      // Pool already has this entity, but the row coming from the
      // network is the freshest server-confirmed state. Apply the new
      // fields onto the existing instance instead of returning the
      // stale model verbatim — otherwise a `load()` that re-fetches
      // after a missed delta (WS dropped, tab slept, redeploy) silently
      // discards the fresh state and the consumer keeps seeing the
      // birth-time snapshot forever. `updateFromData` is the same
      // primitive `ObjectPool.upsert()` uses for delta application,
      // so the behaviour matches "delta-applied" semantics exactly.
      const existing = this.opts.objectPool.get(obj.id);
      if (existing) {
        const stamped = this.stampTypename(obj, typename) as Record<string, unknown>;
        existing.updateFromData(stamped as never);
        return existing;
      }
      return null;
    }
    // Stamp the known relation typename onto the row when the source
    // (IndexedDB rows, sometimes network rows) didn't carry one. Without
    // this, ObjectPool.createFromData falls through to the 'Unknown'
    // model-name branch and emits the
    // "ObjectPool.createFromData: No model identifier found" warning,
    // failing to hydrate the entity from cache (network path then has to
    // re-populate it). The typename comes from the schema relation
    // (`'SlideLayer'`, `'SlideLayoutLayer'`, etc.) so no guessing involved.
    const stamped = this.stampTypename(obj, typename) as Record<string, unknown>;
    return this.opts.objectPool.createFromData(stamped);
  }

  /**
   * Stamp `__typename` onto a row when it's known (from the schema's
   * relation target). Strips the mangled `_Typename` key the
   * `postgres.camel` driver leaves behind when the server's SQL
   * bakes `__typename` into a JSONB literal — the driver's
   * snake↔camel transform misreads `__typename` as `_typename` with
   * a leading underscore and produces `_Typename`. ObjectPool only
   * recognises `__typename`, so without this step nested rows fall
   * through to the 'Unknown' branch and never instantiate.
   */
  private stampTypename(item: unknown, typename: string | undefined): unknown {
    if (!item || typeof item !== 'object' || !typename) return item;
    const obj = item as Record<string, unknown>;
    if (obj.__typename === typename) return obj;
    const { _Typename: _drop, ...rest } = obj as Record<string, unknown> & { _Typename?: unknown };
    void _drop;
    return { __typename: typename, ...rest };
  }

  private async queryNetwork(
    modelName: string,
    clauses: readonly WhereClause[],
    options: FetchOptions<unknown> | undefined,
  ): Promise<unknown[]> {
    const typename = this.resolveTypename(modelName);
    const orderEntries = options?.orderBy ? Object.entries(options.orderBy) : [];
    const firstOrder = orderEntries[0];
    const query: Query = {
      model: typename,
      where: clauses.map((c) => this.columnizeClause(modelName, c)),
      ...(firstOrder
        ? {
            orderBy: this.columnizeField(modelName, firstOrder[0]),
            order: (firstOrder[1] as 'asc' | 'desc') ?? 'asc',
          }
        : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      ...(options?.expand && options.expand.length > 0
        ? { related: options.expand }
        : {}),
    };
    const result = await postQuery(
      {
        baseUrl: this.opts.baseUrl,
        capabilityToken: this.resolveToken(),
      },
      { queries: [query] },
    );
    const rows = Array.isArray(result.results[0]) ? result.results[0] : [];
    // Normalize: wire rows lack `__typename` when the server elides it.
    const normalized = rows.map((row) => {
      if (row && typeof row === 'object' && !('__typename' in row)) {
        return { __typename: typename, ...(row as object) };
      }
      return row;
    });

    // Expand: server returns related entities nested under each row
    // (`row.layers = [{...}, ...]`). Walk the nested shape, stamp the
    // typename from the schema's relation metadata (the server bakes
    // `__typename` into the JSONB but the postgres.camel driver
    // mangles it to `_Typename` mid-flight, so client-side stamping
    // is the only reliable path), hydrate each related row into its
    // own typed pool, then leave the nested arrays in place on the
    // primary row.
    if (options?.expand && options.expand.length > 0) {
      this.hydrateExpanded(modelName, normalized, options.expand);
    }
    return normalized;
  }

  /**
   * Hydrate nested expanded rows. Resolves each relation's target
   * typename via the schema and stamps `__typename` on every nested
   * row before passing to `hydrateOne` — the server's JSONB
   * `__typename` field gets mangled by `postgres.camel` (`__typename`
   * → `_Typename`), so the SDK can't trust whatever string lands.
   */
  private hydrateExpanded(
    parentModelName: string,
    rows: unknown[],
    relationNames: readonly string[],
  ): void {
    const schemaModels = (this.opts.schema as {
      models?: Record<string, {
        relations?: Record<string, { target?: string }>;
      }>;
    }).models;
    const parentDef = schemaModels?.[parentModelName];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const obj = row as Record<string, unknown>;
      for (const rel of relationNames) {
        const nested = obj[rel];
        if (!nested) continue;
        // Resolve target typename via parent's relations map.
        const relDef = parentDef?.relations?.[rel];
        const targetKey = relDef?.target;
        const targetTypename = targetKey ? this.resolveTypename(targetKey) : undefined;
        const items = Array.isArray(nested) ? nested : [nested];
        const models: Model[] = [];
        for (const item of items) {
          const stamped = this.stampTypename(item, targetTypename);
          const m = this.hydrateOne(stamped);
          if (m) models.push(m);
        }
        if (models.length > 0) {
          this.opts.objectPool.addBatch(models, ModelScope.live);
        }
      }
    }
  }

  private async persistToIdb(modelName: string, rows: unknown[]): Promise<void> {
    const store = this.opts.database.getStore(this.resolveTypename(modelName));
    if (!store) return;
    for (const row of rows) {
      try {
        await store.put(row as Record<string, unknown>);
      } catch {
        // IDB writes are best-effort — a transient quota/transaction
        // failure shouldn't break the hydration's primary purpose.
      }
    }
  }

  private resolveTypename(modelName: string): string {
    // Schema is the source of truth for wire typenames. The model proxy
    // is keyed by camelCase plural (`slideLayers`) but the wire query +
    // ObjectPool typeIndex use the typename (`SlideLayer`).
    const def = (this.opts.schema as { models?: Record<string, { typename?: string }> })
      .models?.[modelName];
    return def?.typename ?? modelName;
  }

  private columnizeField(modelName: string, field: string): string {
    const fields = (this.opts.schema as {
      models?: Record<string, { fields?: Record<string, { column?: string }> }>;
    }).models?.[modelName]?.fields;
    if (fields) {
      const direct = fields[field]?.column;
      if (direct) return direct;
      for (const [fieldName, meta] of Object.entries(fields)) {
        const conventional = columnize(fieldName);
        if (field === fieldName || field === conventional || field === meta.column) {
          return meta.column ?? conventional;
        }
      }
    }
    return /[A-Z]/.test(field) ? columnize(field) : field;
  }

  private columnizeClause(modelName: string, clause: WhereClause): WhereClause {
    const finalCol = this.columnizeField(modelName, clause[0]);
    if (clause.length === 2) return [finalCol, clause[1]] as WhereClause;
    return [finalCol, clause[1], clause[2]] as WhereClause;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stableKey(
  modelName: string,
  clauses: readonly WhereClause[],
  orderBy: Record<string, unknown> | undefined,
  limit: number | undefined,
): string {
  // Sort clauses by their stringified form so caller order doesn't
  // produce different dedup keys for semantically identical queries.
  const sorted = [...clauses].map((c) => [...c]).sort((a, b) => {
    const ka = JSON.stringify(a);
    const kb = JSON.stringify(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return JSON.stringify({ modelName, where: sorted, orderBy, limit });
}

function applyLimit<T>(arr: T[], limit: number | undefined): T[] {
  return typeof limit === 'number' ? arr.slice(0, limit) : arr;
}

function scanPool<M>(
  pool: ObjectPool,
  ModelClass: typeof Model,
  clauses: readonly WhereClause[],
): M[] {
  const all = pool.getByType(ModelClass) as unknown as M[];
  if (clauses.length === 0) return all;
  return all.filter((entity) => matchesClauses(entity as Record<string, unknown>, clauses));
}

async function scanIdb(
  database: Database,
  modelName: string,
  clauses: readonly WhereClause[],
): Promise<unknown[]> {
  const store = database.getStore(modelName);
  if (!store) return [];

  // Fast path: a single equality `id` lookup hits the primary key.
  const eqClauses = extractEqClauses(clauses);
  if (clauses.length === 1 && eqClauses.id !== undefined && typeof eqClauses.id === 'string') {
    try {
      const row = await store.get(eqClauses.id);
      return row ? [row] : [];
    } catch {
      return [];
    }
  }

  // Index-aware path: when every clause is equality and exactly one
  // non-id string column is constrained, hit that column's index for
  // an O(matches) read. Anything involving LIKE/ILIKE/ranges falls
  // through to full-scan + filter.
  if (clausesAreAllEquality(clauses)) {
    const indexedKeys = Object.keys(eqClauses).filter(
      (k) => k !== 'id' && typeof eqClauses[k] === 'string',
    );
    if (indexedKeys.length === 1) {
      const idxKey = indexedKeys[0];
      try {
        const rows = await store.getAllFromIndex(idxKey, eqClauses[idxKey] as string);
        if (Array.isArray(rows)) {
          return rows.filter((r) => matchesClauses(r as Record<string, unknown>, clauses));
        }
      } catch {
        // index doesn't exist — fall through to full-scan path.
      }
    }
  }

  try {
    const rows = await store.getAll();
    return Array.isArray(rows)
      ? rows.filter((r) => matchesClauses(r as Record<string, unknown>, clauses))
      : [];
  } catch {
    return [];
  }
}

/**
 * Normalize `LoadWhere<T>` input to the canonical `readonly WhereClause[]`
 * tuple form used throughout `runFetch`. Tuple inputs pass through; object
 * inputs become one `['col', '=', val]` or `['col', 'IN', vals]` per key.
 *
 * Detection: an array whose first element is itself an array is treated
 * as tuple form. Object form is the fallback.
 *
 * Exported so callers can pre-normalize (e.g., for tests, or to inspect
 * the canonical clauses before passing them to `load`/`subscribe`).
 */
export function normalizeWhere(where: unknown): readonly WhereClause[] {
  if (where == null) return [];
  if (Array.isArray(where)) {
    // Tuple form — assumed to already use server-side column names.
    return where as readonly WhereClause[];
  }
  if (typeof where === 'object') {
    const obj = where as Record<string, unknown>;
    return Object.entries(obj).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, 'IN', value as readonly WherePrimitive[]] as WhereClause;
      }
      return [key, value as WherePrimitive] as WhereClause;
    });
  }
  return [];
}

/** Equality-only subset of clauses, keyed by column. Used by IDB fast paths. */
function extractEqClauses(clauses: readonly WhereClause[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of clauses) {
    if (c.length === 2) {
      out[c[0]] = c[1];
    } else if (c[1] === '=') {
      out[c[0]] = c[2];
    }
  }
  return out;
}

function clausesAreAllEquality(clauses: readonly WhereClause[]): boolean {
  return clauses.every((c) => c.length === 2 || c[1] === '=');
}

/**
 * Operator-aware predicate. Mirrors the server's WhereOp semantics for
 * local matching against pool/IDB rows. LIKE/ILIKE use SQL wildcards
 * (`%` = any chars, `_` = one char) translated to a JS regex.
 *
 * Exported so callers can apply the same predicate to in-memory
 * collections (tests, batch operations) using the canonical clauses.
 */
export function matchesClauses(entity: Record<string, unknown>, clauses: readonly WhereClause[]): boolean {
  for (const clause of clauses) {
    const col = clause[0];
    const op: WhereOp = clause.length === 2 ? '=' : clause[1];
    const expected = clause.length === 2 ? clause[1] : clause[2];
    const v = entity[col];
    if (!matchOp(v, op, expected)) return false;
  }
  return true;
}

function matchOp(actual: unknown, op: WhereOp, expected: unknown): boolean {
  switch (op) {
    case '=':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '<':
      return compareOrdered(actual, expected, (a, b) => a < b);
    case '<=':
      return compareOrdered(actual, expected, (a, b) => a <= b);
    case '>':
      return compareOrdered(actual, expected, (a, b) => a > b);
    case '>=':
      return compareOrdered(actual, expected, (a, b) => a >= b);
    case 'IN':
      return Array.isArray(expected) && (expected as readonly unknown[]).some((alt) => alt === actual);
    case 'NOT IN':
      return Array.isArray(expected) && !(expected as readonly unknown[]).some((alt) => alt === actual);
    case 'IS':
      // SQL `IS` is null-equality; the only meaningful right-hand side here is null.
      return actual === expected;
    case 'IS NOT':
      return actual !== expected;
    case 'LIKE':
      return typeof actual === 'string' && typeof expected === 'string' && likeRegex(expected, false).test(actual);
    case 'NOT LIKE':
      return typeof actual === 'string' && typeof expected === 'string' && !likeRegex(expected, false).test(actual);
    case 'ILIKE':
      return typeof actual === 'string' && typeof expected === 'string' && likeRegex(expected, true).test(actual);
    case 'NOT ILIKE':
      return typeof actual === 'string' && typeof expected === 'string' && !likeRegex(expected, true).test(actual);
  }
}

/**
 * Ordered comparison helper. Both operands must be non-null and the same
 * comparable primitive (string-vs-string or number-vs-number). Mixed
 * types fall back to JS's loose ordering, which would be confusing — so
 * we reject early to match SQL semantics (a NULL operand yields false).
 */
function compareOrdered(
  actual: unknown,
  expected: unknown,
  cmp: (a: string | number, b: string | number) => boolean,
): boolean {
  if (actual == null || expected == null) return false;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return cmp(actual, expected);
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return cmp(actual, expected);
  }
  return false;
}

/** Translate a SQL LIKE/ILIKE pattern to a JS regex (`%` → `.*`, `_` → `.`). */
function likeRegex(pattern: string, insensitive: boolean): RegExp {
  // Escape regex specials *except* `%` and `_`, then translate those.
  const escaped = pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, insensitive ? 'i' : '');
}

/**
 * Schema fields are camelCase (`slideId`); the wire query expects
 * the server-side column name. The query server's input resolver
 * casing-folds, but we send snake_case to match the convention used
 * by the existing loaders' postQuery calls (`'slide_id'` etc.).
 */
function columnize(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
