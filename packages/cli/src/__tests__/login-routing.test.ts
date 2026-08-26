/**
 * @jest-environment node
 *
 * `ablo login`, driven for real against two local HTTP servers that speak the
 * device-flow protocol.
 *
 * The flow spans TWO origins now that Better Auth runs as its own service (see
 * packages/cli/src/login.ts):
 *
 *   - AUTH_URL      (auth.abloatai.com)  — RFC 8628 device endpoints
 *                                          (/api/auth/device/code, /token).
 *   - DASHBOARD_URL (www.abloatai.com)   — the human /cli approval page and the
 *                                          CLI bridge: /api/cli/projects for
 *                                          the picker, /api/cli/provision-key
 *                                          for the key handoff.
 *
 * Two concerns, one harness. First, routing: the CLI used to send EVERY call
 * to a single origin (`www`), where the device endpoints no longer resolve →
 * "Couldn't start login", so each request is asserted to land on the correct
 * origin — and the approval URL to be built against the dashboard host even
 * when the auth server advertises a (wrong) `verification_uri` on its own
 * origin. Second, the project picker: with a terminal and no `--project`, the
 * approved session lists the organization's projects and the choice scopes
 * the mint; without a terminal, nothing is listed and nothing is asked.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { select } from '@clack/prompts';
import type { ProjectListResponse } from '@abloatai/transaction/wire';
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

/** The `project_slug` a provision request carries, if any. */
function requestedProjectSlug(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('project_slug' in body)) return undefined;
  return typeof body.project_slug === 'string' ? body.project_slug : undefined;
}

/**
 * The organization's projects as the engine lists them — the default first,
 * then a named one whose display name adds something and one whose name only
 * re-spells its slug. Typed by the wire schema, so a field the server renames
 * fails here rather than in a fixture that quietly kept the old spelling.
 */
const PROJECTS: ProjectListResponse = {
  object: 'list',
  data: [
    {
      object: 'project',
      id: 'org_routing',
      slug: 'default',
      name: 'default',
      default: true,
      created_at: '1970-01-01T00:00:00.000Z',
    },
    {
      object: 'project',
      id: 'prj_orders',
      slug: 'orders',
      name: 'Orders Service',
      default: false,
      created_at: '2026-08-01T00:00:00.000Z',
    },
    {
      object: 'project',
      id: 'prj_billing-api',
      slug: 'billing-api',
      name: 'Billing API',
      default: false,
      created_at: '2026-08-02T00:00:00.000Z',
    },
  ],
  has_more: false,
  next_cursor: null,
};

/** Only the organization default: nothing to choose. */
const DEFAULT_ONLY: ProjectListResponse = {
  ...PROJECTS,
  data: PROJECTS.data.filter((p) => p.default),
};

/**
 * What a prompt offered, as the test observed it: labels and hints in order,
 * and the label the cursor started on. The option values themselves are
 * project objects the test never needs to hold.
 */
interface OfferedPrompt {
  readonly message: string;
  readonly options: readonly { readonly label: string | undefined; readonly hint: string | undefined }[];
  readonly initialLabel: string | undefined;
}

/**
 * A terminal, as `login()` detects one: both stdio streams report a TTY and
 * clack's `select` answers from the test instead of waiting on a keyboard. The
 * account prompt is always answered "log in"; every other prompt is answered
 * by the index `answer` returns. Prompts are recorded so a test can assert
 * what was offered and where the cursor started.
 */
function attachTerminal(answer: (prompt: OfferedPrompt) => number): {
  readonly prompts: OfferedPrompt[];
  detach(): void;
} {
  const prompts: OfferedPrompt[] = [];
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  // A TTY stdin has `setRawMode`, which clack's spinner calls once it sees one;
  // the test's stdin is a pipe, so give it the method as a no-op.
  Object.defineProperty(process.stdin, 'setRawMode', {
    value: () => process.stdin,
    configurable: true,
  });
  jest.doMock('@clack/prompts', () => {
    const actual = jest.requireActual<typeof import('@clack/prompts')>('@clack/prompts');
    const fake: typeof select = async (prompt) => {
      const offered: OfferedPrompt = {
        message: prompt.message,
        options: prompt.options.map((o) => ({ label: o.label, hint: o.hint })),
        initialLabel: prompt.options.find((o) => o.value === prompt.initialValue)?.label,
      };
      prompts.push(offered);
      const index =
        prompt.message === 'Ablo account'
          ? prompt.options.findIndex((o) => o.value === 'login')
          : answer(offered);
      const picked = prompt.options[index];
      if (!picked) throw new Error(`no option ${index} offered by "${prompt.message}"`);
      return picked.value;
    };
    return { ...actual, select: fake };
  });
  const restore = (
    stream: NodeJS.WriteStream | NodeJS.ReadStream,
    property: 'isTTY' | 'setRawMode',
    saved?: PropertyDescriptor,
  ) => {
    if (saved) Object.defineProperty(stream, property, saved);
    else Reflect.deleteProperty(stream, property);
  };
  return {
    prompts,
    detach() {
      jest.dontMock('@clack/prompts');
      restore(process.stdout, 'isTTY', stdoutTty);
      restore(process.stdin, 'isTTY', stdinTty);
      restore(process.stdin, 'setRawMode', rawMode);
    },
  };
}

/** Answers the project prompt with the option labelled `slug`. */
const choose =
  (slug: string) =>
  (prompt: OfferedPrompt): number =>
    prompt.options.findIndex((o) => o.label === slug);

/** Answers the project prompt with a plain Enter: the option the cursor is on. */
const pressEnter = (prompt: OfferedPrompt): number =>
  prompt.options.findIndex((o) => o.label === prompt.initialLabel);

/** The provision request's body as the dashboard saw it. */
function provisionBody(host: Fixture): unknown {
  return host.requests.find((r) => r.path === '/api/cli/provision-key')?.body;
}

beforeAll(() => {
  // This file drives REAL local HTTP fixtures — undo the setup file's
  // reject-all fetch mock and let the runtime fetch through.
  jest.restoreAllMocks();
});

let authHost: Fixture;
let dashHost: Fixture;
let configPath: string;
let envBackup: NodeJS.ProcessEnv;
/** What the dashboard answers the picker's listing with; a test overrides it. */
let projectList: () => { status: number; body: unknown };

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

  // DASHBOARD host: the /cli page (browser-only) + the CLI bridge live here.
  projectList = () => ({ status: 200, body: PROJECTS });
  dashHost = await startFixture((req, res, body) => {
    if (req.url === '/api/cli/projects') {
      const listed = projectList();
      json(res, listed.status, listed.body);
      return;
    }
    if (req.url === '/api/cli/provision-key') {
      const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      // The engine resolves the requested slug to a project and answers with
      // it; null is the organization default.
      const slug = requestedProjectSlug(body);
      json(res, 201, {
        management: { apiKey: MANAGEMENT_KEY, expiresAt },
        organizationId: 'org_routing',
        organizationSlug: 'acme',
        project: slug ? { id: `prj_${slug}`, slug } : null,
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

describe('ablo login — request routing across auth + dashboard hosts', () => {
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

  it('asks nothing and lists nothing without a terminal, targeting the active project', async () => {
    const { setActiveProject } = await import('../config');
    setActiveProject({ id: 'prj_orders', slug: 'orders' });

    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    // No picker without a keyboard: the listing is never requested, and the
    // stored preference scopes the mint — login doubles as a refresh in place.
    expect(dashHost.requests.map((r) => r.path)).toEqual(['/api/cli/provision-key']);
    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE, project_slug: 'orders' });
  });
});

describe('ablo login — the project picker', () => {
  let terminal: ReturnType<typeof attachTerminal> | undefined;

  afterEach(() => {
    terminal?.detach();
    terminal = undefined;
  });

  it('lists the approved organization’s projects and scopes the mint to the choice', async () => {
    terminal = attachTerminal(choose('orders'));
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    // The listing rides the same device session as the handoff, and happens
    // only after approval — the organization is not known before it.
    const listing = dashHost.requests.find((r) => r.path === '/api/cli/projects');
    expect(listing?.method).toBe('GET');
    expect(listing?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(dashHost.requests.map((r) => r.path)).toEqual([
      '/api/cli/projects',
      '/api/cli/provision-key',
    ]);

    // Every project is offered under its slug, the default included; a display
    // name is a hint only where it says something the slug does not.
    const prompt = terminal.prompts.find((p) => p.message === 'Project');
    expect(prompt?.options.map((o) => [o.label, o.hint])).toEqual([
      ['default', 'organization default'],
      ['orders', 'Orders Service'],
      ['billing-api', undefined],
    ]);

    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE, project_slug: 'orders' });
    const creds = JSON.parse(readFileSync(join(configPath, 'credentials.json'), 'utf8'));
    expect(creds.profiles.orders.management.apiKey).toBe(MANAGEMENT_KEY);
    const config = JSON.parse(readFileSync(join(configPath, 'config.json'), 'utf8'));
    expect(config.activeProject).toEqual({ id: 'prj_orders', slug: 'orders' });
  });

  it('starts the cursor on the active project so Enter refreshes in place', async () => {
    const { setActiveProject } = await import('../config');
    setActiveProject({ id: 'prj_billing-api', slug: 'billing-api' });

    terminal = attachTerminal(pressEnter);
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    const prompt = terminal.prompts.find((p) => p.message === 'Project');
    expect(prompt?.initialLabel).toBe('billing-api');
    expect(provisionBody(dashHost)).toEqual({
      device_code: DEVICE_CODE,
      project_slug: 'billing-api',
    });
  });

  it('choosing the organization default clears the active project', async () => {
    const { setActiveProject } = await import('../config');
    setActiveProject({ id: 'prj_orders', slug: 'orders' });

    terminal = attachTerminal(choose('default'));
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE });
    const config = JSON.parse(readFileSync(join(configPath, 'config.json'), 'utf8'));
    expect(config.activeProject).toBeUndefined();
    const creds = JSON.parse(readFileSync(join(configPath, 'credentials.json'), 'utf8'));
    expect(creds.profiles.default.management.apiKey).toBe(MANAGEMENT_KEY);
  });

  it('skips the picker when --project names the project', async () => {
    terminal = attachTerminal(() => {
      throw new Error('the project prompt must not be shown');
    });
    const { login } = await import('../login');
    await login(['--project', 'orders'], { openUrl: () => undefined });

    expect(dashHost.requests.map((r) => r.path)).toEqual(['/api/cli/provision-key']);
    expect(terminal.prompts.map((p) => p.message)).toEqual(['Ablo account']);
    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE, project_slug: 'orders' });
  });

  it('skips the picker when the organization holds only its default project', async () => {
    projectList = () => ({ status: 200, body: DEFAULT_ONLY });
    terminal = attachTerminal(() => {
      throw new Error('the project prompt must not be shown');
    });
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    expect(terminal.prompts.map((p) => p.message)).toEqual(['Ablo account']);
    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE });
  });

  it('finishes the approved login on the stored preference when the list cannot be fetched', async () => {
    const { setActiveProject } = await import('../config');
    setActiveProject({ id: 'prj_orders', slug: 'orders' });
    projectList = () => ({
      status: 503,
      body: { code: 'internal_error', message: 'The project list could not be reached.' },
    });
    terminal = attachTerminal(() => {
      throw new Error('the project prompt must not be shown');
    });
    const { login } = await import('../login');
    await login([], { openUrl: () => undefined });

    // A failed listing degrades to the terminal-less behaviour rather than
    // abandoning a login the browser already approved.
    expect(terminal.prompts.map((p) => p.message)).toEqual(['Ablo account']);
    expect(provisionBody(dashHost)).toEqual({ device_code: DEVICE_CODE, project_slug: 'orders' });
    const creds = JSON.parse(readFileSync(join(configPath, 'credentials.json'), 'utf8'));
    expect(creds.profiles.orders.management.apiKey).toBe(MANAGEMENT_KEY);
  });
});
