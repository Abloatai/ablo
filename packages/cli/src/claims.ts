/**
 * `ablo claims` — take, hold, and release a row lease from the shell.
 *
 * The coordination loop was reachable only through the SDK: a participant had
 * to import a typed client into the project before it could take a lease. That
 * put the one operation the commit chokepoint exists to arbitrate behind a code
 * change, so an agent working in a repository nobody had wired up could install
 * Ablo, connect a database, and push a schema, and still have no way to say "I
 * am editing this row". Setup was reachable from a shell and participation was
 * not.
 *
 * Every verb here is the contract's own. `acquire`, `release`, `heartbeat`, and
 * `list` name the operations `claims/contract.ts` already names, and every
 * response is parsed against that contract's schema rather than a shape
 * restated here — so this module adds a spelling, never a second definition.
 *
 * The invocations live in `commands.ts` and are not repeated here: it is the
 * registry that renders them for `--help` and `help --all`, and a list in this
 * comment would be a third copy that nothing keeps honest.
 *
 * The `--` form is the one an agent should reach for. The lease lives exactly as
 * long as the child process: it is beaten while the command runs and released on
 * success, on failure, and on Ctrl-C. A lease outliving the process that took it
 * is the failure this shape makes unreachable, and it is the failure a bare
 * `acquire` in an agent's shell would otherwise produce every time the agent
 * moved on and forgot.
 */

import { spawn } from 'node:child_process';
import pc from 'picocolors';
import {
  claimAcquireResponseSchema,
  claimHeartbeatReplySchema,
  claimListResponseSchema,
  claimReleaseReplySchema,
  claimStateSchema,
  claimTtlMs,
  type ClaimAcquireResponse,
  type ClaimState,
} from '@abloatai/transaction/claims/contract';
import {
  CLAIM_ROUTES,
  claimByIdPath,
  claimHeartbeatOnModelPath,
  claimOnModelPath,
} from '@abloatai/transaction/claims/routes';
import type { ModelClaim } from '@abloatai/transaction/coordination/schema';
import { requestControlPlane } from './controlPlane';
import { usageFor } from './commands';
import { resolveRuntimeApiKey } from './config';

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * The lease is a runtime operation, so it travels on the runtime credential
 * rather than the management key the workspace verbs use.
 */
function requireRuntimeKey(): string {
  const { key } = resolveRuntimeApiKey();
  if (!key) {
    writeStderr(
      pc.red('  No runtime credential.') +
        pc.dim(
          ` Run ${pc.bold('npx ablo login')}, or set ${pc.bold('ABLO_API_KEY')} to a runtime key.`,
        ),
    );
    process.exit(1);
  }
  return key;
}

/** Flags that consume the argument after them, so positional scanning skips it. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--ttl', '--description', '--actor']);

interface Flags {
  readonly json: boolean;
  readonly queue: boolean;
  readonly ttl: string | undefined;
  readonly description: string | undefined;
  readonly actor: string | undefined;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

function parseFlags(argv: readonly string[]): Flags {
  return {
    json: argv.includes('--json') || process.env.ABLO_JSON === '1',
    queue: argv.includes('--queue'),
    ttl: flagValue(argv, 'ttl'),
    description: flagValue(argv, 'description'),
    actor: flagValue(argv, 'actor'),
  };
}

/** Everything before `--`, and the command after it. */
function splitAtCommand(argv: readonly string[]): {
  readonly args: readonly string[];
  readonly command: readonly string[];
} {
  const at = argv.indexOf('--');
  return at === -1
    ? { args: argv, command: [] }
    : { args: argv.slice(0, at), command: argv.slice(at + 1) };
}

function positionals(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

async function acquireClaim(
  model: string,
  id: string,
  flags: Flags,
  apiKey: string,
): Promise<ClaimAcquireResponse> {
  return requestControlPlane({
    path: claimOnModelPath({ model, id }),
    method: 'POST',
    apiKey,
    body: {
      ...(flags.ttl !== undefined ? { ttl: flags.ttl } : {}),
      ...(flags.description !== undefined ? { description: flags.description } : {}),
      ...(flags.queue ? { queue: true } : {}),
    },
    responseSchema: claimAcquireResponseSchema,
  });
}

async function releaseClaim(model: string, id: string, apiKey: string): Promise<boolean> {
  const reply = await requestControlPlane({
    path: claimOnModelPath({ model, id }),
    method: 'DELETE',
    apiKey,
    responseSchema: claimReleaseReplySchema,
  });
  return reply.released;
}

async function beat(
  model: string,
  id: string,
  ttl: string | undefined,
  apiKey: string,
): Promise<void> {
  await requestControlPlane({
    path: claimHeartbeatOnModelPath({ model, id }),
    method: 'POST',
    apiKey,
    body: ttl !== undefined ? { ttl } : {},
    responseSchema: claimHeartbeatReplySchema,
  });
}

async function pollClaim(claimId: string, apiKey: string): Promise<ClaimState> {
  return requestControlPlane({
    path: claimByIdPath(claimId),
    apiKey,
    responseSchema: claimStateSchema,
  });
}

/**
 * Wait for a queued claim to be granted.
 *
 * The socket path is told about its grant; a shell has no stream to be told on,
 * so it asks. Only `status` is read: the contract warns that a wait-line
 * position can move backwards when a privileged caller reorders the line, so a
 * poll that watched `position` for progress would be wrong in exactly the case
 * reordering exists for. Terminal statuses are treated as a set rather than
 * enumerated, because the contract declares one (`committed`) that the release
 * path cannot yet answer.
 */
async function waitForGrant(claimId: string, ttl: string | undefined, apiKey: string): Promise<void> {
  const everyMs = Math.max(1_000, Math.floor(claimTtlMs(ttl) / 4));
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    const state = await pollClaim(claimId, apiKey);
    if (state.status === 'active') return;
    if (state.status !== 'queued') {
      throw new Error(`the wait ended without the lease (${state.status})`);
    }
  }
}

function describeAcquired(model: string, id: string, granted: ClaimAcquireResponse): string {
  if (granted.status === 'queued') {
    const ahead = granted.position;
    return (
      `  ${pc.yellow('·')} Waiting for ${pc.bold(`${model} ${id}`)}. ` +
      pc.dim(ahead === 0 ? 'Next in line.' : `${ahead} ahead of you.`)
    );
  }
  return `  ${pc.green('✓')} Holding ${pc.bold(`${model} ${id}`)}.`;
}

/**
 * Hold the lease for exactly the life of a child process.
 *
 * The beat runs at a third of the granted lease, derived through the contract's
 * own reading of the duration grammar rather than a cadence guessed here — the
 * defect that grammar exists to prevent was a client beating on one reading of
 * `ttl` while the server granted a lease on another.
 */
async function holdWhile(
  model: string,
  id: string,
  flags: Flags,
  apiKey: string,
  command: readonly string[],
): Promise<number> {
  const granted = await acquireClaim(model, id, flags, apiKey);
  if (granted.status === 'queued') {
    if (!flags.json) writeStderr(describeAcquired(model, id, granted));
    await waitForGrant(granted.id, flags.ttl, apiKey);
  }
  if (!flags.json) writeStderr(`  ${pc.green('✓')} Holding ${pc.bold(`${model} ${id}`)}.`);

  const everyMs = Math.max(1_000, Math.floor(claimTtlMs(flags.ttl) / 3));
  const timer = setInterval(() => {
    void beat(model, id, flags.ttl, apiKey).catch(() => {
      // A missed beat is not fatal on its own: the lease still runs until it
      // expires, and the write that matters will be refused if it lapsed. The
      // command keeps going rather than being killed by a transient blip.
    });
  }, everyMs);

  let released = false;
  const giveBack = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      await releaseClaim(model, id, apiKey);
    } catch {
      // Nothing useful is left to do: the lease expires on its own, and a
      // failure to say so must not mask the command's own exit code.
    }
  };

  const [head, ...rest] = command;
  if (head === undefined) {
    await giveBack();
    throw new Error('no command was given after `--`');
  }

  const code = await new Promise<number>((resolve) => {
    const child = spawn(head, rest, { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(127);
    });
    child.on('close', (status) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(status ?? 1);
    });
  });

  await giveBack();
  if (!flags.json) writeStderr(`  ${pc.dim('·')} ${pc.dim(`Released ${model} ${id}.`)}`);
  return code;
}

/**
 * The listing. Holders come first and waiters follow, which is the order the
 * route returns them in, so the rows are not re-sorted here.
 *
 * The claim id is carried only by `--json`. On the terminal a reader is asking
 * who holds a row, and an opaque identifier in every row would crowd out the
 * three facts they came for.
 */
function renderList(rows: readonly ModelClaim[]): void {
  if (rows.length === 0) {
    console.log(`  ${pc.dim('Nothing is held right now.')}`);
    return;
  }
  const held = rows.filter((row) => row.status !== 'queued').length;
  const waiting = rows.length - held;
  console.log();
  for (const row of rows) {
    const where = `${row.target.model} ${row.target.id}`;
    const state =
      row.status === 'queued'
        ? pc.yellow(row.position === undefined ? 'waiting' : `waiting (${row.position} ahead)`)
        : pc.green('held');
    console.log(
      `  ${pc.bold(where.padEnd(28))} ${state.padEnd(28)} ${pc.dim(row.description ?? row.actor)}`,
    );
  }
  console.log();
  console.log(pc.dim(`  ${held} held, ${waiting} waiting.`));
  console.log();
}

export async function claims(argv: readonly string[] = []): Promise<void> {
  const { args, command } = splitAtCommand(argv);
  const flags = parseFlags(args);
  const [verb, ...rest] = positionals(args);

  if (verb === undefined || verb === 'help' || args.includes('--help')) {
    console.log(usageFor('claims'));
    return;
  }

  const apiKey = requireRuntimeKey();

  if (verb === 'list') {
    const [model, id] = rest;
    const query = new URLSearchParams();
    if (model !== undefined) query.set('model', model);
    if (id !== undefined) query.set('id', id);
    if (flags.actor !== undefined) query.set('actorId', flags.actor);
    const suffix = query.toString();
    const page = await requestControlPlane({
      path: `${CLAIM_ROUTES.collection}${suffix ? `?${suffix}` : ''}`,
      apiKey,
      responseSchema: claimListResponseSchema,
    });
    if (flags.json) console.log(JSON.stringify(page, null, 2));
    else renderList(page.data);
    return;
  }

  const [model, id] = rest;
  if (model === undefined || id === undefined) {
    writeStderr(`  ${pc.red('✗')} Name the row: ${pc.bold(`ablo claims ${verb} <model> <id>`)}.`);
    process.exitCode = 1;
    return;
  }

  if (verb === 'acquire') {
    if (command.length > 0) {
      process.exitCode = await holdWhile(model, id, flags, apiKey, command);
      return;
    }
    const granted = await acquireClaim(model, id, flags, apiKey);
    if (flags.json) console.log(JSON.stringify(granted, null, 2));
    else console.log(describeAcquired(model, id, granted));
    return;
  }

  if (verb === 'release') {
    const released = await releaseClaim(model, id, apiKey);
    if (flags.json) console.log(JSON.stringify({ object: 'claim_release', released }, null, 2));
    else if (released) console.log(`  ${pc.green('✓')} Released ${pc.bold(`${model} ${id}`)}.`);
    else console.log(`  ${pc.dim('·')} ${pc.dim(`You were not holding ${model} ${id}.`)}`);
    return;
  }

  if (verb === 'heartbeat') {
    await beat(model, id, flags.ttl, apiKey);
    if (flags.json) console.log(JSON.stringify({ object: 'claim_heartbeat', ok: true }, null, 2));
    else console.log(`  ${pc.green('✓')} Still holding ${pc.bold(`${model} ${id}`)}.`);
    return;
  }

  writeStderr(`  ${pc.red('✗')} Unknown: ${pc.bold(`ablo claims ${verb}`)}.`);
  const usage = usageFor('claims');
  if (usage) writeStderr(usage);
  process.exitCode = 1;
}
