/**
 * Two OpenAPI 3.1 documents describing the same API, for two different readers.
 *
 * The server registers ONE parameterised route family — `/api/v1/models/:model`,
 * `/:id`, `/:id/claim`, `/claim/heartbeat`, `/claim/reorder`, plus `/v1/commits`.
 * Six routes, whatever a tenant's schema contains. Authentication is a single
 * Bearer scheme, your API key.
 *
 * {@link abloOpenApi} publishes exactly those six. It takes no schema, so it
 * cannot grow with one: identical for every caller, stable across every push,
 * and the document a Python or Go client is generated from once.
 *
 * {@link schemaToOpenApi} expands the same six into one set per model, with
 * payloads typed from each model's introspectable {@link FieldMeta}. Five paths
 * per model, regenerated on every push — worth it when you want generated types
 * for one schema, and the wrong thing to hand an agent.
 *
 * Both return a plain JSON-serializable object; feed either into codegen (for
 * example `ablo openapi > openapi.json`) or serve it directly.
 */
import type { Schema, SchemaRecord } from './schema.js';
import type { FieldMeta } from './field.js';
// Pulled from the endpoints module to keep this schema file free of the client's
// error-handling and credential dependencies.
import { ABLO_HOSTED_HTTP_BASE_URL } from '../auth/hostedEndpoints.js';
// The commit body is DERIVED from the schema the server validates against —
// one definition site, so the documented surface cannot drift from the
// enforced one.
import { z } from 'zod';
import { commitRequestSchema, commitReceiptSchema } from '../wire/commit.js';
import {
  claimRequestSchema,
  claimHeartbeatRequestSchema,
  listQuerySchema,
  claimStateSchema,
  claimAcquiredResponseSchema,
  claimQueuedResponseSchema,
  claimHeartbeatReplySchema,
} from '../wire/claims.js';
import { modelReadResponseSchema, modelListResponseSchema } from '../wire/modelResponses.js';
import { ephemeralKeyRequestSchema, capabilityRequestSchema } from '../wire/auth.js';
import { EphemeralKeyResponseSchema } from '../auth/schemas.js';

/** Options for {@link schemaToOpenApi} — the metadata stamped into the generated spec. */
export interface SchemaToOpenApiOptions {
  /** Spec title. Default `"Ablo API"`. */
  readonly title?: string;
  /** Spec version. Default `"1.0.0"`. */
  readonly version?: string;
  /** API base URL. Default `"https://api.abloatai.com/api"`. */
  readonly serverUrl?: string;
}

type Json = Record<string, unknown>;

function fieldSchema(f: FieldMeta): Json {
  switch (f.type) {
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'enum':
      return f.enumValues ? { type: 'string', enum: [...f.enumValues] } : { type: 'string' };
    case 'json':
      return { type: 'object', additionalProperties: true };
    case 'string':
    default:
      return { type: 'string' };
  }
}

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const idParam = (): Json => ({ name: 'id', in: 'path', required: true, schema: { type: 'string' } });
const jsonBody = (schema: Json): Json => ({
  required: true,
  content: { 'application/json': { schema } },
});
/** For routes where an empty body is meaningful — a bare claim, a plain beat. */
const optionalJsonBody = (schema: Json): Json => ({
  required: false,
  content: { 'application/json': { schema } },
});
const jsonResp = (description: string, schema: Json): Json => ({
  description,
  content: { 'application/json': { schema } },
});
/**
 * Derive a JSON Schema from a wire schema.
 *
 * `io` is not optional by accident. A request is what the caller SENDS, so it
 * derives from the input type; a response is what the server RETURNS, so it
 * derives from the output type. Reversing them is silent — the document still
 * looks like a working spec — which is why the direction is stated at every
 * call site rather than defaulted.
 */
const derive = (schema: z.ZodType, io: 'input' | 'output'): Json =>
  z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Json;

const commitReceipt = (): Json => jsonResp('Commit receipt', derive(commitReceiptSchema, 'output'));

const modelParam = (): Json => ({
  name: 'model',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'A model name from your pushed schema, e.g. `task`.',
});
const genericRow = (): Json => ({ type: 'object', additionalProperties: true });

/**
 * Fill in `data` on a derived model-response schema.
 *
 * The wire schemas type a row as `unknown`, because the transport that reads
 * them serves every schema and knows none of them. A reference has the opposite
 * need — a reader wants to see that `data` holds rows — so the envelope is
 * still derived, and only the one deliberately-open field is described. Both
 * shapes of that field are handled: an array for a list, a bare object for a
 * single read.
 */
function withGenericRows(derived: Json): Json {
  const properties = { ...(derived.properties as Record<string, Json> | undefined) };
  if (!('data' in properties)) return derived;
  properties.data =
    (properties.data as Json | undefined)?.type === 'array'
      ? { type: 'array', items: genericRow() }
      : genericRow();
  return { ...derived, properties };
}

/** Query parameters derived from the schema the route reads them with. */
function listQueryParams(): Json[] {
  const props = (derive(listQuerySchema, 'input').properties ?? {}) as Record<string, Json>;
  return Object.entries(props).map(([name, schema]) => ({ name, in: 'query', schema }));
}

/**
 * The `POST /v1/commits` body, derived from {@link commitRequestSchema} — the
 * same schema the server validates the request against.
 *
 * Deriving rather than describing is the point: a hand-written copy of this
 * shape would drift silently, and the tests would pin the copy to itself.
 */
const commitBody = (): Json => jsonBody(derive(commitRequestSchema, 'input'));

/** The envelope shared by both specs — same server, same auth, same version. */
function envelope(options: SchemaToOpenApiOptions, description: string, paths: Json, schemas: Record<string, Json>): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Ablo API',
      version: options.version ?? '1.0.0',
      description,
    },
    servers: [{ url: options.serverUrl ?? `${ABLO_HOSTED_HTTP_BASE_URL}/api` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Your Ablo API key (sk_… / rk_…).' },
      },
      schemas,
    },
    paths,
  };
}

/**
 * The protocol reference: the five route templates the server actually serves,
 * plus `/v1/commits`.
 *
 * This takes no schema, and that is the point. The server registers one
 * parameterised route family (`/api/v1/models/:model/...`), so the API is five
 * routes no matter how many models a tenant defines — and a spec that cannot see
 * a schema cannot grow with one. It is publishable once, identical for every
 * caller, and stable across every schema push: the document a Python or Go
 * client is generated from, and the surface an agent is handed.
 *
 * Payload shapes are generic here by design. A caller that wants them typed
 * either reads the schema at runtime or generates the per-tenant expansion with
 * {@link schemaToOpenApi}.
 */
export function abloOpenApi(options: SchemaToOpenApiOptions = {}): Json {
  const rowResp = jsonResp(
    'The row, with the watermark it was read at and who holds it.',
    withGenericRows(derive(modelReadResponseSchema, 'output')),
  );
  const writeBody = jsonBody(genericRow());
  const tags = ['models'];

  const paths: Json = {
    '/v1/models/{model}': {
      get: {
        tags,
        summary: 'List rows of a model',
        parameters: [modelParam(), ...listQueryParams()],
        responses: {
          '200': jsonResp(
            'A page of rows. `next_cursor` feeds `starting_after` on the next ' +
              'call; `stamp` is the watermark the page was read at.',
            withGenericRows(derive(modelListResponseSchema, 'output')),
          ),
        },
      },
      post: { tags, summary: 'Create a row', parameters: [modelParam()], requestBody: writeBody, responses: { '200': commitReceipt() } },
    },
    '/v1/models/{model}/{id}': {
      get: { tags, summary: 'Retrieve a row', parameters: [modelParam(), idParam()], responses: { '200': rowResp } },
      patch: { tags, summary: 'Update a row', parameters: [modelParam(), idParam()], requestBody: writeBody, responses: { '200': commitReceipt() } },
      delete: { tags, summary: 'Delete a row', parameters: [modelParam(), idParam()], responses: { '200': commitReceipt() } },
    },
    '/v1/models/{model}/{id}/claim': {
      post: {
        tags: ['claims'],
        summary: 'Claim a row (acquire lease)',
        parameters: [modelParam(), idParam()],
        requestBody: optionalJsonBody(derive(claimRequestSchema, 'input')),
        responses: {
          '201': jsonResp(
            'The lease is yours. `claim.fenceToken` is set when the coordinator ' +
              'minted one; carry it on writes made under the lease.',
            derive(claimAcquiredResponseSchema, 'output'),
          ),
          '202': jsonResp(
            'The row was already held and you asked to queue. You are in line at ' +
              '`position` — heartbeat to keep the slot, and poll ' +
              '`GET /v1/claims/{claimId}` for the grant.',
            derive(claimQueuedResponseSchema, 'output'),
          ),
        },
      },
      delete: { tags: ['claims'], summary: 'Release a claim', parameters: [modelParam(), idParam()], responses: { '200': jsonResp('Released', { type: 'object' }) } },
    },
    '/v1/models/{model}/{id}/claim/heartbeat': {
      post: {
        tags: ['claims'],
        summary: 'Heartbeat a held claim (extend the lease for long-running work)',
        parameters: [modelParam(), idParam()],
        requestBody: optionalJsonBody(derive(claimHeartbeatRequestSchema, 'input')),
        responses: {
          '200': jsonResp(
            'Lease extended (or queued slot refreshed)',
            derive(claimHeartbeatReplySchema, 'output'),
          ),
        },
      },
    },
    '/v1/models/{model}/{id}/claim/reorder': {
      post: { tags: ['claims'], summary: 'Reorder the wait-line (privileged)', parameters: [modelParam(), idParam()], responses: { '200': jsonResp('Reordered', { type: 'object' }) } },
    },
    '/v1/ephemeral_keys': {
      post: {
        tags: ['credentials'],
        summary: 'Mint a short-lived session credential',
        description:
          'Call this first: every other route needs the key it returns. Requires a ' +
          'secret (`sk_`) key — a session cannot mint itself.',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay-safe key; the server returns the cached credential on retry.' },
        ],
        requestBody: jsonBody(derive(ephemeralKeyRequestSchema, 'input')),
        responses: { '200': jsonResp('The minted credential', derive(EphemeralKeyResponseSchema, 'output')) },
      },
    },
    '/v1/claims/{claimId}': {
      get: {
        tags: ['claims'],
        summary: 'Poll a claim for its current state',
        description:
          'How a caller without a persistent connection learns its queued claim ' +
          'was granted. `position` is advisory — a privileged reorder can move it ' +
          'up — so branch on `status`, never on position.',
        parameters: [{ name: 'claimId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': jsonResp('The claim state', derive(claimStateSchema, 'output')) },
      },
      delete: {
        tags: ['claims'],
        summary: 'Release a claim, or leave the wait line',
        description:
          'The same call for both: releasing a held lease and abandoning a queued ' +
          'position are one operation, because a queue entry is a lease in a ' +
          'different state.',
        parameters: [{ name: 'claimId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': jsonResp('Released', { type: 'object' }) },
      },
    },
    '/v1/capabilities': {
      post: {
        tags: ['credentials'],
        summary: 'Mint a capability for an agent or system',
        description:
          'A scoped, revocable grant. Narrow by default: an agent or system ' +
          'capability must name its `syncGroups` and `operations`.',
        requestBody: jsonBody(derive(capabilityRequestSchema, 'input')),
        responses: { '200': jsonResp('The minted capability', { type: 'object' }) },
      },
    },
    '/v1/capabilities/{id}': {
      get: {
        tags: ['credentials'],
        summary: 'Inspect a capability',
        parameters: [idParam()],
        responses: { '200': jsonResp('The capability', { type: 'object' }) },
      },
      delete: {
        tags: ['credentials'],
        summary: 'Revoke a capability',
        parameters: [idParam()],
        responses: { '200': jsonResp('Revoked', { type: 'object' }) },
      },
    },
    '/v1/capabilities/{id}/rotate': {
      post: {
        tags: ['credentials'],
        summary: 'Rotate a capability, keeping its grant',
        parameters: [idParam()],
        responses: { '200': jsonResp('The rotated capability', { type: 'object' }) },
      },
    },
    '/v1/commits': {
      post: {
        tags: ['commits'],
        summary: 'Commit a batch of operations atomically, and/or register durable premises',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay-safe key; the server returns the cached receipt on retry.' }],
        requestBody: commitBody(),
        responses: { '200': commitReceipt() },
      },
    },
  };

  return envelope(
    options,
    'The Ablo transaction layer: commit, read, and claim. `{model}` is any model ' +
      'from your pushed schema — the routes are the same whichever it is. ' +
      'Authenticate every request with your API key as a Bearer token.',
    paths,
    {},
  );
}

/**
 * The per-tenant expansion: every model's routes written out with typed payloads.
 *
 * Useful when you want generated types for one schema — five paths per model, so
 * it grows with the schema and is regenerated on every push. It documents the
 * same five routes {@link abloOpenApi} describes; it does not describe a
 * different API.
 */
export function schemaToOpenApi<S extends SchemaRecord>(
  schema: Schema<S>,
  options: SchemaToOpenApiOptions = {},
): Json {
  const models: SchemaRecord = schema.models;
  const paths: Json = {};
  const schemas: Record<string, Json> = {};

  for (const [key, def] of Object.entries(models)) {
    const ref: Json = { $ref: `#/components/schemas/${pascal(key)}` };
    const properties: Record<string, Json> = { id: { type: 'string' } };
    const required: string[] = ['id'];
    const createProps: Record<string, Json> = {};
    for (const [fname, fmeta] of Object.entries(def.fields)) {
      const fs = fieldSchema(fmeta);
      properties[fname] = fs;
      createProps[fname] = fs;
      if (!fmeta.isOptional) required.push(fname);
    }
    schemas[pascal(key)] = { type: 'object', properties, required };
    const createBody = jsonBody({ type: 'object', properties: createProps });

    paths[`/v1/models/${key}`] = {
      get: {
        tags: [key],
        summary: `List ${key}`,
        parameters: listQueryParams(),
        responses: {
          '200': jsonResp('List of rows', {
            type: 'object',
            properties: { object: { type: 'string', enum: ['list'] }, data: { type: 'array', items: ref } },
          }),
        },
      },
      post: { tags: [key], summary: `Create a ${key}`, requestBody: createBody, responses: { '200': commitReceipt() } },
    };
    paths[`/v1/models/${key}/{id}`] = {
      get: {
        tags: [key],
        summary: `Retrieve a ${key}`,
        parameters: [idParam()],
        responses: {
          '200': jsonResp('The row', {
            type: 'object',
            properties: { data: ref, stamp: { type: 'integer' } },
          }),
        },
      },
      patch: { tags: [key], summary: `Update a ${key}`, parameters: [idParam()], requestBody: createBody, responses: { '200': commitReceipt() } },
      delete: { tags: [key], summary: `Delete a ${key}`, parameters: [idParam()], responses: { '200': commitReceipt() } },
    };
    paths[`/v1/models/${key}/{id}/claim`] = {
      post: { tags: [key], summary: `Claim a ${key} (acquire lease)`, parameters: [idParam()], responses: { '200': jsonResp('Claim acquired', { type: 'object' }) } },
      delete: { tags: [key], summary: `Release a ${key} claim`, parameters: [idParam()], responses: { '200': jsonResp('Released', { type: 'object' }) } },
    };
    paths[`/v1/models/${key}/{id}/claim/heartbeat`] = {
      post: { tags: [key], summary: `Heartbeat a held ${key} claim (extend the lease for long-running work)`, parameters: [idParam()], responses: { '200': jsonResp('Lease extended (or queued slot refreshed)', derive(claimHeartbeatReplySchema, 'output')) } },
    };
    paths[`/v1/models/${key}/{id}/claim/reorder`] = {
      post: { tags: [key], summary: `Reorder the ${key} wait-line (privileged)`, parameters: [idParam()], responses: { '200': jsonResp('Reordered', { type: 'object' }) } },
    };
  }

  paths['/v1/commits'] = {
    post: {
      tags: ['commits'],
      summary: 'Commit a batch of operations atomically, and/or register durable premises',
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay-safe key; the server returns the cached receipt on retry.' }],
      requestBody: commitBody(),
      responses: { '200': commitReceipt() },
    },
  };

  return envelope(
    options,
    'Generated from your pushed Ablo schema — these routes are your models. ' +
      'Authenticate every request with your API key as a Bearer token.',
    paths,
    schemas,
  );
}
