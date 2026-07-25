/**
 * Mutation pipeline integration tests.
 *
 * Proves the moved primitives (Mutation, MutationRecorder, AdapterRegistry,
 * StreamingParser) work end-to-end with a fake "slide" adapter — without
 * any apps/web coupling.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AdapterRegistry,
  MutationRecorder,
  StreamingParser,
  validateParserPattern,
  type ContentMutationAdapter,
  type Mutation,
  type ParserPattern,
} from './index';

// ── Test fixture: a minimal slide adapter ────────────────────────────────

interface FakeLayerCreate extends Mutation {
  type: 'create';
  entityType: 'layer';
  slideId: string;
  payload: { content: string };
}

const layerCreatePattern: ParserPattern = {
  type: 'layer.create',
  mutationType: 'create',
  entityType: 'layer',
  contentType: 'slide',
  // Pattern stops BEFORE the opening paren — the parser walks the parens
  // itself to capture arguments.
  callPattern: /\blayer\s*\.\s*create\s*/g,
};

const fakeSlideAdapter: ContentMutationAdapter<FakeLayerCreate> = {
  contentType: 'slide',
  entityTypes: ['layer'],
  payloadSchemas: {
    layer: z.object({ content: z.string() }),
  },
  isMutation: (m: Mutation): m is FakeLayerCreate =>
    m.type === 'create' && m.entityType === 'layer',
  buildSandboxNamespace: (ctx, recorder) => ({
    layer: {
      create: (args: { content: string }) => {
        recorder.record({
          type: 'create',
          entityType: 'layer',
          slideId: ctx.entityId,
          payload: args,
        });
        return { id: `layer-${recorder.count()}` };
      },
    },
  }),
  parserPatterns: [layerCreatePattern],
  applyPreview: (snapshot) => snapshot,
  persistMutations: async (mutations) => ({
    success: true,
    applied: mutations.length,
  }),
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AdapterRegistry', () => {
  it('registers and looks up adapters by content type', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeSlideAdapter);

    expect(registry.get('slide')).toBe(fakeSlideAdapter);
    expect(registry.list()).toEqual(['slide']);
  });

  it('throws on unknown content type with helpful message', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeSlideAdapter);
    try {
      registry.get('document');
      expect.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('No adapter registered');
      expect(message).toContain('document');
      expect(message).toContain('slide'); // shows what IS registered
    }
  });

  it('findForMutation routes mutations to the owning adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeSlideAdapter);

    const mutation: Mutation = {
      type: 'create',
      entityType: 'layer',
      slideId: 's1',
    };
    expect(registry.findForMutation(mutation)).toBe(fakeSlideAdapter);
  });

  it('findForMutation returns null for unrouted mutations', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeSlideAdapter);

    const mutation: Mutation = {
      type: 'create',
      entityType: 'block', // not handled by slide adapter
    };
    expect(registry.findForMutation(mutation)).toBeNull();
  });

  it('register is idempotent (replaces, not appends)', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeSlideAdapter);
    registry.register(fakeSlideAdapter);
    registry.register(fakeSlideAdapter);
    expect(registry.list()).toEqual(['slide']);
  });
});

describe('MutationRecorder', () => {
  it('records mutations in insertion order', () => {
    const recorder = new MutationRecorder<FakeLayerCreate>();
    recorder.record({
      type: 'create',
      entityType: 'layer',
      slideId: 's1',
      payload: { content: 'first' },
    });
    recorder.record({
      type: 'create',
      entityType: 'layer',
      slideId: 's1',
      payload: { content: 'second' },
    });
    expect(recorder.count()).toBe(2);
    expect(recorder.getAll()).toHaveLength(2);
    expect(recorder.getAll()[0].payload.content).toBe('first');
  });

  it('enforces the maxMutations cap', () => {
    const recorder = new MutationRecorder({ maxMutations: 2 });
    recorder.record({ type: 'create', entityType: 'layer' });
    recorder.record({ type: 'create', entityType: 'layer' });
    expect(() =>
      recorder.record({ type: 'create', entityType: 'layer' }),
    ).toThrow(/Maximum mutations \(2\) exceeded/);
  });

  it('clear() resets the recorder', () => {
    const recorder = new MutationRecorder();
    recorder.record({ type: 'create', entityType: 'layer' });
    recorder.clear();
    expect(recorder.count()).toBe(0);
  });
});

describe('end-to-end: adapter + recorder', () => {
  it('adapter sandbox calls produce mutations in the recorder', () => {
    const recorder = new MutationRecorder<FakeLayerCreate>();
    const namespace = fakeSlideAdapter.buildSandboxNamespace(
      { entityId: 'slide-1', initialData: null, organizationId: 'org-1' },
      recorder,
    );

    const layer = namespace.layer as { create: (args: { content: string }) => { id: string } };
    layer.create({ content: 'Hello' });
    layer.create({ content: 'World' });

    const all = recorder.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].slideId).toBe('slide-1');
    expect(all[0].payload.content).toBe('Hello');
    expect(all[1].payload.content).toBe('World');
  });

  it('persistMutations receives all recorded mutations', async () => {
    const recorder = new MutationRecorder<FakeLayerCreate>();
    const namespace = fakeSlideAdapter.buildSandboxNamespace(
      { entityId: 'slide-1', initialData: null, organizationId: 'org-1' },
      recorder,
    );
    const layer = namespace.layer as { create: (args: { content: string }) => unknown };
    layer.create({ content: 'one' });
    layer.create({ content: 'two' });
    layer.create({ content: 'three' });

    const result = await fakeSlideAdapter.persistMutations(
      [...recorder.getAll()],
      { entityId: 'slide-1', organizationId: 'org-1', dispatcher: null },
    );
    expect(result.success).toBe(true);
    expect(result.applied).toBe(3);
  });
});

describe('StreamingParser', () => {
  it('detects function calls matching adapter patterns', () => {
    validateParserPattern(layerCreatePattern);
    const events: unknown[] = [];
    const parser = new StreamingParser({
      patterns: [layerCreatePattern],
      onIntent: (e) => events.push(e),
    });

    parser.feedChunk(`layer.create({ content: "Hello" })`);
    parser.finalize();

    expect(events.length).toBeGreaterThan(0);
  });

  it('validateParserPattern rejects non-global patterns', () => {
    expect(() =>
      validateParserPattern({
        type: 'bad',
        mutationType: 'create',
        entityType: 'x',
        contentType: 'slide',
        callPattern: /pattern/, // missing 'g' flag
      }),
    ).toThrow(/global/);
  });
});
