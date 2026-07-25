/**
 * `resolveTarget` — the CLI's single, server-confirmed answer to "where does
 * this command act?"
 *
 * The recurring failure is a push that lands somewhere other than where the
 * banner says. It happens because two different sources describe the target and
 * nothing reconciles them: what the CLI *shows* (`ablo status`, the push banner)
 * has historically come from a LOCAL preference — `activeProject` in
 * `config.json`, set by `ablo projects use` — while what actually *routes* the
 * push is the API key's server-side scope, which the key prefix cannot reveal (a
 * prefix only tells sandbox from production). So `ablo projects use acme`
 * followed by a push with an `.env.local` key minted for `globex` prints
 * "project: acme" and deploys to globex.
 *
 * This resolver closes that gap. It asks the server who the key really is
 * (`GET /api/auth/identity`, which now returns the full `{ org, project,
 * environment, sandbox }` plane), names the project against the project list,
 * and compares that ground truth to the local preference. Commands render the
 * SERVER-CONFIRMED plane and surface any drift, so what you see is where you
 * land. When the server can't answer — offline, an older server, or a human
 * session with no key scope — `confirmed` is null and callers fall back to the
 * local view, clearly marked as unconfirmed.
 */

import { resolveIdentity } from '@abloatai/transaction/auth';
import { resolveBootstrapBaseUrl } from '@abloatai/transaction/auth/apiKey';
import {
  getActiveProject,
  getMode,
  modeFromKey,
  type Mode,
  type ActiveProject,
  type EffectiveKeySource,
} from './config';
import { listProjects } from './projects';

/** The project a credential resolves to, named against the project list. */
export interface TargetProject {
  id: string;
  /** The project's slug, or its id when the list couldn't name it. */
  slug: string;
  name: string | null;
  /** The organization-default project (its id equals the org id). */
  isDefault: boolean;
  /**
   * Why this project has no name — set only when the project list did not
   * answer, so `slug` is holding the id. A caller that shows the id, or asks
   * an operator to type it, can say why rather than presenting a fallback as
   * though it were the project's name.
   */
  unnamedReason?: string;
}

/** The plane the server confirms this credential acts on. */
export interface ConfirmedTarget {
  organizationId: string;
  /** From the server; falls back to the key prefix when the server omits it. */
  environment: Mode | null;
  /** Named project, or null when the identity carried no project (human
   *  session, or a server too old to report one). */
  project: TargetProject | null;
  /** The raw project id from the identity, even when it couldn't be named. */
  projectId: string | null;
  /** The sandbox a sandbox-bound key belongs to, when present. */
  sandboxId: string | null;
}

/**
 * A divergence between local intent and server-confirmed truth. Not an error on
 * its own — a key legitimately overrides the CLI's stored preferences — but the
 * exact thing worth naming before a mutating command runs.
 */
export type TargetMismatch =
  | {
      /** The locally-selected project isn't the one this key targets. */
      kind: 'project';
      /** The project the local preference names (`default` for the org-default). */
      intended: string;
      /** The project the key actually targets. */
      actual: string;
    }
  | {
      /** The key's environment isn't the CLI's active mode. */
      kind: 'environment';
      /** The environment the key deploys to (the real one). */
      keyEnv: Mode;
      /** The CLI's active `ablo mode`. */
      cliMode: Mode;
    };

export interface ResolvedTarget {
  /** The host every request goes to (honoring `--url` / `ABLO_API_URL`). */
  url: string;
  /** Masked key — `sk_test_CEIM…`, never the full secret. */
  keyPrefix: string;
  /** Where the resolved key came from (env, a project env file, or login). */
  keySource: EffectiveKeySource;
  /** The environment the key's prefix implies — known offline, before any call. */
  keyEnv: Mode | null;
  /** The server-confirmed plane, or null when the server didn't answer. */
  confirmed: ConfirmedTarget | null;
  /** The local `ablo projects use` preference (undefined = org-default). */
  localProject: ActiveProject | undefined;
  /** Divergences between local intent and the confirmed plane. Empty = aligned. */
  mismatches: TargetMismatch[];
}

export interface ResolveTargetOptions {
  url: string;
  apiKey: string;
  keySource: EffectiveKeySource;
  /** Per-call network budget; defaults to a short, status-friendly 4s. */
  timeoutMs?: number;
}

/** Slug used to describe "the organization-default project" everywhere. */
const DEFAULT_PROJECT_SLUG = 'default';

/**
 * Resolves the true target of a CLI command from its credential. Never throws:
 * a server that can't answer yields `confirmed: null` so callers degrade to the
 * local view rather than failing a diagnostic.
 */
export async function resolveTarget(opts: ResolveTargetOptions): Promise<ResolvedTarget> {
  const keyEnv = modeFromKey(opts.apiKey) ?? null;
  const localProject = getActiveProject();

  const confirmed = await confirmFromServer(opts);

  return {
    url: opts.url,
    keyPrefix: `${opts.apiKey.slice(0, 12)}…`,
    keySource: opts.keySource,
    keyEnv,
    confirmed,
    localProject,
    mismatches: reconcile({ confirmed, keyEnv, localProject, cliMode: getMode() }),
  };
}

/** Ask the server who this key is, and name its project. Any failure → null. */
async function confirmFromServer(opts: ResolveTargetOptions): Promise<ConfirmedTarget | null> {
  const keyEnv = modeFromKey(opts.apiKey) ?? null;
  try {
    const identity = await resolveIdentity({
      baseUrl: resolveBootstrapBaseUrl({ url: opts.url }),
      authToken: opts.apiKey,
      timeoutMs: opts.timeoutMs ?? 4000,
    });
    const projectId = identity.projectId ?? null;
    const environment: Mode | null = identity.environment ?? keyEnv;
    const project = projectId
      ? await nameProject(projectId, identity.accountScope, opts)
      : null;
    return {
      organizationId: identity.accountScope,
      environment,
      project,
      projectId,
      sandboxId: identity.sandboxId ?? null,
    };
  } catch {
    // Offline, an older server without the route, or a credential that can't
    // resolve an identity. The caller falls back to the local view.
    return null;
  }
}

/**
 * Turns a project id into a human name via the project list. When the list is
 * unavailable or doesn't contain the id (a key scoped to a project the list
 * won't return), the id still stands in as the slug so the target is never
 * blank — and `isDefault` is inferred from the org-default convention (the
 * default project's id equals the org id).
 */
async function nameProject(
  projectId: string,
  organizationId: string,
  opts: ResolveTargetOptions,
): Promise<TargetProject> {
  // The HOST, not the `/api`-suffixed bootstrap base the identity call above
  // needs: `listProjects` builds `${base}/api/v1/projects` itself. Passing the
  // bootstrap base asked for `…/api/api/v1/projects`, and the 404 degraded
  // every confirmed project to the fallback below — which is why `ablo status`
  // printed a project id where its slug belongs.
  const listed = await listProjects(opts.apiKey, opts.url);
  const match = listed.ok ? listed.projects.find((p) => p.id === projectId) : undefined;
  if (match) {
    return { id: match.id, slug: match.slug, name: match.name, isDefault: match.default };
  }
  return {
    id: projectId,
    slug: projectId,
    name: null,
    isDefault: projectId === organizationId,
    unnamedReason: listed.ok ? 'it is not in this key’s project list' : listed.reason,
  };
}

/** The project slug the local preference intends: its slug, or `default`. */
function intendedProjectSlug(localProject: ActiveProject | undefined): string {
  return localProject?.slug ?? DEFAULT_PROJECT_SLUG;
}

/** The confirmed project's display slug: `default` for the org-default. */
function confirmedProjectSlug(project: TargetProject): string {
  return project.isDefault ? DEFAULT_PROJECT_SLUG : project.slug;
}

/**
 * Compares local intent against the confirmed plane and returns each real
 * divergence. Matching is by id where possible (the org-default project's id is
 * the org id), so a slug rename never reads as a false mismatch. Pure: the CLI
 * mode is passed in (not read from disk) so the reconciliation can be tested on
 * its inputs alone.
 */
export function reconcile(input: {
  confirmed: ConfirmedTarget | null;
  keyEnv: Mode | null;
  localProject: ActiveProject | undefined;
  /** The CLI's active `ablo mode` — the local environment preference. */
  cliMode: Mode;
}): TargetMismatch[] {
  const { confirmed, keyEnv, localProject, cliMode } = input;
  const mismatches: TargetMismatch[] = [];

  // Environment: the key's real environment vs the CLI's active mode. Prefer
  // the server's environment; fall back to the key prefix when it's all we have.
  const realEnv = confirmed?.environment ?? keyEnv;
  if (realEnv && realEnv !== cliMode) {
    mismatches.push({ kind: 'environment', keyEnv: realEnv, cliMode });
  }

  // Project: the local preference vs the key's real project. Only decidable
  // once the server confirms a project id.
  if (confirmed?.projectId) {
    const intendedId = localProject?.id ?? confirmed.organizationId;
    if (intendedId !== confirmed.projectId) {
      mismatches.push({
        kind: 'project',
        intended: intendedProjectSlug(localProject),
        actual: confirmed.project ? confirmedProjectSlug(confirmed.project) : confirmed.projectId,
      });
    }
  }

  return mismatches;
}

/**
 * ONE short, consequence-first note covering however many saved-selection
 * divergences exist. It answers the only question that matters — "is this
 * going where I meant?" — and offers the one real remedy (the matching key).
 * It never mentions saved settings, modes, reconciliation, or which input
 * "wins": that is the system explaining itself, and a click-and-play surface
 * states the target once (the command header) and asks about intent.
 */
export function describeMismatches(mismatches: readonly TargetMismatch[]): string | null {
  if (mismatches.length === 0) return null;
  const actual: string[] = [];
  const selected: string[] = [];
  for (const m of mismatches) {
    if (m.kind === 'environment') {
      actual.push(m.keyEnv);
      selected.push(m.cliMode);
    } else {
      actual.push(`project ${m.actual}`);
      selected.push(m.intended);
    }
  }
  return (
    `This key acts on ${actual.join(' · ')}, not ${selected.join(' · ')} as selected. ` +
    `Wrong target? Use a key for ${selected.join(' · ')}.`
  );
}
