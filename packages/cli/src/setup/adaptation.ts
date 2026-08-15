/**
 * The application-code handoff owned by setup. Discovery supplies leads; this
 * module turns reviewed model selection into a bounded record for a coding agent.
 * It never claims the lexical inventory is complete.
 */

import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
  setupMutationSiteSchema,
  type SetupAdaptationTask,
  type SetupPlan,
} from './contracts';

export function buildWritePathAdaptationTask(input: {
  readonly plan: SetupPlan;
  readonly selectedModels: readonly string[];
}): SetupAdaptationTask {
  if (input.plan.compatibility.status !== 'compatible') {
    const blockerCodes = [...new Set(input.plan.compatibility.blockers.map(({ code }) => code))];
    throw new Error(
      `Write-path adaptation is blocked by ${input.plan.compatibility.status}: ${blockerCodes.join(', ')}.`,
    );
  }
  const selectedModels = [...new Set(input.selectedModels.map((model) => model.trim()).filter(Boolean))];
  if (selectedModels.length === 0) {
    throw new Error('Write-path adaptation requires at least one reviewed model.');
  }
  const applicationRoot = input.plan.target.applicationRoot;
  if (!applicationRoot) {
    throw new Error('Write-path adaptation requires a confirmed application root.');
  }
  const value = input.plan.facts.find(({ key }) => key === 'application.directMutationSites')?.value;
  const hints = setupMutationSiteSchema.array().parse(value ?? []);
  const selected = new Set(selectedModels.map((model) => model.toLowerCase()));
  const relevantHints = hints.filter(({ modelHint }) =>
    modelHint === null || selected.has(modelHint.toLowerCase()),
  );

  return setupAdaptationTaskSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_adaptation_task',
    recordId: 'adapt-selected-write-paths-v1',
    actionId: 'adapt_write_paths',
    repositoryRoot: input.plan.target.repositoryRoot,
    applicationRoot,
    selectedModels,
    databaseMappings: input.plan.compatibility.mappings,
    discoveryHints: relevantHints,
    scope: {
      allowedRoot: applicationRoot,
      mustExploreBeyondHints: true,
      mayReadEnvironmentValues: false,
      maximumMutation: 'local_write',
    },
    objective: 'Independently explore the selected application, preserve its database contract, and adapt the reviewed model writes through Ablo using the approved database mappings and atomic commit operations.',
    constraints: [
      'Treat discovery hints only as possibly useful starting points. They may be incomplete, duplicated, misleading, or absent; do not derive migration coverage from them.',
      'Preserve application authorization, validation, transactions, error handling, and response contracts.',
      'Use each approved database mapping exactly; do not invent timestamp units, columns, identities, or metadata.',
      'Keep conditional updates, dependent writes, and their operation results in one customer database transaction.',
      'For a Node service, keep one schema-backed transaction client per service or worker authority, inject it through the existing composition root, and preserve memory-backed test modes.',
      'Validate ABLO_API_KEY presence without logging its value; await client readiness before work and await client disposal after active work during shutdown.',
      'Do not edit outside the selected application root or read environment values.',
      'Do not perform remote, database, credential, branch, or schema-push effects.',
      'Classify intentional direct-write exceptions explicitly instead of silently leaving them behind.',
    ],
    acceptanceCriteria: [
      'Every selected model write path is routed through Ablo or has a reviewed exception.',
      'Database-generated identities and exact operation rows come from the writing transaction.',
      'The application typecheck and relevant tests pass.',
      'Existing application-owned wiring and unrelated behavior remain intact.',
      'Node lifecycle tests cover startup failure and shutdown while work is active when server-client wiring changes.',
      'The deterministic setup verifier can account for every discovered candidate.',
    ],
  });
}
