/**
 * `createMesh` — thin-wrapper mesh client (the canonical public surface).
 * Implements the `AbloClient` contract declared in `./api.ts`.
 *
 * What this owns:
 *
 *   • `mesh.join(agent, opts)` — the front-page verb. Takes the
 *     customer's existing agent-like object, mints a Biscuit capability
 *     token against `POST /api/auth/capability`, and returns a
 *     `MeshParticipant` that wraps it. The customer's agent object is
 *     held by reference, not rewrapped — tools / prompts / models stay
 *     entirely in their code.
 *
 *   • `mesh.describeJoin(agent, opts)` — pure dry-run; derives the
 *     capability request without hitting the network. Used by tests,
 *     local Biscuit minters, and admin UIs previewing scope.
 *
 *   • `mesh.capabilities.create(...)` — escape hatch for customers who
 *     want raw Biscuit tokens for external integration.
 *
 *   • `mesh.roles` / `mesh.members` / `mesh.audit` — admin surface for
 *     tenant UIs. Backed in-memory for now; the types stay stable
 *     when server endpoints land.
 *
 * Ablo does NOT own or model: tools, skills, system prompts, LLM
 * providers, agent loops, or anything else that was in the customer's
 * stack before they called `createMesh`.
 */

import type { Schema } from '../schema/schema';
import type { ModelDef } from '../schema/model';
import { SyncAgent } from '../agent/SyncAgent';
import {
  AbloError,
  AbloValidationError,
  translateHttpError,
} from '../errors';

import type {
  ActiveIntent,
  Activity,
  AdminResources,
  AgentLike,
  AuditEntry,
  AuditListFilters,
  AuditResource,
  Capability,
  CapabilityCreateParams,
  CapabilitiesResource,
  CapturedContext,
  ContextAPI,
  ContextCaptureParams,
  ContextChange,
  CreateMeshOptions,
  Deleted,
  DeltaEnvelope,
  EntityRef,
  IntentHandle,
  IntentOptions,
  IntentRejection,
  IntentStream,
  JsonValue,
  JoinDescription,
  JoinOptions,
  Member,
  MemberCreateParams,
  MemberListFilters,
  MembersResource,
  AbloClient,
  AbloClientBase,
  MeshParticipant,
  Page,
  PresenceEntry,
  PresenceStream,
  PresenceTarget,
  Principal,
  Role,
  RoleCreateParams,
  RolesResource,
  ScopedJoiner,
  ScopedJoiners,
  ScopedJoinOptions,
  ScopeRef,
  Snapshot,
} from './api';
import { toMs, type Duration } from './duration';
import { asyncIteratorFrom, asyncIteratorFromEvents } from './asyncIterator';

// Polyfill `Symbol.asyncDispose` / `Symbol.dispose` for runtimes that
// haven't shipped native support (Node 18, older browsers). The TC39
// "Explicit Resource Management" proposal is stage 4, but the symbols
// only land in Node 20+ and some bundlers' `@@asyncDispose` helpers
// call `Symbol.for('Symbol.asyncDispose')` when the real symbol is
// missing — the polyfill below makes `await using` work end-to-end
// without forcing every consumer onto Node 20.
if (typeof (Symbol as { asyncDispose?: symbol }).asyncDispose === 'undefined') {
  Object.defineProperty(Symbol, 'asyncDispose', {
    value: Symbol.for('Symbol.asyncDispose'),
  });
}
if (typeof (Symbol as { dispose?: symbol }).dispose === 'undefined') {
  Object.defineProperty(Symbol, 'dispose', {
    value: Symbol.for('Symbol.dispose'),
  });
}

/**
 * Default TTL when the caller doesn't specify one. NOT a ceiling —
 * the server enforces the 30-day ceiling at `/api/auth/capability`
 * and returns a 400 if exceeded. We default to 2h because most joins
 * are short-lived (a scheduled task, an agent loop inside a request)
 * and short tokens narrow the blast radius of a leak. Callers running
 * 24/7 daemons explicitly opt in via `ttlSeconds: 86400` (1 day) or
 * longer, up to the server's 30-day max.
 *
 * Pair a long TTL with `participant.autoRefresh(...)` to rotate the
 * token before expiry without any observable downtime.
 */
const DEFAULT_TTL_SECONDS = 7200;

/**
 * Hosted production mesh endpoint. Customers using the managed service
 * reach this without any env configuration. Override via the `baseURL`
 * option or the `ABLO_BASE_URL` env var for staging / local-dev during
 * Ablo's own testing. Not a customer-facing self-host path — the
 * managed service is the only supported deployment today.
 */
const DEFAULT_MESH_BASE_URL = 'https://mesh.ablo.finance';

// ─────────────────────────────────────────────────────────────────────
//  createMesh — the factory
// ─────────────────────────────────────────────────────────────────────

export function createMesh<S extends Schema>(
  options: CreateMeshOptions<S>,
): AbloClient<S> {
  // Resolve config with the OpenAI / Anthropic precedence: explicit
  // option wins, env var is the fallback, built-in default last. This
  // is why `createMesh({ schema })` works in most server-side contexts
  // — the SDK reads `ABLO_API_KEY` / `ABLO_BASE_URL` from `process.env`
  // so the customer never repeats values that live in their `.env`
  // file.
  //
  // `organizationId` is deliberately NOT read from env. The API key or
  // session already binds the caller to one org server-side, and the
  // capability mint response echoes it back (see `doJoin` below). The
  // option exists only for admin tooling that spans multiple tenants.
  const env: Record<string, string | undefined> =
    typeof process !== 'undefined' ? (process.env ?? {}) : {};

  const baseURL = options.baseURL ?? env.ABLO_BASE_URL ?? DEFAULT_MESH_BASE_URL;
  const organizationId = options.organizationId;
  const apiKey = options.apiKey ?? env.ABLO_API_KEY;

  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    throw new Error(
      'createMesh: `baseURL` resolved to an empty string. Unset ' +
        '`ABLO_BASE_URL` or pass `baseURL` explicitly.',
    );
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  const delegationPolicy = options.delegationPolicy ?? 'strict';

  // In-memory registries for admin resources. Server-backed versions
  // come as endpoints land; the surface stays stable.
  const roles = new Map<string, Role>();
  const members = new Map<string, Member>();

  const ctx: JoinCtx = {
    schema: options.schema,
    baseURL,
    organizationId,
    apiKey,
    capabilityToken: options.capabilityToken,
    onTokenRefresh: options.onTokenRefresh,
    delegationPolicy,
    doFetch,
  };

  // Schema model names can be anything the customer declares —
  // `roles`, `members`, `audit`, `capabilities` are all fine because
  // admin resources live under `ablo.admin.*`, not at the top level.
  // Only four names are reserved on the root client: `schema`,
  // `join`, `describeJoin`, `admin` — the Proxy below ignores them
  // for joiner lookup.

  const admin: AdminResources = {
    capabilities: createCapabilitiesResource(ctx),
    roles: inMemoryResource<Role, RoleCreateParams>(roles, 'role', (params) => ({
      name: params.name,
      organizationId: params.organizationId ?? null,
      read: params.read ?? [],
      write: params.write ?? [],
      origin: 'tenant',
    })),
    members: inMemoryResource<Member, MemberCreateParams, MemberListFilters>(
      members,
      'mbr',
      (params) => ({
        userId: params.userId,
        organizationId: params.organizationId,
        roleId: params.roleId,
        scope: params.scope,
      }),
    ),
    audit: createAuditResource(),
  };

  const base: AbloClientBase<S> = {
    schema: options.schema,

    join: <A extends AgentLike>(agent: A, opts: JoinOptions<S>) =>
      doJoin<A, S>(ctx, agent, opts),

    describeJoin: (agent, opts) => describeJoin<S>(ctx, agent, opts),

    admin,
  };

  // Wrap in a Proxy that exposes model-scoped joiners at the top
  // level. Built-in keys hit `base` as normal; unknown keys fall
  // through to the scoped joiner lookup (populated from
  // `options.schema.models`). Joiners are cached per-model for
  // reference stability (matters for `useMemo` / React dep arrays).
  const scopedCache = new Map<string, ScopedJoiner<S>>();
  const getScopedJoiner = (modelName: string): ScopedJoiner<S> | undefined => {
    if (!(modelName in options.schema.models)) return undefined;
    let joiner = scopedCache.get(modelName);
    if (!joiner) {
      joiner = buildScopedJoiner<S>(modelName, (agent, opts) =>
        doJoin<AgentLike, S>(ctx, agent, opts),
      );
      scopedCache.set(modelName, joiner);
    }
    return joiner;
  };

  const mesh = new Proxy(base as unknown as AbloClient<S>, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') {
        return Reflect.get(target, prop, receiver);
      }
      // Built-in / admin field: return base's field.
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Otherwise: maybe a model-scoped joiner.
      return getScopedJoiner(prop);
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in options.schema.models) return true;
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return [
        ...Reflect.ownKeys(target),
        ...Object.keys(options.schema.models),
      ];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && prop in options.schema.models) {
        const joiner = getScopedJoiner(prop);
        if (joiner) return { enumerable: true, configurable: true, value: joiner };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  return mesh;
}

// ─────────────────────────────────────────────────────────────────────
//  mesh.join — the one primitive customers actually touch
// ─────────────────────────────────────────────────────────────────────

interface JoinCtx {
  schema: Schema;
  baseURL: string;
  /**
   * Caller-pinned organization id. Undefined in the common case —
   * the server derives org from the API key / session, and the
   * capability mint response echoes it back. Set only when an admin
   * caller wants to target a specific tenant.
   */
  organizationId: string | undefined;
  apiKey: string | undefined;
  /**
   * Pre-minted Biscuit capability token — the Stripe `client_secret`
   * analogue. When set, `join` skips the mint POST and uses this
   * token directly on the WS connection.
   */
  capabilityToken: string | undefined;
  /**
   * Caller-provided refresh callback. Used by `participant.refresh()`
   * when `capabilityToken` was supplied at construction time (the SDK
   * itself has no way to re-mint without the server-side API key).
   */
  onTokenRefresh: (() => Promise<string>) | undefined;
  delegationPolicy: 'strict' | 'permissive';
  doFetch: typeof fetch;
}

async function doJoin<A extends AgentLike, S extends Schema>(
  ctx: JoinCtx,
  agent: A,
  opts: JoinOptions<S>,
): Promise<MeshParticipant<A, S>> {
  // `as` is the plain-English alias; `onBehalfOf` is the legacy name.
  // Accept both, `as` wins when both are passed (explicit > legacy).
  const principal = opts.as ?? opts.onBehalfOf;

  // ── 1. Delegation policy ─────────────────────────────────────────
  if (principal && !opts.scope && ctx.delegationPolicy === 'strict') {
    throw new AbloValidationError(
      'mesh.join: `scope` is required when `as` is set under the ' +
        'default strict delegation policy. Pass the principal\'s scope ' +
        'explicitly, or set `delegationPolicy: "permissive"` on createMesh() ' +
        'to allow silent inheritance of the principal\'s full ceiling.',
      { code: 'mesh_delegation_scope_required' },
    );
  }

  // ── 2. Derive the capability request ─────────────────────────────
  const description = describeJoin<S>(ctx, agent, opts);
  if (description.allowedSyncGroups.length === 0) {
    throw new AbloValidationError(
      'mesh.join: scope produced an empty sync group list — at least one ' +
        'scopable entity id is required.',
      { code: 'mesh_scope_empty' },
    );
  }

  // ── 3. Mint OR reuse the capability ─────────────────────────────
  //
  // Two paths:
  //
  //   (a) `ctx.capabilityToken` set — Stripe-style browser flow. The
  //       caller already has a scoped Biscuit (their server minted it
  //       and shipped it down). We skip the mint POST entirely and
  //       use the provided token as-is; `capabilityId` / `expiresAt`
  //       are unknown to the SDK because we never saw the mint
  //       response. `refresh()` delegates to `ctx.onTokenRefresh`.
  //
  //   (b) No `capabilityToken` — classic mint: POST to
  //       `/api/auth/capability` under the API key / session cookie /
  //       parent AgentRef, receive the fresh Biscuit, open WS with it.
  let body: {
    capabilityId: string;
    token: string;
    expiresAt: string;
    organizationId: string;
  };

  // Path (a) applies only when:
  //   - ctx.capabilityToken is present (browser flow), AND
  //   - this is a self-join, not a sub-agent spawn — a sub-agent spawn
  //     (principal.kind === 'agent') needs a server-side attenuated
  //     mint, which only the mint endpoint can produce.
  const shouldUsePreMintedToken =
    ctx.capabilityToken !== undefined && principal?.kind !== 'agent';

  if (shouldUsePreMintedToken) {
    // Path (a). Synthesize a body matching the mint response shape so
    // the downstream participant wiring doesn't branch. The
    // capabilityId is unknown from the SDK side, so we stamp a
    // placeholder the customer can ignore (they never revoke a token
    // they didn't mint).
    body = {
      capabilityId: `pre-minted:${generateId()}`,
      token: ctx.capabilityToken!,
      expiresAt: new Date(Date.now() + description.ttlSeconds * 1000).toISOString(),
      organizationId: ctx.organizationId ?? 'from-capability-token',
    };
  } else {
    // Path (b). Existing mint flow.
    const authorization = resolveAuthorization(ctx.apiKey, principal);
    const credentials = resolveFetchCredentials(ctx.apiKey);
    // Caller-supplied `idempotencyKey` wins: a string gets pinned
    // across retries so the server can replay the cached capability.
    // Omit → auto-mint so every join is still replay-safe-by-default.
    // Explicit `null` opts out of the header entirely.
    const idempotencyKey =
      opts.idempotencyKey === null
        ? undefined
        : opts.idempotencyKey ?? generateId();
    const res = await ctx.doFetch(
      `${ctx.baseURL.replace(/\/$/, '')}/api/auth/capability`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(credentials ? { credentials } : {}),
        body: JSON.stringify({
          participantKind: description.participantKind,
          participantId: description.participantId,
          allowedSyncGroups: [...description.allowedSyncGroups],
          ttlSeconds: description.ttlSeconds,
          label: description.label,
        }),
      },
    );

    if (!res.ok) {
      const requestId = res.headers.get('x-request-id') ?? undefined;
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
      throw translateHttpError(res.status, parsed, requestId);
    }

    body = (await res.json()) as typeof body;
  }

  // ── 4. Hydrate the participant ───────────────────────────────────
  // Server-derived org wins by default (it matches the verified
  // Biscuit token's embedded org). Caller-pinned value wins only if
  // explicitly provided on `createMesh` — that's the admin / cross-org
  // override path.
  const resolvedOrganizationId = ctx.organizationId ?? body.organizationId;
  const syncAgent = new SyncAgent({
    url: ctx.baseURL,
    agentId: description.participantId,
    organizationId: resolvedOrganizationId,
    syncGroups: [...description.allowedSyncGroups],
    capabilityToken: body.token,
  });

  // Mutable capability state. `refresh()` swaps these without tearing
  // down the SyncAgent (its subscriptions, entity cache, and lastSyncId
  // stay intact), so long-running daemons rotating tokens keep their
  // observer wiring.
  const tokenState = {
    capabilityId: body.capabilityId,
    capabilityToken: body.token,
    expiresMs: new Date(body.expiresAt).getTime(),
  };

  // autoRefresh scheduling — single-timer, latest-wins so repeated
  // calls don't stack.
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAutoRefresh = () => {
    if (autoRefreshTimer !== null) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  };

  const doRefresh = async (): Promise<void> => {
    // Two refresh paths mirroring the two mint paths:
    //
    //   (a) Pre-minted token + `onTokenRefresh` callback — ask the
    //       customer's server for a fresh token. The SDK has no API
    //       key so it can't mint directly.
    //   (b) Otherwise — classic re-mint via `/api/auth/capability`
    //       with the original participantId so observers stay bound.
    let fresh: { capabilityId: string; token: string; expiresAt: string };

    if (ctx.capabilityToken) {
      if (!ctx.onTokenRefresh) {
        throw new AbloValidationError(
          'participant.refresh: this client was constructed with a pre-minted ' +
            '`capabilityToken` but no `onTokenRefresh` callback. Either pass ' +
            '`onTokenRefresh` on `new Ablo({...})` so the SDK can request a ' +
            'fresh token from your server, or re-mint server-side and construct ' +
            'a new client.',
          { code: 'mesh_refresh_unavailable' },
        );
      }
      const nextToken = await ctx.onTokenRefresh();
      fresh = {
        capabilityId: `pre-minted:${generateId()}`,
        token: nextToken,
        // We don't know the server's expiry for a pre-minted token —
        // assume the same TTL as the original join. Callers whose
        // server mints with a different TTL should tune their own
        // rotation cadence.
        expiresAt: new Date(Date.now() + description.ttlSeconds * 1000).toISOString(),
      };
    } else {
      // Re-mint with the SAME participantId + scope + principal as the
      // original join. This preserves participant identity across
      // rotation — observers keyed on participantId still match.
      const authorization = resolveAuthorization(ctx.apiKey, principal);
      const credentials = resolveFetchCredentials(ctx.apiKey);
      const res = await ctx.doFetch(
        `${ctx.baseURL.replace(/\/$/, '')}/api/auth/capability`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
            'Idempotency-Key': generateId(),
          },
          ...(credentials ? { credentials } : {}),
          body: JSON.stringify({
            participantKind: description.participantKind,
            participantId: description.participantId,
            allowedSyncGroups: [...description.allowedSyncGroups],
            ttlSeconds: description.ttlSeconds,
            label: description.label,
          }),
        },
      );
      if (!res.ok) {
        const requestId = res.headers.get('x-request-id') ?? undefined;
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        throw translateHttpError(res.status, parsed, requestId);
      }
      fresh = (await res.json()) as typeof fresh;
    }
    // Swap token on the live SyncAgent, then cycle the WS. Writes
    // submitted during the blip are buffered by the offline queue;
    // deltas missed during the blip are replayed on reconnect.
    syncAgent.disconnect();
    syncAgent.setCapabilityToken(fresh.token);
    tokenState.capabilityId = fresh.capabilityId;
    tokenState.capabilityToken = fresh.token;
    tokenState.expiresMs = new Date(fresh.expiresAt).getTime();
    await syncAgent.connect();
  };

  const participant: MeshParticipant<A, S> = {
    agent,
    id: description.participantId,
    get capabilityId() {
      return tokenState.capabilityId;
    },
    get capabilityToken() {
      return tokenState.capabilityToken;
    },
    onBehalfOf: principal ?? null,
    get ttlSecondsRemaining() {
      return Math.max(0, Math.floor((tokenState.expiresMs - Date.now()) / 1000));
    },
    connect: () => syncAgent.connect(),
    disconnect: async () => {
      clearAutoRefresh();
      syncAgent.disconnect();
    },
    refresh: doRefresh,
    autoRefresh: (opts) => {
      // Replace any prior schedule — last call wins. This matters for
      // testing (reset the timer between setups) and for callers that
      // flip between schedules on config reload.
      clearAutoRefresh();

      const scheduleNext = () => {
        const now = Date.now();
        let delayMs: number;
        if (opts?.schedule === 'interval') {
          delayMs = opts.intervalSeconds * 1000;
        } else {
          const thresholdSec =
            opts && 'thresholdSeconds' in opts && opts.thresholdSeconds !== undefined
              ? opts.thresholdSeconds
              : 300;
          // Fire when (remaining - threshold) has elapsed. If threshold
          // exceeds remaining, fire immediately.
          const remainingMs = tokenState.expiresMs - now;
          delayMs = Math.max(0, remainingMs - thresholdSec * 1000);
        }
        autoRefreshTimer = setTimeout(async () => {
          try {
            await doRefresh();
          } catch {
            // Refresh errors surface via the underlying fetch —
            // caller code that cares can wrap doRefresh manually.
            // The timer keeps running (next tick retries) so a
            // transient failure doesn't permanently stop rotation.
          }
          if (autoRefreshTimer !== null) scheduleNext();
        }, delayMs);
      };
      scheduleNext();

      return clearAutoRefresh;
    },
    get currentSyncId() {
      return syncAgent.currentSyncId;
    },
    onDelta: (handler) => {
      // SyncAgent emits 'delta' via its internal event bus. Adapt onto
      // the mesh-facing signature and return a typed unsubscribe fn.
      const wrapped = (delta: unknown) => handler(delta as DeltaEnvelope);
      syncAgent.on('delta', wrapped);
      return () => syncAgent.off('delta', wrapped);
    },
    // Async-iterable mirror of `onDelta`. Event-per-iteration semantics:
    // every delta lands as one `for await` yield, even if the consumer
    // is slow (bursts buffer). Each `for await` opens a fresh
    // subscription; `break` or error tears it down via the iterator's
    // `return()` hook.
    deltas: {
      [Symbol.asyncIterator]: () =>
        asyncIteratorFromEvents<DeltaEnvelope>((push) => {
          const wrapped = (delta: unknown) => push(delta as DeltaEnvelope);
          syncAgent.on('delta', wrapped);
          return () => syncAgent.off('delta', wrapped);
        }),
    },
    // ── Mutations — delegate to the underlying SyncAgent ──────────
    // Batch-always: every method takes an array. Single-item =
    // array of one. One `sendCommit` per call regardless of length.
    //
    // The public signatures are typed via `InferCreate` / `InferModel`.
    // `SyncAgent` is schema-agnostic (it accepts any shape because its
    // protocol is stringly-typed at the model name boundary), so we
    // cast at this one seam. Every cast below has the same shape:
    // customer-schema-inferred types → untyped wire.
    create: ((modelName: string, data: unknown, opts?: unknown) =>
      syncAgent.create(modelName, data as never, opts as never)) as MeshParticipant<
      A,
      S
    >['create'],
    update: ((modelName: string, patches: unknown, opts?: unknown) =>
      syncAgent.update(modelName, patches as never, opts as never)) as MeshParticipant<
      A,
      S
    >['update'],
    del: ((modelName: string, ids: readonly string[], opts?: unknown) =>
      syncAgent.delete(modelName, ids, opts as never)) as MeshParticipant<A, S>['del'],
    archive: ((modelName: string, ids: readonly string[], opts?: unknown) =>
      syncAgent.archive(modelName, ids, opts as never)) as MeshParticipant<
      A,
      S
    >['archive'],
    unarchive: ((modelName: string, ids: readonly string[], opts?: unknown) =>
      syncAgent.unarchive(modelName, ids, opts as never)) as MeshParticipant<
      A,
      S
    >['unarchive'],
    // Recursive join — child attenuates from this participant's token.
    // The child's principal is forced to an AgentRef derived from the
    // parent's capability, so `as` / `onBehalfOf` are removed from the
    // child's option surface.
    join: <B extends AgentLike>(
      childAgent: B,
      childOpts: Omit<JoinOptions<S>, 'as' | 'onBehalfOf'>,
    ) =>
      doJoin<B, S>(ctx, childAgent, {
        ...childOpts,
        as: {
          kind: 'agent',
          id: description.participantId,
          capabilityToken: body.token,
        },
      } as JoinOptions<S>),
    context: createContextAPI(syncAgent),
    snapshot: (entities) => createSnapshot(syncAgent, entities),
    presence: createPresenceStream(
      syncAgent,
      description.participantId,
      description.label,
      description.allowedSyncGroups,
    ),
    intents: createIntentStream(syncAgent, description.participantId),
  };

  // Auto-connect by default — matches `openai.chat.completions.stream()`
  // and `stripe.customers.create()` where the returned object is ready
  // to use. Callers who want token-without-socket pass `autoConnect:
  // false`. If the open fails we still return the participant so the
  // caller can inspect capability metadata and retry explicitly.
  if (opts.autoConnect !== false) {
    try {
      await syncAgent.connect();
    } catch {
      // Swallow — the caller can observe the failure by calling
      // participant.connect() themselves and handling the thrown error.
      // We'd rather return a usable participant (capability is already
      // minted) than fail the whole join.
    }
  }

  return participant;
}

// ─────────────────────────────────────────────────────────────────────
//  Presence / intents — livestream, wired to SyncAgent
// ─────────────────────────────────────────────────────────────────────
//
// The SyncAgent already ships/receives `presence_update`, `intent_begin`,
// and `intent_abandon` frames on its WebSocket. These factories just
// adapt the mesh-facing `PresenceStream` / `IntentStream` interfaces
// onto those existing primitives — one class of abstraction layer, no
// new wire protocol.

export function createPresenceStream(
  syncAgent: SyncAgent,
  participantId: string,
  label: string | undefined,
  syncGroups: readonly string[],
): PresenceStream {
  // A mutable "self" entry that `update(...)` advances. The object
  // itself is held stable across updates so observers can `.self` once
  // and trust the reference; the mutable fields reflect the latest
  // announced state.
  const self: PresenceEntry = {
    participantKind: 'agent',
    participantId,
    label,
    syncGroups: [...syncGroups],
    activity: { entityType: 'Unknown', entityId: '', action: 'idle' },
    lastActive: new Date().toISOString(),
  };

  // Rolling map keyed by `participantId`, populated from SyncAgent's
  // `onPresence` callback. Exposed as `others` (array) and
  // `othersIn(syncGroup)` (filtered view).
  const othersById = new Map<string, PresenceEntry>();

  // Cached snapshot of `others` — rebuilt only when `othersById`
  // actually mutates. Required by `React.useSyncExternalStore`: its
  // `getSnapshot` must return the same reference until something
  // changes, or React detects the new reference as "state changed"
  // every render and enters an infinite update loop (React error
  // #185). The cache lives outside the `get others()` getter so
  // repeated reads in a render cycle return the identical array.
  let othersSnapshot: ReadonlyArray<PresenceEntry> = Object.freeze([]);

  // On every WS reconnect, two things happen:
  //
  // (1) Clear the local peer map so the roster snapshot (sent by Hub
  //     immediately after the upgrade) becomes the sole source of
  //     truth. Without this, peers that left during the OFFLINE
  //     window linger: the SDK never received their `leave` frame,
  //     and the roster snapshot only broadcasts `enter` for
  //     currently-present peers.
  //
  // (2) Re-announce our own activity. The server's roster snapshot
  //     tells US who else is around, but peers don't automatically
  //     learn about US — they get a `kind: 'enter'` frame with no
  //     prior activity. Without re-announce, peers see the
  //     reconnecting participant as freshly joined, any editing /
  //     viewing state wiped. Fixing it here keeps the participant's
  //     visible state continuous across reconnects from the peer
  //     POV — matches Liveblocks semantics where WS lifetime ==
  //     presence lifetime, no gap on blip.
  syncAgent.on('connected', () => {
    if (othersById.size > 0) {
      othersById.clear();
      othersSnapshot = Object.freeze([]);
      notifyListeners();
    }
    // Re-broadcast self activity. Skip the default idle-sentinel
    // (no point telling peers "I'm idle on nothing" every reconnect).
    if (self.activity.entityId) {
      void syncAgent.announce('online', {
        entityType: self.activity.entityType,
        entityId: self.activity.entityId,
        action: self.activity.action,
        detail: self.activity.detail,
      });
    }
  });

  // Subscriber set for framework-agnostic reactivity. Fires whenever
  // `othersById` mutates (peer joined, left, or updated activity).
  // React callers bind via `useSyncExternalStore(subscribe, getSnapshot)`;
  // MobX callers wrap the read in `autorun(() => presence.others)`.
  const listeners = new Set<() => void>();
  const notifyListeners = () => {
    // Invalidate the cached snapshot so the next read returns a
    // fresh array reflecting the mutation.
    othersSnapshot = Object.freeze(Array.from(othersById.values()));
    for (const l of listeners) {
      try {
        l();
      } catch {
        // Listener errors shouldn't break other subscribers.
      }
    }
  };

  syncAgent.onPresence((entry) => {
    // Skip our own frames — echoed back from the server, uninteresting.
    if (entry.userId === participantId) return;

    // Dispatch on `kind` — the server classifies every transition as
    // enter / update / leave. Clients reduce with an explicit switch
    // instead of diffing the previous map, eliminating a class of
    // state-inconsistency bugs ("did this peer arrive or change?").
    switch (entry.kind) {
      case 'leave':
        if (othersById.delete(entry.userId)) notifyListeners();
        return;
      case 'enter':
      case 'update': {
        const meshEntry: PresenceEntry = {
          participantKind: entry.isAgent ? 'agent' : 'human',
          participantId: entry.userId,
          syncGroups: entry.syncGroups ?? [],
          activity: entry.activity
            ? {
                entityType: entry.activity.entityType,
                entityId: entry.activity.entityId,
                action: entry.activity.action,
                detail: entry.activity.detail,
              }
            : { entityType: 'Unknown', entityId: '', action: entry.status },
          lastActive: entry.timestamp
            ? new Date(entry.timestamp).toISOString()
            : new Date().toISOString(),
        };
        othersById.set(entry.userId, meshEntry);
        notifyListeners();
        return;
      }
    }
  });

  // Shared implementation — the verb methods below all funnel through
  // this, so the wire format stays identical and `update(...)` remains
  // the single source of truth for the wire frame.
  const doUpdate = (activity: Activity) => {
    // Mutate the stable `self` reference so callers reading `self`
    // see the latest state synchronously without holding a new object.
    // SyncAgent.announce ships the wire frame on the open WS.
    (self as { activity: Activity }).activity = activity;
    (self as { lastActive: string }).lastActive = new Date().toISOString();
    // Fire-and-forget — presence is ephemeral; a missed frame
    // resolves on the next update or a reconnection snapshot.
    void syncAgent.announce('online', {
      entityType: activity.entityType,
      entityId: activity.entityId,
      action: activity.action,
      detail: activity.detail,
    });
  };

  // Positional-arg verb helpers — accept either `{ type, id }` or the
  // tuple form `['Clause', 'cl_3']`. Makes `presence.editing(clause)`
  // and `presence.editing(['Clause', id])` both compile and read
  // naturally at the call site.
  const withVerb = (action: string) =>
    (target: PresenceTarget, detail?: string) => {
      const [entityType, entityId] = resolvePresenceTarget(target);
      doUpdate({ entityType, entityId, action, detail });
    };

  return {
    self,
    update: doUpdate,
    editing: withVerb('editing'),
    viewing: withVerb('viewing'),
    idle: () => {
      doUpdate({ entityType: 'Unknown', entityId: '', action: 'idle' });
    },
    get others() {
      // Cached reference. Returns the SAME array until `othersById`
      // mutates, at which point `notifyListeners` replaces the
      // snapshot. Safe as a `useSyncExternalStore` getSnapshot.
      return othersSnapshot;
    },
    othersIn: (syncGroup) =>
      othersSnapshot.filter((e) => e.syncGroups.includes(syncGroup)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      // One independent iterator per `for await` loop — each gets its
      // own subscription via `asyncIteratorFrom`. Tear-down happens
      // in the iterator's `return()` when the loop breaks / throws.
      return asyncIteratorFrom<ReadonlyArray<PresenceEntry>>(
        (onChange) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
        () => othersSnapshot,
      );
    },
  };
}

/**
 * Normalize the two accepted target shapes (object `{ type, id }` or
 * tuple `[type, id]`) into a `[type, id]` pair. Picked this shape
 * because tuple destructuring at the call site is the cheapest form
 * of "pass two strings" in TypeScript and matches what the wire
 * format needs downstream.
 */
function resolvePresenceTarget(
  target: PresenceTarget,
): readonly [type: string, id: string] {
  if (Array.isArray(target)) return [target[0], target[1]];
  const obj = target as EntityRef;
  return [obj.type, obj.id];
}

// ─────────────────────────────────────────────────────────────────────
//  context.capture — watermark the world for write honesty
// ─────────────────────────────────────────────────────────────────────
//
// Before an LLM starts reasoning, the caller captures a snapshot of
// the entities the prompt will include. The snapshot carries a
// `watermark` — the sync engine's current `lastSyncId` — which flows
// into every write the LLM's tools emit (via `readAt`). The server
// rejects writes whose `readAt` precedes the target entity's current
// delta, surfacing "the LLM reasoned against a now-stale slide" as
// a typed error instead of a silent overwrite.
//
// We also expose `onChange` — the subscription fires whenever any
// of the captured entities receives a delta. Callers wire this into
// the LLM call's AbortSignal so a mid-generation invalidation
// cancels the in-flight token stream rather than completing against
// a dead snapshot.

function createContextAPI(syncAgent: SyncAgent): ContextAPI {
  return {
    capture: async (params: ContextCaptureParams): Promise<CapturedContext> => {
      const watermark = String(syncAgent.currentSyncId);

      // Build the keyed-by-type, keyed-by-id data payload from the
      // agent's cache. Callers include this in their system prompt.
      const data: Record<string, Record<string, unknown>> = {};
      // Set of `${type}:${id}` pairs we're watching for change events.
      const watched = new Set<string>();

      for (const spec of params.entities) {
        const bucket: Record<string, unknown> = {};
        // If `ids` is provided, pluck just those; otherwise filter
        // by `where` if provided; otherwise take everything of that
        // type. The agent's `query` does the second two uniformly.
        if (spec.ids) {
          for (const id of spec.ids) {
            const results = syncAgent.query(spec.type, { where: { id } });
            if (results[0]) bucket[id] = results[0];
            watched.add(`${spec.type}:${id}`);
          }
        } else {
          const results = syncAgent.query(spec.type, spec.where ? { where: spec.where } : undefined);
          for (const entity of results) {
            const id = entity.id as string;
            bucket[id] = entity;
            watched.add(`${spec.type}:${id}`);
          }
        }
        data[spec.type] = bucket;
      }

      const listeners = new Set<(change: ContextChange) => void>();

      // Wire a single delta subscription per entity type touched. On
      // each delta, check if the (type, id) is in the watched set and
      // if so fire every registered listener. Unsubscribing is a
      // no-op on our side — the listener set clears when the agent
      // disposes; the per-model listeners ride on the agent's own
      // handler set (which also clears on dispose).
      const subs: Array<() => void> = [];
      const types = new Set(params.entities.map((e) => e.type));
      for (const type of types) {
        // `syncAgent.on(modelName, handler)` registers a delta
        // callback; the handler receives `(entity, delta)`.
        syncAgent.on(type, (entity, delta) => {
          const id = (entity.id ?? delta.modelId) as string | undefined;
          if (!id) return;
          if (!watched.has(`${type}:${id}`)) return;
          // `severity` heuristic: creates/deletes are structural;
          // updates that only touch `updatedAt` or `position` are
          // metadata. For now every delta is `semantic` — the
          // classifier is a follow-up; conservative default is safer
          // for "agent wrote against stale slide" scenarios.
          const change: ContextChange = {
            model: type,
            id,
            severity: 'semantic',
          };
          for (const listener of listeners) listener(change);
        });
        // The SyncAgent's `.on` returns `this` (chain style), not an
        // unsubscribe — so we don't have a per-capture teardown yet.
        // That's acceptable for a first pass; disposal follows
        // SyncAgent's own lifecycle.
        subs.push(() => {
          /* no-op for now; pending a proper per-handler release API */
        });
      }

      // Cast at the wire boundary: SyncAgent's `query(...)` returns
      // `Record<string, unknown>` because the protocol is stringly-
      // typed at the model-name boundary. The `CapturedContext` type
      // promises `JsonValue` for API consumers — runtime payload
      // IS JSON, so this is the only honest place for the cast.
      return {
        data: data as Readonly<Record<string, Readonly<Record<string, JsonValue>>>>,
        watermark,
        onChange: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            for (const teardown of subs) teardown();
          };
        },
      };
    },
  };
}

/**
 * Flat snapshot — the ergonomic face of `context.capture(...)`.
 *
 * Per-model buckets land directly on the returned object
 * (`snap.clauses[id]`), plus three concurrency primitives:
 * `stamp` (opaque watermark for `readAt`), `signal` (AbortSignal
 * that aborts on any captured-entity change), and `onChange`
 * (callback form for non-abort consumers).
 *
 * Implementation is a thin adapter over `createContextAPI` — same
 * wire protocol, same subscription wiring. The shape is what changed.
 */
async function createSnapshot<S extends Schema, K extends keyof S['models'] & string>(
  syncAgent: SyncAgent,
  entities: { readonly [M in K]: string | readonly string[] },
): Promise<Snapshot<S, K>> {
  // Reserved top-level names on the returned snapshot — schema models
  // with these names would shadow the concurrency surface.
  const reservedSnapshotKeys: ReadonlySet<string> = new Set([
    'stamp',
    'signal',
    'onChange',
  ]);
  for (const key of Object.keys(entities)) {
    if (reservedSnapshotKeys.has(key)) {
      throw new AbloValidationError(
        `participant.snapshot: model key "${key}" collides with a reserved ` +
          `snapshot field (stamp / signal / onChange). Rename the model ` +
          'in your schema, or use `participant.context.capture(...)` directly.',
        { code: 'mesh_snapshot_reserved_key' },
      );
    }
  }

  // Translate to the underlying context API's shape and delegate.
  const captureParams: ContextCaptureParams = {
    entities: Object.entries(entities).map(([type, idOrIds]) => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds as string];
      return { type, ids };
    }),
  };

  const captured = await createContextAPI(syncAgent).capture(captureParams);

  // Wire the AbortController to the underlying onChange so the LLM
  // call can pass `snap.signal` directly into `fetch` / `streamText`
  // / whatever — first invalidation aborts. We DO NOT unsubscribe
  // the underlying callback when signal fires; the caller might
  // still want to observe subsequent changes via `onChange`.
  const controller = new AbortController();
  captured.onChange(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new Error('snapshot invalidated — underlying entity received a delta'),
      );
    }
  });

  // Build the flat result: one top-level key per model bucket, plus
  // the three reserved fields.
  const result: Record<string, unknown> = {
    stamp: captured.watermark,
    signal: controller.signal,
    onChange: captured.onChange,
  };
  for (const [modelName, bucket] of Object.entries(captured.data)) {
    result[modelName] = bucket;
  }
  return result as unknown as Snapshot<S, K>;
}

export function createIntentStream(
  syncAgent: SyncAgent,
  participantId: string,
): IntentStream {
  // Intent state for everyone else derives from the same presence
  // stream — the server piggybacks `activeIntents` on every
  // `presence_update` frame, so subscribing to presence is how we
  // learn what intents other participants hold. We keep a rolling
  // map keyed by `intentId` (each participant can declare many).
  const activeByIntentId = new Map<string, ActiveIntent>();

  // Cached snapshot — same rationale as presence. `useSyncExternalStore`
  // requires reference stability between mutations.
  let intentsSnapshot: ReadonlyArray<ActiveIntent> = Object.freeze([]);

  // Subscriber set mirrors the presence stream's pattern. Any
  // announce / revoke / TTL expiry received from the server causes
  // `activeByIntentId` to mutate, and listeners are notified.
  const listeners = new Set<() => void>();
  const notifyListeners = () => {
    intentsSnapshot = Object.freeze(Array.from(activeByIntentId.values()));
    for (const l of listeners) {
      try {
        l();
      } catch {
        // Isolate listener errors.
      }
    }
  };

  syncAgent.onPresence((entry) => {
    // Skip self-echoes — `.others` is by definition everyone OTHER
    // than this participant. Matches the filter in createPresenceStream.
    if (entry.userId === participantId) return;

    // On `leave`: wipe every intent held by the departing peer.
    // The activity-change path below covers `enter` and `update` —
    // in both cases, the frame's `activeIntents` is the whole truth,
    // so pruning + re-adding is correct.
    let mutated = false;
    if (entry.kind === 'leave') {
      for (const [id, intent] of activeByIntentId) {
        if (intent.heldBy === entry.userId) {
          activeByIntentId.delete(id);
          mutated = true;
        }
      }
      if (mutated) notifyListeners();
      return;
    }

    // Prune every existing intent belonging to this participant —
    // a presence frame is the whole truth for that participant's
    // open intents at that moment, so anything not present has been
    // released (commit / TTL / abandon).
    for (const [id, intent] of activeByIntentId) {
      if (intent.heldBy === entry.userId) {
        activeByIntentId.delete(id);
        mutated = true;
      }
    }
    for (const claim of entry.activeIntents ?? []) {
      activeByIntentId.set(claim.intentId, {
        id: claim.intentId,
        heldBy: entry.userId,
        participantKind: entry.isAgent ? 'agent' : 'human',
        target: { type: claim.entityType, id: claim.entityId },
        reason: claim.action,
        ttlSeconds: Math.max(
          0,
          Math.floor((claim.expiresAt - Date.now()) / 1000),
        ),
        announcedAt: new Date(claim.declaredAt).toISOString(),
        expiresAt: new Date(claim.expiresAt).toISOString(),
      });
      mutated = true;
    }
    if (mutated) notifyListeners();
  });

  // Self-held intents — every open claim minted by this participant
  // that hasn't been revoked yet. Tracked so we can re-announce them
  // on WS reconnect (server's in-memory intent state is lost across
  // restarts; without re-announce, peers would see our claims vanish
  // whenever our connection blipped). Keyed by intentId; each entry
  // has the shape we'd need to call `syncAgent.beginIntent` again.
  interface OwnIntent {
    readonly entityType: string;
    readonly entityId: string;
    readonly action: string;
    readonly estimatedMs: number | undefined;
  }
  const ownIntents = new Map<string, OwnIntent>();

  // Server-side rejection listeners. When `intent_begin` is rejected
  // (another participant holds the target), fire every registered
  // listener. One source of truth — callers subscribe via
  // `intents.onRejected(cb)`; each rejection reaches them in order.
  const rejectionListeners = new Set<(r: IntentRejection) => void>();
  syncAgent.on('intent_rejected', (payload: unknown) => {
    const rejection = payload as IntentRejection;
    if (!rejection.intentId) return;
    // A rejected claim also needs to be removed from ownIntents — we
    // don't want reconnect to re-announce a claim the server already
    // rejected (it'd just reject again, spamming both sides).
    ownIntents.delete(rejection.intentId);
    for (const l of rejectionListeners) {
      try {
        l(rejection);
      } catch {
        // Isolate listener errors.
      }
    }
  });

  // On WS reconnect, re-announce every open self-claim. Server's
  // post-reconnect presence broadcast tells peers we're back; this
  // makes sure they see our claims too, not just our identity.
  // Matches the presence re-announce pattern in createPresenceStream
  // — self-state survives WS blips.
  syncAgent.on('connected', () => {
    for (const intent of ownIntents.values()) {
      syncAgent.beginIntent({
        entityType: intent.entityType,
        entityId: intent.entityId,
        action: intent.action,
        estimatedMs: intent.estimatedMs,
      });
    }
  });

  // Shared mint path — every verb helper funnels through this so the
  // wire format stays identical and asyncDispose/revoke land in one
  // place.
  const mintHandle = (args: {
    entityType: string;
    entityId: string;
    action: string;
    ttl: Duration | undefined;
  }): IntentHandle => {
    // SyncAgent.beginIntent returns its own handle; adapt to
    // the mesh's IntentHandle shape.
    const estimatedMs = args.ttl !== undefined ? toMs(args.ttl) : undefined;
    const handle = syncAgent.beginIntent({
      entityType: args.entityType,
      entityId: args.entityId,
      action: args.action,
      estimatedMs,
    });
    // Remember the claim so reconnect can re-send it.
    ownIntents.set(handle.intentId, {
      entityType: args.entityType,
      entityId: args.entityId,
      action: args.action,
      estimatedMs,
    });
    const revoke = () => {
      ownIntents.delete(handle.intentId);
      handle.abandon();
    };
    return {
      id: handle.intentId,
      revoke,
      // `Symbol.asyncDispose` makes `await using work = ...; ...`
      // auto-revoke when the enclosing block exits — success OR
      // throw. This is the TC39 "Explicit Resource Management"
      // proposal (stage 4, native in Node >= 20 + TS >= 5.2).
      // Revoke itself is synchronous; we wrap it in a resolved
      // promise to match the AsyncDisposable shape.
      [Symbol.asyncDispose]: async () => {
        revoke();
      },
    };
  };

  // Verb helper factory for the `editing` / `writing` shortcuts below.
  // Accepts the same loose target shape as presence verbs (object OR
  // tuple) and a ttl string/number.
  const verbAnnounce = (action: string) =>
    (target: PresenceTarget, opts?: IntentOptions): IntentHandle => {
      const [entityType, entityId] = resolvePresenceTarget(target);
      return mintHandle({
        entityType,
        entityId,
        action,
        ttl: opts?.ttl,
      });
    };

  return {
    announce: (intent) =>
      mintHandle({
        entityType: intent.target.type,
        entityId: intent.target.id,
        action: intent.reason,
        ttl: intent.ttlSeconds,
      }),
    editing: verbAnnounce('editing'),
    writing: verbAnnounce('writing'),
    // Reactive read of everyone else's open intents. One source of
    // truth: the presence stream. Returns the cached snapshot so
    // `useSyncExternalStore` callers don't infinite-loop.
    get others() {
      return intentsSnapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRejected: (listener) => {
      rejectionListeners.add(listener);
      return () => {
        rejectionListeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      return asyncIteratorFrom<ReadonlyArray<ActiveIntent>>(
        (onChange) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
        () => intentsSnapshot,
      );
    },
  };
}

function describeJoin<S extends Schema>(
  ctx: JoinCtx,
  agent: AgentLike,
  opts: JoinOptions<S>,
): JoinDescription {
  const allowedSyncGroups = deriveSyncGroups<S>(ctx.schema as S, opts.scope);
  // Pass the caller's requested TTL through unchanged. The server's
  // `/api/auth/capability` handler enforces the 30-day ceiling and
  // returns a clear 400 if exceeded; clamping silently at the SDK
  // layer would hide that contract from callers who explicitly
  // asked for (say) 24h because they run a 24/7 daemon. Accepts
  // either a number (seconds, back-compat) or a duration string
  // (`'24h'`, `'3m'`, `'30s'`, `'500ms'`).
  const ttlSeconds =
    opts.ttlSeconds !== undefined
      ? Math.floor(toMs(opts.ttlSeconds) / 1_000)
      : DEFAULT_TTL_SECONDS;
  // Auto-generate when the customer's agent has no natural id.
  // Stripe-style: callers let the SDK pick ids unless they need
  // correlation (tests, log joining, reconnection).
  const participantId = agent.id ?? `agent_${generateId()}`;
  // participantKind on the capability mint body is ALWAYS 'agent'. The
  // server (`apps/sync-server/src/routes/auth.ts:186-194`) rejects
  // `'user'` with `invalid_participant_kind — capability tokens cannot
  // impersonate human users`. The mint represents delegation (this
  // session/key is acting through an agent participant); the human
  // identity lives on the caller's session cookie, not on the cap.
  // Presence kind is separately derived server-side from the WS
  // connection's authenticated identity, not from this field.
  return {
    participantKind: 'agent',
    participantId,
    allowedSyncGroups,
    ttlSeconds,
    label: opts.label ?? agent.label,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  mesh.capabilities — raw Biscuit mint (escape hatch)
// ─────────────────────────────────────────────────────────────────────

function createCapabilitiesResource(ctx: JoinCtx): CapabilitiesResource {
  return {
    create: async (params: CapabilityCreateParams): Promise<Capability> => {
      const authorization = resolveAuthorization(ctx.apiKey, params.onBehalfOf);
      const credentials = resolveFetchCredentials(ctx.apiKey);
      const res = await ctx.doFetch(
        `${ctx.baseURL.replace(/\/$/, '')}/api/auth/capability`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
            'Idempotency-Key': generateId(),
          },
          ...(credentials ? { credentials } : {}),
          body: JSON.stringify({
            participantKind: 'agent',
            participantId: `cap_${generateId()}`,
            allowedSyncGroups: params.allowedSyncGroups,
            allowedOperations: params.allowedOperations,
            ttlSeconds: params.ttlSeconds ?? DEFAULT_TTL_SECONDS,
          }),
        },
      );
      if (!res.ok) {
        const requestId = res.headers.get('x-request-id') ?? undefined;
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep as text */
        }
        throw translateHttpError(res.status, parsed, requestId);
      }
      const body = (await res.json()) as {
        capabilityId: string;
        token: string;
        expiresAt: string;
      };
      return {
        id: body.capabilityId,
        token: body.token,
        parentId: null,
        allowedSyncGroups: params.allowedSyncGroups,
        allowedOperations: params.allowedOperations ?? null,
        expiresAt: body.expiresAt,
        revokedAt: null,
      };
    },
    retrieve: notImplemented('capabilities.retrieve'),
    list: notImplemented('capabilities.list'),
    update: notImplemented('capabilities.update'),
    del: async (id: string): Promise<Deleted> => {
      // Revoke is the tenant-compliance primitive — the token stays
      // signed (the chain is already in the wild) but the server's
      // next verify rejects it. Sub-second effect in practice.
      const res = await ctx.doFetch(
        `${ctx.baseURL.replace(/\/$/, '')}/api/auth/capability/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
          },
          // Session callers (no apiKey set) rely on the cookie, same
          // as the mint path. Including credentials here matches the
          // mint call's behaviour so customers don't have to know
          // which authentication path is in use.
          credentials: ctx.apiKey ? undefined : 'include',
        },
      );
      if (!res.ok) {
        const requestId = res.headers.get('x-request-id') ?? undefined;
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep as text */
        }
        throw translateHttpError(res.status, parsed, requestId);
      }
      return { id, deleted: true as const };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  mesh.audit — read-only, not-yet-implemented
// ─────────────────────────────────────────────────────────────────────

function createAuditResource(): AuditResource {
  return {
    retrieve: notImplemented<AuditEntry, [string]>('audit.retrieve'),
    list: notImplemented<Page<AuditEntry>, [AuditListFilters | undefined]>('audit.list'),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Generic in-memory resource (admin surface, pre-server-endpoint)
// ─────────────────────────────────────────────────────────────────────

type InMemoryItem = { id: string; createdAt: string; updatedAt: string };

function inMemoryResource<
  Item extends InMemoryItem,
  CreateParams,
  ListFilters = Record<string, never>,
>(
  store: Map<string, Item>,
  idPrefix: string,
  project: (params: CreateParams) => Omit<Item, 'id' | 'createdAt' | 'updatedAt'>,
) {
  return {
    create: async (params: CreateParams): Promise<Item> => {
      const now = new Date().toISOString();
      const id = `${idPrefix}_${generateId()}`;
      const item = {
        id,
        createdAt: now,
        updatedAt: now,
        ...project(params),
      } as Item;
      store.set(id, item);
      return item;
    },
    retrieve: async (id: string): Promise<Item> => {
      const item = store.get(id);
      if (!item) {
        throw new AbloValidationError(
          `${idPrefix}.retrieve: no item with id "${id}"`,
          { code: `${idPrefix}_not_found` },
        );
      }
      return item;
    },
    list: async (_filters?: ListFilters): Promise<Page<Item>> => ({
      data: Array.from(store.values()),
      hasMore: false,
    }),
    update: async (id: string, params: Partial<CreateParams>): Promise<Item> => {
      const existing = store.get(id);
      if (!existing) {
        throw new AbloValidationError(
          `${idPrefix}.update: no item with id "${id}"`,
          { code: `${idPrefix}_not_found` },
        );
      }
      const partial = project(params as CreateParams);
      const updated = {
        ...existing,
        ...partial,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      } as Item;
      store.set(id, updated);
      return updated;
    },
    del: async (id: string): Promise<Deleted> => {
      store.delete(id);
      return { id, deleted: true as const };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function deriveSyncGroups<S extends Schema>(
  schema: S,
  scope: ScopeRef<S> | undefined,
): string[] {
  if (!scope) return [];

  // Normalize both forms to the same internal shape: an array of
  // `{ def: ModelDef, ids: string[] }`. The flat-object form lives
  // alongside the array form for terseness; both reach the same code
  // path downstream, so the runtime invariants (syncGroupFormat
  // required, idents stringified) stay in one place.
  interface Normalized {
    def: ModelDef;
    ids: readonly string[];
    labelForError: string;
  }
  const normalized: Normalized[] = [];

  if (Array.isArray(scope)) {
    for (const entry of scope) {
      const def = entry.entity as ModelDef;
      if (!def) {
        throw new AbloValidationError(
          'mesh.join: scope entry is missing an `entity` reference. Pass ' +
            'the ModelDef from your schema (e.g. schema.models.matters).',
          { code: 'mesh_scope_undeclared_entity' },
        );
      }
      const ids = Array.isArray(entry.ids) ? entry.ids : [entry.ids];
      normalized.push({ def, ids, labelForError: def.typename ?? '<unknown>' });
    }
  } else {
    // Flat object form: `{ matters: 'id' | ['id1', 'id2'], teams: ... }`.
    // Walk the schema's model record for each key, so runtime and type
    // system agree on which keys are valid.
    for (const [modelName, value] of Object.entries(scope as Record<string, unknown>)) {
      if (value === undefined) continue;
      const def = schema.models[modelName as keyof typeof schema.models] as ModelDef | undefined;
      if (!def) {
        throw new AbloValidationError(
          `mesh.join: scope key "${modelName}" does not match any model in ` +
            'the schema. Check for typos or schema drift.',
          { code: 'mesh_scope_unknown_model' },
        );
      }
      const ids = Array.isArray(value) ? (value as string[]) : [value as string];
      normalized.push({ def, ids, labelForError: modelName });
    }
  }

  const groups: string[] = [];
  for (const { def, ids, labelForError } of normalized) {
    if (!def.syncGroupFormat) {
      throw new AbloValidationError(
        `mesh.join: entity "${labelForError}" has no \`syncGroupFormat\` — ` +
          'cannot be used as a scope entry. Declare `syncGroupFormat` in ' +
          'the model options, or drop this entry.',
        { code: 'mesh_entity_not_scopable' },
      );
    }
    for (const id of ids) {
      groups.push(def.syncGroupFormat.replace('{id}', String(id)));
    }
  }
  return groups;
}

function resolveAuthorization(
  apiKey: string | undefined,
  onBehalfOf: Principal | undefined,
): string | undefined {
  if (onBehalfOf?.kind === 'agent') {
    // Attenuation chain: the child capability mint runs under the
    // parent's token as Authorization.
    return `Bearer ${onBehalfOf.capabilityToken}`;
  }
  if (onBehalfOf?.kind === 'session') {
    // Session auth rides the HTTP request via the Better Auth cookie —
    // there is no bearer to set. `doJoin` sets
    // `credentials: 'include'` on the fetch so the cookie reaches the
    // server on both same-origin (browser) and cross-origin (embedded
    // SDK) calls. The server's `POST /api/auth/capability` route
    // (apps/sync-server/src/routes/auth.ts:82) accepts `caller.method
    // === 'session'` and mints the capability scoped to the session's
    // organizationId.
    return undefined;
  }
  return apiKey ? `Bearer ${apiKey}` : undefined;
}

/**
 * Fetch credentials policy for the capability-mint call. If the caller
 * has an API key, cookies are irrelevant — `Authorization: Bearer <key>`
 * carries identity. Otherwise (browser flow) opt into cookies so the
 * Better Auth session cookie reaches the mesh server on cross-origin
 * POSTs. Matches the DELETE/revoke path's rule — both endpoints
 * authenticate the same way without the caller having to pass
 * `as: session({...})` explicitly.
 */
function resolveFetchCredentials(
  apiKey: string | undefined,
): RequestCredentials | undefined {
  return apiKey ? undefined : 'include';
}

function generateId(): string {
  return (globalThis.crypto ?? require('crypto')).randomUUID();
}

/**
 * Build one `ScopedJoiner` for a single model name. The Proxy in
 * `createMesh` above calls this lazily per model and caches the
 * result — customers see `ablo.matters` as a stable reference.
 *
 * The joiner desugars `ablo.matters.join(id, opts)` into the
 * equivalent generic `doJoin(agent, { scope: { matters: id }, ...opts })`
 * call, synthesizing an `agent` from the optional `label` when the
 * caller didn't supply one. Model-name validation happens at
 * `doJoin` time via `deriveSyncGroups` — unknown keys produce a
 * clear `mesh_scope_unknown_model` error.
 */
function buildScopedJoiner<S extends Schema>(
  modelName: string,
  doJoinImpl: (
    agent: AgentLike,
    opts: JoinOptions<S>,
  ) => Promise<MeshParticipant<AgentLike, S>>,
): ScopedJoiner<S> {
  return {
    join: async <A extends AgentLike>(
      id: string | readonly string[],
      opts: ScopedJoinOptions<S> = {},
    ): Promise<MeshParticipant<A, S>> => {
      // Synthesize an agent object when the caller didn't pass one.
      // `label` on opts is a shortcut for "peers should see this
      // human-readable name"; `id` is auto-minted by doJoin.
      const agent: AgentLike = opts.agent ?? (
        opts.label !== undefined ? { label: opts.label } : {}
      );
      // Strip our convenience keys before passing through — doJoin
      // doesn't know about `agent` as an opt field.
      const { agent: _agent, ...joinOpts } = opts;
      const scope = { [modelName]: id } as ScopeRef<S>;
      return (await doJoinImpl(agent, {
        ...joinOpts,
        scope,
      })) as MeshParticipant<A, S>;
    },
  };
}

/**
 * Throws at call time with a clear, actionable message. Used for
 * spec-declared methods whose server endpoints don't exist yet.
 */
function notImplemented<R = never, A extends unknown[] = unknown[]>(
  path: string,
): (...args: A) => Promise<R> {
  return async () => {
    throw new AbloError(
      `mesh.${path}: not yet implemented. This method is spec-declared; the ` +
        'server endpoint is on the migration roadmap.',
      { code: 'mesh_not_implemented' },
    );
  };
}
