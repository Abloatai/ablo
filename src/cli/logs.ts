/**
 * `ablo logs` — tail your sandbox's commit activity (Stripe's `logs tail`).
 *
 * Scope is the API key's: a test key streams only its sandbox's deltas, a live
 * key the org's. The server enforces it from the key; the CLI just polls from a
 * cursor. Follows by default; `--no-follow` prints recent and exits.
 *
 *   ablo logs                     # last 50, then stream
 *   ablo logs -n 100 --model task # backfill 100, filter to one model
 *   ablo logs --since 15m --json  # last 15m as NDJSON, then stream
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import { resolveApiKey, normalizeMode, type Mode } from './config';
import { brand } from './theme';
import { DEFAULT_URL } from './push';

interface LogEvent {
  id: number;
  at: string;
  model: string;
  op: string;
  recordId: string;
  actor: string | null;
}

interface LogsArgs {
  follow: boolean;
  tail: number;
  since: string | undefined;
  model: string | undefined;
  op: string | undefined;
  json: boolean;
  mode: Mode | undefined;
}

export function parseLogsArgs(argv: readonly string[]): LogsArgs {
  const args: LogsArgs = {
    follow: true,
    tail: 50,
    since: undefined,
    model: undefined,
    op: undefined,
    json: false,
    mode: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-f':
      case '--follow':
        args.follow = true;
        break;
      case '--no-follow':
        args.follow = false;
        break;
      case '-n':
      case '--tail':
        args.tail = Math.max(0, parseInt(argv[++i] ?? '50', 10) || 50);
        break;
      case '--since':
        args.since = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--op':
        args.op = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--mode': {
        const raw = argv[++i];
        const m = normalizeMode(raw);
        if (!m) throw new AbloValidationError(`--mode expects "sandbox" or "production", got "${raw}"`, { code: 'cli_invalid_arguments' });
        args.mode = m;
        break;
      }
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return args;
}

/** Resolve `--since` as a duration (`15m`/`2h`/`3d`/`30s`) or ISO timestamp → ISO. */
export function resolveSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const m = /^(\d+)([smhd])$/.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as 's' | 'm' | 'h' | 'd'];
    return new Date(Date.now() - n * unit).toISOString();
  }
  const t = Date.parse(since);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function colorOp(op: string): string {
  const label = op.padEnd(6);
  if (op === 'create') return pc.green(label);
  if (op === 'update') return pc.yellow(label);
  if (op === 'delete') return pc.red(label);
  return pc.dim(label);
}

function render(e: LogEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(e)}\n`);
    return;
  }
  const t = new Date(e.at).toLocaleTimeString();
  const actor = e.actor ? pc.dim(`  ${e.actor}`) : '';
  console.log(`  ${pc.dim(t)}  ${colorOp(e.op)}  ${pc.bold(e.model)} ${pc.dim(e.recordId)}${actor}`);
}

export async function logs(argv: readonly string[]): Promise<void> {
  let args: LogsArgs;
  try {
    args = parseLogsArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const apiKey = resolveApiKey(args.mode);
  if (!apiKey) {
    console.error(
      pc.red(`  No API key.`) + pc.dim(` Run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')}.`),
    );
    process.exit(1);
  }

  const baseUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const since = resolveSince(args.since);

  async function fetchPage(params: Record<string, string>): Promise<{ events: LogEvent[]; cursor: number } | null> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${baseUrl}/api/v1/logs?${qs}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }).catch(() => null);
    if (!res) return null;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string; message?: string };
      console.error(pc.red(`  logs failed (${res.status}): ${body.reason ?? body.message ?? ''}`));
      process.exit(1);
    }
    // Canonical list envelope `{ object:'list', data, next_cursor }`; tolerate
    // the legacy `{ events, cursor }` during rollout. Normalize to the CLI's
    // internal { events, cursor } so the render + follow loop stays unchanged.
    const json = (await res.json()) as {
      data?: LogEvent[];
      events?: LogEvent[];
      next_cursor?: string | null;
      cursor?: number;
    };
    return {
      events: json.data ?? json.events ?? [],
      cursor: json.next_cursor != null ? Number(json.next_cursor) : (json.cursor ?? 0),
    };
  }

  if (!args.json) {
    console.log(`\n  ${brand('ablo')} ${pc.dim('logs')} ${pc.dim(`(${args.mode ?? 'active'} mode)`)}\n`);
  }

  // Initial backfill (no `after` → recent N).
  const initial = await fetchPage({
    limit: String(args.tail),
    ...(since ? { since } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.op ? { op: args.op } : {}),
  });
  if (!initial) {
    console.error(pc.red(`  Couldn't reach ${baseUrl}.`));
    process.exit(1);
  }
  for (const e of initial.events) render(e, args.json);
  let cursor = initial.cursor;

  if (!args.follow) return;

  if (!args.json) console.log(`  ${pc.dim('watching for new activity … (Ctrl-C to stop)')}\n`);

  // Poll forward from the cursor. `since` only applies to the backfill.
  for (;;) {
    await sleep(1500);
    const page = await fetchPage({
      after: String(cursor),
      ...(args.model ? { model: args.model } : {}),
      ...(args.op ? { op: args.op } : {}),
    });
    if (!page) continue; // transient network blip — keep polling
    for (const e of page.events) render(e, args.json);
    if (page.cursor > cursor) cursor = page.cursor;
  }
}
