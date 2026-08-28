#!/usr/bin/env node

import pc from 'picocolors';
import { migrate } from './migrate';
import { connect } from './connect';
import {
  coreRows,
  fullRows,
  parseCommandName,
  suggestCommand,
  usageFor,
  CORE_GROUPS,
  FULL_GROUPS,
  type CommandName,
} from './commands';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { push } from './push';
import { generate } from './generate';
import { dev } from './dev';
import { login, logout } from './login';
import { projects } from './projects';
import { branches } from './branches';
import { runBranchDev } from './branchDev';
import { status } from './status';
import { whoami } from './whoami';
import { doctor } from './doctor';
import { logs } from './logs';
import { webhooks } from './webhooks';
import { check } from './check';
import { claims } from './claims';
import { docs } from './docs';
import { feedback } from './feedback';
import { upgrade } from './upgrade';
import { pull } from './pull';
import { prismaPull } from './prismaPull';
import { drizzlePull } from './drizzlePull';
import { brand } from './theme';
import { renderCliError } from './renderError';
import {
  CliFailureExit,
  flushCliErrors,
  installCliExitObservationBoundary,
  observeCliError,
  restoreCliExitObservationBoundary,
} from './observeCliError';
import {
  flushProductAnalytics,
  runTelemetryCommand,
  trackCliInitCompleted,
  trackCliInitStarted,
} from './telemetry';
import { parseInitArgs } from './init/options';
import { runInit } from './init/run';
import { runSetup } from './setup/run';
import { plan } from './plan/index';
import { rollback } from './rollback';

const LOGO = `
  ${brand('ablo')} ${pc.dim('sync engine')}
`;

/**
 * One handler per command, keyed on the registry's own name union. A command in
 * `COMMANDS` with no handler here, or a handler for something unregistered, is a
 * compile error — which is what keeps the reachable surface and the documented
 * surface the same set.
 */
const HANDLERS: Readonly<Record<CommandName, (argv: readonly string[]) => Promise<void> | void>> = {
  setup: (argv) => runSetup(argv),
  plan: async (argv) => { await plan(argv); },
  rollback: (argv) => rollback(argv),
  init: async (argv) => { await runInit(argv); },
  login: (argv) => login([...argv]),
  logout: () => logout(),
  telemetry: (argv) => runTelemetryCommand(argv),
  projects: (argv) => projects([...argv]),
  branch: (argv) => branches([...argv]),
  status: (argv) => status([...argv]),
  whoami: (argv) => whoami([...argv]),
  doctor: (argv) => doctor([...argv]),
  logs: (argv) => logs([...argv]),
  claims: (argv) => claims([...argv]),
  webhooks: (argv) => webhooks([...argv]),
  check: (argv) => check([...argv]),
  docs: (argv) => docs([...argv]),
  feedback: (argv) => feedback([...argv]),
  connect: (argv) => connect([...argv]),
  migrate: (argv) => migrate([...argv]),
  upgrade: (argv) => upgrade([...argv]),
  generate: (argv) => generate([...argv]),
  dev: runDev,
  pull: runPull,
  push: runPush,
  schema: runRenamedSchema,
};

/**
 * `dev` is the branch-first wrapper around the existing schema watcher. Honor
 * an explicit `--no-watch` (push once, then exit): appending `--watch`
 * unconditionally would clobber it under last-flag-wins parsing.
 */
async function runDev(argv: readonly string[]): Promise<void> {
  const devArgs = [...argv];
  const oneShot = devArgs.includes('--no-watch');
  console.log(
    pc.dim(
      oneShot
        ? '  `ablo dev --no-watch` prepares this Git branch and pushes once.'
        : '  `ablo dev` prepares this Git branch and watches the schema.',
    ),
  );
  await runBranchDev(oneShot ? devArgs : [...devArgs, '--watch']);
}

/**
 * `ablo pull`         → introspect the live database (lossy: no enums/relations)
 * `ablo pull prisma`  → read a Prisma schema file (lossless: enums + relations)
 * `ablo pull drizzle` → reflect a Drizzle module    (lossless: enums + relations)
 */
async function runPull(argv: readonly string[]): Promise<void> {
  const rest = [...argv];
  if (rest[0] === 'prisma') await prismaPull(rest.slice(1));
  else if (rest[0] === 'drizzle') await drizzlePull(rest.slice(1));
  else await pull(rest);
}

/**
 * `ablo push` is always the one-shot pusher. `ablo dev` is the explicit
 * branch-first watch workflow. Routing a command from a key's old live/test
 * spelling is impossible for current keys and was the wrong abstraction: the
 * server-confirmed branch decides the target.
 */
async function runPush(argv: readonly string[]): Promise<void> {
  const rest = [...argv];
  await push(rest);
}

/** Renamed: `ablo schema push` → `ablo push` (flat-verb grammar). */
function runRenamedSchema(argv: readonly string[]): void {
  const forwarded = argv.slice(1).join(' ');
  console.error(`  ${pc.red('✗')} \`ablo schema push\` was renamed to \`${brand('ablo push')}\`.`);
  console.error(`    Run \`ablo push${forwarded ? ' ' + forwarded : ''}\` instead.`);
  process.exitCode = 1;
}

async function main() {
  const raw = process.argv[2];
  const command = parseCommandName(raw);
  const argv = process.argv.slice(3);

  // An unrecognized command must SAY so and exit non-zero — silently printing
  // the help reads as "that command doesn't exist, here's everything", costs a
  // person a re-read and an agent a whole turn, and hid both a typo
  // (`disconnnect`) and a wrong-name (`disconnect` for `connect deregister`)
  // behind an exit code of 0. `help` stays a help word, not an error.
  if (!command && raw !== undefined && raw !== 'help' && !raw.startsWith('-')) {
    const suggestion = suggestCommand(raw);
    throw new AbloValidationError(
      `\`${raw}\` isn't an ablo command.` +
        (suggestion
          ? ` Did you mean \`ablo ${suggestion}\`?`
          : ' Run `ablo help --all` to see every command.'),
      { code: 'cli_invalid_arguments' }
    );
  }

  // `ablo <command> --help` / `-h` should print usage, not forward `--help` into
  // the command's own arg parser — which throws "unknown flag: --help" and reads
  // as "the command doesn't exist" (a real user's agent drew exactly that wrong
  // conclusion about `ablo migrate`). Print command-specific usage when we have
  // it; otherwise fall through to the top-level command list below.
  if (command && argv.some((a) => a === '--help' || a === '-h')) {
    const usage = usageFor(command);
    if (usage) {
      console.log(usage);
      return;
    }
    printCoreHelp();
    return;
  }

  if (command) {
    const startedAt = Date.now();
    const initOptions = command === 'init' ? parseInitArgs(argv) : undefined;
    if (command === 'init') {
      trackCliInitStarted({
        interactive: Boolean(process.stdin.isTTY) && !argv.includes('--yes') && !process.env.CI,
      });
    }
    await HANDLERS[command](argv);
    if (initOptions && !initOptions.plan) {
      trackCliInitCompleted(Date.now() - startedAt, initOptions.framework ?? 'auto');
    }
  } else if (process.argv.includes('--all')) {
    printFullHelp();
  } else {
    printCoreHelp();
  }
}

/**
 * The default help: the core loop, grouped by record — not a reference dump.
 * Every line names what the command does for you in plain words; flags,
 * variants, and the rest of the surface live behind `ablo help --all`.
 */
function printCoreHelp(): void {
  // The two static rows are help's own, not a command's, so they live here
  // rather than in the registry — which holds only things you can run.
  const extra = [
    { run: 'help --all', does: 'Every command and flag' },
    { run: '<command> --help', does: 'Details for one command' },
  ];
  const rows = [...CORE_GROUPS.flatMap((g) => [...coreRows(g)]), ...extra];
  const width = Math.max(...rows.map((r) => r.run.length)) + 4;

  console.log(LOGO);
  for (const group of CORE_GROUPS) {
    console.log(`  ${pc.bold(group)}`);
    const printed = group === 'More' ? [...coreRows(group), ...extra] : coreRows(group);
    for (const row of printed) console.log(`    npx ablo ${row.run.padEnd(width)}${row.does}`);
    console.log();
  }
  printSchemaReminder();
}

/** The one line every help ends on: pushing is what makes a model writable. */
function printSchemaReminder(): void {
  console.log(
    pc.dim(`  Edit ${pc.bold('ablo/schema.ts')}, then push — writes to models you haven't pushed fail with `) +
      pc.yellow('server_execute_unknown_model') +
      pc.dim('.'),
  );
  console.log();
}

/** The full reference behind `ablo help --all`: every command, plain words. */
function printFullHelp(): void {
  // One width across every group, so the description column lines up down the
  // whole page rather than per-section — and cannot drift as rows are added.
  // Continuation rows are excluded: they have no description to align to, and
  // being the longest lines they would push the column off the screen.
  const width =
    Math.max(
      ...FULL_GROUPS.flatMap((g) => fullRows(g).filter((r) => r.does !== undefined).map((r) => r.run.length)),
    ) + 2;

  console.log(LOGO);
  for (const group of FULL_GROUPS) {
    console.log(`  ${pc.bold(group)}`);
    for (const row of fullRows(group)) {
      console.log(row.does === undefined ? `    ${' '.repeat(9)}${row.run}` : `    npx ablo ${row.run.padEnd(width)}${row.does}`);
    }
    console.log();
  }
  printSchemaReminder();
}

installCliExitObservationBoundary();

main()
  .then(async () => {
    await flushProductAnalytics();
    restoreCliExitObservationBoundary();
  })
  .catch(async (err: unknown) => {
    await flushProductAnalytics();
    if (err instanceof CliFailureExit) {
      // Legacy commands may already have printed a tailored explanation before
      // exiting. Observe and flush that originating call site without printing a
      // second generic error block over it.
      observeCliError(err);
      await flushCliErrors();
      restoreCliExitObservationBoundary();
      process.exit(err.exitCode);
    }
    // Structured terminal block instead of `console.error(err)`'s wall of text
    // (stack + every field). Sets process.exitCode = 1 so failures signal non-zero.
    renderCliError(err);
    await flushCliErrors();
    restoreCliExitObservationBoundary();
    process.exit(process.exitCode ?? 1);
  });
