import pc from 'picocolors';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { brand } from '../theme';
import { discoverSetupPlan } from './discover';
import type { SetupPlan } from './contracts';

export const SETUP_USAGE = `
Usage:
  ablo setup [--root <path>]
  ablo setup --plan [--json] [--root <path>]

One setup journey for an existing application. The current implementation is a
read-only preview: it inspects the repository and current Ablo target, then
prints the decisions, actions, blockers, and postconditions required for a
verified setup. Agent records, skills, and graders are internal program details,
not CLI modes. Mutation remains unavailable until the bounded runner,
customer-Postgres canary contract, and structured command adapters exist.
`;

interface SetupOptions {
  readonly plan: boolean;
  readonly json: boolean;
  readonly root?: string;
}

function parseSetupArgs(args: readonly string[]): SetupOptions {
  const allowedFlags = new Set(['--plan', '--dry-run', '--json', '--root']);
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      continue;
    }
    if (arg === '--root') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new AbloValidationError('`--root` requires a directory.', {
          code: 'cli_invalid_arguments',
        });
      }
      root = next;
      index += 1;
      continue;
    }
    if (!allowedFlags.has(arg)) {
      throw new AbloValidationError(`Unknown setup option: ${arg}`, {
        code: 'cli_invalid_arguments',
      });
    }
  }
  return {
    plan: args.includes('--plan') || args.includes('--dry-run'),
    json: args.includes('--json'),
    ...(root ? { root } : {}),
  };
}

function renderValue(value: unknown): string {
  if (value === null) return pc.dim('unknown');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const encoded = JSON.stringify(value);
  return encoded.length > 140 ? `${encoded.slice(0, 137)}...` : encoded;
}

function renderStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function renderHumanPlan(plan: SetupPlan): void {
  console.log(`\n  ${brand('ablo')} ${pc.dim('setup plan')}  ${pc.dim('(read-only)')}\n`);
  console.log(`  ${pc.bold('Target')}`);
  console.log(`    repository   ${plan.target.repositoryRoot}`);
  console.log(`    application  ${plan.target.applicationRoot ?? pc.yellow('unresolved')}`);
  console.log(`    package      ${plan.target.packageName ?? pc.dim('unknown')}`);
  console.log(`    project      ${plan.target.abloProjectId ?? pc.dim('unconfirmed')}`);
  console.log(`    branch       ${plan.target.abloBranchId ?? pc.dim('unconfirmed')}`);
  console.log(`    compatibility ${plan.compatibility.status === 'compatible' ? pc.green('compatible') : pc.yellow(renderStatus(plan.compatibility.status))}`);

  if (plan.compatibility.blockers.length > 0) {
    console.log(`\n  ${pc.bold('Compatibility blockers')}`);
    for (const blocker of plan.compatibility.blockers) {
      const location = blocker.table
        ? `${blocker.table}${blocker.field ? ` (${blocker.field})` : ''}`
        : 'Repository';
      console.log(`    ${pc.bold(location)}  ${pc.yellow(renderStatus(blocker.code))}`);
      console.log(`      ${blocker.observed}`);
      console.log(`      ${pc.dim(`Required: ${blocker.expected}`)}`);
      for (const remediation of blocker.remediations) {
        console.log(`      ${pc.dim(`${renderStatus(remediation.kind)} — ${remediation.summary}`)}`);
      }
    }
  }

  if (plan.compatibility.mappings.length > 0) {
    console.log(`\n  ${pc.bold('Database mappings')}`);
    for (const mapping of plan.compatibility.mappings) {
      const target = mapping.column === null
        ? 'disabled'
        : `${mapping.column} · ${mapping.databaseType ?? 'unmapped'}`;
      const status = mapping.status === 'ready' ? pc.green('ready') : pc.yellow('review');
      console.log(`    ${`${mapping.table}.${mapping.field}`.padEnd(34)} ${target} · ${status}`);
      if (mapping.status === 'review_required') console.log(`      ${pc.dim(mapping.reason)}`);
    }
  }

  console.log(`\n  ${pc.bold('Evidence')}`);
  for (const item of plan.facts) {
    console.log(`    ${item.key.padEnd(34)} ${renderValue(item.value)}`);
  }

  console.log(`\n  ${pc.bold('Decisions')}`);
  for (const decision of plan.decisions) {
    const marker = decision.status === 'resolved' ? pc.green('✓') : pc.yellow('?');
    console.log(`    ${marker} ${decision.question}`);
    console.log(`      ${pc.dim(decision.reason)}`);
  }

  console.log(`\n  ${pc.bold('Actions')}`);
  for (const action of plan.actions) {
    const marker = action.status === 'blocked' ? pc.yellow('blocked') : pc.green(action.status);
    console.log(`    ${marker.padEnd(18)} ${action.summary} ${pc.dim(`[${action.executor}]`)}`);
    if (action.blockedBy.length > 0) {
      console.log(`      ${pc.dim(`needs ${action.blockedBy.join(', ')}`)}`);
    }
  }

  console.log(`\n  ${pc.bold('Result')}  ${pc.yellow(plan.outcome)}`);
  console.log(`  ${plan.summary}`);
  console.log(pc.dim('  Machine-readable: npx ablo setup --plan --json'));
  console.log();
}

export async function runSetup(args: readonly string[]): Promise<void> {
  const options = parseSetupArgs(args);
  if (options.json && !options.plan) {
    throw new AbloValidationError(
      '`--json` is a plan renderer. Use `ablo setup --plan --json`.',
      { code: 'cli_invalid_arguments' },
    );
  }
  const plan = await discoverSetupPlan({ root: options.root });
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  renderHumanPlan(plan);
}
