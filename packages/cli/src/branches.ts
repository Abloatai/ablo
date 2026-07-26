/**
 * `ablo branch` — immutable transaction-plane management.
 *
 * The API key fixes the organization and project. A branch slug is only a
 * handle; every follow-up mutation uses the immutable id returned by the
 * server.
 */

import pc from 'picocolors';
import {
  branchListResponseSchema,
  branchResponseSchema,
  branchSlugSchema,
  branchCredentialResponseSchema,
  branchStatusResponseSchema,
  type BranchResponse,
  type BranchCredentialResponse,
  type BranchStatusResponse,
} from '@abloatai/transaction/branches';
import { ABLO_DEFAULT_BASE_URL } from '@abloatai/transaction/auth/hostedEndpoints';
import { resolveManagementKey } from './config';

export const BRANCH_USAGE = `Usage:
  ablo branch list [--json]
  ablo branch create <slug> [--from <id|slug>] [--kind dev|preview|test|long_lived] [--credential]
  ablo branch ensure <slug> [--from <id|slug>] [--kind dev|preview|test|long_lived] [--credential]
  ablo branch credential <id|slug> [--ttl-hours <1-168>] [--json]
  ablo branch status <branch-id|slug> [--json]
  ablo branch check <branch-id|slug> [--json]
  ablo branch delete <id|slug>

Branches are scoped by the active project's management credential. Slugs are display handles;
automation should retain the immutable branch id returned by create/ensure.`;

interface BranchRequestContext {
  apiKey?: string;
  baseUrl?: string;
}

function apiUrl(baseUrl?: string): string {
  return (baseUrl ?? process.env.ABLO_API_URL ?? ABLO_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requireKey(explicit?: string): string {
  const key = explicit ?? resolveManagementKey();
  if (!key) {
    throw new Error(
      'No project management credential. Run `npx ablo login` or set ABLO_MANAGEMENT_KEY.',
    );
  }
  return key;
}

async function request(
  path: string,
  init: { method?: string; body?: unknown } = {},
  context: BranchRequestContext = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiUrl(context.baseUrl)}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${requireKey(context.apiKey)}`,
      'content-type': 'application/json',
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function message(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const value = (body as { message?: unknown }).message;
    if (typeof value === 'string') return value;
  }
  return fallback;
}

async function list(context: BranchRequestContext = {}): Promise<readonly BranchResponse[]> {
  const response = await request('/api/v1/branches', {}, context);
  if (response.status !== 200) {
    throw new Error(message(response.body, `Could not list branches (HTTP ${response.status}).`));
  }
  return branchListResponseSchema.parse(response.body).data;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function print(branches: readonly BranchResponse[]): void {
  const slugWidth = Math.max(...branches.map((branch) => branch.slug.length), 6);
  for (const branch of branches) {
    const marker = branch.root ? pc.green('●') : pc.dim('○');
    const kind = branch.root ? pc.green('root') : pc.dim(branch.kind);
    const state =
      branch.state === 'ready' ? pc.green(branch.state) : pc.yellow(branch.state);
    const expiry = branch.expires_at
      ? pc.dim(` expires ${new Date(branch.expires_at).toLocaleDateString()}`)
      : '';
    console.log(
      `  ${marker} ${branch.slug.padEnd(slugWidth)}  ${kind.padEnd(12)} ${state.padEnd(14)} ${pc.dim(branch.id)}${expiry}`,
    );
  }
}

function ttlHoursFrom(argv: readonly string[]): number {
  const rawHours = valueAfter(argv, '--ttl-hours');
  const ttlHours = rawHours === undefined ? 8 : Number(rawHours);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error('--ttl-hours must be between 1 and 168');
  }
  return ttlHours;
}

async function mintCredential(
  branchId: string,
  ttlHours: number,
  context: BranchRequestContext = {},
): Promise<BranchCredentialResponse> {
  const response = await request(
    `/api/v1/branches/${encodeURIComponent(branchId)}/credentials`,
    { method: 'POST', body: { ttl_hours: ttlHours } },
    context,
  );
  if (response.status !== 201) {
    throw new Error(
      message(response.body, `Could not mint branch credential (HTTP ${response.status}).`),
    );
  }
  return branchCredentialResponseSchema.parse(response.body);
}

async function resolveBranch(ref: string, context: BranchRequestContext = {}): Promise<BranchResponse> {
  const branch = (await list(context)).find(
    (candidate) => candidate.id === ref || candidate.slug === ref,
  );
  if (!branch) throw new Error(`Branch "${ref}" was not found in the active project.`);
  return branch;
}

async function readStatus(
  ref: string,
  context: BranchRequestContext = {},
): Promise<BranchStatusResponse> {
  const branch = await resolveBranch(ref, context);
  const response = await request(
    `/api/v1/branches/${encodeURIComponent(branch.id)}/status`,
    {},
    context,
  );
  if (response.status !== 200) {
    throw new Error(
      message(response.body, `Could not read branch status (HTTP ${response.status}).`),
    );
  }
  return branchStatusResponseSchema.parse(response.body);
}

function printStatus(status: BranchStatusResponse): void {
  const { branch, schema, data_source: source } = status;
  console.log(`  ${pc.bold(branch.slug)} ${pc.dim(branch.id)}`);
  console.log(
    `  ${pc.dim('state')}   ${branch.state === 'ready' ? pc.green(branch.state) : pc.yellow(branch.state)}`,
  );
  console.log(
    `  ${pc.dim('schema')}  ${
      schema.active
        ? `${pc.green('active')} ${pc.dim(`v${schema.version ?? '?'} · ${schema.hash ?? 'no hash'}`)}`
        : pc.red('missing')
    }`,
  );
  if (!branch.root) {
    const counts =
      schema.changes > 0
        ? pc.dim(
            ` · ${schema.changes} changes, ${schema.warnings} warnings, ${schema.blockers} blockers`,
          )
        : '';
    console.log(
      `  ${pc.dim('parent')}  ${pc.bold(schema.parent_compatibility)}${counts}`,
    );
  }
  const sourceLabel =
    source.kind === 'hosted'
      ? 'hosted branch plane'
      : `${source.kind} · ${source.host ?? 'unknown host'}${
          source.database ? `/${source.database}` : ''
        } · ${source.status ?? 'unknown'}`;
  console.log(`  ${pc.dim('data')}    ${sourceLabel}`);
  if (status.ready) {
    console.log(`\n  ${pc.green('✓ ready')}`);
  } else {
    console.log(`\n  ${pc.red('✗ not ready')}`);
    for (const blocker of status.blockers) {
      console.log(`    ${pc.red('•')} ${blocker.problem}`);
      console.log(`      ${pc.dim(`Fix: ${blocker.fix}`)}`);
    }
  }
}

async function create(
  slug: string,
  argv: readonly string[],
  idempotent: boolean,
  context: BranchRequestContext = {},
): Promise<BranchResponse> {
  const parsedSlug = branchSlugSchema.safeParse(slug);
  if (!parsedSlug.success) throw new Error(parsedSlug.error.issues[0]?.message ?? 'Invalid slug.');

  if (idempotent) {
    const existing = (await list(context)).find((branch) => branch.slug === parsedSlug.data);
    if (existing) return existing;
  }

  const parentRef = valueAfter(argv, '--from');
  const parentId = parentRef ? (await resolveBranch(parentRef, context)).id : undefined;
  const response = await request('/api/v1/branches', {
    method: 'POST',
    body: {
      slug: parsedSlug.data,
      ...(parentId ? { parent_branch_id: parentId } : {}),
      ...(valueAfter(argv, '--kind') ? { kind: valueAfter(argv, '--kind') } : {}),
      ...(valueAfter(argv, '--expires-at')
        ? { expires_at: valueAfter(argv, '--expires-at') }
        : {}),
    },
  }, context);
  if (response.status !== 201) {
    // A concurrent ensure can win between list and create. Resolve it instead
    // of making idempotent automation implement its own retry.
    if (idempotent && response.status === 409) {
      const winner = (await list(context)).find((branch) => branch.slug === parsedSlug.data);
      if (winner) return winner;
    }
    throw new Error(message(response.body, `Could not create branch (HTTP ${response.status}).`));
  }
  return branchResponseSchema.parse(response.body);
}

export interface EnsureBranchCredentialInput {
  slug: string;
  apiKey: string;
  baseUrl?: string;
  ttlHours?: number;
  kind?: 'dev' | 'preview' | 'test' | 'long_lived';
}

/**
 * Resolve-or-create a branch and exchange the management credential for one
 * expiring runtime credential. The plaintext key is returned to the caller
 * only; this helper never writes it to config or an env file.
 */
export async function ensureBranchCredential(
  input: EnsureBranchCredentialInput,
): Promise<{ branch: BranchResponse; credential: BranchCredentialResponse }> {
  const context: BranchRequestContext = {
    apiKey: input.apiKey,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
  const branch = await create(
    input.slug,
    input.kind ? ['--kind', input.kind] : [],
    true,
    context,
  );
  const credential = await mintCredential(branch.id, input.ttlHours ?? 8, context);
  return { branch, credential };
}

export async function branches(argv: readonly string[]): Promise<void> {
  const [command = 'list', ref] = argv;
  if (command === 'list') {
    const rows = await list();
    if (argv.includes('--json')) console.log(JSON.stringify({ object: 'list', data: rows }, null, 2));
    else print(rows);
    return;
  }

  if (command === 'create' || command === 'ensure') {
    if (!ref || ref.startsWith('--')) throw new Error(`Usage: ablo branch ${command} <slug>`);
    const row = await create(ref, argv.slice(2), command === 'ensure');
    const credential = argv.includes('--credential')
      ? await mintCredential(row.id, ttlHoursFrom(argv.slice(2)))
      : null;
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify(
          credential
            ? { object: 'branch_bootstrap', branch: row, credential }
            : row,
          null,
          2,
        ),
      );
    }
    else {
      console.log(`  ${pc.green('✓')} ${row.slug} ${pc.dim(row.id)}`);
      console.log(pc.dim(`    parent ${row.parent_branch_id ?? 'none'} · ${row.state}`));
      if (credential) {
        console.log(credential.api_key);
        console.error(
          pc.dim(`  expires ${credential.expires_at} · branch ${credential.branch_id}`),
        );
      }
    }
    return;
  }

  if (command === 'status' || command === 'check') {
    if (!ref || ref.startsWith('--')) {
      throw new Error(`Usage: ablo branch ${command} <branch-id|slug> [--json]`);
    }
    const status = await readStatus(ref);
    if (argv.includes('--json')) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    return;
  }

  if (command === 'delete') {
    if (!ref || ref.startsWith('--')) throw new Error('Usage: ablo branch delete <id|slug>');
    const branch = await resolveBranch(ref);
    const response = await request(`/api/v1/branches/${encodeURIComponent(branch.id)}`, {
      method: 'DELETE',
    });
    if (response.status !== 200) {
      throw new Error(message(response.body, `Could not delete branch (HTTP ${response.status}).`));
    }
    const row = branchResponseSchema.parse(response.body);
    console.log(`  ${pc.green('✓')} deleted ${row.slug} ${pc.dim(row.id)}`);
    return;
  }

  if (command === 'credential') {
    if (!ref || ref.startsWith('--')) {
      throw new Error('Usage: ablo branch credential <id|slug> [--ttl-hours <1-168>]');
    }
    const branch = await resolveBranch(ref);
    const credential = await mintCredential(branch.id, ttlHoursFrom(argv.slice(2)));
    if (argv.includes('--json')) console.log(JSON.stringify(credential, null, 2));
    else {
      console.log(credential.api_key);
      console.error(pc.dim(`  expires ${credential.expires_at} · branch ${credential.branch_id}`));
    }
    return;
  }

  throw new Error(BRANCH_USAGE);
}
