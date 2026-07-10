/**
 * Caches and manages the lifecycle of long-lived agent connections on a server.
 *
 * Server code that runs AI agents typically needs the same four things, and this
 * module handles all of them:
 *   1. Reuse one connected agent per (organization, user, surface, target)
 *      instead of connecting anew on every request.
 *   2. Re-issue the agent's capability token before it expires.
 *   3. Request exactly the sync groups the token allows, so the two lists
 *      overlap. If they don't, the agent subscribes to nothing and every
 *      broadcast is silently filtered out.
 *   4. Connect, disconnect, and dispose cleanly.
 *
 * Everything except obtaining the token is the same for every caller and lives
 * here. Obtaining the token depends on how you authenticate — cookie forwarding,
 * API-key exchange, OAuth, and so on — so you supply that step through the
 * {@link AgentSessionOptions.issueToken} callback. The module itself depends on
 * nothing outside this package.
 */

import { Ablo } from '../client/Ablo.js';
import { AbloConnectionError } from '../errors.js';
import { getContext } from '../context.js';
import type { Schema, SchemaRecord } from '../schema/schema.js';

// These shapes describe what the issueToken callback receives and returns. They
// are not exported because you never name them directly — you write a callback
// with the right shape and the type-checker verifies it.

interface IssuedToken {
  readonly token: string;
  readonly expiresAtMs: number;
  /**
   * The sync groups this token grants access to. It must include every group the
   * agent needs to subscribe to. The agent's effective subscription is the
   * overlap between the groups it requests and the groups listed here, so a list
   * that omits a needed group leaves the agent subscribed to nothing and silently
   * receiving no broadcasts.
   */
  readonly syncGroups: readonly string[];
}

interface AgentIdentity {
  readonly userId: string;
  readonly organizationId: string;
  /**
   * The kind of surface making the request, such as `'chat'`, `'mcp'`, or
   * `'agent_worker'`. The cache keys on this value, so two surfaces never share a
   * token or a WebSocket connection.
   */
  readonly surfaceClass: string;
  readonly target?: { readonly entityType: string; readonly entityId: string } | null;
}

export interface AgentSessionOptions<R extends SchemaRecord = SchemaRecord> {
  /** WebSocket URL of your sync server, such as `wss://sync.example.com` or `ws://localhost:3001`. */
  readonly syncServerUrl: string;
  /**
   * Your schema, used to build the typed model proxy on the returned client. The
   * agent client exposes it as `agent.<model>.create/update/delete`.
   */
  readonly schema: Schema<R>;
  /**
   * Issues a capability token for the given identity. The session calls it on a
   * cache miss or when the current token is near expiry. Because this callback
   * carries out your authentication flow — cookie forwarding, API-key exchange,
   * OAuth, and so on — the rest of the session stays independent of how you
   * authenticate.
   */
  readonly issueToken: (identity: AgentIdentity) => Promise<IssuedToken>;
  /**
   * How long before a token's true expiry the session should re-issue it, in
   * milliseconds. Defaults to 30 seconds. The buffer absorbs clock skew so a
   * token never expires mid-use.
   */
  readonly reissueBufferMs?: number;
  /**
   * How to derive the agent's identifier from the request identity. Defaults to
   * `${surfaceClass}:${userId}`. Override it when you want a different shape for
   * attribution.
   */
  readonly agentIdFor?: (identity: AgentIdentity) => string;
}

interface CachedAgent<R extends SchemaRecord = SchemaRecord> {
  agent: Ablo<R>;
  expiresAtMs: number;
}

/**
 * Creates a session that hands out connected agents on demand. Its `getAgent`
 * method handles caching, token issuance, sync-group alignment, and connection
 * lifecycle; call `disposeAll` from your process's shutdown hook to close every
 * open connection.
 *
 * Treat the session as a long-lived singleton shared across requests. The cache
 * key combines organization, user, surface, and target, so two concurrent
 * requests for the same combination share one agent and one WebSocket, while
 * requests for different combinations get independent agents.
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

    // Request the same sync groups the token grants. The groups requested here
    // and the groups the token allows must overlap; otherwise their intersection
    // is empty and every broadcast is filtered out. The token's allowed list is
    // exactly what to request, since the caller decided what went into it.
    //
    // Pass the URL as `baseURL`, the field the client reads. Any other field name
    // is ignored, in which case the client would fall back to its default host,
    // so `baseURL` keeps the caller's URL the single source of truth.
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
      // `agent.ready` establishes the WebSocket connection, and it is the second
      // place getAgent can fail (the first is issueToken above). Because a thrown
      // error may cross a boundary that preserves only its message, capture the
      // URL, identity, and cause chain in the logs here, then re-throw with the
      // URL embedded so the failure names a concrete host.
      interface WithCauseCode { cause?: { code?: string; message?: string }; message?: string }
      const e = err as WithCauseCode;
      const code = e.cause?.code;
      const causeMsg = e.cause?.message;
      // Best-effort dispose so the failed agent doesn't leak ws state.
      try { await agent.dispose(); } catch { /* ignore */ }
      // Log through the level-gated logger so it honors ABLO_LOG_LEVEL: an
      // `error` headline naming the unreachable URL and code, plus a `debug`
      // companion carrying the structured fields for deeper diagnosis.
      const log = getContext().logger;
      log.error(`Agent could not connect to the sync server at ${wsUrl}${code ? ` (${code})` : ''}.`);
      log.debug('[Agent.session] ws bootstrap failed', {
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
   * Removes and disposes one cached agent. Call it when you know the agent's
   * token is no longer valid — after a revocation or role change, for example —
   * so the next `getAgent` call issues a fresh one.
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
