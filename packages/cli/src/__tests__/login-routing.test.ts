/**
 * @jest-environment node
 *
 * `ablo login` request-routing regression test.
 *
 * The device flow spans TWO origins now that Better Auth runs as its own
 * service (see packages/cli/src/login.ts):
 *
 *   - AUTH_URL      (auth.abloatai.com)  — RFC 8628 device endpoints
 *                                          (/api/auth/device/code, /token).
 *   - DASHBOARD_URL (www.abloatai.com)   — the human /cli approval page and the
 *                                          key-handoff /api/cli/provision-key.
 *
 * The bug this guards against: the CLI used to send EVERY call to a single
 * origin (`www`), where the device endpoints no longer resolve → "Couldn't
 * start login". The regression is purely about WHICH host each of the four
 * calls lands on, so we drive the REAL `login()` against two local HTTP servers
 * that speak the real device-flow protocol and assert each request hit the
 * correct origin — plus that the approval URL is built against the dashboard
 * host even when the auth server advertises a (wrong) `verification_uri` on its
 * own origin.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LoginDeps } from '../login';

const DEVICE_CODE = 'dev_code_abc';
const USER_CODE = 'WXYZ-1234';
const ACCESS_TOKEN = 'sess_token_xyz';
const MANAGEMENT_KEY = 'mk_routingfixture';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body: unknown;
}

interface Fixture {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type Responder = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => void;

async function startFixture(respond: Responder): Promise<Fixture> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      requests.push({
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        authorization: req.headers.authorization,
        body,
      });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

beforeAll(() => {
  // This file drives REAL local HTTP fixtures — undo the setup file's
  // reject-all fetch mock and let the runtime fetch through.
  jest.restoreAllMocks();
});

describe('ablo login — request routing across auth + dashboard hosts', () => {
  let authHost: Fixture;
  let dashHost: Fixture;
  let configPath: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // AUTH host: ONLY the Better Auth device endpoints live here.
    authHost = await startFixture((req, res) => {
      if (req.url === '/api/auth/device/code') {
        json(res, 200, {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          // Deliberately advertise the approval URI on the AUTH origin — the
          // wrong place (/cli is a dashboard page). Better Auth does exactly
          // this because its `verificationUri: '/cli'` resolves against its own
          // baseURL. The CLI must IGNORE this and target DASHBOARD_URL instead.
          verification_uri: `${authHost.origin}/cli`,
          verification_uri_complete: `${authHost.origin}/cli?user_code=${USER_CODE}`,
          interval: 0, // poll immediately — keep the test fast
          expires_in: 900,
        });
        return;
      }
      if (req.url === '/api/auth/device/token') {
        // Human already "approved" — hand back the session token on first poll.
        json(res, 200, { access_token: ACCESS_TOKEN });
        return;
      }
      json(res, 404, { error: 'not_found', host: 'auth' });
    });

    // DASHBOARD host: the /cli page (browser-only) + the key handoff live here.
    dashHost = await startFixture((req, res) => {
      if (req.url === '/api/cli/provision-key') {
        const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
        json(res, 201, {
          management: { apiKey: MANAGEMENT_KEY, expiresAt },
          organizationId: 'org_routing',
          organizationSlug: 'acme',
          project: null,
        });
        return;
      }
      json(res, 404, { error: 'not_found', host: 'dashboard' });
    });

    configPath = mkdtempSync(join(tmpdir(), 'ablo-login-routing-'));
    envBackup = { ...process.env };
    process.env.ABLO_AUTH_URL = authHost.origin;
    process.env.ABLO_DASHBOARD_URL = dashHost.origin;
    process.env.ABLO_CONFIG_DIR = configPath;
    // login.ts freezes AUTH_URL/DASHBOARD_URL at module load, so re-import it
    // fresh now that the env points at our fixtures.
    jest.resetModules();
  });

  afterEach(async () => {
    process.env = envBackup;
    await authHost.close();
    await dashHost.close();
    rmSync(configPath, { recursive: true, force: true });
  });

  it('sends device endpoints to the auth host and the key handoff to the dashboard host', async () => {
    const openedUrls: string[] = [];
    const deps: LoginDeps = { openUrl: (u) => openedUrls.push(u) };

    const { login } = await import('../login');
    await login([], deps);

    const authPaths = authHost.requests.map((r) => r.path);
    const dashPaths = dashHost.requests.map((r) => r.path);

    // Device code + token poll → AUTH host, and nowhere else.
    expect(authPaths).toEqual(
      expect.arrayContaining(['/api/auth/device/code', '/api/auth/device/token']),
    );
    expect(authPaths).not.toContain('/api/cli/provision-key');

    // Key handoff → DASHBOARD host, never the auth host. The device endpoints
    // must not leak onto the dashboard either.
    expect(dashPaths).toEqual(['/api/cli/provision-key']);
    expect(dashPaths.some((p) => p.startsWith('/api/auth/'))).toBe(false);
  });

  it('carries the device session token as a Bearer to provision-key', async () => {
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    const prov = dashHost.requests.find((r) => r.path === '/api/cli/provision-key');
    expect(prov).toBeDefined();
    expect(prov?.method).toBe('POST');
    expect(prov?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(prov?.body).toMatchObject({ device_code: DEVICE_CODE });
  });

  it('opens the approval page on the DASHBOARD host, ignoring the auth server verification_uri', async () => {
    const openedUrls: string[] = [];
    const { login } = await import('../login');
    await login([], { openUrl: (u) => openedUrls.push(u) });

    expect(openedUrls).toEqual([`${dashHost.origin}/cli?user_code=${USER_CODE}`]);
    // It must NOT have opened the auth host's (wrong) advertised URI.
    expect(openedUrls.some((u) => u.startsWith(authHost.origin))).toBe(false);
  });

  it('persists the provisioned management credential to the config dir', async () => {
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    const creds = JSON.parse(readFileSync(join(configPath, 'credentials.json'), 'utf8'));
    const stored = JSON.stringify(creds);
    expect(stored).toContain(MANAGEMENT_KEY);
    expect(creds.profiles.default.management.apiKey).toBe(MANAGEMENT_KEY);
    // The org the server scoped the credential to travels into the store, slug
    // and id both — the slug is what `ablo status` prints in prose.
    expect(creds.profiles.default.management.organizationId).toBe('org_routing');
    expect(creds.profiles.default.management.organizationSlug).toBe('acme');
  });

  it('carries --org onto the approval URL as a preselect, and only then', async () => {
    const openedUrls: string[] = [];
    const { login } = await import('../login');
    await login(['--org', 'acme'], { openUrl: (u) => openedUrls.push(u) });

    expect(openedUrls).toEqual([
      `${dashHost.origin}/cli?user_code=${USER_CODE}&org=acme`,
    ]);
    // The flag preselects on the page; the provision body must NOT name an org
    // — the approved session's active org is the single authority downstream.
    const prov = dashHost.requests.find((r) => r.path === '/api/cli/provision-key');
    expect(prov?.body).toEqual({ device_code: DEVICE_CODE });
  });
});
