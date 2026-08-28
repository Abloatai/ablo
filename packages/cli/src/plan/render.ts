import pc from 'picocolors';
import type { SchemaDeploymentPlan } from '@abloatai/transaction/schema';
import { brand } from '../theme';

const mark = (status: string): string => status === 'blocked' ? pc.red('✗') : status === 'advisory' ? pc.yellow('!') : pc.green('→');

export function renderDeploymentPlan(plan: SchemaDeploymentPlan): void {
  console.log(`\n  ${brand('ablo')} ${pc.dim('plan')}  ${pc.dim(plan.fingerprint)}\n`);
  console.log(`  ${pc.dim('source')}    ${pc.bold(plan.states.source.path)} ${pc.dim(plan.states.source.hash)}`);
  console.log(`  ${pc.dim('active')}    ${plan.states.active ? pc.bold(`v${plan.states.active.version}`) + pc.dim(` ${plan.states.active.hash}`) : pc.yellow('none')}`);
  console.log(`  ${pc.dim('database')}  ${plan.states.database ? pc.bold(plan.states.database.subject) + pc.dim(` ${plan.states.database.fingerprint}`) : pc.red('not observed')}`);
  console.log(`  ${pc.dim('outcome')}   ${plan.outcome === 'blocked' ? pc.red(plan.outcome) : plan.outcome === 'aligned' ? pc.green(plan.outcome) : pc.yellow(plan.outcome)}\n`);

  for (const step of plan.steps) {
    console.log(`  ${mark(step.status)} ${pc.bold(step.title)} ${pc.dim(`[${step.owner}]`)}`);
    for (const findingId of step.findingIds) {
      const finding = plan.findings.find(({ id }) => id === findingId);
      if (!finding) continue;
      const where = [finding.model, finding.field].filter(Boolean).join('.');
      const column = finding.column ? ` → ${finding.column}` : '';
      console.log(`      ${pc.dim(finding.severity.padEnd(7))} ${where ? pc.bold(where) : finding.code}${column}`);
      console.log(`              ${finding.message}`);
      console.log(`              ${pc.dim(finding.action)}`);
    }
    if (step.dependsOn.length > 0) console.log(`      ${pc.dim(`after ${step.dependsOn.join(', ')}`)}`);
    console.log();
  }
  if (plan.rollbackTarget) console.log(`  ${pc.dim('rollback')}  reactivate v${plan.rollbackTarget.version} (${plan.rollbackTarget.schemaId}) after compatibility verification`);
  else console.log(`  ${pc.dim('recovery')}  ${pc.yellow('forward-only')}`);
  console.log(`  ${pc.dim('json')}      ${pc.bold('npx ablo plan --json')}\n`);
}
