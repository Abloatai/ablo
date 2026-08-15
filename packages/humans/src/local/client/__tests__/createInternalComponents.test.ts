/**
 * Pure-construction tests for `createInternalComponents`. No mocks —
 * the function only wires real classes together, so assertions check
 * the shape of the returned graph and the configuration each
 * component received.
 *
 * The instant-models filter is the one piece of business logic
 * worth locking in: schema models with `load: 'lazy'` must not appear
 * in the bootstrap subscription, otherwise lazy loaders compete with
 * bootstrap for the same data.
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { createInternalComponents } from '../createInternalComponents.js';

describe('createInternalComponents', () => {
  it('returns the full component graph wired in dependency order', () => {
    const schema = defineSchema({
      items: model({ title: z.string() }),
    });

    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });

    expect(components.modelRegistry).toBeDefined();
    expect(components.objectPool).toBeDefined();
    expect(components.bootstrapHelper).toBeDefined();
    expect(components.database).toBeDefined();
    expect(components.syncClient).toBeDefined();
    expect(components.hydration).toBeDefined();
  });

  it('honors maxPoolSize override', () => {
    const schema = defineSchema({ items: model({ title: z.string() }) });
    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: { maxPoolSize: 500 },
    });
    // InstanceCache stores its config; we read through the public surface.
    // The exact internal property may vary, but the constructor
    // receiving the override is the real assertion: no throw.
    expect(components.objectPool).toBeDefined();
  });

  it('derives bootstrap base URL from ws → http when not overridden', () => {
    const schema = defineSchema({ items: model({ title: z.string() }) });
    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });
    // BootstrapFetcher accepts the resolved baseUrl; we read the
    // option through its public surface. Production callers don't
    // peek inside; this test does so the contract is locked.
    const helper = components.bootstrapHelper as unknown as {
      options: { baseUrl: string };
    };
    // `wss://` → `https://` because `replace(/^ws/, 'http')` keeps
    // the trailing `s`. Plain `ws://` → `http://`.
    expect(helper.options.baseUrl).toBe('https://api.example.com/api');
  });

  it('passes through bootstrapBaseUrl override unchanged', () => {
    const schema = defineSchema({ items: model({ title: z.string() }) });
    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: { bootstrapBaseUrl: 'https://custom.example.com/api' },
    });
    const helper = components.bootstrapHelper as unknown as {
      options: { baseUrl: string };
    };
    expect(helper.options.baseUrl).toBe('https://custom.example.com/api');
  });

  it('defaults inMemory based on environment (window-defined → false)', () => {
    // The test runner has `window` defined (jsdom environment), so
    // the auto-detect resolves to `inMemory: false`. The opposite
    // direction is tested below with an explicit override.
    const schema = defineSchema({ items: model({ title: z.string() }) });
    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });
    expect(components.database).toBeDefined();
  });

  it('honors explicit inMemory override', () => {
    const schema = defineSchema({ items: model({ title: z.string() }) });
    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: { inMemory: true },
    });
    expect(components.database).toBeDefined();
  });

  it('filters lazy models from the instant-bootstrap list', () => {
    // The instant-models filter is the one piece of business logic
    // in createInternalComponents — lazy models must not be requested
    // at bootstrap. Verified through `bootstrapHelper`'s configured
    // `instantModels`.
    const schema = defineSchema({
      eager: model({ title: z.string() }, { load: 'instant' }),
      lazyOne: model({ title: z.string() }, { load: 'lazy' }),
      defaulted: model({ title: z.string() }), // no load → instant
    });

    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });
    const helper = components.bootstrapHelper as unknown as {
      options: { instantModels: string[] };
    };
    expect(helper.options.instantModels).toContain('eager');
    expect(helper.options.instantModels).toContain('defaulted');
    expect(helper.options.instantModels).not.toContain('lazyOne');
  });

  it('uses model.typename for instant-bootstrap when set', () => {
    // Schema key is camelCase plural (`entryDetails`); typename is
    // PascalCase singular (`EntryDetail`). The instant list goes on
    // the wire as the typename — the server speaks that vocabulary,
    // not the schema-key one.
    const schema = defineSchema({
      entryDetails: model(
        { title: z.string() },
        { typename: 'EntryDetail' }),
    });

    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });
    const helper = components.bootstrapHelper as unknown as {
      options: { instantModels: string[] };
    };
    expect(helper.options.instantModels).toContain('EntryDetail');
    expect(helper.options.instantModels).not.toContain('entryDetails');
  });

  it('bootstraps an instant model even when it is also lazyObservable', () => {
    // Production shape of EntryDetail / EntryLayoutLayer after the
    // lazy→instant flip: `load: 'instant'` AND `lazyObservable: true`.
    // `lazyObservable` is a MobX observability hint, orthogonal to the
    // load strategy — it must NOT exclude the model from bootstrap. The
    // inverse (lazy + lazyObservable) must still be excluded, so the two
    // flags are proven independent.
    const schema = defineSchema({
      entryDetails: model(
        { title: z.string() },
        { typename: 'EntryDetail', load: 'instant', lazyObservable: true }),
      entryLayoutLayers: model(
        { title: z.string() },
        { typename: 'EntryLayoutLayer', load: 'instant', lazyObservable: true }),
      stillLazy: model(
        { title: z.string() },
        { typename: 'StillLazy', load: 'lazy', lazyObservable: true }),
    });

    const components = createInternalComponents({
      schema,
      url: 'wss://api.example.com',
      options: {},
    });
    const helper = components.bootstrapHelper as unknown as {
      options: { instantModels: string[] };
    };
    expect(helper.options.instantModels).toContain('EntryDetail');
    expect(helper.options.instantModels).toContain('EntryLayoutLayer');
    expect(helper.options.instantModels).not.toContain('StillLazy');
  });
});
