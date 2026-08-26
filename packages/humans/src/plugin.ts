/**
 * The plugin contract (ADR 0016).
 *
 * The core is `commit` · `get`/`list` · `observe` · `claim` · auth. Everything
 * else a caller might want — a local materialised copy, presence rendering,
 * batching, framework bindings — is a plugin declared in one list, so a server
 * or an agent installs only what it asked for.
 *
 * Every plugin has the same shape on purpose. Uniformity is what makes the list
 * composable and the types inferable; bespoke plugins would reproduce today's
 * nineteen export subpaths with extra ceremony.
 *
 * Where this shape came from, and the field-by-field reasoning behind it, is
 * recorded in ADR 0016 — the contract itself only states what each field does.
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';
import type { ErrorCodeSpec } from '@abloatai/transaction/errorCodes';
import type { Logger } from '@abloatai/transaction/logger';
import type { CoordinationObservability } from '@abloatai/transaction/observability';
import type { WsTransport } from '@abloatai/transaction/transport/websocket';
import type { AuthCredentialSource } from '@abloatai/transaction/auth/credentialSource';
import type { SyncDeltaWireCore } from '@abloatai/transaction/observation';
import type { ModelData } from '@abloatai/transaction/types/modelData';

/**
 * A string type that keeps literal inference alive: `id: 'humans'` stays the
 * literal `'humans'` through object-literal inference instead of widening to
 * `string`, which is what lets {@link InstalledSurface} key a plugin list's
 * surface by id.
 */
export type LiteralString = '' | (string & Record<never, never>);

/**
 * The ordered stages a delta passes through on its way from the feed into
 * whatever is watching. A plugin names the one it attaches to.
 *
 * The order is not a convention — it is a correctness constraint. `acknowledge`
 * must follow `persist`, because acknowledging the input range rather than the
 * persisted high-water mark advances the server's cursor past deltas that never
 * committed, and the next catch-up then answers "you're up to date" for a delta
 * that was lost. Declaring the stage keeps that ordering out of array position,
 * where it would be load-bearing and undocumented.
 */
export type PipelineStage =
  /** Deltas arrive from `observe()` and are queued. */
  | 'receive'
  /** Per-entity collapse of the queued batch. */
  | 'dedupe'
  /** The batch is written to durable local storage. */
  | 'persist'
  /** Persisted results land in the in-memory graph. */
  | 'apply'
  /** The cursor advances — gated on `persist`, never on the input range. */
  | 'acknowledge'
  /** Anything downstream reacts: re-render, presence, subscribers. */
  | 'notify';

/** Canonical order. A plugin runner must run stages in this sequence. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'receive',
  'dedupe',
  'persist',
  'apply',
  'acknowledge',
  'notify',
];

/**
 * A delta as stage handlers receive it — the identity slice of the wire
 * shape, projected rather than restated so the wire schema stays the one
 * definition.
 */
export type StageDelta = Pick<
  SyncDeltaWireCore,
  'id' | 'actionType' | 'modelName' | 'modelId'
>;

/**
 * One persisted change: what the durable write reported and the apply stage
 * lands in the in-memory graph. `data` is absent for actions that carry
 * none (a remove reports identity only).
 */
export interface AppliedChange {
  action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
  modelName: string;
  modelId: string;
  data?: ModelData | null;
  /**
   * Server-stamped transaction id, echoing the client's own commit
   * operation id — how a client recognizes the confirmation of a change it
   * already applied locally. Absent for system-emitted changes, which have
   * no client transaction behind them.
   */
  transactionId?: string;
  /**
   * The log position of the delta this change answers — its `sync_deltas` id.
   * The apply stage records it per row so a later snapshot can be judged
   * against what the row already reflects. Absent when the source carried no
   * position.
   */
  syncId?: number;
}

/**
 * What each stage hands its handlers. Read off the delta pipeline these
 * stages were read off, not invented: `receive` sees the delta being
 * queued, `dedupe` and `persist` see the batch at those boundaries,
 * `apply` and `notify` see the persisted changes, and `acknowledge` sees
 * the persistence-gated cursor value.
 */
export interface StagePayloads {
  receive: { readonly delta: StageDelta };
  dedupe: { readonly deltas: readonly StageDelta[] };
  persist: { readonly deltas: readonly StageDelta[] };
  apply: { readonly changes: readonly AppliedChange[] };
  acknowledge: { readonly syncId: number };
  notify: { readonly changes: readonly AppliedChange[] };
}

/** The handler a plugin attaches at one stage. The payload derives from the key. */
export type StageHandler<K extends PipelineStage> = (
  payload: StagePayloads[K],
) => void;

/**
 * What a capability needs from whatever transport was selected.
 *
 * Transport is a slot the caller fills, not a packaging axis, so a capability
 * states its requirement and an incompatible pairing fails when the client is
 * configured — with a typed error naming the plugin — rather than at runtime
 * with a subscription that silently never delivers.
 */
export interface TransportCapabilities {
  /**
   * Requires a transport the server can initiate frames on. Live subscriptions,
   * presence, and claim grants need this; commit and point-in-time reads do not.
   */
  readonly duplex?: boolean;
}

/**
 * The core surface a plugin is handed at construction.
 *
 * Generic over the client's options type: the host instantiates it with its
 * own options bag, so a plugin reads configuration without this package
 * naming any consumer's types. Alongside the raw options, the context
 * carries the values the host has already resolved (`participant`,
 * `syncGroups`), so a plugin never re-derives identity.
 */
export interface PluginContext<Options = unknown> {
  readonly logger: Logger;
  readonly observability?: CoordinationObservability;

  /** The client's own options bag, as the host received it. */
  readonly options?: Options;

  /**
   * The live duplex connection. The host builds it during construction, so a
   * plugin holds the thing rather than a function that fetches it: the
   * connection object is stable for the client's lifetime — identity and
   * read scope are seeded into it when they resolve, and reconnects replace
   * only the socket inside it, never the object. Absent on a
   * request-response client, which is what `requires: { duplex: true }`
   * guards.
   */
  readonly transport?: WsTransport;

  /** The participant this client runs as, when known at construction. */
  readonly participant?: {
    readonly id: string;
    readonly kind: ParticipantKind;
  };

  /** The connection's initial read scope (sync groups). */
  readonly syncGroups?: readonly string[];

  /** The resolved server base URL, settled by the host before construction. */
  readonly url?: string;

  /**
   * The client's single bearer-credential source, shared with every
   * auth-aware transport the host built. A plugin that constructs its own
   * fetching component hands this on rather than re-deriving a credential.
   */
  readonly auth?: AuthCredentialSource;

  /**
   * Whether a plugin with the given id is installed on this client. Supplied
   * by {@link resolvePlugins} from the list it is resolving — the one place
   * that truthfully knows the assembly — so a plugin interrogates what is
   * installed instead of the host special-casing plugins by name.
   */
  readonly hasPlugin?: (id: string) => boolean;

  /**
   * The resolved plugin list itself, supplied by {@link resolvePlugins}
   * alongside {@link hasPlugin} (which derives from it). A component a
   * plugin constructs — the store and its delta pipeline — holds this list
   * to dispatch the declared stage handlers through {@link runStage}.
   */
  readonly plugins?: readonly AbloPlugin[];
}

/**
 * One installed capability.
 *
 * @typeParam Surface - what `init` contributes to the client. The plugin list's
 * element types are what let the installed surface be inferred rather than
 * declared.
 */
export interface AbloPlugin<Surface = unknown> {
  /** Stable identity — deduplication, diagnostics, and error attribution.
   *  Literal-typed so a list's installed surface can be keyed by it. */
  readonly id: LiteralString;

  /** The plugin's own version, for diagnostics. */
  readonly version?: string;

  /** What this plugin needs from the transport. Checked at configuration time. */
  readonly requires?: TransportCapabilities;

  /**
   * Whether this plugin keeps a local copy of rows.
   *
   * This is ADR 0013 §4's membership test as a declared, checkable property
   * rather than a rule someone has to remember: a stateless caller can assert
   * that nothing in its list materialises, and CI can assert the core's own
   * list is uniformly `false`.
   */
  readonly materialises: boolean;

  /**
   * Error codes this plugin may raise, folded into the registry.
   *
   * Registration is part of the contract because the error catalog is
   * generated — a plugin that invents untyped errors would silently punch a
   * hole in the published reference.
   */
  readonly errorCodes?: Readonly<Record<string, ErrorCodeSpec>>;

  /**
   * The pipeline stages this plugin attaches to: each key names a stage and
   * holds the handler the runner invokes there. One field on purpose — a
   * declared stage cannot exist without its handler, nor a handler without
   * its stage, so the declaration can never point at nothing. The payload
   * type derives from the key ({@link StagePayloads}).
   */
  readonly stages?: { readonly [K in PipelineStage]?: StageHandler<K> };

  /** Build the plugin's contribution to the client surface. */
  init(context: PluginContext): Surface;
}

/** The surface a plugin list contributes, keyed by plugin id. */
export type InstalledSurface<Plugins extends readonly AbloPlugin[]> = {
  [P in Plugins[number] as P['id']]: P extends AbloPlugin<infer S> ? S : never;
};

/**
 * The plugin with the given id in a list, or `never` when absent. Sound
 * because ids are literal ({@link LiteralString}); a list typed only as
 * `AbloPlugin[]` has widened ids and resolves to `never`, so write plugin
 * lists inline for the client type to follow them.
 */
export type PluginById<
  Plugins extends readonly AbloPlugin[],
  Id extends string,
> = Extract<Plugins[number], { id: Id }>;

/** Collapses a union into an intersection, member by member. */
type UnionToIntersection<U> = (
  U extends unknown ? (member: U) => void : never
) extends (member: infer I) => void
  ? I
  : never;

/**
 * Every surface in a plugin list, folded into the one shape that merges onto
 * the client: `[a(), b()]` contributes `ASurface & BSurface`. An empty list
 * contributes nothing (`unknown`), so intersecting it changes no type.
 */
export type MergedSurface<Plugins extends readonly AbloPlugin[]> = [
  Plugins[number],
] extends [never]
  ? unknown
  : UnionToIntersection<
      Plugins[number] extends AbloPlugin<infer Surface> ? Surface : never
    >;

/** What the selected transport can actually do, for checking `requires`. */
export interface TransportProfile {
  readonly duplex: boolean;
}

/**
 * Check a plugin list against the selected transport and build its surface.
 *
 * Both failures are configuration mistakes, so they surface here — while the
 * client is being constructed and the stack still points at the caller's own
 * setup — rather than later as a subscription that never delivers.
 */
export function resolvePlugins<const Plugins extends readonly AbloPlugin[], Options = unknown>(
  plugins: Plugins,
  transport: TransportProfile,
  context: PluginContext<Options>,
): InstalledSurface<Plugins> {
  const surface: Record<string, unknown> = {};
  const seen = new Set<string>();

  // The assembly, injected from the list being resolved. Always this list's
  // own answer — a host-supplied `plugins` or `hasPlugin` could disagree
  // with the assembly it describes, so both are replaced, not deferred to.
  const initContext: PluginContext<Options> = {
    ...context,
    plugins,
    hasPlugin: (id: string): boolean => plugins.some((plugin) => plugin.id === id),
  };

  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new AbloValidationError(
        `The ${plugin.id} plugin is listed twice. Remove the duplicate; a plugin is installed once per client.`,
        { code: 'invalid_options', param: 'plugins' },
      );
    }
    seen.add(plugin.id);

    if (plugin.requires?.duplex && !transport.duplex) {
      throw new AbloValidationError(
        `The ${plugin.id} plugin needs a connection the server can send on, and this client is set up for request-response only. Switch the transport to 'websocket', or drop the plugin.`,
        { code: 'invalid_options', param: 'plugins' },
      );
    }

    surface[plugin.id] = plugin.init(initContext);
  }

  return surface as InstalledSurface<Plugins>;
}

/**
 * Lays every installed plugin surface over a built client, so a plugin's
 * contributions are reachable as client members. The base always wins — a
 * plugin cannot shadow `dispose`, a model accessor, or any other member the
 * client itself defines; contributions only fill what the base leaves
 * undefined. With nothing installed the base is returned untouched.
 *
 * The second half of {@link resolvePlugins}: that call turns a list into a
 * surface, this one merges the surface onto the client the host built.
 */
export function layerPluginSurface<T extends object>(
  base: T,
  installed: Record<string, unknown>,
): T {
  const contributions: Record<string, unknown> = {};
  for (const surface of Object.values(installed)) {
    if (surface && typeof surface === 'object') {
      Object.assign(contributions, surface);
    }
  }
  if (Object.keys(contributions).length === 0) return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const own: unknown = Reflect.get(target, prop, receiver);
      if (own !== undefined) return own;
      return typeof prop === 'string' && prop in contributions
        ? contributions[prop]
        : own;
    },
  });
}

/**
 * The plugins attached to one pipeline stage, in declaration order.
 *
 * Stage order across the pipeline is fixed by {@link PIPELINE_STAGES}; this
 * returns the members of a single stage, where declaration order is the caller's
 * to choose and carries no correctness weight.
 */
export function pluginsForStage(
  plugins: readonly AbloPlugin[],
  stage: PipelineStage,
): readonly AbloPlugin[] {
  return plugins.filter((plugin) => plugin.stages?.[stage] !== undefined);
}

/**
 * Invokes every handler declared for one stage, in declaration order, with
 * that stage's payload. No handlers declared is a plain no-op, so a pipeline
 * dispatches unconditionally at each boundary and pays nothing when the
 * stage is unclaimed.
 */
export function runStage<K extends PipelineStage>(
  plugins: readonly AbloPlugin[],
  stage: K,
  payload: StagePayloads[K],
): void {
  for (const plugin of plugins) {
    plugin.stages?.[stage]?.(payload);
  }
}
