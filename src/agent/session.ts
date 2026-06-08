/**
 * Agent session — cache + lifecycle for server-side `SyncAgent`s.
 *
 * Captures the pattern every server-side consumer needs:
 *   1. Cache `SyncAgent` instances per (org, user, surface, target).
 *   2. Re-mint capabilities before TTL elapses.
 *   3. Align the SyncAgent ctor's `syncGroups` with the cap allowlist
 *      so the upgrade-time intersection is non-empty (avoid the
 *      silent black-hole-broadcast bug).
 *   4. Connect / disconnect / dispose lifecycle.
 *
 * What's generic, what isn't:
 *   - Cache, TTL, sync_groups alignment, lifecycle: SAME for every
 *     consumer. Lives here.
 *   - Cap mint: AUTH-FLOW-SPECIFIC. Every consumer has a different
 *     way to obtain a token (Better Auth cookie forwarding, API key
 *     exchange, OAuth, etc.). Consumer provides via the
 *     `issueToken` callback.
 *
 * The helper itself imports nothing app-specific. Open-source-clean.
 */

import { Ablo } from '../client/Ablo.js';
import { AbloConnectionError } from '../errors.js';
import type { Schema, SchemaRecord } from '../schema/schema.js';

// Internal shapes — used by the implementation and by the inline
// signature of `AgentSessionOptions.issueToken`. Not exported: the
// caller never references them by name. They build a callback that
// returns the right shape, the type-checker enforces it.

interface IssuedToken {
  readonly token: string;
  readonly expiresAtMs: number;
  /**
   * Sync groups allowed by this capability. Must include every group
   * the agent will subscribe to — the upgrade-time intersection of
   * (allowed) ∩ (requested) determines effective subscription. Returning
   * a list that doesn't include the needed groups produces an empty
   * intersection and silent broadcast failure.
   */
  readonly syncGroups: readonly string[];
}

interface AgentIdentity {
  readonly userId: string;
  readonly organizationId: string;
  /**
   * Surface class — `'chat'`, `'mcp'`, `'agent_worker'`, etc. Session
   * caches per surface so two surfaces don't share token or WS.
   */
  readonly surfaceClass: string;
  readonly target?: { readonly entityType: string; readonly entityId: string } | null;
}

export interface AgentSessionOptions<R extends SchemaRecord = SchemaRecord> {
  /** Sync-server WebSocket URL — `wss://sync.example.com` or `ws://localhost:3001`. */
  readonly syncServerUrl: string;
  /** Schema for the typed model proxy on the returned Ablo. After
   *  the dual-engine collapse, `Ablo({kind:'agent'})` is the unified
   *  factory and requires the schema to expose
   *  `agent.<model>.create/update/delete`. */
  readonly schema: Schema<R>;
  /**
   * Token-issuing callback. Called on cache miss / expiry. Owns the
   * consumer's auth flow (Better Auth cookies, API key exchange, OAuth,
   * etc.) so the engine stays auth-flow-agnostic.
   */
  readonly issueToken: (identity: AgentIdentity) => Promise<IssuedToken>;
  /**
   * Soft window before actual expiry to re-mint. Defaults to 30s.
   * Avoids races between mint-time and clock-skew at use-time.
   */
  readonly reissueBufferMs?: number;
  /**
   * Optional agent-id strategy. Default: `${surfaceClass}:${userId}`.
   * Override when the consumer wants different attribution shape.
   */
  readonly agentIdFor?: (identity: AgentIdentity) => string;
}

interface CachedAgent<R extends SchemaRecord = SchemaRecord> {
  agent: Ablo<R>;
  expiresAtMs: number;
}

/**
 * Returns a session whose `getAgent` method handles cache, mint,
 * sync_groups alignment, and lifecycle. Call `disposeAll()` from
 * the consumer's process shutdown hook.
 *
 * Threading: the session is intended to be a long-lived singleton
 * shared across requests. The cache is keyed precisely so two
 * concurrent requests for the same (user, org, surface, target)
 * share one agent + one WS, while different requests get
 * independent agents.
 */
export function createAgentSession<R extends SchemaRecord = SchemaRecord>(
  options: AgentSessionOptions<R>,
) {
  const reissueBufferMs = options.reissueBufferMs ?? 30_000;
  const agentIdFor =
    options.agentIdFor ??
    ((id: AgentIdentity) => `${id.surfaceClass}:${id.userId}`);

  const cacheByKey = new Map<string, CachedAgent<R>>();

  function cacheKey(id: AgentIdentity): string {
    const targetSeg = id.target
      ? `:${id.target.entityType}:${id.target.entityId}`
      : '';
    return `${id.organizationId}:${id.userId}:${id.surfaceClass}${targetSeg}`;
  }

  async function getAgent(identity: AgentIdentity): Promise<Ablo<R>> {
    const key = cacheKey(identity);
    const cached = cacheByKey.get(key);
    if (cached && cached.expiresAtMs - Date.now() > reissueBufferMs) {
      return cached.agent;
    }

    // Best-effort cleanup of stale agent — don't let a stuck cached
    // entry block fresh issuance.
    if (cached) {
      try {
        await cached.agent.dispose();
      } catch {
        /* ignore */
      }
    }

    const minted = await options.issueToken(identity);

    // Sync_groups alignment is the load-bearing detail. The SDK
    // ctor's `syncGroups` and the cap mint's `syncGroups`
    // MUST overlap or the upgrade intersection is empty and every
    // broadcast filter returns false. Use the cap's allowed list
    // verbatim — the caller controlled what went in there, so it's
    // exactly what the SDK should request.
    // `AbloOptions` exposes the URL as `baseURL` (resolved by
    // `resolveBaseURL`). Earlier code passed `url:` here — `Ablo()`
    // silently dropped the unknown field (the cast below masked the
    // type error) and `resolveBaseURL` fell through to the hosted
    // default `wss://api.abloatai.com`. Staging surfaced the bug
    // 2026-05-07 — DNS lookup hit the wrong
    // host even though the caller threaded `syncServerUrl` through
    // correctly. Forward as `baseURL` so the caller's URL is the only
    // source of truth and the package default never silently applies.
    const wsUrl = toWsUrl(options.syncServerUrl);
    const agentOptions = {
      baseURL: wsUrl,
      schema: options.schema,
      kind: 'agent',
      capabilityToken: minted.token,
      agentId: agentIdFor(identity),
      organizationId: identity.organizationId,
      syncGroups: [...minted.syncGroups],
      // Agents run in Node — no IDB available, no need for it.
      inMemory: true,
    } as Parameters<typeof Ablo<R>>[0] & { organizationId: string };
    const agent = Ablo<R>(agentOptions);

    try {
      await agent.ready();
    } catch (err) {
      // The WS bootstrap (`agent.ready()`) is the second of two
      // failure modes in `getAgent` — the first is `issueToken` above.
      // Both can stall server-side `agent.run` dispatches, but only
      // the message survives the structured-clone hop into the
      // isolated-vm caller. Capture the URL + identity + `.cause`
      // chain here so staging logs name what was unreachable, then
      // re-throw with the URL embedded so the dispatch wrapper at
      // least surfaces a concrete failure point.
      type WithCauseCode = { cause?: { code?: string; message?: string }; message?: string };
      const e = err as WithCauseCode;
      const code = e.cause?.code;
      const causeMsg = e.cause?.message;
      // Best-effort dispose so the failed agent doesn't leak ws state.
      try { await agent.dispose(); } catch { /* ignore */ }
      // Use console.error directly (rather than the engine logger)
      // because this path may run before the per-agent logger is
      // attached. The structured fields match the cap-mint logger in
      // `connectAgent.ts` so a single search picks both up.
      // eslint-disable-next-line no-console
      console.error('[Agent.session] ws bootstrap failed', {
        url: wsUrl,
        surfaceClass: identity.surfaceClass,
        orgId: identity.organizationId,
        userId: identity.userId,
        code,
        causeMsg,
        err,
      });
      throw new AbloConnectionError(
        `ws bootstrap ${wsUrl} failed: ${e.message ?? 'bootstrap failed'}` +
          (code ? ` (${code})` : ''),
        { code: 'bootstrap_fetch_timeout', cause: err },
      );
    }

    cacheByKey.set(key, { agent, expiresAtMs: minted.expiresAtMs });
    return agent;
  }

  function disposeAll(): void {
    for (const { agent } of cacheByKey.values()) {
      try {
        void agent.dispose();
      } catch {
        /* ignore */
      }
    }
    cacheByKey.clear();
  }

  /**
   * Eject a specific cached agent — useful when the consumer knows
   * the underlying token is invalidated (revocation, role change)
   * and wants the next `getAgent` call to mint fresh.
   */
  function evict(identity: AgentIdentity): void {
    const key = cacheKey(identity);
    const cached = cacheByKey.get(key);
    if (cached) {
      try {
        void cached.agent.dispose();
      } catch {
        /* ignore */
      }
      cacheByKey.delete(key);
    }
  }

  return { getAgent, evict, disposeAll };
}

/** `https://host` → `wss://host`; `http://host` → `ws://host`. */
function toWsUrl(url: string): string {
  return url.replace(/^http/, 'ws');
}
