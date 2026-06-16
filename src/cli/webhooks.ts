/**
 * `ablo webhooks` — manage the outbound webhook endpoints Ablo streams your
 * committed changes to (the Stripe `webhook_endpoints` resource, Svix's
 * `endpoint`). The signing secret is MINTED by Ablo and shown ONCE; `create` and
 * `roll` write it straight into your env file so you never copy/paste it.
 *
 *   ablo webhooks create <url> [--events a,b] [--description "..."]
 *   ablo webhooks list
 *   ablo webhooks roll <id>
 *   ablo webhooks enable <id>
 *   ablo webhooks rm <id>
 *
 * Local dev needs none of this — `ablo dev` already forwards to your machine
 * (the `stripe listen` model). Register a real endpoint only for a deployed URL.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import pc from 'picocolors';
import { classifyCredentialKind } from '../auth/credentialPolicy.js';
import { resolveApiKey, normalizeMode, type Mode } from './config';
import { brand } from './theme';
import { DEFAULT_URL } from './push';

interface WebhookEndpointObject {
  object: 'webhook_endpoint';
  id: string;
  url: string;
  environment: string;
  status: string;
  enabled_events: string[];
  description: string | null;
  secret_last4: string | null;
  disabled_reason: string | null;
  cursor: string | null;
  retry_count: number;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
}
type CreatedWebhookEndpoint = WebhookEndpointObject & { secret: string };

const ENV_KEY = 'ABLO_WEBHOOK_SECRET';

function flag(args: readonly string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  const next = args[i + 1];
  return i >= 0 && next && !next.startsWith('-') ? next : undefined;
}

function parseMode(args: readonly string[]): Mode | undefined {
  return normalizeMode(flag(args, '--mode'));
}

/** First positional (non-flag, not consumed by a flag) argument. */
function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // Skip a value-bearing flag's value (unless it's `--flag=value`).
      if (!a.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function requireKey(mode: Mode | undefined): string {
  const apiKey = resolveApiKey(mode);
  if (!apiKey) {
    console.error(
      pc.red('  No API key.') + pc.dim(` Run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')}.`),
    );
    process.exit(1);
  }
  if (classifyCredentialKind(apiKey) !== 'secret') {
    console.error(pc.red('  Managing webhooks requires a secret key ') + pc.dim('(sk_test_ / sk_live_).'));
    process.exit(1);
  }
  return apiKey;
}

const baseUrl = (): string => (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');

async function api<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}/api/v1/webhook_endpoints${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null);
  if (!res) {
    console.error(pc.red(`  Couldn't reach ${baseUrl()}.`));
    process.exit(1);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; reason?: string };
    console.error(pc.red(`  Request failed (${res.status}): ${err.message ?? err.reason ?? ''}`));
    process.exit(1);
  }
  return (await res.json()) as T;
}

/** Upsert `ABLO_WEBHOOK_SECRET=<secret>` into the project's env file. */
function writeSecretToEnv(secret: string): string {
  const file = existsSync('.env.local') ? '.env.local' : existsSync('.env') ? '.env' : '.env.local';
  const line = `${ENV_KEY}=${secret}`;
  let next: string;
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8');
    next = new RegExp(`^${ENV_KEY}=.*$`, 'm').test(existing)
      ? existing.replace(new RegExp(`^${ENV_KEY}=.*$`, 'm'), line)
      : `${existing.replace(/\n*$/, '')}\n${line}\n`;
  } else {
    next = `${line}\n`;
  }
  writeFileSync(file, next);
  return file;
}

function printEndpoint(e: WebhookEndpointObject): void {
  const dot = e.status === 'enabled' ? pc.green('●') : pc.red('●');
  const health = e.last_error ? pc.red(` last error: ${e.last_error}`) : '';
  console.log(`  ${dot} ${pc.bold(e.id)}  ${e.url}`);
  console.log(
    pc.dim(
      `      ${e.status} · ${e.environment} · events ${e.enabled_events.join(',')} · cursor ${e.cursor ?? '—'}${health}`,
    ),
  );
}

export async function webhooks(argv: readonly string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const mode = parseMode(rest);

  if (sub === 'create') {
    const url = positional(rest);
    if (!url) {
      console.error(pc.red('  Usage: ') + brand('ablo webhooks create <url>'));
      process.exit(1);
    }
    const apiKey = requireKey(mode);
    const events = flag(rest, '--events');
    const created = await api<CreatedWebhookEndpoint>(apiKey, 'POST', '', {
      url,
      ...(events ? { enabledEvents: events.split(',').map((s) => s.trim()) } : {}),
      ...(flag(rest, '--description') ? { description: flag(rest, '--description') } : {}),
    });
    const file = writeSecretToEnv(created.secret);
    console.log(`\n  ${pc.green('✓')} Registered ${pc.bold(created.id)} → ${created.url}`);
    console.log(`  ${pc.green('✓')} Wrote ${pc.bold(ENV_KEY)} to ${pc.bold(file)} ${pc.dim('(shown once)')}\n`);
    return;
  }

  if (sub === 'list') {
    const apiKey = requireKey(mode);
    const { data } = await api<{ data: WebhookEndpointObject[] }>(apiKey, 'GET', '');
    if (data.length === 0) {
      console.log(pc.dim('  No webhook endpoints. ') + brand('ablo webhooks create <url>'));
      return;
    }
    console.log();
    data.forEach(printEndpoint);
    console.log();
    return;
  }

  if (sub === 'roll') {
    const id = positional(rest);
    if (!id) {
      console.error(pc.red('  Usage: ') + brand('ablo webhooks roll <id>'));
      process.exit(1);
    }
    const apiKey = requireKey(mode);
    const rolled = await api<CreatedWebhookEndpoint>(apiKey, 'POST', `/${id}/roll_secret`);
    const file = writeSecretToEnv(rolled.secret);
    console.log(`\n  ${pc.green('✓')} Rolled secret for ${pc.bold(id)} → ${pc.bold(file)} ${pc.dim('(old secret now invalid)')}\n`);
    return;
  }

  if (sub === 'enable') {
    const id = positional(rest);
    if (!id) {
      console.error(pc.red('  Usage: ') + brand('ablo webhooks enable <id>'));
      process.exit(1);
    }
    const apiKey = requireKey(mode);
    const e = await api<WebhookEndpointObject>(apiKey, 'POST', `/${id}/enable`);
    console.log(`  ${pc.green('✓')} Re-enabled ${pc.bold(e.id)}`);
    return;
  }

  if (sub === 'rm' || sub === 'delete') {
    const id = positional(rest);
    if (!id) {
      console.error(pc.red('  Usage: ') + brand('ablo webhooks rm <id>'));
      process.exit(1);
    }
    const apiKey = requireKey(mode);
    await api(apiKey, 'DELETE', `/${id}`);
    console.log(`  ${pc.green('✓')} Removed ${pc.bold(id)}`);
    return;
  }

  console.log(`  ${pc.bold('Usage:')}`);
  console.log(`    ${brand('ablo webhooks create <url>')}   Register an endpoint; writes ${ENV_KEY}`);
  console.log(`    ${brand('ablo webhooks list')}           List endpoints + delivery health`);
  console.log(`    ${brand('ablo webhooks roll <id>')}       Mint a fresh signing secret`);
  console.log(`    ${brand('ablo webhooks enable <id>')}     Re-enable a disabled endpoint`);
  console.log(`    ${brand('ablo webhooks rm <id>')}         Remove an endpoint`);
  if (sub && sub !== 'help') process.exitCode = 1;
}
