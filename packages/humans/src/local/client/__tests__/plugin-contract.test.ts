/**
 * The plugin contract's two configuration gates and its stage ordering
 * (ADR 0016). The contract lives in `@ablo/humans/plugin`; the test lives
 * here because the core package carries no test harness of its own.
 */

import {
  PIPELINE_STAGES,
  pluginsForStage,
  resolvePlugins,
  runStage,
  type AbloPlugin,
  type PluginContext,
} from '@ablo/humans/plugin';

// The contract requires a logger; nothing here reads what it emits.
const noop = (): void => undefined;

const context: PluginContext = {
  logger: { debug: noop, info: noop, warn: noop, error: noop },
};

const plugin = (
  id: string,
  overrides: Partial<AbloPlugin> = {},
): AbloPlugin => ({
  id,
  materialises: false,
  init: () => ({ name: id }),
  ...overrides,
});

describe('plugin contract', () => {
  it('builds the installed surface keyed by plugin id', () => {
    const surface = resolvePlugins(
      [plugin('offline'), plugin('humans')],
      { duplex: true },
      context,
    );

    expect(surface).toEqual({ offline: { name: 'offline' }, humans: { name: 'humans' } });
  });

  it('rejects the same plugin listed twice', () => {
    expect(() =>
      resolvePlugins([plugin('humans'), plugin('humans')], { duplex: true }, context),
    ).toThrow(/listed twice/);
  });

  it('hands every init a hasPlugin derived from the list being resolved', () => {
    const answers: Record<string, boolean | undefined> = {};
    const probe: AbloPlugin = {
      id: 'probe',
      materialises: false,
      init: (ctx) => {
        answers.self = ctx.hasPlugin?.('probe');
        answers.sibling = ctx.hasPlugin?.('offline');
        answers.absent = ctx.hasPlugin?.('humans');
        return {};
      },
    };

    resolvePlugins([probe, plugin('offline')], { duplex: true }, context);

    expect(answers).toEqual({ self: true, sibling: true, absent: false });
  });

  it('replaces a host-supplied hasPlugin with the list-derived answer', () => {
    let observed: boolean | undefined;
    const probe: AbloPlugin = {
      id: 'probe',
      materialises: false,
      init: (ctx) => {
        observed = ctx.hasPlugin?.('probe');
        return {};
      },
    };

    // A context claiming nothing is installed must not override the
    // assembly's own truth: the probe IS in the list being resolved.
    resolvePlugins([probe], { duplex: true }, { ...context, hasPlugin: () => false });

    expect(observed).toBe(true);
  });

  it('rejects a duplex-requiring plugin on a request-response transport', () => {
    expect(() =>
      resolvePlugins(
        [plugin('presence', { requires: { duplex: true } })],
        { duplex: false },
        context,
      ),
    ).toThrow(/needs a connection the server can send on/);
  });

  it('names the offending plugin so the caller knows which line to change', () => {
    expect(() =>
      resolvePlugins(
        [plugin('presence', { requires: { duplex: true } })],
        { duplex: false },
        context,
      ),
    ).toThrow(/presence/);
  });

  it('admits a duplex-requiring plugin when the transport can carry it', () => {
    const surface = resolvePlugins(
      [plugin('presence', { requires: { duplex: true } })],
      { duplex: true },
      context,
    );

    expect(surface).toEqual({ presence: { name: 'presence' } });
  });

  it('does not gate a plugin that states no transport requirement', () => {
    expect(() =>
      resolvePlugins([plugin('batching')], { duplex: false }, context),
    ).not.toThrow();
  });

  it('hands init the client options bag', () => {
    const seen: unknown[] = [];
    resolvePlugins(
      [plugin('probe', { init: (ctx) => { seen.push(ctx.options); return {}; } })],
      { duplex: true },
      { ...context, options: { marker: 1 } },
    );
    expect(seen[0]).toEqual({ marker: 1 });
  });

  it('groups plugins by declared stage handler in declaration order', () => {
    const persisted = (): void => undefined;
    const first = plugin('offline', { stages: { persist: persisted } });
    const second = plugin('audit', { stages: { persist: persisted } });
    const other = plugin('humans', { stages: { notify: () => undefined } });

    expect(pluginsForStage([first, other, second], 'persist')).toEqual([first, second]);
  });

  it('runStage invokes each declared handler with the stage payload, and only those', () => {
    const applied: string[] = [];
    const a = plugin('a', {
      stages: { apply: ({ changes }) => { applied.push(`a:${changes.length}`); } },
    });
    const b = plugin('b', {
      stages: { notify: () => { applied.push('b:notify'); } },
    });
    const c = plugin('c', {
      stages: { apply: () => { applied.push('c'); } },
    });

    runStage([a, b, c], 'apply', {
      changes: [{ action: 'add', modelName: 'tasks', modelId: 't1' }],
    });

    expect(applied).toEqual(['a:1', 'c']);
  });

  it('orders acknowledge after persist, which is a correctness constraint', () => {
    // Acknowledging the input range rather than the persisted high-water mark
    // advances the server cursor past deltas that never committed; the next
    // catch-up then reports "up to date" for a delta that was lost.
    expect(PIPELINE_STAGES.indexOf('acknowledge')).toBeGreaterThan(
      PIPELINE_STAGES.indexOf('persist'),
    );
    expect(PIPELINE_STAGES.indexOf('apply')).toBeGreaterThan(
      PIPELINE_STAGES.indexOf('persist'),
    );
  });
});

// ── The gates through the real factory ─────────────────────────────────
//
// `Ablo({ ... })` resolves its plugin list before anything is constructed,
// so both configuration mistakes surface as typed errors with the caller's
// own setup on the stack. These run the true entry point, not resolvePlugins
// directly: the wiring between the factory and the contract is what they pin.

import { Ablo } from '../../../Ablo.js';
import { humans } from '../../../humans.js';
import { defineSchema } from '@ablo/transaction/schema/schema';
import { model } from '@ablo/transaction/schema/model';
import { z } from 'zod';

const schema = defineSchema({});

describe('Ablo({ plugins }) configuration gates', () => {
  it('rejects an empty plugin list because this package is the human materializer', () => {
    expect(() =>
      Ablo({
        schema,
        authEndpoint: '/api/ablo-session',
        plugins: [],
      }),
    ).toThrow(/requires the humans\(\) materializer plugin/);
  });

  it('the client type includes contributions installed beside humans()', () => {
    const _typeOnly = (): void => {
      const client = Ablo({
        schema,
        authEndpoint: '/api/ablo-session',
        plugins: [humans()],
      });
      void client.ready;
      void client.presence;
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('merges plugin surfaces onto the client, typed and at runtime', async () => {
    // A minimal contributing plugin: no transport requirement, no local
    // state — its surface should simply appear on the client.
    const metrics = () =>
      ({
        id: 'metrics',
        materialises: false,
        init: () => ({ metricsProbe: 42 }),
      }) as const satisfies AbloPlugin<{ metricsProbe: number }>;

    const client = Ablo({
      schema,
      authEndpoint: '/api/ablo-session',
      plugins: [humans(), metrics()],
    });

    // Typed through MergedSurface, delivered through the layering proxy.
    const probe: number = client.metricsProbe;
    expect(probe).toBe(42);
    await client.dispose();
  });

  it('never lets a contribution shadow a member the client itself defines', async () => {
    const hijack = () =>
      ({
        id: 'hijack',
        materialises: false,
        init: () => ({ dispose: 'not-a-function' }),
      }) as const satisfies AbloPlugin<{ dispose: string }>;

    const client = Ablo({
      schema,
      authEndpoint: '/api/ablo-session',
      plugins: [humans(), hijack()],
    });

    // The base always wins: dispose is still the client's own method.
    expect(typeof client.dispose).toBe('function');
    await client.dispose();
  });

  it('rejects a non-empty plugins list without humans() — no other plugin exists yet', () => {
    expect(() =>
      Ablo({
        schema,
        authEndpoint: '/api/ablo-session',
        plugins: [plugin('batching')],
      }),
    ).toThrow(/humans\(\)|empty list/);
  });

  it('rejects humans() listed twice', () => {
    expect(() =>
      Ablo({ schema, authEndpoint: '/api/ablo-session', plugins: [humans(), humans()] }),
    ).toThrow(/listed twice/);
  });

  it('declares the capability the way the contract reads it', () => {
    const plugin = humans();
    // Literal id, at the type level too — the LiteralString mechanism keeps
    // 'humans' from widening to string, so a list's surface can key by it.
    const id: 'humans' = plugin.id;
    expect(id).toBe('humans');
    expect(plugin.materialises).toBe(true);
    expect(plugin.requires).toEqual({ duplex: true });
    // The stage declaration and its handler are one field, so declaring a
    // stage without work — or work without a stage — is unrepresentable.
    expect(typeof plugin.stages.apply).toBe('function');
    expect(pluginsForStage([plugin], 'apply')).toEqual([plugin]);
  });

  it('constructs the presence stream in init, from the widened context', () => {
    // No transport in the context (a request-response host): the stream is
    // real and stays detached until one is attached. The surface carries
    // contributions only, no markers.
    const surface = humans().init({
      logger: context.logger,
      participant: { id: 'agent-1', kind: 'agent' },
      syncGroups: ['org:acme'],
    });

    expect(typeof surface.presence.attach).toBe('function');
    expect(surface.presence.self.participantId).toBe('agent-1');
    expect(surface.presence.self.participantKind).toBe('agent');
  });
});

// ── The store cluster (package-split step 2) ────────────────────────────
//
// `init` constructs the store cluster when the context carries the
// connection, the resolved url, the credential source, and a schema — and
// tolerates a thinner context by building the presence stream alone, the
// same tolerance the stream itself established.

import { kStoreCluster } from '../storeCluster.js';

describe('humans() constructs the store cluster', () => {
  it('a thin context yields the presence stream and no cluster, without throwing', () => {
    const surface = humans().init({
      logger: context.logger,
      participant: { id: 'agent-1', kind: 'agent' },
    });

    expect(typeof surface.presence.attach).toBe('function');
    expect(surface[kStoreCluster]).toBeUndefined();
  });

  it('the factory path yields a cluster whose store and runtime are live', () => {
    const client = Ablo({ schema, authEndpoint: '/api/ablo-session', plugins: [humans()] });
    try {
      // The client works end-to-end (every reactive suite pins that); here,
      // pin that its store came from the plugin: the internal `_store`
      // accessor serves the init-constructed instance, and the engine's
      // store-backed members are wired to it.
      expect(client._store).toBeDefined();
      expect(typeof client.subscribe).toBe('function');
      expect(client.syncStatus).toBeDefined();
    } finally {
      void client.dispose();
    }
  });

  it('the declared apply handler lands changes in this client\'s pool', async () => {
    const taskSchema = defineSchema({ tasks: model({ title: z.string() }) });
    const installed = humans();
    const client = Ablo({
      schema: taskSchema,
      authEndpoint: '/api/ablo-session',
      plugins: [installed],
    });
    try {
      // Dispatch the stage exactly as the pipeline does: through the plugin's
      // declared handler. The change must land in THIS client's pool.
      runStage([installed], 'apply', {
        changes: [
          { action: 'add', modelName: 'tasks', modelId: 'row-1', data: { id: 'row-1', title: 'landed' } },
        ],
      });
      const row = client.tasks.local.get('row-1');
      expect(row).toMatchObject({ title: 'landed' });
    } finally {
      await client.dispose();
    }
  });

  it('one humans() instance serves one client — a second install fails', async () => {
    const shared = humans();
    const clientA = Ablo({ schema, authEndpoint: '/api/ablo-session', plugins: [shared] });
    try {
      expect(() =>
        Ablo({ schema, authEndpoint: '/api/ablo-session', plugins: [shared] }),
      ).toThrow(/already installed/);
    } finally {
      await clientA.dispose();
    }
  });

  it('the cluster never becomes a client member — the handoff is symbol-keyed', () => {
    const client = Ablo({ schema, authEndpoint: '/api/ablo-session' });
    try {
      // The surface's symbol slot must not surface on the client, and no
      // string-keyed cluster members may leak through the layering proxy.
      expect(Reflect.get(client, kStoreCluster)).toBeUndefined();
      const leaked = client as Partial<Record<'cluster' | 'store' | 'runtime' | 'components', unknown>>;
      expect(leaked.cluster).toBeUndefined();
      expect(leaked.store).toBeUndefined();
      expect(leaked.runtime).toBeUndefined();
      expect(leaked.components).toBeUndefined();
    } finally {
      void client.dispose();
    }
  });
});
