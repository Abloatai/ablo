import type { DeploymentApplyResult, DeploymentObservation, DeploymentStep, SchemaDeploymentPlan } from './contracts.js';
import { deploymentFingerprint } from './fingerprint.js';
import { reconcileDeploymentManifest, reconcilePolicyIntent, reconcileSchemaToDatabase, reconcileSourceToActiveResult } from './reconcile.js';
import { sequenceDeployment } from './sequence.js';

export * from './contracts.js';
export { deploymentFingerprint } from './fingerprint.js';
export { reconcileClientToActive, reconcileDeploymentManifest, reconcilePolicyIntent, reconcileSchemaToDatabase, reconcileSourceToActive, reconcileSourceToActiveResult } from './reconcile.js';
export { sequenceDeployment } from './sequence.js';
export * from './backfill.js';
export * from './postgresCatalog.js';

function planStates(observation: DeploymentObservation): SchemaDeploymentPlan['states'] {
  const { schema: _sourceSchema, ...source } = observation.source;
  const active = observation.active ? (({ schema: _activeSchema, ...state }) => state)(observation.active) : null;
  const database = observation.database ? (({ tables: _tables, ...state }) => state)(observation.database) : null;
  return { source, active, database };
}

/** The one pure reconciliation skeleton every lifecycle surface projects. */
export function buildSchemaDeploymentPlan(observation: DeploymentObservation, now = new Date().toISOString()): SchemaDeploymentPlan {
  const sourceToActive = reconcileSourceToActiveResult(
    observation.active?.schema ?? null,
    observation.source.schema,
    observation.intent?.renames,
    observation.intent?.backfills,
  );
  const provision = reconcileSourceToActiveResult(null, observation.source.schema).operations;
  const findings = [
    ...reconcilePolicyIntent(observation.source.schema),
    ...reconcileDeploymentManifest(observation.intent?.manifest),
    ...sourceToActive.findings,
    ...reconcileSchemaToDatabase(observation.source.schema, observation.database, 'source_to_database'),
    ...(observation.active ? reconcileSchemaToDatabase(observation.active.schema, observation.database, 'active_to_database') : []),
    ...(observation.supplementalFindings ?? []),
  ];
  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()].map((finding) =>
    observation.intent?.acceptDestructive && finding.category === 'destructive_contract' &&
      finding.code !== 'mixed_expand_contract' && finding.code !== 'contract_approval_required' && finding.code !== 'lifecycle_dependency_unsatisfied'
      ? { ...finding, severity: 'warning' as const, action: `${finding.action} Destructive intent was explicitly accepted for this reviewed plan.` }
      : finding
  );
  const steps = sequenceDeployment(unique);
  const blocking = unique.some(({ severity }) => severity === 'blocker' || severity === 'error');
  const meaningful = unique.some(({ category }) => category !== 'advisory');
  const states = planStates(observation);
  const destructive = unique.some(({ category }) => category === 'destructive_contract');
  const rollbackTarget = observation.active && !destructive ? { schemaId: observation.active.schemaId, version: observation.active.version, hash: observation.active.hash, strategy: 'reactivate_artifact' as const } : null;
  const fingerprint = deploymentFingerprint({
    target: observation.target,
    states: {
      source: { hash: states.source.hash },
      active: states.active ? { schemaId: states.active.schemaId, version: states.active.version, hash: states.active.hash } : null,
      database: states.database ? { subject: states.database.subject, fingerprint: states.database.fingerprint, ownership: states.database.ownership } : null,
    },
    intent: observation.intent ?? {}, findings: unique, steps, operations: { sourceToActive: sourceToActive.operations, provision },
  });
  return { id: 'ablo-schema-deployment-plan-v1', mode: 'plan', createdAt: now, fingerprint, target: observation.target, states, findings: unique, steps, operations: { sourceToActive: sourceToActive.operations, provision }, outcome: blocking ? 'blocked' : meaningful ? 'ready' : 'aligned', rollbackTarget, recovery: rollbackTarget ? 'rollback' : 'forward_only' };
}

export interface SchemaDeploymentLifecycleEffects {
  readonly observe: () => Promise<DeploymentObservation>;
  readonly approve?: (plan: SchemaDeploymentPlan) => Promise<boolean>;
  readonly apply?: (step: DeploymentStep, plan: SchemaDeploymentPlan) => Promise<void>;
  readonly record?: (result: Omit<DeploymentApplyResult, 'recorded'>) => Promise<void>;
}

/** One observe → reconcile → sequence → approve → apply → verify → record path. */
export async function runSchemaDeploymentLifecycle(effects: SchemaDeploymentLifecycleEffects, mode: 'plan' | 'apply' = 'plan'): Promise<SchemaDeploymentPlan | DeploymentApplyResult> {
  const plan = buildSchemaDeploymentPlan(await effects.observe());
  if (mode === 'plan') return plan;
  if (plan.outcome === 'blocked') throw new Error(`schema deployment plan ${plan.fingerprint} is blocked`);
  if (!effects.apply) throw new Error('schema deployment apply effect is not configured');
  if (effects.approve && !(await effects.approve(plan))) throw new Error('schema deployment was not approved');
  const appliedStepIds: string[] = [];
  for (const step of plan.steps) if (step.executableByAblo && step.status === 'ready') { await effects.apply(step, plan); appliedStepIds.push(step.id); }
  const verification = buildSchemaDeploymentPlan(await effects.observe());
  const unrecorded = { plan, appliedStepIds, verification };
  await effects.record?.(unrecorded);
  return { ...unrecorded, recorded: effects.record !== undefined };
}
