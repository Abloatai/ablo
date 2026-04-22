/**
 * @jest-environment node
 */

import { z } from 'zod';
import { defineMutator, defineMutators } from '../../../src/server/defineMutator';
import { MutatorRegistry } from '../../../src/server/registry';

// ── Fixtures ─────────────────────────────────────────────────────────────

const testMutators = defineMutators({
  slideLayer: {
    create: defineMutator(
      z.object({ id: z.string(), slideId: z.string() }),
      async () => {},
    ),
    delete: defineMutator(
      z.object({ id: z.string() }),
      async () => {},
    ),
  },
  message: {
    create: defineMutator(
      z.object({ id: z.string(), chatId: z.string(), content: z.string() }),
      async () => {},
    ),
  },
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('MutatorRegistry', () => {
  it('registers all mutators from a nested defineMutators map', () => {
    const registry = new MutatorRegistry();
    registry.register(testMutators);

    expect(registry.size).toBe(3);
    expect(registry.list()).toEqual([
      'message.create',
      'slideLayer.create',
      'slideLayer.delete',
    ]);
  });

  it('looks up a mutator by dot-namespaced name', () => {
    const registry = new MutatorRegistry();
    registry.register(testMutators);

    const def = registry.get('slideLayer.create');
    expect(def).toBeDefined();
    expect(def!.name).toBe('slideLayer.create');
    expect(def!.fn).toBeInstanceOf(Function);
  });

  it('returns undefined for an unknown name', () => {
    const registry = new MutatorRegistry();
    registry.register(testMutators);

    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.get('slideLayer.nonexistent')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = new MutatorRegistry();
    registry.register(testMutators);

    expect(() => registry.register(testMutators)).toThrow(
      /duplicate mutator.*slideLayer\.create/i,
    );
  });

  it('throws if MutatorDef has no name (not processed by defineMutators)', () => {
    const raw = defineMutator(
      z.object({ id: z.string() }),
      async () => {},
    );
    // Raw defineMutator returns name: '' — not yet processed
    expect(raw.name).toBe('');

    const registry = new MutatorRegistry();
    expect(() =>
      registry.register({ raw } as Record<string, typeof raw>),
    ).toThrow(/no name/i);
  });

  it('supports fluent chaining via register().get()', () => {
    const def = new MutatorRegistry()
      .register(testMutators)
      .get('message.create');

    expect(def).toBeDefined();
    expect(def!.name).toBe('message.create');
  });

  it('preserves the Zod input schema on the looked-up def', () => {
    const registry = new MutatorRegistry();
    registry.register(testMutators);

    const def = registry.get('slideLayer.create')!;
    // The input schema should parse valid input
    const parsed = def.input.parse({ id: 'abc', slideId: 'slide1' });
    expect(parsed).toEqual({ id: 'abc', slideId: 'slide1' });

    // And reject invalid input
    expect(() => def.input.parse({ id: 123 })).toThrow();
  });
});
