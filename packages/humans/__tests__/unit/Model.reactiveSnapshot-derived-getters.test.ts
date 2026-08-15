/**
 * toReactiveSnapshot must materialize schema-derived getters — `computed:`
 * entries and `${field}Json` getters — onto the plain snapshot.
 *
 * The schema's inferred row type declares these as readonly properties, so a
 * snapshot without them is a type-level lie: `useAblo` consumers read
 * `snapshot.settingsObject` (compiles fine) and get `undefined` at runtime.
 * These tests pin the contract: derived getters are present with the model
 * instance's getter value, non-enumerable (so `{...snapshot}` spreads and
 * `JSON.stringify` keep data-field-only parity with model instances), and
 * relation getters stay excluded.
 */

import { z } from 'zod';
import { createTestContext } from '../../src/local/testing';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { relation } from '@abloatai/transaction/schema/relation';
import { registerModelsFromSchema } from '../../src/local/client/modelRegistration';
import { getActiveRegistry } from '../../src/local/ModelRegistry';
import type { Model } from '../../src/local/Model';

const DEFAULT_SETTINGS = { width: 1920, height: 1080 };

const schema = defineSchema({
  entries: model(
    {
      title: z.string().optional(),
      settings: z.string().optional(),
      metadata: z.object({ icon: z.string().default('presentation') }).optional(),
    },
    {
      typename: 'SnapshotTestEntry',
      computed: {
        settingsObject: (self: { settings?: string }) => {
          try {
            const raw = self.settings;
            if (!raw) return { ...DEFAULT_SETTINGS };
            const parsed: unknown = JSON.parse(raw);
            return { ...DEFAULT_SETTINGS, ...(parsed as Record<string, unknown>) };
          } catch {
            return { ...DEFAULT_SETTINGS };
          }
        },
        displayTitle: (self: { title?: string }) => self.title ?? 'Untitled',
      },
    }),
});

interface SnapshotRow {
  id: string;
  title?: string;
  settings?: string;
  settingsObject: { width: number; height: number };
  displayTitle: string;
  metadataJson: { icon: string };
}

describe('toReactiveSnapshot — derived getters', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    registerModelsFromSchema(schema, getActiveRegistry());
  });

  afterEach(() => {
    cleanup();
  });

  function makeEntry(data: Record<string, unknown>): Model {
    const ModelClass = getActiveRegistry().getModelByName('SnapshotTestEntry');
    if (!ModelClass) throw new Error('SnapshotTestEntry is not registered');
    return new ModelClass(data);
  }

  it('materializes computed getters with the model getter value', () => {
    const entry = makeEntry({
      id: 's1',
      title: 'Roadmap',
      settings: JSON.stringify({ width: 800, height: 600 }),
    });

    const snapshot = entry.toReactiveSnapshot<SnapshotRow>();

    expect(snapshot.settingsObject).toEqual({ width: 800, height: 600 });
    expect(snapshot.displayTitle).toBe('Roadmap');
  });

  it('computed getters resolve defaults for rows without the raw field', () => {
    const entry = makeEntry({ id: 's2' });

    const snapshot = entry.toReactiveSnapshot<SnapshotRow>();

    expect(snapshot.settingsObject).toEqual(DEFAULT_SETTINGS);
    expect(snapshot.displayTitle).toBe('Untitled');
  });

  it('materializes ${field}Json getters', () => {
    const entry = makeEntry({ id: 's3', metadata: { icon: 'chart' } });

    const snapshot = entry.toReactiveSnapshot<SnapshotRow>();

    expect(snapshot.metadataJson).toEqual({ icon: 'chart' });
  });

  it('keeps derived getters out of spreads and JSON — write-path parity with model instances', () => {
    const entry = makeEntry({
      id: 's4',
      title: 'Spread me',
      settings: JSON.stringify({ width: 100, height: 100 }),
    });

    const snapshot = entry.toReactiveSnapshot<SnapshotRow>();
    const spread = { ...snapshot } as Record<string, unknown>;
    const json = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

    // A model instance never leaks getters into `{...model}` (they sit on the
    // prototype); a snapshot spread must not either, or app code spreading a
    // row into an update payload would send computed keys to the server.
    expect('settingsObject' in spread).toBe(false);
    expect('displayTitle' in spread).toBe(false);
    expect('metadataJson' in spread).toBe(false);
    expect('settingsObject' in json).toBe(false);

    // But direct reads and `in` checks work, matching the row type.
    expect('settingsObject' in snapshot).toBe(true);
    expect(snapshot.settingsObject.width).toBe(100);

    // Data fields still spread normally.
    expect(spread.title).toBe('Spread me');
    expect(spread.id).toBe('s4');
  });

  it('still excludes relation getters from snapshots', () => {
    const relSchema = defineSchema({
      collections: model(
        { title: z.string().optional() },
        {
          relations: { entries: relation.hasMany('relEntrys', 'collectionId') },
          typename: 'SnapshotTestCollection',
        }),
      relEntrys: model(
        { collectionId: z.string() },
        { typename: 'SnapshotTestRelEntry' }),
    });
    registerModelsFromSchema(relSchema, getActiveRegistry());

    const CollectionClass = getActiveRegistry().getModelByName('SnapshotTestCollection');
    if (!CollectionClass) throw new Error('SnapshotTestCollection is not registered');
    const collection = new CollectionClass({ id: 'd1', title: 'Collection' });

    const snapshot = collection.toReactiveSnapshot<Record<string, unknown>>();

    expect('entries' in snapshot).toBe(false);
  });
});
