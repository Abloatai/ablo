/**
 * `ablo projects` manages the projects within your organization.
 *
 *   ablo projects list                 List projects (marks active and default)
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
  resolveApiKey,
  getActiveProject,
  setActiveProject,
  guardActiveProjectKey,
  DEFAULT_PROFILE,
} from './config';
import { ABLO_DEFAULT_BASE_URL } from '../client/hostedEndpoints.js';
import { brand } from './theme';

export interface ProjectObject {
  id: string;
  slug: string;
  name: string | null;
  default: boolean;
  created_at: string;
}

function apiUrl(): string {
  return (process.env.ABLO_API_URL ?? ABLO_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requireKey(): string {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red('  No API key.') +
        pc.dim(
          ` Run ${pc.bold('npx ablo login')} — or set ${pc.bold('ABLO_API_KEY')} ` +
            `(${pc.bold('sk_test_')} = sandbox; ${pc.bold('sk_live_')} = production).`,
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

/**
 * Lists the projects the key can see (`GET /api/v1/projects`). Returns null on
 * any failure — no key, an unreachable server, or a denial — so callers such as
 * `ablo status` degrade to a shorter output rather than erroring. `baseUrl`
 * overrides the default host so a command with `--url` names projects against
 * the same server it targets.
 */
export async function listProjects(apiKey: string, baseUrl?: string): Promise<ProjectObject[] | null> {
  try {
    const { status, body } = await request('/api/v1/projects', apiKey, {}, baseUrl);
    if (status !== 200 || !Array.isArray(body.data)) return null;
    return body.data as ProjectObject[];
  } catch {
    return null;
  }
}

async function fetchProjects(): Promise<ProjectObject[]> {
  const all = await listProjects(requireKey());
  if (!all) {
    console.error(pc.red('  Could not list projects — is the API reachable and the key valid?'));
    process.exit(1);
  }
  return all;
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
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  try {
    const { status, body } = await request('/api/v1/projects', apiKey, {
      method: 'POST',
      body: { slug, ...(name ? { name } : {}) },
    });
    if (status === 201) {
      const created = body as unknown as ProjectObject;
      setActiveProject({ id: created.id, slug: created.slug });
      return { id: created.id, slug: created.slug, created: true };
    }
    if (body.code === 'project_slug_taken') {
      const all = await listProjects(apiKey);
      const existing = all?.find((p) => p.slug === slug);
      if (!existing) return null;
      setActiveProject({ id: existing.id, slug: existing.slug });
      return { id: existing.id, slug: existing.slug, created: false };
    }
    return null;
  } catch {
    return null;
  }
}

function printList(projects: ProjectObject[]): void {
  const active = getActiveProject();
  for (const p of projects) {
    // Active = the explicit `use` selection, else the org-default project.
    const isActive = active ? active.id === p.id : p.default;
    const marker = isActive ? pc.green('●') : pc.dim('○');
    const tags = [p.default ? pc.dim('default') : '', isActive ? pc.green('active') : '']
      .filter(Boolean)
      .join(pc.dim(', '));
    console.log(
      `  ${marker} ${p.slug.padEnd(20)} ${pc.dim(p.id)}${tags ? `  ${tags}` : ''}`,
    );
  }
}

export async function projects(argv: readonly string[]): Promise<void> {
  const sub = argv[0];

  if (sub === 'list' || sub === undefined) {
    console.log(`\n  ${brand('ablo')} ${pc.dim('projects')}\n`);
    printList(await fetchProjects());
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
    const created = body as unknown as ProjectObject;
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
    const updated = body as unknown as ProjectObject;
    console.log(
      `  ${pc.green('✓')} Renamed ${pc.bold(updated.slug)} → ${pc.bold(updated.name ?? updated.slug)} ${pc.dim(`(${updated.id})`)}`,
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
