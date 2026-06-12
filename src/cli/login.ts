/**
 * `ablo login` / `ablo logout` — manage the stored CLI credential.
 *
 *   ablo login    Browser device flow (RFC 8628): approve at /cli, the CLI
 *                 provisions a test + live key pair and stores both.
 *   ablo logout   Clear the stored keys.
 *
 * Headless/CI doesn't log in — it sets `ABLO_API_KEY`, which always wins.
 *
 * The device flow is two plain HTTP calls (code + token polling) so the
 * published CLI stays lean — no Better Auth client dependency. Visuals use
 * `@clack/prompts`; the browser is opened via the OS (no `open` dependency).
 */

import { spawn } from 'child_process';
import pc from 'picocolors';
import { intro, outro, note, spinner, log, select, isCancel, cancel } from '@clack/prompts';
import { writeConfig, clearCredential, configDir, type KeyEntry } from './config';
import { brand } from './theme';

const CLIENT_ID = 'ablo-cli';
/**
 * Dashboard origin (Better Auth + /cli + provision-key live here). MUST be the
 * canonical `www` host: the apex 307-redirects to www, and `fetch` strips the
 * `Authorization` header on that cross-origin hop — so the authenticated
 * provision call silently arrives tokenless and 401s while every other step
 * (no auth header) works. Symptom: browser says "Approved", CLI says
 * "Could not provision a key".
 */
const AUTH_URL = (process.env.ABLO_AUTH_URL ?? 'https://www.abloatai.com').replace(/\/+$/, '');

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

interface ProvisionKey {
  apiKey: string;
  expiresAt?: string;
}
interface ProvisionResponse {
  test: ProvisionKey;
  live?: ProvisionKey;
  organizationId?: string;
  error?: string;
}

async function deviceLogin(): Promise<void> {
  intro(`${brand('ablo')} login`);

  // Account choice — both paths complete in the browser; the CLI just opens
  // the right page (sign-in vs sign-up) and then the same /cli approval.
  // NON-TTY (agents — Claude Code, CI wrappers): skip the prompt entirely; a
  // clack select can't receive input without a TTY and would HANG the agent.
  // Default to the sign-in URL — the /cli approval page offers sign-up
  // itself, and the device flow below is already agent-shaped: it PRINTS the
  // approval URL + code (the agent relays it to the human) and polls until
  // the human approves in their own browser.
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

  if (!codeRes || !codeRes.ok) {
    log.error(`Couldn't start login against ${AUTH_URL}. Is the dashboard reachable?`);
    process.exit(1);
  }
  const code = (await codeRes.json()) as DeviceCodeResponse;
  // Sign-up opens the signup page (which returns to /cli after creating an org);
  // log-in opens /cli directly (it bounces to sign-in if no session).
  const approvePath = `/cli?user_code=${code.user_code}`;
  const url =
    account === 'signup'
      ? `${AUTH_URL}/signup?next=${encodeURIComponent(approvePath)}`
      : code.verification_uri_complete ?? code.verification_uri;

  note(`${pc.bold(code.user_code)}\n\n${pc.dim(url)}`, 'Approve in your browser');
  openBrowser(url);

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

  s.message('Provisioning a sandbox key…');
  const provRes = await fetch(`${AUTH_URL}/api/cli/provision-key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  }).catch(() => null);

  if (!provRes || !provRes.ok) {
    s.stop('Could not provision a key.');
    const reason = provRes ? ((await provRes.json().catch(() => ({}))) as ProvisionResponse).error : undefined;
    if (reason) log.error(reason);
    else if (provRes) log.error(`Key provisioning returned ${provRes.status} from ${AUTH_URL}/api/cli/provision-key.`);
    log.error(
      `The browser approval succeeded but the key handoff failed. Try again, or grab a ${pc.bold('sk_test_')} key from the dashboard and set ${pc.bold('ABLO_API_KEY')}.`,
    );
    process.exit(1);
  }
  const prov = (await provRes.json()) as ProvisionResponse;
  const entry = (k: ProvisionKey): KeyEntry => ({
    apiKey: k.apiKey,
    ...(prov.organizationId ? { organizationId: prov.organizationId } : {}),
    ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
  });
  // Default to sandbox (the dev loop); store the production key too so
  // `ablo mode production` works without re-auth (Stripe mints both at
  // login). The provision response names the key-prefix buckets: sk_test_
  // keys are sandbox, sk_live_ keys are production.
  const path = writeConfig({
    mode: 'sandbox',
    sandbox: entry(prov.test),
    ...(prov.live ? { production: entry(prov.live) } : {}),
  });
  s.stop(`Saved keys to ${path}`);
  outro(`${pc.green('✓')} Logged in ${pc.dim('(sandbox)')}. Run ${pc.bold('npx ablo push')} to push your schema.`);
}

export async function login(): Promise<void> {
  await deviceLogin();
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
