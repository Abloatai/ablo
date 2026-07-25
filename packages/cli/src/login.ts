/**
 * Manages the stored command-line credential through two commands.
 *
 *   ablo login                  Browser device flow (RFC 8628): you approve at
 *                               /cli, and the command provisions a test and a
 *                               live key pair, storing both under the active
 *                               project.
 *   ablo login --project <slug> The same, but scopes and mints the pair to a
 *                               named project, which then becomes active.
 *   ablo logout                 Clears the stored keys.
 *
 * With no `--project`, login targets the currently active project — so it
 * doubles as a refresh in place — and otherwise falls back to the
 * organization's default project. In a headless or CI environment you don't log
 * in; you set `ABLO_API_KEY`, which always takes precedence.
 *
 * The device flow is two plain HTTP calls, one for the code and one that polls
 * for the token, which keeps the published command lean. Prompts are drawn with
 * `@clack/prompts`, and the browser is opened through the operating system.
 */

import { spawn } from 'child_process';
import pc from 'picocolors';
import { intro, outro, note, spinner, log, select, isCancel, cancel } from '@clack/prompts';
import { translateHttpError } from '@abloatai/transaction/errors';
import { provisionKeyResponseSchema, type ProvisionedKey } from '@abloatai/transaction/wire';
import { credentialCapability } from './credentialCapability';
import {
  setProfileKeys,
  getActiveProject,
  clearCredential,
  configDir,
  DEFAULT_PROFILE,
  type KeyEntry,
} from './config';
import { brand } from './theme';

const CLIENT_ID = 'ablo-cli';

const stripSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * The device flow talks to two separate hosts, each overridable by an
 * environment variable.
 *
 * - AUTH_URL — the identity server (`auth.abloatai.com`), which owns the RFC
 *   8628 device endpoints (`/api/auth/device/*`) and the session store behind
 *   them. Override it with `ABLO_AUTH_URL` (for example, `http://localhost:8081`
 *   in local development).
 *
 * - DASHBOARD_URL — the product dashboard (`www.abloatai.com`), which serves the
 *   browser approval page (`/cli`), the sign-up page, and the key-handoff route
 *   (`/api/cli/provision-key`). None of these live on the auth server. Point it
 *   at the canonical `www` host: the bare apex redirects to `www`, and a browser
 *   fetch drops the `Authorization` header on that cross-origin hop, so the
 *   authenticated provision call would arrive without its token and fail with a
 *   401 — the browser reads "Approved" while the command reports "Could not
 *   provision a key". Override it with `ABLO_DASHBOARD_URL`.
 */
const AUTH_URL = stripSlash(process.env.ABLO_AUTH_URL ?? 'https://auth.abloatai.com');
const DASHBOARD_URL = stripSlash(process.env.ABLO_DASHBOARD_URL ?? 'https://www.abloatai.com');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Best-effort OS browser open. Always print the URL as a fallback. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

// What the handoff answers with is defined once, in the wire module the route
// building it reads too — see `provisionKeyResponseSchema`.
type ProvisionKey = ProvisionedKey;

/** Pull `--project <slug>` out of the argv (the only login flag). */
function parseProjectFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--project');
  if (i >= 0) {
    const slug = argv[i + 1];
    if (slug && !slug.startsWith('-')) return slug;
  }
  const eq = argv.find((a) => a.startsWith('--project='));
  return eq ? eq.slice('--project='.length) || undefined : undefined;
}

/** Injectable seam (tests capture the approval URL; default opens the OS browser). */
export interface LoginDeps {
  readonly openUrl?: (url: string) => void;
}

async function deviceLogin(argv: readonly string[], deps: LoginDeps = {}): Promise<void> {
  const openUrl = deps.openUrl ?? openBrowser;
  intro(`${brand('ablo')} login`);

  // Which project to scope the minted pair to: an explicit `--project`, else
  // the active project (login doubles as a refresh in place), else the
  // org-default. The server resolves + verifies the slug against the org.
  // `--project default` means the org-default (no slug to resolve), mirroring
  // `ablo projects use default`.
  const requested = parseProjectFlag(argv) ?? getActiveProject()?.slug;
  const targetProject = requested === DEFAULT_PROFILE ? undefined : requested;

  // Account choice — both paths finish in the browser; the command only opens
  // the right page (sign-in versus sign-up) and then the same /cli approval.
  // Without a terminal (agents and CI wrappers), skip the prompt entirely: a
  // clack select can't receive input without a terminal and would hang the
  // caller. Default to the sign-in URL — the /cli approval page offers sign-up
  // itself, and the device flow below already suits an unattended caller: it
  // prints the approval URL and code for a human to approve, then polls until
  // they do.
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let account: 'login' | 'signup' = 'login';
  if (interactive) {
    const choice = await select({
      message: 'Ablo account',
      options: [
        { value: 'login' as const, label: 'Log in to an existing account' },
        { value: 'signup' as const, label: 'Create a new account' },
      ],
    });
    if (isCancel(choice)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    account = choice;
  }

  const codeRes = await fetch(`${AUTH_URL}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'openid profile email' }),
  }).catch(() => null);

  if (!codeRes?.ok) {
    log.error(`Couldn't start login against ${AUTH_URL}. Is the dashboard reachable?`);
    process.exit(1);
  }
  const code = (await codeRes.json()) as DeviceCodeResponse;
  // The approval page and sign-up live on the dashboard host, not the auth
  // server, so the URL is built here rather than trusting the server's
  // `verification_uri_complete`: that value resolves the relative `/cli` path
  // against the auth server's base URL and would send the browser to
  // `auth.abloatai.com/cli`, which the auth server does not serve. Sign-up opens
  // the sign-up page, which returns to /cli after creating an organization;
  // log-in opens /cli directly, which falls back to sign-in when there's no
  // session.
  const approvePath = `/cli?user_code=${code.user_code}`;
  const url =
    account === 'signup'
      ? `${DASHBOARD_URL}/signup?next=${encodeURIComponent(approvePath)}`
      : `${DASHBOARD_URL}${approvePath}`;

  note(`${pc.bold(code.user_code)}\n\n${pc.dim(url)}`, 'Approve in your browser');
  openUrl(url);

  const s = spinner();
  s.start('Waiting for approval…');

  let pollMs = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
  let accessToken: string | undefined;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const tokRes = await fetch(`${AUTH_URL}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: CLIENT_ID,
      }),
    }).catch(() => null);

    if (!tokRes) continue; // transient network blip — keep polling
    const body = (await tokRes.json().catch(() => ({}))) as DeviceTokenResponse;

    if (tokRes.ok && body.access_token) {
      accessToken = body.access_token;
      break;
    }
    switch (body.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        pollMs += 5000;
        break;
      case 'access_denied':
        s.stop('Denied.');
        process.exit(1);
        break;
      case 'expired_token':
        s.stop('Code expired — run `ablo login` again.');
        process.exit(1);
        break;
      default:
        s.stop(`Login failed: ${body.error_description ?? body.error ?? 'unknown error'}`);
        process.exit(1);
    }
  }

  if (!accessToken) {
    s.stop('Timed out waiting for approval.');
    process.exit(1);
  }

  s.message(
    targetProject ? `Provisioning keys for ${targetProject}…` : 'Provisioning a sandbox key…',
  );
  const provRes = await fetch(`${DASHBOARD_URL}/api/cli/provision-key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    // Scope the minted keys to the chosen project (`--project`/active), with
    // the device_code as a legacy fallback for the /cli picker. Both harmless
    // if absent → org-default keys.
    body: JSON.stringify({
      device_code: code.device_code,
      ...(targetProject ? { project_slug: targetProject } : {}),
    }),
  }).catch(() => null);

  if (!provRes) {
    s.stop('Could not provision a key.');
    log.error(
      `Could not reach ${DASHBOARD_URL} to finish the handoff. Check your connection and run \`ablo login\` again.`,
    );
    process.exit(1);
  }
  if (!provRes.ok) {
    s.stop('Could not provision a key.');
    // The dashboard forwards the engine's error envelope untouched, so read it
    // through the same translator every other transport uses rather than
    // reaching for a field name — the envelope is flat (`message`/`code`), and
    // a hand-picked key here would silently go quiet the moment it moved.
    const err = translateHttpError(
      provRes.status,
      await provRes.json().catch(() => null),
      provRes.headers.get('x-request-id') ?? undefined,
    );
    log.error(err.message);
    if (err.code === 'entity_not_found' && targetProject) {
      // The server names the organization it searched and what that
      // organization holds, so the remaining question is only which of the two
      // is wrong: the account that approved in the browser, or the slug.
      log.error(
        `If that isn't the account you meant, run ${pc.bold('npx ablo logout')} and sign in again. Otherwise create it with ${pc.bold(`npx ablo projects create ${targetProject}`)}.`,
      );
    } else {
      log.error(
        `The browser approval succeeded but the key handoff failed. Try again, or grab a ${pc.bold('sk_test_')} key from the dashboard and set ${pc.bold('ABLO_API_KEY')}.`,
      );
    }
    process.exit(1);
  }
  // The one place the handoff's body is checked. A response that does not match
  // would otherwise be stored as credentials and fail later, on some unrelated
  // command, with nothing pointing back at the login that wrote it.
  const parsedProv = provisionKeyResponseSchema.safeParse(
    await provRes.json().catch(() => null),
  );
  if (!parsedProv.success) {
    s.stop('Could not provision a key.');
    log.error('The key handoff returned something this version does not recognize.');
    log.error(`Try again, or upgrade with ${pc.bold('npm i -g @abloatai/ablo')}.`);
    process.exit(1);
  }
  const prov = parsedProv.data;
  const entry = (k: ProvisionKey): KeyEntry => ({
    apiKey: k.apiKey,
    ...(prov.organizationId ? { organizationId: prov.organizationId } : {}),
    ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
  });
  // Store the pair under the project profile the server scoped them to and make
  // that project active. Default to sandbox (the dev loop); the production key
  // rides along so `ablo mode production` works without another login. The
  // server's `project` field (null means the org-default) is authoritative — it
  // resolved the slug to an id.
  const profileName = prov.project?.slug ?? DEFAULT_PROFILE;
  const path = setProfileKeys(
    profileName,
    {
      sandbox: entry(prov.test),
      ...(prov.live ? { production: entry(prov.live) } : {}),
    },
    { mode: 'sandbox', activeProject: prov.project ?? undefined },
  );
  s.stop(`Saved keys to ${path}`);
  const where = prov.project ? ` ${pc.dim(`(project ${prov.project.slug})`)}` : '';
  // The production key rides along silently, and it observes rather than
  // deploys. Naming that here means the reader learns it while holding the key,
  // instead of from a 403 the first time they push to production.
  const live = prov.live ? credentialCapability(prov.live.apiKey).note : null;
  outro(
    `${pc.green('✓')} Logged in ${pc.dim('(sandbox)')}${where}. Run ${pc.bold('npx ablo push')} to push your schema.` +
      (live ? `\n  ${pc.dim(`Your production key: ${live}`)}` : ''),
  );
}

export async function login(argv: readonly string[] = [], deps: LoginDeps = {}): Promise<void> {
  await deviceLogin(argv, deps);
}

export function logout(): void {
  const removed = clearCredential();
  if (removed) {
    console.log(`  ${pc.green('✓')} Logged out ${pc.dim(`(credentials removed from ${configDir()})`)}`);
  } else {
    console.log(`  ${pc.dim('○')} Not logged in — nothing to remove.`);
  }
  if (process.env.ABLO_API_KEY) {
    console.log(
      pc.dim(`  Note: ${pc.bold('ABLO_API_KEY')} is still set in this shell and takes precedence.`),
    );
  }
}
