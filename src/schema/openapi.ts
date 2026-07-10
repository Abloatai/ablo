/**
 * Generates an OpenAPI 3.1 specification from a pushed schema, so the API reference
 * describes your own models rather than a fixed set. The API surface is the schema:
 * defining a `task` model is what makes `/v1/models/task` exist. This walks each
 * model's `fields` (the introspectable {@link FieldMeta}) and emits, per model, the
 * CRUD and coordination routes the API serves:
 *   GET/POST   /v1/models/{model}
 *   GET/PATCH/DELETE /v1/models/{model}/{id}
 *   POST/DELETE      /v1/models/{model}/{id}/claim
 *   POST            /v1/models/{model}/{id}/claim/heartbeat
 *   POST            /v1/models/{model}/{id}/claim/reorder
 * plus POST /v1/commits. Authentication is a single Bearer scheme, your API key.
 *
 * Feed it into codegen (for example `ablo openapi > openapi.json`) or serve it
 * directly; the return value is a plain JSON-serializable object.
 */
import type { Schema, SchemaRecord } from './schema.js';
import type { ModelDef } from './model.js';
import type { FieldMeta } from './field.js';
// Pulled from the endpoints module to keep this schema file free of the client's
// error-handling and credential dependencies.
import { ABLO_HOSTED_HTTP_BASE_URL } from '../client/hostedEndpoints.js';

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
const jsonResp = (description: string, schema: Json): Json => ({
  description,
  content: { 'application/json': { schema } },
});
const commitReceipt = (): Json =>
  jsonResp('Commit receipt', {
    type: 'object',
    properties: {
      object: { type: 'string', enum: ['commit_receipt'] },
      clientTxId: { type: 'string' },
      serverTxId: { type: 'string' },
      success: { type: 'boolean' },
      lastSyncId: { type: 'integer' },
    },
  });

export function schemaToOpenApi<S extends SchemaRecord>(
  schema: Schema<S>,
  options: SchemaToOpenApiOptions = {},
): Json {
  const models = schema.models as unknown as Record<string, ModelDef>;
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
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'order_by', in: 'query', schema: { type: 'string' } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
        ],
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
      post: { tags: [key], summary: `Heartbeat a held ${key} claim (extend the lease for long-running work)`, parameters: [idParam()], responses: { '200': jsonResp('Lease extended (or queued slot refreshed)', { type: 'object', properties: { object: { type: 'string', enum: ['claim_heartbeat'] }, claimId: { type: 'string' }, status: { type: 'string', enum: ['held', 'queued'] }, expiresAt: { type: 'integer' }, position: { type: 'integer' } } }) } },
    };
    paths[`/v1/models/${key}/{id}/claim/reorder`] = {
      post: { tags: [key], summary: `Reorder the ${key} wait-line (privileged)`, parameters: [idParam()], responses: { '200': jsonResp('Reordered', { type: 'object' }) } },
    };
  }

  paths['/v1/commits'] = {
    post: { tags: ['commits'], summary: 'Commit a batch of operations atomically', responses: { '200': commitReceipt() } },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Ablo API',
      version: options.version ?? '1.0.0',
      description:
        'Generated from your pushed Ablo schema — these routes are your models. ' +
        'Authenticate every request with your API key as a Bearer token.',
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
