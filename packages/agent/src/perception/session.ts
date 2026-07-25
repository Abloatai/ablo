/**
 * Caches and manages the lifecycle of headless agent clients on a server.
 *
 * Server code that runs AI agents typically needs the same four things, and this
 * module handles all of them:
 *   1. Reuse one authenticated client per (organization, user, surface, target)
 *      instead of constructing one on every request.
 *   2. Re-issue the agent's capability token before it expires.
 *   3. Keep authorization on the credential rather than a client-side scope.
 *   4. Initialize and dispose cleanly.
 *
 * Everything except obtaining the token is the same for every caller and lives
 * here. Obtaining the token depends on how you authenticate — cookie forwarding,
 * API-key exchange, OAuth, and so on — so you supply that step through the
 * {@link AgentSessionOptions.issueToken} callback. The module itself depends on
 * nothing outside this package.
 */

import {
  Ablo,
  AbloConnectionError,
  type AbloHttpClient,
} from '@ablo/transaction';
import type { Schema, SchemaRecord } from '@ablo/transaction/schema';
import { createConsoleLogger, resolveLogLevel } from './consoleLogger.js';

// These shapes describe what the issueToken callback receives and returns. They
// are not exported because you never name them directly — you write a callback
// with the right shape and the type-checker verifies it.

interface IssuedToken {
  readonly token: string;
  readonly expiresAtMs: number;
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
  /** HTTP base URL of the transaction API. */
  readonly transactionApiUrl: string;
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
}

interface CachedAgent<R extends SchemaRecord = SchemaRecord> {
  agent: AbloHttpClient<R>;
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
  const logger = createConsoleLogger(resolveLogLevel());
  const cacheByKey = new Map<string, CachedAgent<R>>();

  function cacheKey(id: AgentIdentity): string {
    const targetSeg = id.target
      ? `:${id.target.entityType}:${id.target.entityId}`
      : '';
    return `${id.organizationId}:${id.userId}:${id.surfaceClass}${targetSeg}`;
  }

  async function getAgent(identity: AgentIdentity): Promise<AbloHttpClient<R>> {
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

    const baseURL = options.transactionApiUrl;
    const agent = Ablo<R>({
      baseURL,
      schema: options.schema,
      apiKey: minted.token,
      transport: 'http',
    });

    try {
      await agent.ready();
    } catch (err) {
      // `agent.ready` validates the credential, and it is the second place
      // getAgent can fail (the first is issueToken above). Because a thrown
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
      logger.error(`Agent could not connect to the transaction API at ${baseURL}${code ? ` (${code})` : ''}.`);
      logger.debug('[Agent.session] HTTP initialization failed', {
        url: baseURL,
        surfaceClass: identity.surfaceClass,
        orgId: identity.organizationId,
        userId: identity.userId,
        code,
        causeMsg,
        err,
      });
      throw new AbloConnectionError(
        `transaction API initialization ${baseURL} failed: ${e.message ?? 'initialization failed'}` +
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
