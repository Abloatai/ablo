/**
 * `resolveTarget` — the CLI's single, server-confirmed answer to "where does
 * this command act?"
 *
 * The recurring failure is a push that lands somewhere other than where the
 * banner says. It happens because two different sources describe the target and
 * nothing reconciles them: what the CLI *shows* (`ablo status`, the push banner)
 * has historically come from a LOCAL preference — `activeProject` in
 * `config.json`, set by `ablo projects use` — while what actually *routes* the
 * push is the API key's server-side scope, which the key prefix cannot reveal.
 * So `ablo projects use acme`
 * followed by a push with an `.env.local` key minted for `globex` prints
 * "project: acme" and deploys to globex.
 *
 * This resolver closes that gap. It asks the server who the key really is
 * (`GET /api/auth/identity`, which returns the full `{ org, project, branch }`
 * target), names the project against the project list,
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
  resolveOrgManagementKey,
  modeFromKey,
  type Mode,
  type ActiveProject,
  type ResolvedKeySource,
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
  /** Compatibility label derived from branchRoot; legacy-prefix fallback only. */
  environment: string | null;
  /** Named project, or null when the identity carried no project (human
   *  session, or a server too old to report one). */
  project: TargetProject | null;
  /** The raw project id from the identity, even when it couldn't be named. */
  projectId: string | null;
  /** Immutable transaction branch confirmed by the server. */
  branchId?: string | null;
  /** True when branchId is the production root. */
  branchRoot?: boolean;
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
    };

export interface ResolvedTarget {
  /** The host every request goes to (honoring `--url` / `ABLO_API_URL`). */
  url: string;
  /** Masked key — `sk_CEIM…`, never the full secret. */
  keyPrefix: string;
  /** Where the resolved key came from (env, a project env file, or login). */
  keySource: ResolvedKeySource;
  /** Legacy `_live_`/`_test_` hint, or null for current branch-bound keys. */
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
  keySource: ResolvedKeySource;
  /** Per-call network budget; defaults to a short, status-friendly 4s. */
  timeoutMs?: number;
  /**
   * Diagnostics normally degrade to `confirmed: null` while offline. An
   * identity command cannot answer with a guess, so strict callers preserve
   * the identity resolver's typed failure instead.
   */
  strict?: boolean;
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
    mismatches: reconcile({ confirmed, localProject }),
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
    const project = projectId
      ? await nameProject(projectId, identity.accountScope, opts)
      : null;
    return {
      organizationId: identity.accountScope,
      environment:
        identity.branchRoot === undefined
          ? keyEnv
          : identity.branchRoot
            ? 'production'
            : 'sandbox',
      project,
      projectId,
      branchId: identity.branchId ?? null,
      branchRoot: identity.branchRoot,
    };
  } catch (error) {
    if (opts.strict) throw error;
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
  // Project listing is a management surface. A branch-bound runtime key can
  // resolve its own immutable project id, but is intentionally forbidden from
  // listing the organization's projects; using it here made every correctly
  // minted branch key render its project as "unnamed". Name the already-
  // confirmed id with the stored/org management credential when available.
  // Falling back to the runtime key preserves the explicit failure reason for
  // stateless CI, where no management credential is expected.
  const namingKey = resolveOrgManagementKey() ?? opts.apiKey;
  const listed = await listProjects(namingKey, opts.url);
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
 * the org id), so a slug rename never reads as a false mismatch.
 */
export function reconcile(input: {
  confirmed: ConfirmedTarget | null;
  localProject: ActiveProject | undefined;
}): TargetMismatch[] {
  const { confirmed, localProject } = input;
  const mismatches: TargetMismatch[] = [];

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
    actual.push(`project ${m.actual}`);
    selected.push(m.intended);
  }
  return (
    `This key acts on ${actual.join(' · ')}, not ${selected.join(' · ')} as selected. ` +
    `Wrong target? Use a key for ${selected.join(' · ')}.`
  );
}
