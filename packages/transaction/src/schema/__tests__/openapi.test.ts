/**
 * `schemaToOpenApi` emits a valid-shaped OpenAPI 3.1 spec FROM the schema — the
 * routes are the customer's models. Asserts the per-model CRUD + claim paths,
 * component schemas derived from `FieldMeta` (incl. enum + optionality), the
 * Bearer security scheme, and the `/v1/commits` route.
 */
import { defineSchema, model, z } from '../index.js';
import { abloOpenApi, schemaToOpenApi } from '@abloatai/transaction/schema/openapi';
import { commitRequestSchema } from '@abloatai/transaction/wire';

const schema = defineSchema({
  tasks: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']),
    notes: z.string().optional(),
  }),
});

describe('schemaToOpenApi', () => {
  const spec = schemaToOpenApi(schema, { title: 'Test API' });
  const paths = spec.paths as Record<string, unknown>;
  const components = (spec.components as Record<string, unknown>).schemas as Record<string, Record<string, unknown>>;

  it('is OpenAPI 3.1 with Bearer auth and the title', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect((spec.info as Record<string, unknown>).title).toBe('Test API');
    const schemes = (spec.components as Record<string, Record<string, unknown>>).securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.bearerAuth?.scheme).toBe('bearer');
  });

  it('emits the per-model CRUD + claim routes for each schema model', () => {
    expect(paths['/v1/models/tasks']).toBeDefined();
    expect(paths['/v1/models/tasks/{id}']).toBeDefined();
    expect(paths['/v1/models/tasks/{id}/claim']).toBeDefined();
    expect(paths['/v1/models/tasks/{id}/claim/reorder']).toBeDefined();
    expect(paths['/v1/commits']).toBeDefined();
    // list + create + retrieve + update + delete verbs are present
    expect((paths['/v1/models/tasks'] as Record<string, unknown>).get).toBeDefined();
    expect((paths['/v1/models/tasks'] as Record<string, unknown>).post).toBeDefined();
    const byId = paths['/v1/models/tasks/{id}'] as Record<string, unknown>;
    expect(byId.get && byId.patch && byId.delete).toBeTruthy();
  });

  it('derives the component schema from FieldMeta (types, enum, optionality)', () => {
    const tasks = components.Tasks;
    if (!tasks) throw new Error('expected Tasks component schema');
    const props = tasks.properties as Record<string, Record<string, unknown>>;
    expect(props.id?.type).toBe('string');
    expect(props.title?.type).toBe('string');
    expect(props.status?.enum).toEqual(['todo', 'doing', 'done']);
    const required = tasks.required as string[];
    expect(required).toContain('title'); // required
    expect(required).not.toContain('notes'); // .optional() → not required
  });
});

/**
 * `abloOpenApi` is the protocol reference: the route templates the server
 * actually registers. It takes no schema, which is the property under test — a
 * spec that cannot see a schema cannot grow with one, so it stays publishable
 * once and identical for every caller.
 *
 * The list below is a change-detector, not the authority. Whether the reference
 * matches the SERVED surface is settled by `spec-covers-routes.test.ts` in
 * `apps/sync-server`, which reads the route registrations and checks both
 * directions per operation — the only check that can catch a documented route
 * nobody serves. This package cannot see those registrations, so what it can
 * usefully assert is that the list does not change by accident.
 */
describe('abloOpenApi (protocol reference)', () => {
  const spec = abloOpenApi({ title: 'Ablo' });
  const paths = spec.paths as Record<string, unknown>;

  it('describes the route templates the server registers', () => {
    expect(Object.keys(paths).sort()).toEqual(
      [
        '/v1/commits',
        '/v1/ephemeral_keys',
        // The whole coordination surface, not only the model-scoped half: a
        // socketless caller waits its turn by beating `{claimId}/heartbeat` and
        // reading the grant off `{claimId}`, so a reference missing either one
        // documents a claim you can take but cannot queue for.
        '/v1/claims',
        '/v1/claims/heartbeat',
        '/v1/claims/{claimId}',
        '/v1/claims/{claimId}/heartbeat',
        '/v1/capabilities',
        '/v1/capabilities/{id}',
        '/v1/capabilities/{id}/rotate',
        // Reading what changed is the other half of working alongside someone:
        // a client that can coordinate its writes but cannot see a peer's is
        // only half a participant.
        '/v1/logs',
        '/v1/models/{model}',
        '/v1/models/{model}/{id}',
        '/v1/models/{model}/{id}/claim',
        '/v1/models/{model}/{id}/claim/heartbeat',
        '/v1/models/{model}/{id}/claim/reorder',
        // What the models look like, for a caller holding no schema
        // declaration to read types from. Without it the reference documents
        // how to write a row but not what a row is, and a field typo stays a
        // rejected write instead of a local check.
        '/v1/schema',
      ].sort(),
    );
  });

  it('carries `{model}` as a path parameter rather than a path segment', () => {
    const list = paths['/v1/models/{model}'] as Record<string, Record<string, unknown> | undefined>;
    const params = list.get?.parameters as Record<string, unknown>[];
    expect(params.find((p) => p.name === 'model')).toMatchObject({ in: 'path', required: true });
  });

  it('does not grow with the number of models — the whole point', () => {
    const many = defineSchema(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`model${i}`, model({ name: z.string() })]),
      ) as Record<string, ReturnType<typeof model>>,
    );
    const few = defineSchema({ solo: model({ name: z.string() }) });
    // The expansion scales with the schema; the protocol reference does not.
    // Asserted as a relationship rather than a magic number, so publishing a new
    // route updates the list above without silently weakening this invariant.
    const referencePaths = Object.keys(abloOpenApi().paths as object).length;
    expect(Object.keys(schemaToOpenApi(many).paths as object).length).toBeGreaterThan(100);
    expect(Object.keys(schemaToOpenApi(few).paths as object).length).toBeLessThan(
      Object.keys(schemaToOpenApi(many).paths as object).length,
    );
    expect(referencePaths).toBeLessThan(20);
  });

  it('is byte-identical no matter whose schema is pushed', () => {
    expect(JSON.stringify(abloOpenApi())).toBe(JSON.stringify(abloOpenApi()));
  });

  it('ships no per-model component schemas, so payloads stay generic', () => {
    expect((spec.components as Record<string, unknown>).schemas).toEqual({});
  });
});

/**
 * The commit route is the one an agent cannot work without, and until now
 * neither spec documented its body — so a spec-driven client could not construct
 * a write, and `track` was invisible. These pin the contract in both documents.
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => {
  if (typeof v !== 'object' || v === null) throw new Error('expected an object');
  return v as Json;
};

describe.each([
  ['abloOpenApi', abloOpenApi()],
  ['schemaToOpenApi', schemaToOpenApi(schema)],
])('%s documents the commit body', (_name, spec) => {
  const commit = obj(obj(obj(spec.paths)['/v1/commits']).post);
  const bodySchema = obj(obj(obj(obj(commit.requestBody).content)['application/json']).schema);
  const properties = obj(bodySchema.properties);

  it('carries operations, reads, and track', () => {
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['operations', 'reads', 'track']));
  });

  it('documents the Idempotency-Key header, which is where request identity lives', () => {
    const params = commit.parameters as Json[];
    expect(params.find((p) => p.name === 'Idempotency-Key')).toMatchObject({ in: 'header' });
  });

  it('does not require operations, so a track-only commit is expressible', () => {
    expect((bodySchema.required as string[] | undefined) ?? []).not.toContain('operations');
  });
});

/**
 * The reference must be DERIVED from the contract, not describe it. A
 * hand-written copy drifts silently, and a test that only asserts the copy has
 * the right field names pins the copy to itself — which reads as coverage while
 * the two definitions diverge. This asserts the published body IS the schema the
 * server validates against.
 */
describe('the commit body is derived, not described', () => {
  it('matches z.toJSONSchema(commitRequestSchema) exactly', () => {
    const published = obj(
      obj(obj(obj(obj(obj(obj(abloOpenApi().paths)['/v1/commits']).post).requestBody).content)['application/json']).schema,
    );
    expect(published).toEqual(z.toJSONSchema(commitRequestSchema, { io: 'input' }));
  });

  it('picks up a field added to the contract without touching the generator', () => {
    const extended = commitRequestSchema.extend({ probeField: z.string().optional() });
    const derived = obj(obj(z.toJSONSchema(extended, { io: 'input' })).properties);
    expect(Object.keys(derived)).toContain('probeField');
  });
});
