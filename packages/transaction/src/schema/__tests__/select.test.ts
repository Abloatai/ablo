/**
 * `selectModels` — schema projection tests.
 *
 * The "one canonical schema, each app picks a subset" primitive. A projection
 * must carry field shapes / validators / identity roles from the source, prune
 * relations to excluded models, and refuse to silently drop a `parent` edge.
 */

import { defineSchema, model, relation, identityRole, z } from '../index.js';
import { selectModels, omitModels, omittedModelError } from '../select.js';
import { schemaHash, serializeSchema } from '../serialize.js';

function buildCanonical() {
  return defineSchema(
    {
      organizations: model({ name: z.string() }, { tableName: 'organizations' }),
      archives: model(
        { name: z.string() },
        {
          relations: { organization: relation.belongsTo('organizations', 'organizationId', { parent: true }) },
          tableName: 'archives',
        }),
      files: model(
        { name: z.string(), archiveId: z.string(), uploaderId: z.string() },
        {
          relations: {
            archive: relation.belongsTo('archives', 'archiveId', { parent: true }),
            uploader: relation.belongsTo('users', 'uploaderId'), // non-parent → prunable
          },
          tableName: 'files',
        }),
      users: model({ name: z.string() }, { tableName: 'users' }),
      entries: model({ title: z.string() }, { tableName: 'entries' }),
    },
    { identityRoles: [identityRole({ kind: 'org', source: 'organizationId' })] },
  );
}

describe('selectModels', () => {
  it('keeps only the selected models, with their validators', () => {
    const sub = selectModels(buildCanonical(), ['organizations', 'archives']);
    expect(Object.keys(sub.models).sort()).toEqual(['archives', 'organizations']);
    expect(sub.validators.archives).toBeDefined();
    expect((sub.models as Record<string, unknown>).entries).toBeUndefined();
  });

  it('carries identity roles over from the source schema', () => {
    const sub = selectModels(buildCanonical(), ['organizations']);
    expect(sub.identityRoles).toHaveLength(1);
    expect(sub.identityRoles[0]?.kind).toBe('org');
  });

  it('preserves field shapes from the canonical model (no re-declaration)', () => {
    const sub = selectModels(buildCanonical(), ['archives', 'organizations']);
    // The declared field `name` came from the canonical definition, not
    // re-typed here. `organizationId` is a reserved base field the SDK adds
    // automatically — it is NOT a model field, so it is absent from `.fields`.
    expect(Object.keys(sub.models.archives.fields)).toEqual(expect.arrayContaining(['name']));
    expect(Object.keys(sub.models.archives.fields)).not.toContain('organizationId');
  });

  it('prunes a non-parent relation whose target is excluded', () => {
    // files keeps `archive` (in set) but drops `uploader` → users (excluded).
    const sub = selectModels(buildCanonical(), ['archives', 'organizations', 'files']);
    const rels = Object.keys(sub.models.files.relations);
    expect(rels).toContain('archive');
    expect(rels).not.toContain('uploader');
  });

  it('throws if a dropped relation is a scope-bearing parent edge', () => {
    // archives.organization is `parent: true` → can't drop organizations.
    expect(() => selectModels(buildCanonical(), ['archives', 'files'])).toThrow(/parent relation/);
  });

  it('throws on a key that is not in the source schema', () => {
    // @ts-expect-error — 'ghost' is not a model key of the source schema.
    expect(() => selectModels(buildCanonical(), ['ghost'])).toThrow(/not a model/);
  });
});

describe('omitModels', () => {
  it('keeps everything except the omitted models', () => {
    const sub = omitModels(buildCanonical(), ['entries']);
    expect(Object.keys(sub.models).sort()).toEqual(['archives', 'files', 'organizations', 'users']);
    expect((sub.models as Record<string, unknown>).entries).toBeUndefined();
  });

  it('prunes relations into the omitted set (the standalone-product case)', () => {
    // Omitting users drops files.uploader (non-parent) but keeps the rest.
    const sub = omitModels(buildCanonical(), ['users']);
    const rels = Object.keys(sub.models.files.relations);
    expect(rels).toContain('archive');
    expect(rels).not.toContain('uploader');
  });

  it('throws when omitting a model that kept models parent-route through', () => {
    // files.archive is `parent: true` → archives cannot be omitted alone.
    expect(() => omitModels(buildCanonical(), ['archives'])).toThrow(/parent relation/);
  });

  it('throws on a key that is not in the source schema', () => {
    // @ts-expect-error — 'ghost' is not a model key of the source schema.
    expect(() => omitModels(buildCanonical(), ['ghost'])).toThrow(/not a model/);
  });
});

describe('sourceSchemaHash stamping (drift-check support)', () => {
  it('stamps the full source hash on a selectModels projection', () => {
    const canonical = buildCanonical();
    const sub = selectModels(canonical, ['organizations', 'archives']);
    expect(sub.sourceSchemaHash).toBe(schemaHash(canonical));
  });

  it('stamps the full source hash on an omitModels projection', () => {
    const canonical = buildCanonical();
    const sub = omitModels(canonical, ['entries']);
    expect(sub.sourceSchemaHash).toBe(schemaHash(canonical));
  });

  it('leaves the projection’s OWN hash equal to a hash of the subset', () => {
    // Stamping is metadata only — `schemaHash` reads the model JSON, not this
    // field — so a projection still hashes purely as its subset. This is what
    // keeps the drift check honest: own-hash = subset, source-hash = full.
    const canonical = buildCanonical();
    const sub = selectModels(canonical, ['organizations', 'archives']);
    const bare = selectModels(canonical, ['organizations', 'archives']);
    expect(schemaHash(sub)).toBe(schemaHash(bare));
    expect(schemaHash(sub)).not.toBe(schemaHash(canonical));
  });

  it('points a subset-of-a-subset at the ORIGINAL source, not the intermediate', () => {
    // Re-projecting must not collapse the source hash onto the intermediate
    // projection, or a nested client would compare against a schema no server
    // runs. The original full source is the deployed one.
    const canonical = buildCanonical();
    const intermediate = omitModels(canonical, ['entries']);
    const nested = selectModels(intermediate, ['organizations']);
    expect(nested.sourceSchemaHash).toBe(schemaHash(canonical));
  });

  it('leaves a directly-authored schema without a source hash', () => {
    // Only projections carry it; a hand-authored schema IS the deployed schema,
    // so plain own-hash equality is the right drift check there.
    expect(buildCanonical().sourceSchemaHash).toBeUndefined();
  });
});

describe('omittedModels recording (projected-out access support)', () => {
  it('records the dropped model keys, sorted', () => {
    const sub = selectModels(buildCanonical(), ['organizations', 'archives']);
    expect(sub.omittedModels).toEqual(['entries', 'files', 'users']);
  });

  it('unions a subset-of-a-subset with what the source already dropped', () => {
    // A client bound to the nested projection cannot reach anything the
    // intermediate dropped either, so the record must name all of it.
    const intermediate = omitModels(buildCanonical(), ['entries']);
    const nested = selectModels(intermediate, ['organizations']);
    expect(nested.omittedModels).toEqual(['archives', 'entries', 'files', 'users']);
  });

  it('leaves a directly-authored schema without an omitted list', () => {
    // On a hand-authored schema an unknown property is a typo the types catch;
    // only a projection creates the compile-full-run-subset gap this closes.
    expect(buildCanonical().omittedModels).toBeUndefined();
  });

  it('stays out of the serialized form, so recording it never perturbs the hash', () => {
    const sub = selectModels(buildCanonical(), ['organizations', 'archives']);
    expect(serializeSchema(sub)).not.toContain('omittedModels');
  });
});

describe('omittedModelError', () => {
  it('names the model, the cause, and the fix, under the stable code', () => {
    const err = omittedModelError('invoices');
    expect(err.code).toBe('model_not_in_schema');
    expect(err.param).toBe('invoices');
    expect(err.message).toContain('invoices');
    expect(err.message).toContain('projection');
  });
});
