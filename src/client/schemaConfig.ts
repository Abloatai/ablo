/**
 * Schema-derived engine config — `computeFKDepthPriority` (the Tarjan-SCC
 * create-order derivation) and `deriveConfigFromSchema` (the `SyncEngineConfig`
 * the factory seeds the DI context with).
 *
 * Extracted from `Ablo.ts` as a pure leaf: both functions are deterministic
 * schema → value derivations with no engine state.
 */

import type { Schema } from '../schema/schema.js';
import type { RelationDef } from '../schema/relation.js';
import type { SyncEngineConfig } from '../interfaces/index.js';
import { schemaHash } from '../schema/serialize.js';

// ── Config derivation from schema ─────────────────────────────────────────

/**
 * Compute a create-priority map from schema `belongsTo` relations using
 * Tarjan's strongly-connected-components algorithm.
 *
 * The FK graph has an edge `child → parent` for every `belongsTo`. Tarjan
 * runs a single linear DFS that simultaneously (a) detects cycles by
 * grouping mutually-reachable nodes into SCCs and (b) emits those SCCs
 * in reverse topological order of the condensation graph. In this edge
 * convention a "sink" SCC has no outgoing edges — i.e. no parents — so
 * it is an *FK root* (`organizations`, `themes`, etc.). Tarjan emits
 * roots first and leaves last, exactly the order in which rows must be
 * inserted to satisfy FK constraints.
 *
 * Priorities are assigned by emit order: SCC #0 → 10, SCC #1 → 20, …
 * Members of the same SCC share a priority, so insertion order wins the
 * tiebreak inside a cycle (this matters for cyclic schemas like
 * `slideDecks ↔ layouts`, where one direction is the user's chosen
 * "soft" edge — only the consumer's mutator sequence knows which one).
 *
 * This algorithm is iteration-order-independent: starting the DFS from
 * any node yields the same SCC partitioning, and SCCs always come out
 * in valid topological order. The previous DFS-with-memoization
 * heuristic broke under cycles by treating the back-edge as depth 0,
 * which made priorities depend on which node the walk happened to
 * enter the cycle at.
 *
 * Schema authors can mark one side of a cycle with
 * `belongsTo(target, fk, { defer: true })`. Those edges are excluded
 * from the dependency graph entirely, which deterministically breaks
 * the cycle and turns the SCC into a chain — the marked child gets a
 * strictly higher priority than its parent instead of being tied with
 * it. Pair with a Postgres `DEFERRABLE INITIALLY DEFERRED` constraint
 * if you want the database side of the cycle to also relax. See
 * {@link BelongsToOptions.defer}.
 *
 * The returned map is keyed by {@link ModelDef.typename} (falling back
 * to the schema key), because that is what `Model.getModelName()`
 * returns at transaction time — keying by schema key would silently
 * miss the lookup and every model would fall through to
 * `defaultCreatePriority`.
 *
 * Reference: Tarjan, R. (1972), "Depth-first search and linear graph
 * algorithms." Linear in V + E.
 */
export function computeFKDepthPriority(schema: Schema): ReadonlyMap<string, number> {
  // schemaKey → typename (wire name used at transaction time)
  const keyToTypename = new Map<string, string>();
  for (const [key, def] of Object.entries(schema.models)) {
    keyToTypename.set(key, def.typename ?? key);
  }

  // Adjacency: schemaKey → parent schema keys pulled from `belongsTo`.
  // Parents not in the schema (e.g. external types) are dropped so the
  // graph stays closed. Edges marked `{ defer: true }` are also
  // dropped — the schema author has declared this side of a cycle to
  // be the "soft" one (insert with null FK, patch later), so the
  // dependency-graph walker treats it as if the edge weren't there.
  // That breaks the cycle deterministically and lets the other side
  // become a strict topological predecessor.
  const parentsOf = new Map<string, readonly string[]>();
  for (const [key, def] of Object.entries(schema.models)) {
    const out: string[] = [];
    for (const rel of Object.values(def.relations) as (RelationDef & { options?: { defer?: boolean } })[]) {
      if (rel.type !== 'belongsTo') continue;
      if (!keyToTypename.has(rel.target)) continue;
      if (rel.options?.defer === true) continue;
      out.push(rel.target);
    }
    parentsOf.set(key, out);
  }

  // Tarjan SCC bookkeeping
  const dfsIndex = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function strongconnect(v: string): void {
    dfsIndex.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of parentsOf.get(v) ?? []) {
      if (!dfsIndex.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        // Back-edge into the active DFS path — w is in the same SCC as v.
        lowlink.set(v, Math.min(lowlink.get(v)!, dfsIndex.get(w)!));
      }
    }

    // v is the root of an SCC: pop everything down to v inclusive.
    if (lowlink.get(v) === dfsIndex.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  }

  for (const key of keyToTypename.keys()) {
    if (!dfsIndex.has(key)) strongconnect(key);
  }

  // Tarjan emits SCCs in reverse topological order of the condensation.
  // In our edge convention (child→parent), reverse-topo of the
  // condensation means root-SCCs (no outgoing edges = no parents)
  // first, leaf-SCCs (deepest descendants) last. We could just use
  // emit-order as the priority — but that gives independent sibling
  // SCCs different priorities, which is semantically wrong: siblings
  // don't depend on each other and shouldn't be ordered relative to
  // each other.
  //
  // Instead, do one more pass to compute *longest-path depth* on the
  // condensation DAG: depth(SCC) = max(depth(parent SCC)) + 1, or 0
  // for SCCs with no in-schema parents. SCCs at the same depth get
  // the same priority — siblings stay tied, insertion order in the
  // queue breaks the tie. Priority = (depth + 1) * 10.
  //
  // We can compute this in a single pass over the SCCs because
  // Tarjan's emit-order *is* a valid topological order of the
  // condensation: when we process sccs[i], every parent SCC has
  // already been assigned a depth.
  const nodeToSccIdx = new Map<string, number>();
  sccs.forEach((scc, i) => {
    for (const node of scc) nodeToSccIdx.set(node, i);
  });

  const sccDepth = new Map<number, number>();
  sccs.forEach((scc, i) => {
    let maxParentDepth = -1;
    for (const node of scc) {
      for (const parent of parentsOf.get(node) ?? []) {
        const parentSccIdx = nodeToSccIdx.get(parent);
        if (parentSccIdx === undefined) continue;
        if (parentSccIdx === i) continue; // intra-SCC edge — not a dep
        const d = sccDepth.get(parentSccIdx);
        if (d !== undefined && d > maxParentDepth) maxParentDepth = d;
      }
    }
    sccDepth.set(i, maxParentDepth + 1);
  });

  const out = new Map<string, number>();
  sccs.forEach((scc, i) => {
    const priority = (sccDepth.get(i)! + 1) * 10;
    for (const key of scc) {
      out.set(keyToTypename.get(key)!, priority);
    }
  });
  return out;
}

export function deriveConfigFromSchema(schema: Schema): SyncEngineConfig {
  // Commit payload projection is done directly inside `TransactionQueue`
  // — see `projectCommitPayload` there. Each model's field metadata
  // rides on `ModelRegistry` (populated by `registerModelsFromSchema`),
  // so there's no config-layer shim: the queue asks the registry for
  // the declared fields and serializes accordingly.
  return {
    modelCreatePriority: computeFKDepthPriority(schema),
    defaultCreatePriority: 40,
    defaultNonCreatePriority: 50,
    essentialFields: {},
    classNameFallbackMap: {},
    // Hash this client's schema once so bootstrap can detect drift against the
    // server's active hash (same `schemaHash` the CLI push + server compute).
    expectedSchemaHash: schemaHash(schema),
  };
}
