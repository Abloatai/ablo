/**
 * Derives engine configuration from a schema. This module holds two pure
 * functions: {@link computeFKDepthPriority} works out a safe row-insertion
 * order from the schema's foreign-key relations, and
 * {@link deriveConfigFromSchema} packages that ordering, together with a few
 * defaults, into the {@link RuntimeConfig} a client uses at startup. Both
 * are deterministic transforms of the schema and hold no engine state.
 */

import type { Schema } from '@abloatai/transaction/schema/schema';
import type { RelationDef } from '@abloatai/transaction/schema/relation';
import type { RuntimeConfig } from '../interfaces/index.js';
import { schemaHash, modelHash, toSchemaJSON } from '../schema/serialize.js';

// ── Config derivation from schema ─────────────────────────────────────────

/**
 * Computes a create-priority map that gives the engine a safe order for
 * inserting rows, so a child row is never written before the parent its
 * foreign key references.
 *
 * Every `belongsTo` relation is an edge from a child model to its parent. This
 * function runs Tarjan's strongly-connected-components algorithm over that
 * graph, which does two things at once: it groups any models that reference
 * each other in a cycle into a single component, and it produces those
 * components in an order where parents come before children. Each model then
 * gets a numeric priority from that order, where a lower number means "insert
 * earlier". Top-level models with no parent — an organization or a theme, say —
 * come first, and the deepest descendants come last.
 *
 * Models in the same cycle share a priority, so within a cycle the order rows
 * were queued in breaks the tie. To break a cycle deterministically instead,
 * mark one side of it with `belongsTo(target, fk, { defer: true })`. A deferred
 * edge is left out of the graph, which turns the cycle into a chain and gives
 * the deferred child a strictly higher priority than its parent. Pair it with a
 * Postgres `DEFERRABLE INITIALLY DEFERRED` constraint if you also want the
 * database to relax its check. See {@link BelongsToOptions.defer}.
 *
 * The returned map is keyed by each model's wire type name
 * ({@link ModelDef.typename}, falling back to the schema key), because that is
 * the name the engine looks up at commit time. Keying by the schema key would
 * miss that lookup, and every model would fall back to the default priority.
 *
 * The result does not depend on which model the walk starts from, and the
 * algorithm runs in time linear in the number of models plus relations.
 * Reference: Tarjan, R. (1972), "Depth-first search and linear graph
 * algorithms."
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

export function deriveConfigFromSchema(schema: Schema): RuntimeConfig {
  // Field-level serialization for commits happens in the transaction queue,
  // which reads each model's declared fields from the model registry at commit
  // time. There is no per-field metadata to configure here, so these maps stay
  // empty.
  return {
    modelCreatePriority: computeFKDepthPriority(schema),
    defaultCreatePriority: 40,
    defaultNonCreatePriority: 50,
    essentialFields: {},
    classNameFallbackMap: {},
    // Hash this schema once, so startup can detect when it has drifted from the
    // schema the server currently has active. The server and the `ablo push`
    // command compute this same hash.
    expectedSchemaHash: schemaHash(schema),
    // Per-model hashes for the SEMANTIC drift check: on a whole-hash mismatch
    // the client compares only the models it declares, so an additive server
    // change stays silent and a real divergence names the exact models.
    expectedModelHashes: Object.fromEntries(
      Object.entries(toSchemaJSON(schema).models).map(([key, model]) => [key, modelHash(model)]),
    ),
    expectedModelShapes: Object.fromEntries(
      Object.entries(toSchemaJSON(schema).models).map(([key, model]) => [key, Object.fromEntries(Object.entries(model.fields).map(([field, meta]) => [field, { type: meta.type, isOptional: meta.isOptional }]))]),
    ),
    // For a projection (`selectModels`/`omitModels`), also carry the full source
    // schema's hash. The drift check accepts a server match on either hash, so a
    // subset client stays quiet against a server running its full source schema.
    // Undefined for a directly-authored schema — plain equality applies there.
    expectedSourceSchemaHash: schema.sourceSchemaHash,
  };
}
