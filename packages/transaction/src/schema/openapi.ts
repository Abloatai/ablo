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
import {
  commitRequestSchema,
  commitReceiptSchema,
  commitRecordSchema,
  commitRecordListSchema,
  commitRecordWhereSchema,
} from '../wire/commit.js';
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
import { errorEnvelopeSchema } from '../wire/errorEnvelope.js';
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
import {
  branchCredentialRequestSchema,
  branchCredentialResponseSchema,
  branchListResponseSchema,
  branchResponseSchema,
  branchStatusResponseSchema,
  createBranchRequestSchema,
} from '../branches.js';
import { modelClaimSchema } from '../coordination/schema.js';

/** Options for {@link schemaToOpenApi} — the metadata stamped into the generated spec. */
export interface SchemaToOpenApiOptions {
  /** Spec title. Default `"Ablo API"`. */
  readonly title?: string;
  /** Spec version. Published artifacts pass the current Ablo package version. */
  readonly version?: string;
  /** API base URL. Default `"https://api.abloatai.com/api"`. */
  readonly serverUrl?: string;
}

type Json = Record<string, unknown>;

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * Give generators a stable public name for every operation.
 *
 * The map is deliberately exhaustive: adding a route without naming it throws
 * while rendering the document instead of letting each language generator
 * invent a different method name.
 */
function applyOperationIds(
  paths: Json,
  operationIds: Readonly<Record<string, string>>,
): void {
  const usedKeys = new Set<string>();
  const usedIds = new Set<string>();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = rawPathItem as Json;
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const operationId = operationIds[key];
      if (!operationId) {
        throw new Error(`OpenAPI operation ${key} has no stable operationId`);
      }
      if (usedIds.has(operationId)) {
        throw new Error(`OpenAPI operationId ${operationId} is not unique`);
      }
      pathItem[method] = { ...(rawOperation as Json), operationId };
      usedKeys.add(key);
      usedIds.add(operationId);
    }
  }

  const stale = Object.keys(operationIds).filter((key) => !usedKeys.has(key));
  if (stale.length > 0) {
    throw new Error(
      `OpenAPI operationId map names operations that do not exist: ${stale.join(', ')}`,
    );
  }
}

const ABLO_OPERATION_IDS: Readonly<Record<string, string>> = {
  'GET /v1/models/{model}': 'listModelRows',
  'POST /v1/models/{model}': 'createModelRow',
  'GET /v1/models/{model}/{id}': 'getModelRow',
  'PATCH /v1/models/{model}/{id}': 'updateModelRow',
  'DELETE /v1/models/{model}/{id}': 'deleteModelRow',
  'POST /v1/models/{model}/{id}/claim': 'acquireModelClaim',
  'DELETE /v1/models/{model}/{id}/claim': 'releaseModelClaim',
  'POST /v1/models/{model}/{id}/claim/heartbeat': 'heartbeatModelClaim',
  'POST /v1/models/{model}/{id}/claim/reorder': 'reorderModelClaimQueue',
  'POST /v1/ephemeral_keys': 'mintEphemeralKey',
  'GET /v1/branches': 'listBranches',
  'POST /v1/branches': 'createBranch',
  'GET /v1/branches/{id}': 'getBranch',
  'DELETE /v1/branches/{id}': 'deleteBranch',
  'POST /v1/branches/{id}/credentials': 'mintBranchCredential',
  'GET /v1/branches/{id}/status': 'getBranchStatus',
  'GET /v1/claims': 'listClaims',
  'POST /v1/claims': 'acquireClaim',
  'POST /v1/claims/heartbeat': 'heartbeatClaims',
  'GET /v1/claims/{claimId}': 'getClaim',
  'DELETE /v1/claims/{claimId}': 'releaseClaim',
  'POST /v1/claims/{claimId}/heartbeat': 'heartbeatClaim',
  'POST /v1/capabilities': 'mintCapability',
  'GET /v1/capabilities/{id}': 'getCapability',
  'DELETE /v1/capabilities/{id}': 'revokeCapability',
  'POST /v1/capabilities/{id}/rotate': 'rotateCapability',
  'GET /v1/schema': 'getSchema',
  'GET /v1/logs': 'listLogEntries',
  'GET /v1/commits': 'listCommits',
  'POST /v1/commits': 'commit',
  'GET /v1/commits/{id}': 'getCommit',
};

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
const schemaRef = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const namedResp = (description: string, name: string): Json =>
  jsonResp(description, schemaRef(name));

/**
 * Zod emits JSON Schema 2020-12. OpenAPI 3.1 accepts it, but SDK generators
 * intentionally support a narrower, portable subset:
 *
 * - `$schema` belongs on a standalone JSON Schema document, not every embedded
 *   OpenAPI Schema Object;
 * - `propertyNames` constraining keys to strings is redundant for JSON objects,
 *   whatever else it constrains, and is unsupported by Stainless. The key rule
 *   still binds at runtime, where the Zod schema parses;
 * - `additionalProperties: {}` means "any JSON value", but Stainless requires
 *   the equivalent, explicit `true`.
 *
 * Keeping this normalization at the rendering boundary lets the Zod schemas
 * remain the wire authority without publishing generator-hostile syntax.
 */
function portableSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableSchema);
  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === '$schema') continue;
    if (
      key === 'propertyNames' &&
      typeof child === 'object' &&
      child !== null &&
      (child as Record<string, unknown>).type === 'string'
    ) {
      continue;
    }
    if (
      key === 'additionalProperties' &&
      typeof child === 'object' &&
      child !== null &&
      Object.keys(child).length === 0
    ) {
      result[key] = true;
      continue;
    }
    result[key] = portableSchema(child);
  }
  return result;
}
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
  portableSchema(
    z.toJSONSchema(schema, { io, unrepresentable: 'any' }),
  ) as Json;

const commitReceipt = (): Json => namedResp('Commit receipt', 'CommitReceipt');

const modelParam = (): Json => ({
  name: 'model',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'A model name from your pushed schema, e.g. `item`.',
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
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: 'query',
    // Query strings arrive at the server as text, but OpenAPI describes the
    // caller-facing value before serialization. Generated clients should take
    // an integer here and encode it, not expose a stringly typed page size.
    schema: name === 'limit'
      ? { type: 'integer', minimum: 1 }
      : s,
  }));
}

const commitRecordListQuerySchema = commitRecordWhereSchema.safeExtend({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * Both release routes answer in one shape. `released` distinguishes "this call
 * ended your lease" from "there was nothing of yours to end" — both success,
 * and a retry after a lost response deserves to know which it got.
 */
const releaseResp = (): Json =>
  namedResp('Released', 'ClaimRelease');

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
      version: options.version ?? 'development',
      description,
      license: {
        name: 'Apache License 2.0',
        identifier: 'Apache-2.0',
      },
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

const ERROR_RESPONSES: Readonly<Record<string, string>> = {
  '400': 'The request did not satisfy the published contract.',
  '401': 'The Bearer credential is missing, malformed, or expired.',
  '403': 'The credential does not authorize this operation.',
  '404': 'The addressed resource does not exist in the credential scope.',
  '409': 'The request conflicts with current claim, version, or idempotency state.',
  '429': 'The caller exceeded an enforced rate limit.',
  '500': 'The server could not complete the request.',
  '503': 'A required service is temporarily unavailable.',
};

/**
 * Every route passes failures through the same server error funnel. Publish
 * that fact on every operation so generated transports decode all HTTP errors
 * through `ErrorEnvelope`, rather than falling back to a language-specific raw
 * response type.
 */
function attachCanonicalErrors(paths: Json): void {
  for (const rawPathItem of Object.values(paths)) {
    const pathItem = rawPathItem as Json;
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = rawOperation as Json;
      const responses = { ...(operation.responses as Json | undefined) };
      for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
        responses[status] = namedResp(description, 'ErrorEnvelope');
      }
      responses.default = namedResp(
        'An HTTP error not otherwise listed; decoded through the canonical envelope.',
        'ErrorEnvelope',
      );
      operation.responses = responses;
    }
  }
}

function abloComponentSchemas(): Record<string, Json> {
  const commitReceiptSchemaJson = derive(commitReceiptSchema, 'output');
  commitReceiptSchemaJson.discriminator = { propertyName: 'status' };

  const schemas: Record<string, Json> = {
    Cursor: {
      type: 'string',
      description: 'An opaque pagination position. Copy it unchanged into the next request.',
    },
    ErrorEnvelope: derive(errorEnvelopeSchema, 'output'),
    Claim: derive(modelClaimSchema, 'output'),
    ClaimAcquire: {
      oneOf: [schemaRef('ClaimAcquired'), schemaRef('ClaimQueued')],
      discriminator: { propertyName: 'status' },
    },
    ClaimAcquired: derive(claimAcquiredResponseSchema, 'output'),
    ClaimQueued: derive(claimQueuedResponseSchema, 'output'),
    ClaimState: derive(claimStateSchema, 'output'),
    ClaimList: derive(claimListResponseSchema, 'output'),
    ClaimHeartbeat: derive(claimHeartbeatReplySchema, 'output'),
    ClaimHeartbeatBatch: derive(claimHeartbeatBatchReplySchema, 'output'),
    ClaimRelease: derive(claimReleaseReplySchema, 'output'),
    ClaimReorder: derive(claimReorderReplySchema, 'output'),
    CommitReceipt: commitReceiptSchemaJson,
    ModelRead: withGenericRows(derive(modelReadResponseSchema, 'output')),
    ModelPage: withGenericRows(derive(modelListResponseSchema, 'output')),
    LogPage: derive(logListResponseSchema, 'output'),
    SchemaRead: derive(schemaReadResponseSchema, 'output'),
  };

  // Reuse protocol concepts inside the named envelopes too. Without these
  // refs, generators invent separate anonymous Claim and cursor models for
  // every operation even though the server validates one canonical shape.
  const properties = (name: string): Record<string, Json> =>
    (schemas[name]?.properties ?? {}) as Record<string, Json>;
  properties('ClaimAcquired').claim = schemaRef('Claim');
  (properties('ClaimList').data as Json).items = schemaRef('Claim');
  (properties('ModelRead').claims as Json).items = schemaRef('Claim');

  for (const name of ['ClaimList', 'ModelPage', 'LogPage']) {
    properties(name).next_cursor = {
      oneOf: [schemaRef('Cursor'), { type: 'null' }],
    };
  }

  return schemas;
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
  const rowResp = namedResp(
    'The row, with the watermark it was read at and who holds it.',
    'ModelRead',
  );
  const tags = ['models'];

  const paths: Json = {
    '/v1/models/{model}': {
      get: {
        tags,
        summary: 'List rows of a model',
        parameters: [modelParam(), ...queryParams(listQuerySchema)],
        responses: {
          '200': namedResp(
            'A page of rows. `next_cursor` feeds `starting_after` on the next ' +
              'call; `stamp` is the watermark the page was read at.',
            'ModelPage',
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
          '201': namedResp(
            'The lease is yours. `claim.fenceToken` is set when the coordinator ' +
              'minted one; carry it on writes made under the lease.',
            'ClaimAcquire',
          ),
          '202': namedResp(
            'The row was already held and you asked to queue. You are in line at ' +
              '`position` — heartbeat to keep the slot, and poll ' +
              '`GET /v1/claims/{claimId}` for the grant.',
            'ClaimAcquire',
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
          '200': namedResp(
            'Lease extended (or queued slot refreshed)',
            'ClaimHeartbeat',
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
          '200': namedResp('Reordered', 'ClaimReorder'),
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
        requestBody: jsonBody(derive(ephemeralKeyRequestSchema, 'input')),
        responses: { '201': jsonResp('The minted credential', derive(EphemeralKeyResponseSchema, 'output')) },
      },
    },
    '/v1/branches': {
      get: {
        tags: ['branches'],
        summary: 'List transaction branches for the credential project',
        responses: {
          '200': jsonResp(
            'The root and every active child branch.',
            derive(branchListResponseSchema, 'output'),
          ),
        },
      },
      post: {
        tags: ['branches'],
        summary: 'Create an isolated child branch',
        description:
          'The returned id is immutable; retain it for automation. The slug is a project-scoped human handle.',
        requestBody: jsonBody(derive(createBranchRequestSchema, 'input')),
        responses: {
          '201': jsonResp('The ready branch.', derive(branchResponseSchema, 'output')),
        },
      },
    },
    '/v1/branches/{id}': {
      get: {
        tags: ['branches'],
        summary: 'Retrieve a branch by immutable id',
        parameters: [idParam()],
        responses: {
          '200': jsonResp('The branch.', derive(branchResponseSchema, 'output')),
        },
      },
      delete: {
        tags: ['branches'],
        summary: 'Delete a non-root branch and revoke its credentials',
        parameters: [idParam()],
        responses: {
          '200': jsonResp('The deleted branch.', derive(branchResponseSchema, 'output')),
        },
      },
    },
    '/v1/branches/{id}/credentials': {
      post: {
        tags: ['branches', 'credentials'],
        summary: 'Mint an expiring branch-bound test credential',
        parameters: [idParam()],
        requestBody: optionalJsonBody(
          derive(branchCredentialRequestSchema, 'input'),
        ),
        responses: {
          '201': jsonResp(
            'A one-time plaintext credential. Do not persist it in source control.',
            derive(branchCredentialResponseSchema, 'output'),
          ),
        },
      },
    },
    '/v1/branches/{id}/status': {
      get: {
        tags: ['branches'],
        summary: 'Diagnose one branch',
        description:
          'Returns branch lifecycle, active schema, compatibility with the parent schema, safe datasource coordinates, and readiness blockers.',
        parameters: [idParam()],
        responses: {
          '200': jsonResp(
            'The complete branch readiness view.',
            derive(branchStatusResponseSchema, 'output'),
          ),
        },
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
          '200': namedResp(
            'Live claims, and the wait line behind the named row.',
            'ClaimList',
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
          '201': namedResp(
            'The lease is yours.',
            'ClaimAcquire',
          ),
          '202': namedResp(
            'Already held, and you asked to queue. You are in line at `position`.',
            'ClaimAcquire',
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
          'credential holds on this branch.',
        requestBody: optionalJsonBody(derive(claimHeartbeatRequestSchema, 'input')),
        responses: {
          '200': namedResp(
            'One ack per lease extended.',
            'ClaimHeartbeatBatch',
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
        responses: { '200': namedResp('The claim state', 'ClaimState') },
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
          'Keep a held or queued claim active. Branch on the returned status: ' +
          '`queued` is still waiting and `held` has been granted. Retrieve the ' +
          'claim after a grant before writing.',
        parameters: [claimIdParam()],
        requestBody: optionalJsonBody(derive(claimHeartbeatRequestSchema, 'input')),
        responses: {
          '200': namedResp(
            'Lease extended, or queued slot refreshed.',
            'ClaimHeartbeat',
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
          "The schema deployed on your credential's branch: every model with its " +
          'fields, their types, and its relations. Read this when you have no ' +
          'local schema declaration to read types from — it is what makes a ' +
          'field typo a local check rather than a rejected write. Each model ' +
          'carries a content `hash` that moves only when its shape does, so read ' +
          'the shape once and poll the hashes after: a refetch only ever answers ' +
          'a push.',
        responses: {
          '200': namedResp(
            'The deployed schema, or `active: false` when nothing is pushed.',
            'SchemaRead',
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
          'your key — organization, branch and sync groups — so a caller cannot ' +
          'widen what it sees by asking.',
        parameters: queryParams(logQuerySchema),
        responses: {
          '200': namedResp(
            'A page of the feed, oldest first. Entries are discriminated on ' +
              '`object`, so a reader that meets an entry kind it does not know ' +
              'can skip it and keep paging.',
            'LogPage',
          ),
        },
      },
    },
    '/v1/commits': {
      get: {
        tags: ['commits'],
        summary: 'List commit records',
        parameters: queryParams(commitRecordListQuerySchema),
        responses: { '200': jsonResp('Tenant-scoped commit records', derive(commitRecordListSchema, 'output')) },
      },
      post: {
        tags: ['commits'],
        summary: 'Commit a batch of operations atomically, and/or register durable premises',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay-safe key; the server returns the cached receipt on retry.' }],
        requestBody: commitBody(),
        responses: { '200': commitReceipt() },
      },
    },
    '/v1/commits/{id}': {
      get: {
        tags: ['commits'],
        summary: 'Retrieve a commit record',
        parameters: [idParam()],
        responses: { '200': jsonResp('The commit record, or null when absent', derive(commitRecordSchema.nullable(), 'output')) },
      },
    },
  };

  applyOperationIds(paths, ABLO_OPERATION_IDS);
  attachCanonicalErrors(paths);

  return envelope(
    options,
    'Ablo collaboration infrastructure: commit, read, and claim. `{model}` is any model ' +
      'from your pushed schema — the routes are the same whichever it is. ' +
      'Authenticate every request with your API key as a Bearer token.',
    paths,
    abloComponentSchemas(),
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
  const operationIds: Record<string, string> = {};

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

    const collectionPath = `/v1/models/${key}`;
    const rowPath = `/v1/models/${key}/{id}`;
    const claimPath = `/v1/models/${key}/{id}/claim`;
    const heartbeatPath = `/v1/models/${key}/{id}/claim/heartbeat`;
    const reorderPath = `/v1/models/${key}/{id}/claim/reorder`;
    const modelName = pascal(key);

    operationIds[`GET ${collectionPath}`] = `list${modelName}Rows`;
    operationIds[`POST ${collectionPath}`] = `create${modelName}Row`;
    operationIds[`GET ${rowPath}`] = `get${modelName}Row`;
    operationIds[`PATCH ${rowPath}`] = `update${modelName}Row`;
    operationIds[`DELETE ${rowPath}`] = `delete${modelName}Row`;
    operationIds[`POST ${claimPath}`] = `acquire${modelName}Claim`;
    operationIds[`DELETE ${claimPath}`] = `release${modelName}Claim`;
    operationIds[`POST ${heartbeatPath}`] = `heartbeat${modelName}Claim`;
    operationIds[`POST ${reorderPath}`] = `reorder${modelName}ClaimQueue`;

    paths[collectionPath] = {
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
    paths[rowPath] = {
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
    paths[claimPath] = {
      post: { tags: [key], summary: `Claim a ${key} (acquire lease)`, parameters: [idParam()], responses: { '200': jsonResp('Claim acquired', { type: 'object' }) } },
      delete: { tags: [key], summary: `Release a ${key} claim`, parameters: [idParam()], responses: { '200': jsonResp('Released', { type: 'object' }) } },
    };
    paths[heartbeatPath] = {
      post: { tags: [key], summary: `Heartbeat a held ${key} claim (extend the lease for long-running work)`, parameters: [idParam()], responses: { '200': jsonResp('Lease extended (or queued slot refreshed)', derive(claimHeartbeatReplySchema, 'output')) } },
    };
    paths[reorderPath] = {
      post: { tags: [key], summary: `Reorder the ${key} wait-line (privileged)`, parameters: [idParam()], responses: { '200': jsonResp('Reordered', { type: 'object' }) } },
    };
  }

  paths['/v1/commits'] = {
    get: {
      tags: ['commits'],
      summary: 'List commit records',
      parameters: queryParams(commitRecordListQuerySchema),
      responses: { '200': jsonResp('Tenant-scoped commit records', derive(commitRecordListSchema, 'output')) },
    },
    post: {
      tags: ['commits'],
      summary: 'Commit a batch of operations atomically, and/or register durable premises',
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay-safe key; the server returns the cached receipt on retry.' }],
      requestBody: commitBody(),
      responses: { '200': commitReceipt() },
    },
  };
  paths['/v1/commits/{id}'] = {
    get: {
      tags: ['commits'],
      summary: 'Retrieve a commit record',
      parameters: [idParam()],
      responses: { '200': jsonResp('The commit record, or null when absent', derive(commitRecordSchema.nullable(), 'output')) },
    },
  };
  operationIds['GET /v1/commits'] = 'listCommits';
  operationIds['POST /v1/commits'] = 'commit';
  operationIds['GET /v1/commits/{id}'] = 'getCommit';
  applyOperationIds(paths, operationIds);
  attachCanonicalErrors(paths);

  Object.assign(schemas, abloComponentSchemas());

  return envelope(
    options,
    'Generated from your pushed Ablo schema — these routes are your models. ' +
      'Authenticate every request with your API key as a Bearer token.',
    paths,
    schemas,
  );
}
