/**
 * `ablo projects` manages the projects within your organization.
 *
 *   ablo projects list                 List projects with the keys this shell
 *                                      holds for each, and their age
 *   ablo projects list --json          The same, with ids and timestamps
 *   ablo projects create <slug>        Create a project (--name "Display Name")
 *   ablo projects rename <ref> <name>  Rename a project's display name (the
 *                                      slug is the stable handle and never changes)
 *   ablo projects use <slug|id>        Set the active project (stored locally
 *                                      in config.json, like `ablo mode`)
 *   ablo projects use default          Return to the organization's default project
 *
 * The active project is a local, non-secret targeting preference: `ablo status`
 * shows it, and keys minted through the CLI or dashboard pick it up. A key's
 * project scope is fixed by the server when the key is minted, so switching the
 * active project never changes what an existing key can reach.
 */

import pc from 'picocolors';
import {
  resolveOrgManagementKey,
  getActiveProject,
  setActiveProject,
  guardActiveProjectKey,
  readConfig,
  DEFAULT_PROFILE,
  type ProfileKeys,
} from './config';
import { ABLO_DEFAULT_BASE_URL } from '@abloatai/transaction/auth/hostedEndpoints';
import {
  projectResponseSchema,
  projectListResponseSchema,
  type ProjectResponse,
} from '@abloatai/transaction/wire';
import { brand } from './theme';

/**
 * A project, as the server defines it. Re-exported so the CLI's own modules
 * have a local name for it without restating the fields.
 */
export type ProjectObject = ProjectResponse;

function apiUrl(): string {
  return (process.env.ABLO_API_URL ?? ABLO_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requireKey(): string {
  const apiKey = resolveOrgManagementKey();
  if (!apiKey) {
    console.error(
      pc.red('  No project management credential.') +
        pc.dim(
          ` Run ${pc.bold('npx ablo login')} — or set ${pc.bold('ABLO_MANAGEMENT_KEY')} ` +
            `to an ${pc.bold('mk_')} credential.`,
        ),
    );
    process.exit(1);
  }
  return apiKey;
}

async function request(
  path: string,
  apiKey: string,
  init: { method?: string; body?: unknown } = {},
  baseUrl?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl ?? apiUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body };
}

/** A listing, or why there isn't one. */
export type ProjectListResult =
  | { readonly ok: true; readonly projects: readonly ProjectResponse[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Lists the projects the key can see (`GET /api/v1/projects`). Every failure —
 * no key, an unreachable server, a denial, a body that doesn't match — answers
 * with the reason rather than an absence, so a caller degrades knowingly.
 *
 * The reason is the point. This used to return `null` for all of them, and
 * `nameProject` read that as "no name available" and used the project's id as
 * its slug — so a failed call was indistinguishable from a project named after
 * its own id, and the id reached a production confirmation prompt as the word
 * to type. `baseUrl` overrides the default host so a command with `--url` names
 * projects against the same server it targets.
 */
export async function listProjects(
  apiKey: string,
  baseUrl?: string,
): Promise<ProjectListResult> {
  try {
    const { status, body } = await request('/api/v1/projects', apiKey, {}, baseUrl);
    if (status !== 200) {
      const code = (body as { code?: unknown } | null)?.code;
      return { ok: false, reason: typeof code === 'string' ? code : `HTTP ${status}` };
    }
    // The one place this response is checked. Below here it is a typed value,
    // never re-examined — a body that does not match is a failure to degrade
    // from, not a shape to cast over.
    const parsed = projectListResponseSchema.safeParse(body);
    return parsed.success
      ? { ok: true, projects: parsed.data.data }
      : { ok: false, reason: 'the response did not match the project list' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'the request failed' };
  }
}

/**
 * The single project a create or rename answers with. Returns null when the
 * body is not one, so a caller reports a failed call rather than reading fields
 * off a shape it only assumed.
 */
function parseProject(body: unknown): ProjectResponse | null {
  const parsed = projectResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

async function fetchProjects(): Promise<readonly ProjectObject[]> {
  const listed = await listProjects(requireKey());
  if (!listed.ok) {
    console.error(pc.red(`  Could not list projects — ${listed.reason}.`));
    process.exit(1);
  }
  return listed.projects;
}

/**
 * Derive a project slug from an npm package name (`@scope/my-app` →
 * `scope-my-app`). Returns undefined when nothing usable survives (or the
 * result would be the reserved `default`).
 */
export function projectSlugFromPackageName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
  if (!slug || slug === 'default') return undefined;
  return slug;
}

/**
 * Ensures a project with this slug exists and makes it the active one. The call
 * is idempotent: if the slug is already taken, it resolves to the existing
 * project instead of failing. Returns null on any failure — no key, an
 * unreachable server, or a denial — so a caller such as `ablo init` can fall
 * back to the organization's default project rather than stop.
 */
export async function ensureProject(
  slug: string,
  name?: string,
): Promise<{ id: string; slug: string; created: boolean } | null> {
  const apiKey = resolveOrgManagementKey();
  if (!apiKey) return null;
  try {
    const { status, body } = await request('/api/v1/projects', apiKey, {
      method: 'POST',
      body: { slug, ...(name ? { name } : {}) },
    });
    if (status === 201) {
      const created = parseProject(body);
      if (!created) return null;
      setActiveProject({ id: created.id, slug: created.slug });
      return { id: created.id, slug: created.slug, created: true };
    }
    if (body.code === 'project_slug_taken') {
      const listed = await listProjects(apiKey);
      const existing = listed.ok ? listed.projects.find((p) => p.slug === slug) : undefined;
      if (!existing) return null;
      setActiveProject({ id: existing.id, slug: existing.slug });
      return { id: existing.id, slug: existing.slug, created: false };
    }
    return null;
  } catch {
    return null;
  }
}

// Column widths are measured on the text a terminal actually shows, so a
// colored cell pads the same as a plain one.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI_ESCAPE, '').length;
const pad = (s: string, width: number): string =>
  s + ' '.repeat(Math.max(0, width - visibleLength(s)));

/**
 * Which credentials this shell holds for a project, read from the local config.
 * This is the question `ablo push` answers with a refusal when it goes unasked,
 * and it is knowable without a round trip — the keys are already on disk.
 */
function describeKeys(profile: ProfileKeys | undefined): string {
  const now = Date.now();
  let usable = 0;
  let expired = 0;
  for (const entry of [profile?.management, profile?.sandbox, profile?.production]) {
    if (!entry) continue;
    const expiry = entry.expiresAt !== undefined ? Date.parse(entry.expiresAt) : undefined;
    if (expiry !== undefined && Number.isFinite(expiry) && expiry <= now) expired += 1;
    else usable += 1;
  }
  const parts: string[] = [];
  if (usable > 0) parts.push(`${usable} credential${usable === 1 ? '' : 's'}`);
  if (expired > 0) parts.push(pc.yellow(`${expired} expired`));
  return parts.length > 0 ? parts.join(pc.dim(', ')) : pc.dim('no credentials');
}

/**
 * Compact age (`today`, `6d`, `5w`, `7mo`). The organization-default project is
 * synthesized rather than stored, and carries the epoch as its creation time —
 * it has no age to report, so it reports none instead of "56y".
 */
function describeAge(createdAt: string): string {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 7) return `${days}d`;
  if (days < 56) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function printList(projects: readonly ProjectObject[]): void {
  const active = getActiveProject();
  const profiles = readConfig()?.profiles ?? {};
  // A display name that only re-spells its slug ("Billing API" for `billing-api`)
  // says nothing twice, so it earns no column — and where no project has a name
  // that adds anything, the column itself goes.
  const spelling = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameOf = (p: ProjectObject): string =>
    p.name && spelling(p.name) !== spelling(p.slug) ? p.name : '';
  const showNames = projects.some((p) => nameOf(p) !== '');

  const slugWidth = Math.max(...projects.map((p) => p.slug.length));
  const nameWidth = showNames ? Math.max(...projects.map((p) => nameOf(p).length)) : 0;
  const rows = projects.map((p) => ({
    project: p,
    // Keys live under the project's slug, except the organization-default,
    // which owns the reserved `default` profile.
    keys: describeKeys(profiles[p.default ? DEFAULT_PROFILE : p.slug]),
  }));
  const keysWidth = Math.max(...rows.map((r) => visibleLength(r.keys)));

  for (const { project: p, keys } of rows) {
    // Active = the explicit `use` selection, else the org-default project.
    const isActive = active ? active.id === p.id : p.default;
    const marker = isActive ? pc.green('●') : pc.dim('○');
    // Only one flag is worth a word: which project the next command targets.
    // Being the organization default changes nothing you would do differently,
    // and its slug already says so.
    const tags = isActive ? pc.green('active') : '';
    const cells = [
      pad(p.slug, slugWidth),
      ...(showNames ? [pc.dim(pad(nameOf(p), nameWidth))] : []),
      pad(keys, keysWidth),
      pc.dim(pad(describeAge(p.created_at), 5)),
    ];
    console.log(`  ${marker} ${cells.join('  ')}${tags ? `  ${tags}` : ''}`.trimEnd());
  }
}

export async function projects(argv: readonly string[]): Promise<void> {
  const sub = argv[0];

  if (sub === 'list' || sub === undefined) {
    const all = await fetchProjects();
    // The table shows what you act on; ids and timestamps are what you pipe.
    if (argv.includes('--json')) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    console.log(`\n  ${brand('ablo')} ${pc.dim('projects')}\n`);
    printList(all);
    console.log();
    return;
  }

  if (sub === 'create') {
    const slug = argv[1];
    if (!slug || slug.startsWith('-')) {
      console.error(pc.red('  usage: ablo projects create <slug> [--name "Display Name"]'));
      process.exit(1);
    }
    const nameIdx = argv.indexOf('--name');
    const name = nameIdx >= 0 ? argv[nameIdx + 1] : undefined;
    const { status, body } = await request('/api/v1/projects', requireKey(), {
      method: 'POST',
      body: { slug, ...(name ? { name } : {}) },
    });
    if (status !== 201) {
      console.error(
        pc.red(`  Create failed (${status}): ${String(body.message ?? body.code ?? '')}`),
      );
      if (body.code === 'project_slug_taken') {
        console.error(pc.dim(`  Pick another slug, or switch to it: ${pc.bold(`ablo projects use ${slug}`)}`));
      }
      process.exit(1);
    }
    const created = parseProject(body);
    if (!created) {
      console.error(pc.red('  Created, but the server answered with an unfamiliar shape.'));
      process.exit(1);
    }
    console.log(`  ${pc.green('✓')} Created project ${pc.bold(created.slug)} ${pc.dim(`(${created.id})`)}`);
    console.log(
      pc.dim(`  Make it active with ${pc.bold(`ablo projects use ${created.slug}`)}; mint its keys in the dashboard.`),
    );
    return;
  }

  if (sub === 'rename') {
    const ref = argv[1];
    // Everything after the ref is the new name, so an unquoted multi-word name
    // (`ablo projects rename epsilon Epsilon Team`) still works.
    const name = argv.slice(2).join(' ').trim();
    if (!ref || ref.startsWith('-') || !name) {
      console.error(pc.red('  usage: ablo projects rename <slug|id> <new name>'));
      process.exit(1);
    }
    const all = await fetchProjects();
    const target = all.find((p) => p.slug === ref || p.id === ref);
    if (!target) {
      console.error(pc.red(`  No project "${ref}".`) + pc.dim(' Run ablo projects list.'));
      process.exit(1);
    }
    if (target.default) {
      console.error(pc.red('  The default project cannot be renamed.'));
      process.exit(1);
    }
    const { status, body } = await request(`/api/v1/projects/${target.id}`, requireKey(), {
      method: 'PATCH',
      body: { name },
    });
    if (status !== 200) {
      console.error(
        pc.red(`  Rename failed (${status}): ${String(body.message ?? body.code ?? '')}`),
      );
      process.exit(1);
    }
    const updated = parseProject(body);
    if (!updated) {
      console.error(pc.red('  Renamed, but the server answered with an unfamiliar shape.'));
      process.exit(1);
    }
    console.log(
      `  ${pc.green('✓')} Renamed ${pc.bold(updated.slug)} → ${pc.bold(updated.name)} ${pc.dim(`(${updated.id})`)}`,
    );
    return;
  }

  if (sub === 'use') {
    const ref = argv[1];
    if (!ref) {
      console.error(pc.red('  usage: ablo projects use <slug|id|default>'));
      process.exit(1);
    }
    const all = await fetchProjects();
    const target = all.find((p) => p.slug === ref || p.id === ref);
    if (!target) {
      console.error(pc.red(`  No project "${ref}".`) + pc.dim(' Run ablo projects list.'));
      process.exit(1);
    }
    if (target.default) {
      setActiveProject(undefined); // org-default = no stored preference
      console.log(`  ${pc.green('✓')} now targeting the ${pc.bold('default')} project`);
    } else {
      setActiveProject({ id: target.id, slug: target.slug });
      console.log(`  ${pc.green('✓')} now targeting project ${pc.bold(target.slug)} ${pc.dim(`(${target.id})`)}`);
    }
    // A key's project scope is fixed when it is minted, so switching never
    // re-scopes an existing key. If this project has no key yet, point at the
    // command that mints one rather than let a later command fail.
    const guard = guardActiveProjectKey();
    if (!guard.ok) {
      const loginCmd =
        guard.activeProfile === DEFAULT_PROFILE
          ? 'ablo login'
          : `ablo login --project ${guard.activeProfile}`;
      console.log(
        pc.dim(`  No key stored for this project yet — run ${pc.bold(loginCmd)} to mint one.`),
      );
    }
    return;
  }

  console.error(
    pc.red(`  unknown subcommand: ${sub}`) +
      pc.dim(
        ` (expected ${pc.bold('list')}, ${pc.bold('create')}, ${pc.bold('rename')}, or ${pc.bold('use')})`,
      ),
  );
  process.exit(1);
}
