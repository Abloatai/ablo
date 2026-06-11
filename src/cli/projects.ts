/**
 * `ablo projects` — manage the org's control-plane projects.
 *
 *   ablo projects list                 List projects (marks active + default)
 *   ablo projects create <slug>        Create a project (--name "Display Name")
 *   ablo projects use <slug|id>        Set the ACTIVE project (stored in
 *                                      config.json like `mode`)
 *   ablo projects use default          Back to the org-default project
 *
 * The active project is a local, non-secret targeting preference: status
 * shows it, and key mints made through the CLI/dashboard pick it up. A key's
 * project SCOPE is decided server-side at mint — switching `use` never
 * changes what an existing key can reach.
 */

import pc from 'picocolors';
import { resolveApiKey, getActiveProject, setActiveProject } from './config';
import { DEFAULT_URL } from './push';
import { brand } from './theme';

interface ProjectObject {
  id: string;
  slug: string;
  name: string | null;
  default: boolean;
  created_at: string;
}

function apiUrl(): string {
  return (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${apiUrl()}${path}`, {
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

async function listProjects(apiKey: string): Promise<ProjectObject[] | null> {
  try {
    const { status, body } = await request('/api/v1/projects', apiKey);
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
 * Ensure a project with this slug exists and make it the ACTIVE one —
 * idempotent (a `project_slug_taken` clash resolves to the existing row).
 * Returns null on any failure (no key, unreachable, denied): callers like
 * `ablo init` degrade to the org-default project rather than failing.
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
    console.log(
      pc.dim(
        '  Note: a key’s project scope is fixed at mint — switch keys (or mint one for this project) to act in it.',
      ),
    );
    return;
  }

  console.error(
    pc.red(`  unknown subcommand: ${sub}`) +
      pc.dim(` (expected ${pc.bold('list')}, ${pc.bold('create')}, or ${pc.bold('use')})`),
  );
  process.exit(1);
}
