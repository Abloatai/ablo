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
  items: model({
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
    expect(paths['/v1/models/items']).toBeDefined();
    expect(paths['/v1/models/items/{id}']).toBeDefined();
    expect(paths['/v1/models/items/{id}/claim']).toBeDefined();
    expect(paths['/v1/models/items/{id}/claim/reorder']).toBeDefined();
    expect(paths['/v1/commits']).toBeDefined();
    // list + create + retrieve + update + delete verbs are present
    expect((paths['/v1/models/items'] as Record<string, unknown>).get).toBeDefined();
    expect((paths['/v1/models/items'] as Record<string, unknown>).post).toBeDefined();
    const byId = paths['/v1/models/items/{id}'] as Record<string, unknown>;
    expect(byId.get && byId.patch && byId.delete).toBeTruthy();
  });

  it('derives the component schema from FieldMeta (types, enum, optionality)', () => {
    const items = components.Items;
    if (!items) throw new Error('expected Items component schema');
    const props = items.properties as Record<string, Record<string, unknown>>;
    expect(props.id?.type).toBe('string');
    expect(props.title?.type).toBe('string');
    expect(props.status?.enum).toEqual(['todo', 'doing', 'done']);
    const required = items.required as string[];
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
        '/v1/commits/{id}',
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
        '/v1/branches',
        '/v1/branches/{id}',
        '/v1/branches/{id}/credentials',
        '/v1/branches/{id}/status',
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
    expect(referencePaths).toBeLessThan(22);
  });

  it('is byte-identical no matter whose schema is pushed', () => {
    expect(JSON.stringify(abloOpenApi())).toBe(JSON.stringify(abloOpenApi()));
  });

  it('ships named protocol schemas without tenant-specific models', () => {
    const schemas = (spec.components as Record<string, unknown>).schemas as Record<string, unknown>;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'Claim',
        'ClaimAcquire',
        'CommitReceipt',
        'Cursor',
        'ErrorEnvelope',
        'LogPage',
        'ModelPage',
      ]),
    );
    expect(schemas.Items).toBeUndefined();
  });

  it('gives every operation a stable unique operationId', () => {
    const operationIds: string[] = [];
    for (const pathItem of Object.values(paths)) {
      for (const [method, rawOperation] of Object.entries(
        pathItem as Record<string, unknown>,
      )) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          continue;
        }
        const operation = rawOperation as Record<string, unknown>;
        expect(operation.operationId).toEqual(expect.any(String));
        operationIds.push(operation.operationId as string);
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toContain('updateModelRow');
    expect(operationIds).toContain('commit');
  });

  it('documents retained-response replay on branch creation', () => {
    const createBranch = obj(obj(paths['/v1/branches']).post);
    const parameters = createBranch.parameters as Json[];
    expect(parameters.find((parameter) => parameter.name === 'Idempotency-Key')).toMatchObject({
      in: 'header',
      schema: { type: 'string', maxLength: 255 },
    });
  });

  it('documents bounded branch collection pagination', () => {
    const listBranches = obj(obj(paths['/v1/branches']).get);
    const parameters = listBranches.parameters as Json[];
    expect(parameters.find((parameter) => parameter.name === 'limit')).toMatchObject({
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    });
    expect(parameters.find((parameter) => parameter.name === 'cursor')).toMatchObject({
      in: 'query',
      schema: { type: 'string' },
    });
    // The retired spelling stays documented so a caller on it can see it is going.
    expect(parameters.find((parameter) => parameter.name === 'starting_after')).toMatchObject({
      in: 'query',
      deprecated: true,
    });
  });
});

describe('schemaToOpenApi operation names', () => {
  it('uses model-specific stable names for generated clients', () => {
    const paths = schemaToOpenApi(schema).paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    expect(paths['/v1/models/items']?.get?.operationId).toBe('listItemsRows');
    expect(paths['/v1/models/items/{id}']?.patch?.operationId).toBe(
      'updateItemsRow',
    );
    expect(paths['/v1/commits']?.post?.operationId).toBe('commit');
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
  it('carries the same properties and required fields as the Zod contract', () => {
    const published = obj(
      obj(obj(obj(obj(obj(obj(abloOpenApi().paths)['/v1/commits']).post).requestBody).content)['application/json']).schema,
    );
    const canonical = obj(z.toJSONSchema(commitRequestSchema, { io: 'input' }));
    expect(Object.keys(obj(published.properties)).sort()).toEqual(
      Object.keys(obj(canonical.properties)).sort(),
    );
    expect(published.required).toEqual(canonical.required);
  });

  it('picks up a field added to the contract without touching the generator', () => {
    const extended = commitRequestSchema.extend({ probeField: z.string().optional() });
    const derived = obj(obj(z.toJSONSchema(extended, { io: 'input' })).properties);
    expect(Object.keys(derived)).toContain('probeField');
  });
});

describe('abloOpenApi generator readiness', () => {
  const spec = abloOpenApi();
  const paths = obj(spec.paths);
  const schemas = obj(obj(spec.components).schemas);

  it('references one canonical error envelope from every error response', () => {
    for (const pathItem of Object.values(paths)) {
      for (const [method, rawOperation] of Object.entries(obj(pathItem))) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const responses = obj(obj(rawOperation).responses);
        expect(Object.keys(responses).some((status) => /^[45]/.test(status))).toBe(true);
        for (const [status, rawResponse] of Object.entries(responses)) {
          if (!/^[45]/.test(status) && status !== 'default') continue;
          const schema = obj(
            obj(obj(obj(rawResponse).content)['application/json']).schema,
          );
          expect(schema.$ref).toBe('#/components/schemas/ErrorEnvelope');
        }
      }
    }
  });

  it('names and discriminates the coordination and receipt unions', () => {
    expect(obj(schemas.ClaimAcquire).discriminator).toEqual({ propertyName: 'status' });
    expect(obj(schemas.CommitReceipt).discriminator).toEqual({ propertyName: 'status' });
    expect(obj(obj(schemas.ClaimAcquired).properties).claim).toEqual({
      $ref: '#/components/schemas/Claim',
    });
  });

  it('publishes integer page sizes for generated callers', () => {
    for (const path of ['/v1/models/{model}', '/v1/logs']) {
      const parameters = obj(obj(paths[path]).get).parameters as Json[];
      expect(parameters.find((parameter) => parameter.name === 'limit')).toMatchObject({
        schema: { type: 'integer', minimum: 1 },
      });
    }
  });

  it('uses the portable OpenAPI schema subset accepted by both generator candidates', () => {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Json;
      expect(record).not.toHaveProperty('$schema');
      expect(record).not.toHaveProperty('propertyNames');
      expect(record.additionalProperties).not.toEqual({});
      Object.values(record).forEach(visit);
    };
    visit(spec);
  });
});
