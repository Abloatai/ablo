import type { DeploymentFinding, DeploymentPhase, DeploymentStep } from './contracts.js';

const PHASES: readonly DeploymentPhase[] = [
  'intent',
  'expand',
  'dual_write',
  'backfill',
  'verify',
  'switch',
  'contract',
  'recover',
];

function statusOf(findings: readonly DeploymentFinding[]): DeploymentStep['status'] {
  if (findings.some(({ severity }) => severity === 'blocker' || severity === 'error')) {
    return 'blocked';
  }
  if (findings.some(({ code }) => code === 'lifecycle_ready')) return 'ready';
  return findings.every(({ severity }) => severity === 'warning' || severity === 'info')
    ? 'advisory'
    : 'ready';
}

function manifestStep(finding: DeploymentFinding): DeploymentStep {
  const status = statusOf([finding]);
  return {
    id: finding.id,
    phase: finding.phase,
    owner: finding.owner,
    title: finding.message,
    action: finding.action,
    dependsOn: finding.dependsOn ?? [],
    findingIds: [finding.id],
    status,
    executableByAblo: finding.owner === 'ablo' && status === 'ready',
  };
}

function groupedStep(
  phase: DeploymentPhase,
  owner: DeploymentFinding['owner'],
  findings: readonly DeploymentFinding[],
): DeploymentStep {
  const status = statusOf(findings);
  return {
    id: `${phase}:${owner}`,
    phase,
    owner,
    title: `${phase} — ${owner.replaceAll('_', ' ')}`,
    action: [...new Set(findings.map(({ action }) => action))].join(' '),
    dependsOn: [],
    findingIds: findings.map(({ id }) => id),
    status,
    executableByAblo: owner === 'ablo' && status === 'ready',
  };
}

/** Preserve manifest gates while grouping ordinary diagnostics by phase/owner. */
export function sequenceDeployment(findings: readonly DeploymentFinding[]): readonly DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  let previousPhase: readonly string[] = [];

  for (const phase of PHASES) {
    const phaseFindings = findings.filter((finding) => finding.phase === phase);
    const manifest = phaseFindings.filter(({ id }) => id.startsWith('manifest:'));
    const ordinary = phaseFindings.filter(({ id }) => !id.startsWith('manifest:'));
    const phaseSteps = manifest.map(manifestStep);

    for (const owner of [...new Set(ordinary.map(({ owner }) => owner))]) {
      phaseSteps.push(groupedStep(
        phase,
        owner,
        ordinary.filter((finding) => finding.owner === owner),
      ));
    }

    for (const step of phaseSteps) {
      const explicit = step.dependsOn;
      const barrier = explicit.length === 0 ? previousPhase : [];
      steps.push({ ...step, dependsOn: [...new Set([...explicit, ...barrier])] });
    }
    if (phaseSteps.length > 0) previousPhase = phaseSteps.map(({ id }) => id);
  }
  return steps;
}
