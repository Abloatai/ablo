import { AbloValidationError } from '@abloatai/transaction/errors';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  schemaDeploymentPlanSchema,
  serializeSchema,
  type SchemaDeploymentPlan,
  type SchemaJSON,
  type Schema,
  type DatabaseSnapshot,
  type BackfillValue,
  type DeploymentManifest,
  deploymentManifestSchema,
} from '@abloatai/transaction/schema';
import { readProjectAdminDatabaseUrl } from '../dbRole';
import { loadSchema } from '../push';
import { resolveRuntimeApiKeyReadOnly } from '../config';
import { apiBaseUrl, requestControlPlane } from '../controlPlane';
import { inspectDatabase } from './inspectDatabase';
import { renderDeploymentPlan } from './render';

export const PLAN_USAGE = `  ablo plan — reconcile source schema, active Ablo schema, and PostgreSQL (read-only)

  Usage:
    npx ablo plan
    npx ablo plan --json
    npx ablo plan --manifest ablo/deployment.json
    npx ablo plan --schema path.ts --export schema --app-schema public

  Reads ABLO_API_KEY and DATABASE_ADMIN_URL/DATABASE_URL. A manifest declares
  dual-write/backfill/verify/switch/contract gates. Planning never changes state.`;

export interface PlanArgs { schemaPath: string; exportName: string; appSchema: string; json: boolean; url?: string; manifestPath?: string; }

export function parsePlanArgs(argv: readonly string[]): PlanArgs {
  const args: PlanArgs = { schemaPath: 'ablo/schema.ts', exportName: 'schema', appSchema: 'public', json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--schema') args.schemaPath = argv[++index] ?? args.schemaPath;
    else if (arg === '--export') args.exportName = argv[++index] ?? args.exportName;
    else if (arg === '--app-schema') args.appSchema = argv[++index] ?? args.appSchema;
    else if (arg === '--url') args.url = argv[++index];
    else if (arg === '--manifest') args.manifestPath = argv[++index];
    else throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
  }
  return args;
}

export interface CreateDeploymentPlanOptions {
  readonly schema: Schema;
  readonly schemaPath: string;
  readonly appSchema: string;
  readonly apiKey: string;
  readonly databaseUrl?: string;
  readonly url?: string;
  readonly renames?: readonly { from: string; to: string }[];
  readonly backfills?: readonly BackfillValue[];
  readonly force?: boolean;
  readonly manifest?: DeploymentManifest;
}

export function loadDeploymentManifest(path: string): DeploymentManifest {
  try {
    return deploymentManifestSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
  } catch (error) {
    throw new AbloValidationError(`invalid deployment manifest ${path}: ${error instanceof Error ? error.message : String(error)}`, { code: 'cli_invalid_arguments' });
  }
}

/** Shared CLI observation boundary used by plan/check/push/migrate. */
export async function createDeploymentPlanBundle(options: CreateDeploymentPlanOptions): Promise<{ plan: SchemaDeploymentPlan; database: DatabaseSnapshot | null }> {
  const observedAt = new Date().toISOString();
  const schemaJson = JSON.parse(serializeSchema(options.schema)) as SchemaJSON;
  const database = options.databaseUrl ? await inspectDatabase(options.databaseUrl, options.appSchema, schemaJson) : null;
  const result = await requestControlPlane({
    path: '/schema/plan', method: 'POST', baseUrl: apiBaseUrl(options.url), apiKey: options.apiKey, responseSchema: schemaDeploymentPlanSchema,
    body: {
      schema: schemaJson,
      source: { path: options.schemaPath, observedAt }, database,
      renames: options.renames ?? [], backfills: options.backfills ?? [],
      force: options.force ?? false,
      ...(options.manifest ? { manifest: options.manifest } : {}),
    },
  });
  return { plan: result as SchemaDeploymentPlan, database };
}

export async function createDeploymentPlan(options: CreateDeploymentPlanOptions): Promise<SchemaDeploymentPlan> {
  return (await createDeploymentPlanBundle(options)).plan;
}

export async function plan(argv: readonly string[]): Promise<SchemaDeploymentPlan> {
  const args = parsePlanArgs(argv);
  const key = resolveRuntimeApiKeyReadOnly().key;
  if (!key) throw new AbloValidationError('No ABLO_API_KEY found. A three-state plan must read the active plane.', { code: 'cli_api_key_missing' });
  const databaseUrl = readProjectAdminDatabaseUrl();
  const source = await loadSchema(args.schemaPath, args.exportName);
  const deploymentPlan = await createDeploymentPlan({ schema: source, schemaPath: args.schemaPath, appSchema: args.appSchema, apiKey: key, ...(databaseUrl ? { databaseUrl } : {}), url: args.url, ...(args.manifestPath ? { manifest: loadDeploymentManifest(args.manifestPath) } : {}) });
  if (args.json) console.log(JSON.stringify(deploymentPlan, null, 2));
  else renderDeploymentPlan(deploymentPlan);
  if (deploymentPlan.outcome === 'blocked') process.exitCode = 1;
  return deploymentPlan;
}
