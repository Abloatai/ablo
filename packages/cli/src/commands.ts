/**
 * The one definition of the CLI's command surface.
 *
 * Every command is declared here once. Dispatch, `ablo help`, `ablo help --all`,
 * and `ablo <command> --help` all derive from this list — so a command cannot be
 * reachable but undocumented, or documented but unreachable. The handler map in
 * `index.ts` is keyed on {@link CommandName}, which makes a missing handler and
 * an unregistered command both compile errors rather than something a reader has
 * to notice.
 *
 * Before this file the surface was stated three times — an `if/else` chain, a
 * short help, and a long one — and had already drifted: `ablo schema` was
 * dispatched and appeared in neither. It turned out to be a deprecation shim
 * that *should* be unlisted, which is the harder half of the problem. Absence
 * could not distinguish "deliberately hidden" from "forgotten", so `hidden`
 * states the intent instead of leaving it to be inferred.
 */

import { CONNECT_USAGE } from './connect';
import { DOCS_USAGE } from './docs';
import { MIGRATE_USAGE } from './migrate';

/** Headings in the short help — the core loop, in the order you meet it. */
export const CORE_GROUPS = ['Start', 'Every day', 'More'] as const;
export type CoreGroup = (typeof CORE_GROUPS)[number];

/** Headings in `ablo help --all`, grouped by the job rather than the verb. */
export const FULL_GROUPS = [
  'Set up',
  'Your database',
  'Your schema',
  'Read the docs',
  "See what's happening",
  'Workspace',
] as const;
export type FullGroup = (typeof FULL_GROUPS)[number];

/** One printed invocation. `does` is omitted on a continuation line, which
 *  carries the rest of a long flag list under the row above it. */
export interface HelpRow {
  readonly run: string;
  readonly does?: string;
}

export interface Command {
  readonly name: string;
  /** The short help entry. Omitted for commands that belong only in `--all`. */
  readonly core?: { readonly group: CoreGroup; readonly does: string };
  /** The `--all` entry: every invocation worth showing, in order. */
  readonly full?: { readonly group: FullGroup; readonly rows: readonly HelpRow[] };
  /** Dispatched, never printed. A deprecated spelling kept working without
   *  being advertised — see the DX rule against naming deprecated paths. */
  readonly hidden?: true;
  /** Usage for `ablo <command> --help`, owned by the command's own module. */
  readonly usage?: string;
}

export const COMMANDS = [
  {
    name: 'init',
    core: { group: 'Start', does: 'Scaffold ablo/ with a starter schema (--yes runs without prompts, for agents/CI)' },
    full: {
      group: 'Set up',
      rows: [
        { run: 'init', does: 'Scaffold ablo/ with a starter schema' },
        { run: 'init --yes [--framework nextjs]', does: 'No prompts, flag-driven (agents/CI)' },
        { run: '     [--auth apikey] [--storage replication|endpoint] [--project <slug>] [--no-project]' },
        { run: '     [--no-agent] [--no-pull] [--no-install] [--no-login]' },
      ],
    },
  },
  {
    name: 'login',
    core: { group: 'Start', does: 'Authorize in your browser — sets up your sandbox and production keys' },
    full: {
      group: 'Set up',
      rows: [
        { run: 'login', does: 'Authorize in your browser — sets up your sandbox and production keys' },
        { run: 'login --project <slug>', does: 'Same, for one project — its keys become the active ones' },
      ],
    },
  },
  {
    name: 'logout',
    full: { group: 'Set up', rows: [{ run: 'logout', does: 'Remove the stored API key' }] },
  },
  {
    name: 'connect',
    core: { group: 'Start', does: 'Connect your database — shows the setup to run, or applies it for you' },
    usage: CONNECT_USAGE,
    full: {
      group: 'Your database',
      rows: [
        { run: 'connect', does: 'Connect your database — shows the setup to run, or applies it for you' },
        { run: 'connect apply', does: 'Run that setup for you, from a one-time admin URL' },
        { run: 'connect check', does: 'Confirm your database is ready to share changes with Ablo' },
        { run: 'connect scan', does: 'List anything Ablo ever set up in your database (read-only)' },
        { run: 'connect deregister', does: "Disconnect this project's database — Ablo stops reading and writing it" },
      ],
    },
  },
  {
    name: 'migrate',
    usage: MIGRATE_USAGE,
    full: {
      group: 'Your database',
      rows: [
        { run: 'migrate', does: 'Create the tables your schema needs in your own database' },
        { run: 'migrate --dry-run', does: 'Show the SQL without running it' },
      ],
    },
  },
  {
    name: 'pull',
    full: {
      group: 'Your database',
      rows: [
        { run: 'pull', does: 'Generate schema.ts from your database (read-only)' },
        { run: 'pull prisma [path]', does: 'Generate schema.ts from a Prisma schema (keeps enums + relations)' },
        { run: 'pull drizzle <module>', does: 'Generate schema.ts from a Drizzle schema (keeps enums + relations)' },
      ],
    },
  },
  {
    name: 'check',
    full: {
      group: 'Your database',
      rows: [{ run: 'check', does: 'Check your database fits the schema — read-only, creates nothing' }],
    },
  },
  {
    name: 'dev',
    core: { group: 'Every day', does: 'Push your schema and keep watching for changes' },
    full: {
      group: 'Your schema',
      rows: [
        { run: 'dev', does: 'Push your schema and keep watching for changes' },
        { run: 'dev --no-watch', does: 'Push once and exit' },
      ],
    },
  },
  {
    name: 'push',
    core: { group: 'Every day', does: 'Upload your schema — schema only; your rows stay in your database' },
    full: {
      group: 'Your schema',
      rows: [
        { run: 'push', does: 'Upload your schema — schema only; your rows stay in your database' },
        { run: 'push --force', does: 'Allow destructive changes' },
        { run: 'push --rename a:b', does: 'Treat model "a" as renamed to "b"' },
        { run: 'push --backfill model.field=value', does: 'Seed existing rows so a required field can be added' },
      ],
    },
  },
  {
    name: 'generate',
    full: {
      group: 'Your schema',
      rows: [
        { run: 'generate', does: 'Emit TypeScript types from your schema' },
        { run: 'generate --out path.ts', does: 'Write generated types to a path' },
      ],
    },
  },
  {
    name: 'upgrade',
    full: {
      group: 'Your schema',
      rows: [{ run: 'upgrade', does: 'Rewrite your code to the current API (preview; --write applies)' }],
    },
  },
  {
    name: 'docs',
    core: { group: 'More', does: 'Read the docs for the version you installed — offline, no network' },
    usage: DOCS_USAGE,
    full: {
      group: 'Read the docs',
      rows: [
        { run: 'docs', does: 'List every page — these ship in the package, so they match your version' },
        { run: 'docs <page>', does: 'Print one page as markdown (no network needed)' },
        { run: 'docs --json', does: 'The page list, machine-readable' },
      ],
    },
  },
  {
    name: 'status',
    core: { group: 'Every day', does: 'See what this key acts on, your pushed schema, and whether writes will work' },
    full: {
      group: "See what's happening",
      rows: [
        { run: 'status', does: 'See what this key acts on, your pushed schema, and whether writes will work' },
        { run: 'status --json', does: 'Same, machine-readable' },
      ],
    },
  },
  {
    name: 'doctor',
    core: { group: 'Every day', does: 'Check the whole setup at once and list everything that would block a write' },
    full: {
      group: "See what's happening",
      rows: [{ run: 'doctor', does: 'Every setup check at once — exits non-zero when a write would fail' }],
    },
  },
  {
    name: 'logs',
    core: { group: 'Every day', does: 'Follow writes as they happen' },
    full: {
      group: "See what's happening",
      rows: [{ run: 'logs [-n N] [--since 15m]', does: 'Follow writes as they happen (--no-follow to exit)' }],
    },
  },
  {
    name: 'mode',
    full: {
      group: 'Workspace',
      rows: [{ run: 'mode [sandbox|production]', does: 'Pick the environment everyday commands act in' }],
    },
  },
  {
    name: 'projects',
    full: {
      group: 'Workspace',
      rows: [
        { run: 'projects list', does: 'List your projects, and the keys held for each' },
        { run: 'projects create <slug>', does: 'Create a project — its keys, schema, and data are separate' },
        { run: 'projects use <slug|default>', does: 'Switch the active project' },
      ],
    },
  },
  {
    name: 'webhooks',
    full: {
      group: 'Workspace',
      rows: [
        { run: 'webhooks create <url>', does: 'Send committed changes to your endpoint (writes ABLO_WEBHOOK_SECRET)' },
        { run: 'webhooks list|roll|enable|rm', does: 'Manage webhook endpoints + delivery health' },
      ],
    },
  },
  {
    name: 'schema',
    hidden: true,
  },
] as const satisfies readonly Command[];

/** Every command name, derived — never restated. */
export type CommandName = (typeof COMMANDS)[number]['name'];

/** The same list at its declared type. `COMMANDS` keeps literal types so
 *  {@link CommandName} can be derived from it; the helpers below read it
 *  through this widened view, where the optional fields exist to be asked
 *  about. */
const ALL: readonly Command[] = COMMANDS;

const BY_NAME = new Map<string, Command>(ALL.map((c) => [c.name, c]));

/** The command a user typed, or null when it is not one of ours. This is the
 *  argv boundary: everything below it takes a {@link CommandName}. */
export function parseCommandName(raw: string | undefined): CommandName | null {
  return raw !== undefined && BY_NAME.has(raw) ? (raw as CommandName) : null;
}

/** Per-command usage, when the command's module publishes one. */
export function usageFor(name: CommandName): string | undefined {
  return BY_NAME.get(name)?.usage;
}

/** Rows for one short-help heading, in declaration order. */
export function coreRows(group: CoreGroup): readonly { run: string; does: string }[] {
  return ALL.filter((c) => c.core?.group === group).map((c) => ({
    run: c.name,
    does: c.core?.does ?? '',
  }));
}

/** Rows for one `--all` heading, in declaration order. */
export function fullRows(group: FullGroup): readonly HelpRow[] {
  return ALL.filter((c) => c.full?.group === group).flatMap((c) => c.full?.rows ?? []);
}
