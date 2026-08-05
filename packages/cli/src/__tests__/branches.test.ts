import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { branches, ensureBranchCredential } from '../branches';

const ROOT = {
  object: 'branch',
  id: 'br_root',
  project_id: 'project_a',
  parent_branch_id: null,
  slug: 'production',
  name: 'Production',
  kind: 'long_lived',
  state: 'ready',
  origin: 'empty',
  root: true,
  expires_at: null,
  created_at: '2026-07-26T10:00:00.000Z',
  deleted_at: null,
};

describe('ablo branch', () => {
  const originalKey = process.env.ABLO_MANAGEMENT_KEY;
  const originalUrl = process.env.ABLO_API_URL;
  const originalFetch = global.fetch;
  let log: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.ABLO_MANAGEMENT_KEY = 'mk_branch_test';
    process.env.ABLO_API_URL = 'https://engine.example';
  });

  afterEach(() => {
    log.mockRestore();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ABLO_MANAGEMENT_KEY;
    else process.env.ABLO_MANAGEMENT_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.ABLO_API_URL;
    else process.env.ABLO_API_URL = originalUrl;
  });

  it('lists server-validated branches', async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [ROOT] }), { status: 200 }),
    );
    await branches(['list', '--json']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"slug": "production"'));
  });

  it('ensure returns an existing branch without creating another', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      name: 'preview-pr-42',
      kind: 'preview',
      root: false,
    };
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [ROOT, preview] }), {
        status: 200,
      }),
    );
    await branches(['ensure', 'preview-pr-42']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('br_preview'));
  });

  it('creates a missing ensured branch', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      name: 'preview-pr-42',
      kind: 'preview',
      root: false,
    };
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: 'list', data: [ROOT] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 201 }));

    await branches(['ensure', 'preview-pr-42', '--kind', 'preview']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const request = (global.fetch as jest.Mock).mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toMatchObject({
      slug: 'preview-pr-42',
      kind: 'preview',
    });
  });

  it('mints a short-lived credential for an immutable branch id', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      root: false,
    };
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: 'list', data: [ROOT, preview] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'branch_credential',
            branch_id: 'br_preview',
            api_key: 'sk_test_once',
            expires_at: '2026-07-26T12:00:00.000Z',
          }),
          { status: 201 },
        ),
      );

    await branches(['credential', 'preview-pr-42', '--ttl-hours', '2', '--json']);
    const request = (global.fetch as jest.Mock).mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ ttl_hours: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"api_key": "sk_test_once"'));
  });

  it('shows one branch readiness view by slug', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      name: 'preview-pr-42',
      kind: 'preview',
      root: false,
    };
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: 'list', data: [ROOT, preview] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'branch_status',
            branch: preview,
            ready: true,
            schema: {
              active: true,
              version: 12,
              hash: 'schema-hash',
              parent_compatibility: 'compatible',
              changes: 2,
              warnings: 0,
              blockers: 0,
            },
            storage: {
              kind: 'customer',
              transport: 'direct',
              status: 'active',
            },
            data_source: {
              connection: 'direct',
              status: 'active',
              host: null,
              database: null,
              cursor: null,
              event_lag: 0,
              retry_count: 0,
              last_success_at: null,
              last_error: null,
            },
            blockers: [],
          }),
          { status: 200 },
        ),
      );

    await branches(['status', 'preview-pr-42']);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://engine.example/api/v1/branches/br_preview/status',
      expect.any(Object),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('✓ ready'));
  });

  it('can idempotently bootstrap a branch and credential in one CI command', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      name: 'preview-pr-42',
      kind: 'preview',
      root: false,
    };
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: 'list', data: [ROOT, preview] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'branch_credential',
            branch_id: preview.id,
            api_key: 'sk_test_bootstrap',
            expires_at: '2026-07-26T18:00:00.000Z',
          }),
          { status: 201 },
        ),
      );

    await branches([
      'ensure',
      'preview-pr-42',
      '--credential',
      '--ttl-hours',
      '4',
      '--json',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"object": "branch_bootstrap"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"api_key": "sk_test_bootstrap"'));
  });

  it('exchanges an explicit root management key without storing the result', async () => {
    const preview = {
      ...ROOT,
      id: 'br_preview',
      parent_branch_id: ROOT.id,
      slug: 'preview-pr-42',
      name: 'preview-pr-42',
      kind: 'preview',
      root: false,
    };
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: 'list', data: [ROOT, preview] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'branch_credential',
            branch_id: preview.id,
            api_key: 'sk_test_runtime',
            expires_at: '2026-07-26T18:00:00.000Z',
          }),
          { status: 201 },
        ),
      );

    const result = await ensureBranchCredential({
      slug: preview.slug,
      apiKey: 'mk_root_management',
      baseUrl: 'https://engine.example',
      ttlHours: 6,
      kind: 'dev',
    });

    expect(result.credential.api_key).toBe('sk_test_runtime');
    for (const call of (global.fetch as jest.Mock).mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({
        authorization: 'Bearer mk_root_management',
      });
    }
  });
});
