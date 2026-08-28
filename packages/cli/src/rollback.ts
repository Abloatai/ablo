import { z } from 'zod';
import pc from 'picocolors';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { schemaDeploymentPlanSchema } from '@abloatai/transaction/schema';
import { readFileSync, writeFileSync } from 'fs';
import { resolveMutationApiKey } from './config';
import { requestControlPlane } from './controlPlane';
import { renderDeploymentPlan } from './plan/render';

export const ROLLBACK_USAGE = `  ablo rollback — plan or apply safe artifact reactivation

  Usage:
    npx ablo rollback --version 57
    npx ablo rollback --version 57 --output ablo/rollback-57.json
    npx ablo rollback --version 57 --apply ablo/rollback-57.json

  Reactivation changes the active artifact only. It is refused unless the same
  deployment skeleton proves the retained PostgreSQL shape remains compatible.`;

export async function rollback(argv: readonly string[]): Promise<void> {
  let version: number | null = null;
  let applyPath: string | null = null;
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--version') version = Number(argv[++index]);
    else if (arg === '--apply') applyPath = argv[++index] ?? null;
    else if (arg === '--output') outputPath = argv[++index] ?? null;
    else throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
  }
  if (!Number.isInteger(version) || (version ?? 0) <= 0) throw new AbloValidationError('--version must be a positive schema version', { code: 'cli_invalid_arguments' });
  const apiKey = resolveMutationApiKey();
  if (!apiKey) throw new AbloValidationError('No ABLO_API_KEY found.', { code: 'cli_api_key_missing' });

  if (!applyPath) {
    const plan = await requestControlPlane({
      path: '/schema/reactivate', method: 'POST', apiKey, body: { version, plan: true }, responseSchema: schemaDeploymentPlanSchema,
    });
    renderDeploymentPlan(plan);
    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      console.log(`  Reviewed plan written to ${pc.bold(outputPath)}.`);
    } else {
      console.log(`  Re-run with ${pc.bold('--output <path>')} to save the exact reviewed plan for apply.\n`);
    }
    return;
  }

  let reviewedPlan;
  try {
    reviewedPlan = schemaDeploymentPlanSchema.parse(JSON.parse(readFileSync(applyPath, 'utf8')));
  } catch (error) {
    throw new AbloValidationError(`invalid reviewed plan ${applyPath}: ${error instanceof Error ? error.message : String(error)}`, { code: 'cli_invalid_arguments' });
  }

  const result = await requestControlPlane({
    path: '/schema/reactivate', method: 'POST', apiKey, body: { version, reviewedPlan },
    responseSchema: z.object({ schemaId: z.string(), version: z.number(), hash: z.string(), state: z.literal('active'), reactivated: z.literal(true), plan: z.string() }),
  });
  console.log(`  ${pc.green('✓')} Reactivated schema v${result.version} (${result.schemaId}) with plan ${result.plan}.`);
}
