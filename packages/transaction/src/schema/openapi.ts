/**
 * Two OpenAPI 3.1 documents describing the same API, for two different readers.
 *
 * The server registers ONE parameterised route family — `/api/v1/models/:model`
 * and what hangs below it, plus the coordination, credential and commit
 * resources. The count does not move when a tenant's schema does.
 * Authentication is a single Bearer scheme, your API key.
 *
 * {@link abloOpenApi} publishes that family. It takes no schema, so it cannot
 * grow with one: identical for every caller, stable across every push, and the
 * document a Python or Go client is generated from once. `spec-covers-routes`
 * holds it to the served surface in both directions, so this is the list of
 * routes rather than a description of it.
 *
 * {@link schemaToOpenApi} expands the model half into one set per model, with
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
  claimHeartbeatBatchReplySchema,
  claimListQuerySchema,
  claimListResponseSchema,
  claimReorderRequestSchema,
  claimReorderReplySchema,
  claimReleaseReplySchema,
} from '../wire/claims.js';
import { modelReadResponseSchema, modelListResponseSchema } from '../wire/modelResponses.js';
import { modelMutationRequestSchema } from '../wire/modelMutations.js';
import { logListResponseSchema, logQuerySchema } from '../wire/feedEvent.js';
import { schemaReadResponseSchema } from '../wire/accountResponses.js';
import {
  ephemeralKeyRequestSchema,
  capabilityRequestSchema,
  capabilityMintResponseSchema,
} from '../wire/auth.js';
import { EphemeralKeyResponseSchema } from '../auth/schemas.js';
import {
  capabilityRotationRequestSchema,
  capabilityRotationResponseSchema,
  sessionRevocationResponseSchema,
} from '../auth/capabilityLifecycle.js';

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
 * The body of a model-scoped write, derived from the schema the server
 * validates it against.
 *
 * It was `genericRow()` — "an object" — which described the record flat and
 * omitted the envelope entirely. A client built from that document sent the
 * row's fields at the top level, where the server looks for `data`, and every
 * one of them went missing at once.
 */
const mutationBody = (): Json =>
  jsonBody(derive(modelMutationRequestSchema, 'input'));

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

/**
 * Query parameters derived from the schema the route reads them with.
 *
 * Taking the schema as an argument rather than closing over one is what lets the
 * claim listing publish its filters too: `GET /v1/claims` accepts six, and a
 * hand-written parameter list beside them would be the drifting copy this file
 * exists to avoid.
 */
function queryParams(schema: z.ZodType): Json[] {
  const props = (derive(schema, 'input').properties ?? {}) as Record<string, Json>;
  return Object.entries(props).map(([name, s]) => ({ name, in: 'query', schema: s }));
}

/**
 * Both release routes answer in one shape. `released` distinguishes "this call
 * ended your lease" from "there was nothing of yours to end" — both success,
 * and a retry after a lost response deserves to know which it got.
 */
const releaseResp = (): Json =>
  jsonResp('Released', derive(claimReleaseReplySchema, 'output'));

const claimIdParam = (): Json => ({
  name: 'claimId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

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
 * The protocol reference: the route templates the server actually serves.
 *
 * This takes no schema, and that is the point. The server registers one
 * parameterised route family (`/api/v1/models/:model/...`), so the surface is
 * the same size no matter how many models a tenant defines — and a spec that
 * cannot see a schema cannot grow with one. It is publishable once, identical
 * for every caller, and stable across every schema push: the document a Python
 * or Go client is generated from, and the surface an agent is handed.
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
  const tags = ['models'];

  const paths: Json = {
    '/v1/models/{model}': {
      get: {
        tags,
        summary: 'List rows of a model',
        parameters: [modelParam(), ...queryParams(listQuerySchema)],
        responses: {
          '200': jsonResp(
            'A page of rows. `next_cursor` feeds `starting_after` on the next ' +
              'call; `stamp` is the watermark the page was read at.',
            withGenericRows(derive(modelListResponseSchema, 'output')),
          ),
        },
      },
      post: {
        tags,
        summary: 'Create a row',
        description:
          'The record travels in `data`; `id` is yours to choose — see the ' +
          'field for the derivation that makes a retry idempotent.',
        parameters: [modelParam()],
        requestBody: mutationBody(),
        responses: { '200': commitReceipt() },
      },
    },
    '/v1/models/{model}/{id}': {
      get: { tags, summary: 'Retrieve a row', parameters: [modelParam(), idParam()], responses: { '200': rowResp } },
      patch: {
        tags,
        summary: 'Update a row',
        description:
          'Pass `claim` and `readAt` together: the lease says nobody else is ' +
          'writing, the watermark says the row has not moved since you read it.',
        parameters: [modelParam(), idParam()],
        requestBody: mutationBody(),
        responses: { '200': commitReceipt() },
      },
      delete: {
        tags,
        summary: 'Delete a row',
        parameters: [modelParam(), idParam()],
        requestBody: { ...mutationBody(), required: false },
        responses: { '200': commitReceipt() },
      },
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
      delete: {
        tags: ['claims'],
        summary: 'Release a claim',
        parameters: [modelParam(), idParam()],
        responses: { '200': releaseResp() },
      },
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
      post: {
        tags: ['claims'],
        summary: 'Reorder the wait-line (privileged)',
        description:
          'Name the waiters you want at the front, in the order you want them. ' +
          'Waiters you leave out keep their relative places behind them.',
        parameters: [modelParam(), idParam()],
        requestBody: optionalJsonBody(derive(claimReorderRequestSchema, 'input')),
        responses: {
          '200': jsonResp('Reordered', derive(claimReorderReplySchema, 'output')),
        },
      },
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
        responses: { '201': jsonResp('The minted credential', derive(EphemeralKeyResponseSchema, 'output')) },
      },
    },
    '/v1/claims': {
      get: {
        tags: ['claims'],
        summary: 'List who holds what, and who waits',
        description:
          'The coordination view: scope to a row with `model` and `id`, to a ' +
          'participant with `actorId`, `actorKind`, `onBehalfOfId` or ' +
          '`capabilityId`, or combine them. `queue` is populated only when the ' +
          'request names both `model` and `id` — a wait line belongs to one row.',
        parameters: queryParams(claimListQuerySchema),
        responses: {
          '200': jsonResp(
            'Live claims, and the wait line behind the named row.',
            derive(claimListResponseSchema, 'output'),
          ),
        },
      },
      post: {
        tags: ['claims'],
        summary: 'Claim a row named in the body',
        description:
          'The same operation as `POST /v1/models/{model}/{id}/claim`, with the ' +
          'row in `target` instead of the URL. Answers identically.',
        requestBody: jsonBody(derive(claimRequestSchema, 'input')),
        responses: {
          '201': jsonResp(
            'The lease is yours.',
            derive(claimAcquiredResponseSchema, 'output'),
          ),
          '202': jsonResp(
            'Already held, and you asked to queue. You are in line at `position`.',
            derive(claimQueuedResponseSchema, 'output'),
          ),
        },
      },
    },
    '/v1/claims/heartbeat': {
      post: {
        tags: ['claims'],
        summary: 'Heartbeat every lease you hold, in one request',
        description:
          'One round trip per cadence for a worker holding many rows, instead of ' +
          'one per row. Takes only `ttl`; the leases are whichever ones your ' +
          'credential holds on this plane.',
        requestBody: optionalJsonBody(derive(claimHeartbeatRequestSchema, 'input')),
        responses: {
          '200': jsonResp(
            'One ack per lease extended.',
            derive(claimHeartbeatBatchReplySchema, 'output'),
          ),
        },
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
        parameters: [claimIdParam()],
        responses: { '200': jsonResp('The claim state', derive(claimStateSchema, 'output')) },
      },
      delete: {
        tags: ['claims'],
        summary: 'Release a claim, or leave the wait line',
        description:
          'The same call for both: releasing a held lease and abandoning a queued ' +
          'position are one operation, because a queue entry is a lease in a ' +
          'different state.',
        parameters: [claimIdParam()],
        responses: { '200': releaseResp() },
      },
    },
    '/v1/claims/{claimId}/heartbeat': {
      post: {
        tags: ['claims'],
        summary: 'Heartbeat a claim by id — held or queued',
        description:
          'The beat a waiter needs: a queued caller holds nothing but the ' +
          '`claimId` it was handed at enqueue, and an entry that stops beating ' +
          'drops out of the line on TTL. The reply doubles as the wait poll — ' +
          '`queued` means still in line, `held` means the grant landed, at which ' +
          'point `GET /v1/claims/{claimId}` carries the fence token.',
        parameters: [claimIdParam()],
        requestBody: optionalJsonBody(derive(claimHeartbeatRequestSchema, 'input')),
        responses: {
          '200': jsonResp(
            'Lease extended, or queued slot refreshed.',
            derive(claimHeartbeatReplySchema, 'output'),
          ),
        },
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
        responses: {
          // 201, not 200. The reference said 200 while the route has always
          // answered 201, so a generated client checking the documented code
          // failed on every successful mint.
          '201': jsonResp(
            'The minted capability. `token` is the credential — carry it as the ' +
              'Bearer token on every other call. `scope` is what was minted, ' +
              'which is not always what was asked for.',
            derive(capabilityMintResponseSchema, 'output'),
          ),
        },
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
        responses: {
          '200': jsonResp(
            'Revoked',
            derive(sessionRevocationResponseSchema, 'output'),
          ),
        },
      },
    },
    '/v1/capabilities/{id}/rotate': {
      post: {
        tags: ['credentials'],
        summary: 'Rotate a capability, keeping its grant',
        parameters: [idParam()],
        requestBody: optionalJsonBody(
          derive(capabilityRotationRequestSchema, 'input'),
        ),
        responses: {
          '201': jsonResp(
            'The rotated capability',
            derive(capabilityRotationResponseSchema, 'output'),
          ),
        },
      },
    },
    '/v1/schema': {
      get: {
        tags: ['schema'],
        summary: 'What the models look like',
        description:
          "The schema deployed on your credential's plane: every model with its " +
          'fields, their types, and its relations. Read this when you have no ' +
          'local schema declaration to read types from — it is what makes a ' +
          'field typo a local check rather than a rejected write. Each model ' +
          'carries a content `hash` that moves only when its shape does, so read ' +
          'the shape once and poll the hashes after: a refetch only ever answers ' +
          'a push.',
        responses: {
          '200': jsonResp(
            'The deployed schema, or `active: false` when nothing is pushed.',
            derive(schemaReadResponseSchema, 'output'),
          ),
        },
      },
    },
    '/v1/logs': {
      get: {
        tags: ['logs'],
        summary: 'Tail what changed',
        description:
          'How a caller without a socket learns what its peers did. Omit ' +
          '`after` for the most recent entries, then copy each page\'s ' +
          '`next_cursor` back as `after` to walk forward. Scope is taken from ' +
          'your key — organization, plane and sync groups — so a caller cannot ' +
          'widen what it sees by asking.',
        parameters: queryParams(logQuerySchema),
        responses: {
          '200': jsonResp(
            'A page of the feed, oldest first. Entries are discriminated on ' +
              '`object`, so a reader that meets an entry kind it does not know ' +
              'can skip it and keep paging.',
            derive(logListResponseSchema, 'output'),
          ),
        },
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
        parameters: queryParams(listQuerySchema),
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
