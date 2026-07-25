/**
 * Tests for `computeFKDepthPriority` — the Tarjan-SCC-based create-order
 * priority computer.
 *
 * The contract these tests pin down:
 *
 *   1. Acyclic schemas: deeper-FK nodes get higher priority numbers.
 *   2. 2-cycle (the slideDecks ↔ layouts case): both members share a
 *      priority, so commit order is decided by insertion order — never
 *      by which node DFS happened to enter first.
 *   3. Larger SCCs: same rule generalises to any cycle size.
 *   4. Self-loops are treated as a single-node SCC, not a 2-deep tower.
 *   5. Disconnected components don't interfere with each other.
 *   6. External references (parents not declared in the schema) are
 *      ignored cleanly without throwing.
 *   7. The map is keyed by `typename` (wire name), not the schema key —
 *      because that's what `Model.getModelName()` emits at commit time.
 *
 * What the old DFS-with-memoization heuristic got wrong: priorities
 * depended on the order `Object.entries(schema.models)` happened to
 * yield keys, because the cycle-break (`if (stack.has(key)) return 0`)
 * locked in whichever traversal got there first. Tarjan SCC removes
 * that hazard — see the cycle tests below.
 */

import { z } from 'zod';
import { defineSchema, model, relation } from '@ablo/transaction/schema';
import { computeFKDepthPriority } from '../schemaConfig.js';

/** Convenience: build the priority map from a schema literal. */
function priorities(schema: ReturnType<typeof defineSchema>) {
  return computeFKDepthPriority(schema);
}

describe('computeFKDepthPriority', () => {
  it('linear chain A → B → C: priorities increase with FK depth', () => {
    const schema = defineSchema({
      a: model({ name: z.string() }),
      b: model({ aId: z.string() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
      c: model({ bId: z.string() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
    });

    const p = priorities(schema);
    // a is the root (no parents), c is the deepest leaf.
    expect(p.get('a')).toBeLessThan(p.get('b')!);
    expect(p.get('b')).toBeLessThan(p.get('c')!);
  });

  it('2-cycle A ↔ B: members share a priority (the user-reported bug)', () => {
    // Mirrors the slideDecks ↔ layouts cycle in ablo.schema.ts:
    //   slideDecks.layoutId  → layouts
    //   layouts.deckId       → slideDecks
    const schema = defineSchema({
      slideDecks: model({ layoutId: z.string().nullish() }, { relations: {
        layout: relation.belongsTo('layouts', 'layoutId'),
      }, }),
      layouts: model({ deckId: z.string().nullish() }, { relations: {
        deck: relation.belongsTo('slideDecks', 'deckId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('slideDecks')).toBe(p.get('layouts'));
    // And they got *some* priority — not silently dropped.
    expect(p.get('slideDecks')).toBeGreaterThan(0);
  });

  it('priorities are iteration-order-independent across cycles', () => {
    // Define the same cycle in two different declaration orders. The
    // priority assigned to each node must be identical regardless of
    // which one was declared first.
    const schemaA = defineSchema({
      x: model({ yId: z.string().nullish() }, { relations: {
        y: relation.belongsTo('y', 'yId'),
      }, }),
      y: model({ xId: z.string().nullish() }, { relations: {
        x: relation.belongsTo('x', 'xId'),
      }, }),
    });
    const schemaB = defineSchema({
      y: model({ xId: z.string().nullish() }, { relations: {
        x: relation.belongsTo('x', 'xId'),
      }, }),
      x: model({ yId: z.string().nullish() }, { relations: {
        y: relation.belongsTo('y', 'yId'),
      }, }),
    });

    const pA = priorities(schemaA);
    const pB = priorities(schemaB);
    expect(pA.get('x')).toBe(pA.get('y'));
    expect(pB.get('x')).toBe(pB.get('y'));
    // Both schemas place x and y at the same priority value.
    expect(pA.get('x')).toBe(pB.get('x'));
  });

  it('downstream-of-cycle nodes get higher priority than the cycle', () => {
    // Mirrors the real Ablo schema: slides depends on the
    // {slideDecks, layouts} SCC, so slides must commit after.
    const schema = defineSchema({
      slideDecks: model({ layoutId: z.string().nullish() }, { relations: {
        layout: relation.belongsTo('layouts', 'layoutId'),
      }, }),
      layouts: model({ deckId: z.string().nullish() }, { relations: {
        deck: relation.belongsTo('slideDecks', 'deckId'),
      }, }),
      slides: model({ deckId: z.string() }, { relations: {
        deck: relation.belongsTo('slideDecks', 'deckId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('slides')).toBeGreaterThan(p.get('slideDecks')!);
    expect(p.get('slides')).toBeGreaterThan(p.get('layouts')!);
  });

  it('three-node cycle A → B → C → A: all three share a priority', () => {
    const schema = defineSchema({
      a: model({ cId: z.string().nullish() }, { relations: {
        c: relation.belongsTo('c', 'cId'),
      }, }),
      b: model({ aId: z.string().nullish() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
      c: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('a')).toBe(p.get('b'));
    expect(p.get('b')).toBe(p.get('c'));
  });

  it('self-loop is a single-node SCC, not a depth-2 tower', () => {
    // `slides.sourceSlideId → slides` in the real schema. Old code's
    // depth heuristic would try to recurse into the cycle and bail at
    // depth 0 — which gave depth 1 for a self-loop. Tarjan correctly
    // treats it as one node.
    const schema = defineSchema({
      slides: model({ sourceSlideId: z.string().nullish() }, { relations: {
        sourceSlide: relation.belongsTo('slides', 'sourceSlideId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('slides')).toBe(10); // first (and only) emit → 10
  });

  it('sibling DAG branches: A → B, A → C, B and C unrelated', () => {
    // B and C don't depend on each other. Neither must come before the
    // other; only invariant is "both after A".
    const schema = defineSchema({
      a: model({ name: z.string() }),
      b: model({ aId: z.string() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
      c: model({ aId: z.string() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('a')).toBeLessThan(p.get('b')!);
    expect(p.get('a')).toBeLessThan(p.get('c')!);
  });

  it('disconnected components do not interfere', () => {
    const schema = defineSchema({
      a: model({ name: z.string() }),
      b: model({ aId: z.string() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
      x: model({ name: z.string() }),
      y: model({ xId: z.string() }, { relations: {
        x: relation.belongsTo('x', 'xId'),
      }, }),
    });

    const p = priorities(schema);
    // Each chain is internally consistent.
    expect(p.get('a')).toBeLessThan(p.get('b')!);
    expect(p.get('x')).toBeLessThan(p.get('y')!);
  });

  it('external belongsTo target (not in schema) is silently ignored', () => {
    const schema = defineSchema({
      a: model({ outsideId: z.string() }, { relations: {
        outside: relation.belongsTo('externalThing', 'outsideId'),
      }, }),
    });

    const p = priorities(schema);
    // Single node with no in-schema parents → priority 10, no throw.
    expect(p.get('a')).toBe(10);
  });

  it('keys the result by typename, not schema key', () => {
    const schema = defineSchema({
      slideDecks: model({ name: z.string() }, { typename: 'SlideDeck' }),
    });

    const p = priorities(schema);
    expect(p.get('SlideDeck')).toBe(10);
    expect(p.get('slideDecks')).toBeUndefined();
  });

  it('reproduces the user-reported failing batch correctly', () => {
    // Reduced version of the Ablo schema's deck-creation cycle:
    //   layouts ↔ slideDecks (via layouts.deckId / slideDecks.layoutId)
    //   layouts ↔ slideLayouts (via layouts.masterId / slideLayouts.layoutId)
    //   slides → {slideDecks, slideLayouts} (FKs to both)
    //   slideLayers → slides
    const schema = defineSchema({
      layouts: model(
        { masterId: z.string().nullish(), deckId: z.string().nullish() },
        {
          relations: {
            deck: relation.belongsTo('slideDecks', 'deckId'),
            master: relation.belongsTo('slideLayouts', 'masterId'),
          },
          typename: 'Layout',
        }),
      slideDecks: model(
        { layoutId: z.string().nullish() },
        {
          relations: {
            activeLayout: relation.belongsTo('layouts', 'layoutId'),
          },
          typename: 'SlideDeck',
        }),
      slides: model(
        { deckId: z.string(), templateId: z.string().nullish() },
        {
          relations: {
            deck: relation.belongsTo('slideDecks', 'deckId'),
            template: relation.belongsTo('slideLayouts', 'templateId'),
          },
          typename: 'Slide',
        }),
      slideLayers: model(
        { slideId: z.string() },
        {
          relations: {
            slide: relation.belongsTo('slides', 'slideId'),
          },
          typename: 'SlideLayer',
        }),
      slideLayouts: model(
        { layoutId: z.string() },
        {
          relations: {
            layout: relation.belongsTo('layouts', 'layoutId'),
          },
          typename: 'SlideLayout',
        }),
    });

    const p = priorities(schema);
    // The three-node SCC {Layout, SlideDeck, SlideLayout} gets a single
    // priority — which fixes the bug. Previously SlideDeck=20 and
    // Layout=30, putting children before parents.
    const layoutP = p.get('Layout')!;
    const deckP = p.get('SlideDeck')!;
    const slideLayoutP = p.get('SlideLayout')!;
    expect(layoutP).toBe(deckP);
    expect(layoutP).toBe(slideLayoutP);

    // Slide is downstream of the SCC.
    expect(p.get('Slide')!).toBeGreaterThan(layoutP);
    // SlideLayer is downstream of Slide.
    expect(p.get('SlideLayer')!).toBeGreaterThan(p.get('Slide')!);
  });

  // ── defer: true escape hatch ──────────────────────────────────────────

  it('defer:true on a 2-cycle edge breaks the SCC into a chain', () => {
    // Same A↔B cycle as the earlier test, but `b → a` is now `defer:true`.
    // The dependency walker drops that edge, so the only remaining edge
    // is `a → b`, which makes b a strict topological predecessor of a.
    const schema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
      b: model({ aId: z.string().nullish() }, { relations: {
        // The "soft" side: schema author has decided the consumer will
        // create A first and patch a→b later, so this edge is ignored
        // for priority purposes.
        a: relation.belongsTo('a', 'aId', { defer: true }),
      }, }),
    });

    const p = priorities(schema);
    // b has no remaining parents → root → priority 10.
    expect(p.get('b')).toBe(10);
    // a depends on b → strictly higher.
    expect(p.get('a')).toBeGreaterThan(p.get('b')!);
  });

  it('defer:false (default) preserves the SCC tie behavior', () => {
    // Same shape as the test above but without `defer:true`. Members
    // share priority — proves the breaking is opt-in.
    const schema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
      b: model({ aId: z.string().nullish() }, { relations: {
        a: relation.belongsTo('a', 'aId'),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('a')).toBe(p.get('b'));
  });

  it('defer:true on a non-cycle edge is effectively a no-op for priorities', () => {
    // A → B is acyclic. Marking it defer doesn't introduce any cycle
    // and the resulting priorities still respect dep order — but B's
    // priority is one step lower because its only inbound edge was
    // dropped, leaving B as an apparent "root" of its own component.
    const referenceSchema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
      b: model({ name: z.string() }),
    });
    const deferredSchema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId', { defer: true }),
      }, }),
      b: model({ name: z.string() }),
    });

    const ref = priorities(referenceSchema);
    const def = priorities(deferredSchema);
    // Reference: b is root (10), a depends (20).
    expect(ref.get('b')).toBe(10);
    expect(ref.get('a')).toBeGreaterThan(ref.get('b')!);
    // Deferred: a no longer "depends" on b for priority purposes,
    // so both end up as roots — both get 10. Order between them is
    // decided by insertion-order tiebreak in the queue.
    expect(def.get('a')).toBe(10);
    expect(def.get('b')).toBe(10);
  });

  it('defer:true on one edge of a 3-node cycle linearizes the rest', () => {
    // A → B → C → A. Mark C → A as defer.
    // Dependency edges left: A → B, B → C.
    // → C is root, then B, then A.
    const schema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId'),
      }, }),
      b: model({ cId: z.string().nullish() }, { relations: {
        c: relation.belongsTo('c', 'cId'),
      }, }),
      c: model({ aId: z.string().nullish() }, { relations: {
        a: relation.belongsTo('a', 'aId', { defer: true }),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('c')!).toBeLessThan(p.get('b')!);
    expect(p.get('b')!).toBeLessThan(p.get('a')!);
    // None of the three share a priority anymore — cycle is fully broken.
    expect(new Set([p.get('a'), p.get('b'), p.get('c')]).size).toBe(3);
  });

  it('defer applied to all edges of a cycle leaves every node as a root', () => {
    // Pathological case: every cycle edge marked defer. The graph
    // collapses to disconnected singletons. Each gets priority 10;
    // commit order is purely insertion-order. This is allowed (we
    // don't error) because the DEFERRABLE FK in Postgres makes the
    // ordering non-load-bearing for correctness anyway.
    const schema = defineSchema({
      a: model({ bId: z.string().nullish() }, { relations: {
        b: relation.belongsTo('b', 'bId', { defer: true }),
      }, }),
      b: model({ aId: z.string().nullish() }, { relations: {
        a: relation.belongsTo('a', 'aId', { defer: true }),
      }, }),
    });

    const p = priorities(schema);
    expect(p.get('a')).toBe(10);
    expect(p.get('b')).toBe(10);
  });
});
