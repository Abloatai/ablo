/**
 * BootstrapHelper - Fixed to always fetch fresh data
 * Removed problematic caching that was serving stale data
 */

export interface BootstrapData {
  type: 'full' | 'partial';
  lastSyncId: number;
  /**
   * Model rows keyed by typename. Each row is opaque to the SDK at this
   * boundary — the per-model shape is asserted by the consumer (sync
   * engine reduce + IDB write) using the registered schema.
   */
  models?: {
    [typename: string]: unknown[];
  };
  deltas?: ValidatedServerDelta[];
  deltaCount?: number;
  /** Model types whose server-side query failed (timeout, RLS error, etc.) */
  failedModels?: string[];
  timestamp: number;
  /**
   * The server's ACTIVE schema content hash for this tenant (same `schemaHash`
   * the CLI push computes). Present once the tenant has pushed a schema; the
   * client compares it to its own `config.expectedSchemaHash` to warn on drift.
   */
  schemaHash?: string;
}

export interface BootstrapFetchResult {
  notModified: boolean;
  data?: BootstrapData;
  etag?: string | null;
}

export interface BootstrapOptions {
  /**
   * Full base URL of the sync server's HTTP API, **including the `/api`
   * prefix**. The bootstrap endpoint is appended as `/sync/bootstrap`, so
   * the final request hits `${baseUrl}/sync/bootstrap`.
   *
   * Example: `'http://localhost:8080/api'` → `http://localhost:8080/api/sync/bootstrap`
   *
   * Default: `'http://localhost:8080/api'`.
   */
  baseUrl?: string;
  /**
   * Private cache namespace for offline bootstrap fallback. Hosted SDK
   * callers do not pass this; Ablo sets it after auth resolves the
   * account scope.
   */
  cacheScope?: string | null;
  /**
   * @deprecated Use `cacheScope`. Kept so older self-hosted code that
   * still constructs BootstrapHelper directly keeps its cache namespace.
   */
  organizationId?: string;
  syncGroups?: string[];
  maxRetries?: number;
  retryDelay?: number;
  /** Timeout for individual fetch requests in ms (default: 30000) */
  fetchTimeout?: number;
  /**
   * Model names to request in bootstrap. When set, the server only returns
   * these models — everything else is skipped. Derived from the schema's
   * `load` strategy: only models with `load: 'instant'` (or unset, which
   * defaults to instant) are included.
   *
   * When absent, the server returns all models (backward compatible with
   * old clients that don't send a models param).
   */
  instantModels?: string[];
  /**
   * Shared SDK credential getter. Preferred over `setAuthToken`; read at
   * request time so token refreshes apply without recreating BootstrapHelper.
   */
  getAuthToken?: AuthTokenGetter;
}

import { getContext } from '../context.js';
import { SyncSessionError, AbloConnectionError, translateHttpError, toAbloError, isRetryableCode } from '../errors.js';
import { withAuthHeaders, type AuthTokenGetter } from '../auth/credentialSource.js';
// SyncObservability replaced by getContext().observability
import { parseBootstrapResponse, type ValidatedServerDelta } from './schemas.js';

export class BootstrapHelper {
	  private options: Required<Omit<BootstrapOptions, 'baseUrl' | 'instantModels' | 'organizationId' | 'cacheScope' | 'getAuthToken'>> & {
	    baseUrl: string;
	    instantModels?: string[];
	    cacheScope: string | null;
	    organizationId?: string;
	    authToken?: string;
	    getAuthToken?: AuthTokenGetter;
	  };
  private abortController: AbortController | null = null;
  /** Warn about schema drift at most once per helper. */
  private schemaDriftWarned = false;

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * Advisory schema-drift check: compare the server's active schema hash (on the
   * bootstrap response) against the hash this client was built with. A mismatch
   * means the app's schema and the deployed schema have diverged — reads/writes
   * relying on undeployed changes will later fail with an opaque DB constraint
   * error. Warn once, actionably; never throws or blocks the bootstrap.
   */
  private warnOnSchemaDrift(serverHash: string | undefined): void {
    if (this.schemaDriftWarned || !serverHash) return;
    const clientHash = getContext().config.expectedSchemaHash;
    if (!clientHash || clientHash === serverHash) return;
    this.schemaDriftWarned = true;
    // Self-brand the message ("Ablo:") rather than rely on the default logger's
    // `[Ablo]` namespace — consumers wiring their own logger (pino, etc.) lose
    // that prefix, and a drift warning that reads like the app's own log is
    // worse than none. The brand tells them at a glance who is talking.
    getContext().logger.warn(
      `Ablo: Schema drift detected — this app was built against schema ${clientHash}, ` +
        `but the deployed schema is ${serverHash}. Operations that depend on schema ` +
        `changes not yet deployed will fail later with an opaque database error. Run ` +
        `\`ablo push\` to deploy your schema (or update this app to match the deployed one).`,
      { clientSchemaHash: clientHash, serverSchemaHash: serverHash },
    );
  }

  constructor(options: BootstrapOptions) {
    // Defaults are spread first; the explicit `baseUrl` then takes precedence
    // and is computed from `options.baseUrl` (or the localhost fallback).
    //
    // Historical note: a previous version of this constructor placed
    // `baseUrl: \`${baseUrl}/api\`` BEFORE the `...options` spread, which
    // meant the spread silently overwrote it back to the caller's value
    // and the `/api` suffix was dead code. Both Ablo and `createSyncEngine`
    // already pass `${url}/api` explicitly, so removing the suffix here
    // preserves the actual on-the-wire behavior while making the contract
    // explicit: callers pass the full base URL including `/api`.
    this.options = {
      syncGroups: [],
      maxRetries: 3,
      retryDelay: 1000,
      fetchTimeout: 10_000, // 10 second timeout per request - fail fast for good UX
      ...options,
      baseUrl: options.baseUrl || 'http://localhost:8080/api',
      cacheScope: options.cacheScope ?? options.organizationId ?? null,
    };

    // Do not clear cache here; keep offline fallback available
  }

  /**
   * Update the offline-cache namespace once auth has resolved the server-side
   * account scope. This is intentionally not a public organizationId input.
   */
  setCacheScope(cacheScope: string): void {
    if (cacheScope.trim().length === 0) return;
    this.options.cacheScope = cacheScope;
  }

	  setSyncGroups(syncGroups: readonly string[] | undefined): void {
	    this.options.syncGroups = [...(syncGroups ?? [])];
	  }

	  /**
	   * Compatibility setter for direct BootstrapHelper users. The SDK-owned
	   * `Ablo()` path passes `getAuthToken` and does not mutate this helper.
	   */
	  setAuthToken(authToken: string | undefined): void {
	    if (!authToken) {
	      delete this.options.authToken;
	      return;
	    }
	    this.options.authToken = authToken;
	  }

  /**
   * Create a promise that rejects after a timeout
   * Used to race against fetch requests that may hang indefinitely
   */
  private createTimeoutPromise<T>(ms: number, operation: string): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new AbloConnectionError(`Bootstrap ${operation} timed out after ${ms}ms`, {
            code: 'bootstrap_fetch_timeout',
          }),
        );
      }, ms);
    });
  }

  /**
   * Wrap a promise with a timeout - if the promise doesn't resolve within
   * the timeout period, the AbortController is triggered and an error is thrown
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    return Promise.race([promise, this.createTimeoutPromise<T>(timeoutMs, operation)]);
  }

  /**
   * Fetch bootstrap data from sync engine with partial bootstrap support
   * @param lastSyncId - Optional: client's current lastSyncId for partial bootstrap
   * @returns Bootstrap data (either full snapshot or delta batch)
   */
  async fetchBootstrap(
    lastSyncId?: number,
    /**
     * Per-call sync-group override for SCOPED hydrate-on-enter. When provided,
     * the request uses THESE groups instead of `this.options.syncGroups`,
     * WITHOUT mutating the shared options (so a concurrent full bootstrap is
     * unaffected). Also bypasses the offline full-snapshot cache below, which
     * holds the connection's full bootstrap and would be wrong for a subset.
     */
    syncGroupsOverride?: readonly string[],
  ): Promise<BootstrapData> {
    // organizationId omitted — server reads it from auth identity.
    // See `fetchBootstrapWithETag` for the full rationale.
    const params = new URLSearchParams();

    // Add lastSyncId for partial bootstrap support
    if (lastSyncId !== undefined && lastSyncId > 0) {
      params.append('lastSyncId', lastSyncId.toString());
    }

    // Add sync groups (per-call override wins over the configured set).
    (syncGroupsOverride ?? this.options.syncGroups).forEach((group) => {
      params.append('syncGroups', group);
    });

    // Selective bootstrap: only request instant-strategy models.
    // When present, the server skips all other models → smaller payload.
    // When absent, server returns all models (backward compat).
    if (this.options.instantModels && this.options.instantModels.length > 0) {
      params.append('models', this.options.instantModels.join(','));
    }

    const url = `${this.options.baseUrl}/sync/bootstrap?${params.toString()}`;

    // If offline, try cached bootstrap. Skipped for a scoped override — the
    // cache holds the FULL snapshot, which is not a valid answer to a subset
    // request; a scoped hydrate just soft-fails offline and retries on re-enter.
    if (!syncGroupsOverride && typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      const cached = this.options.cacheScope
        ? this.loadCachedBootstrap(this.options.cacheScope)
        : null;
      if (cached) {
        getContext().logger.info('Using cached bootstrap (offline)');
        return cached;
      }
      throw new AbloConnectionError('Offline and no cached bootstrap available', {
        code: 'bootstrap_offline_no_cache',
      });
    }

    getContext().logger.info('Fetching fresh bootstrap data', { url });

    // Fetch with retries
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const data = await this.performFetch(url);

        getContext().logger.info('Bootstrap data fetched', {
          type: data.type,
          lastSyncId: data.lastSyncId,
          modelCount: data.models ? Object.keys(data.models).length : 0,
          deltaCount: data.deltaCount || 0,
          totalItems: data.models
            ? Object.values(data.models).reduce(
                (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
                0
              )
            : 0,
        });

        // Persist for offline fallback
        if (this.options.cacheScope) {
          this.saveCachedBootstrap(this.options.cacheScope, data);
        }
        return data;
      } catch (error) {
        // SessionError should NOT be retried - the session is invalid and needs re-authentication
        // Also do NOT fallback to cache - the user must sign in again
        if (SyncSessionError.isSessionError(error)) {
          getContext().observability.breadcrumb(
            'Bootstrap session error - redirecting to sign-in',
            'sync.bootstrap',
            'warning',
            {
              statusCode: (error as SyncSessionError).statusCode,
            }
          );
          throw error;
        }

        // Don't retry NON-retryable errors. A 401/403/4xx auth or client error
        // (api_key_required, jwt_issuer_untrusted, …) will NOT succeed by
        // repeating the same request with the same credential — retrying just
        // hammers the server and floods the console with doomed requests. Only
        // transient failures (5xx, 429, timeouts, network blips, or an
        // unclassified error with no code) flow through to the retry/backoff.
        const ablo = toAbloError(error);
        if (ablo.code && !isRetryableCode(ablo.code)) {
          getContext().observability.breadcrumb(
            'Bootstrap non-retryable error — failing fast',
            'sync.bootstrap',
            'warning',
            { code: ablo.code, httpStatus: ablo.httpStatus },
          );
          throw ablo;
        }

        lastError = error as Error;
        getContext().observability.breadcrumb('Bootstrap fetch failed', 'sync.bootstrap', 'warning', {
          attempt: attempt + 1,
        });

        if (attempt < this.options.maxRetries - 1) {
          await this.delay(this.options.retryDelay * Math.pow(2, attempt));
        }
      }
    }

    // On error, attempt cached fallback (but NOT for session errors - already handled above)
    const cached = this.options.cacheScope
      ? this.loadCachedBootstrap(this.options.cacheScope)
      : null;
    if (cached) {
      getContext().observability.breadcrumb('Bootstrap cache fallback', 'sync.bootstrap', 'warning', {
        error: lastError?.message,
      });
      return cached;
    }
    throw lastError
      ? toAbloError(lastError)
      : new AbloConnectionError('Failed to fetch bootstrap data', {
          code: 'bootstrap_fetch_timeout',
        });
  }

  /**
   * Fetch bootstrap with ETag, returning 304 hints
   */
  async fetchBootstrapWithETag(): Promise<BootstrapFetchResult> {
    // organizationId is intentionally NOT sent. Server resolves it from
    // the authenticated identity (`c.var.identity.organizationId`) —
    // see `apps/sync-server/src/routes/bootstrap.ts`. Sending it
    // client-side was historical: it predated the auth-context pipeline
    // and forced a cross-org guard to defend against the SDK lying.
    const params = new URLSearchParams();
    this.options.syncGroups.forEach((g) => params.append('syncGroups', g));
    if (this.options.instantModels && this.options.instantModels.length > 0) {
      params.append('models', this.options.instantModels.join(','));
    }
    const url = `${this.options.baseUrl}/sync/bootstrap?${params.toString()}`;

    // Note: ETag caching is deliberately app-side, not SDK-side. The server
    // still returns an ETag on responses, which is captured below and
    // forwarded to callers via BootstrapFetchResult.etag — apps that want
    // conditional revalidation (If-None-Match) implement it at their own
    // level where they own the cache-key namespace. The 304 branch below
    // remains defensively in place for when a caller enables revalidation.
	    const headers = withAuthHeaders(
	      this.options.getAuthToken,
	      { 'Content-Type': 'application/json' },
	      this.options.authToken,
	    );

    this.abortController = new AbortController();
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: this.abortController.signal,
    });

    const etag = res.headers.get('ETag');

    if (res.status === 304) {
      // Log for telemetry
      getContext().logger.info('[Bootstrap] 304 Not Modified - using cached data');
      return { notModified: true, etag };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let parsed: unknown = bodyText;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      // Translate the canonical envelope FIRST so the server's specific code +
      // message survive (e.g. `api_key_required`, `jwt_issuer_untrusted`).
      const translated = translateHttpError(
        res.status,
        parsed || `Bootstrap fetch failed: ${res.status} ${res.statusText}`,
        res.headers.get('x-request-id') ?? undefined,
      );
      // Only a genuine session/JWT EXPIRY — or a bare auth failure carrying no
      // structured code — should drive the sign-in redirect. A specific auth
      // code like `api_key_required` is NOT an expired session: re-logging-in
      // mints the same credential and loops. Surface it as its real typed error
      // instead of a `session_expired` wrapping the stringified body.
      if (
        translated.code === 'session_expired' ||
        translated.code === 'jwt_expired' ||
        ((res.status === 401 || res.status === 403) &&
          translated.code === undefined)
      ) {
        throw new SyncSessionError(translated.message, res.status);
      }
      throw translated;
    }

    const rawJson = await res.json();
    const data: BootstrapData = parseBootstrapResponse(rawJson);
    this.warnOnSchemaDrift(data.schemaHash);

    // Persist payload for offline
    try {
      if (this.options.cacheScope) {
        this.saveCachedBootstrap(this.options.cacheScope, data);
      }
    } catch {}
    getContext().logger.info('[Bootstrap] 200 OK - received new data');
    return { notModified: false, data, etag };
  }

  /**
   * Perform the actual fetch request with timeout protection
   */
  private async performFetch(url: string): Promise<BootstrapData> {
    // Cancel any previous in-flight request
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const timeoutId = setTimeout(() => {
      getContext().observability.breadcrumb('Bootstrap fetch timeout', 'sync.bootstrap', 'warning', {
        timeoutMs: this.options.fetchTimeout,
      });
      this.abortController?.abort();
    }, this.options.fetchTimeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
	        headers: withAuthHeaders(this.options.getAuthToken, {
	          'Content-Type': 'application/json',
	          'Cache-Control': 'no-cache, no-store, must-revalidate',
	          Pragma: 'no-cache',
	        }, this.options.authToken),
        signal: this.abortController.signal,
        cache: 'no-store', // Force browser to not cache
      });
    } catch (error) {
      clearTimeout(timeoutId);
      // Convert abort to timeout error for better error messaging
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AbloConnectionError(
          `Bootstrap fetch timed out after ${this.options.fetchTimeout}ms`,
          { code: 'bootstrap_fetch_timeout', cause: error },
        );
      }
      throw error;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let parsed: unknown = bodyText;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      // Same code-aware handling as the primary bootstrap fetch: preserve the
      // server's specific code/message; only a genuine expiry (or a bare,
      // code-less auth failure) drives the sign-in redirect.
      const translated = translateHttpError(
        response.status,
        parsed || `Bootstrap fetch failed: ${response.status} ${response.statusText}`,
        response.headers.get('x-request-id') ?? undefined,
      );
      if (
        translated.code === 'session_expired' ||
        translated.code === 'jwt_expired' ||
        ((response.status === 401 || response.status === 403) &&
          translated.code === undefined)
      ) {
        throw new SyncSessionError(translated.message, response.status);
      }
      throw translated;
    }

    const rawJson = await response.json();
    const data = parseBootstrapResponse(rawJson);
    this.warnOnSchemaDrift(data.schemaHash);

    // Save a copy for offline
    try {
      if (this.options.cacheScope) {
        this.saveCachedBootstrap(this.options.cacheScope, data);
      }
    } catch {}
    return data;
  }

  /**
   * Fetch a single entity by ID (on-demand self-healing).
   * Returns `null` for 404 (entity deleted) — this is an expected state, not an error.
   * Throws for unexpected HTTP errors (5xx, network failures).
   */
  async fetchEntity(modelName: string, id: string): Promise<Record<string, unknown> | null> {
    const url = `${this.options.baseUrl}/sync/entity/${modelName}/${id}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: withAuthHeaders(this.options.getAuthToken, {
        'Content-Type': 'application/json',
      }, this.options.authToken),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let parsed: unknown = bodyText;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      throw translateHttpError(
        response.status,
        parsed || `Entity fetch failed: ${response.status} ${response.statusText}`,
        response.headers.get('x-request-id') ?? undefined,
      );
    }

    return await response.json();
  }

  // ─────────────────────────────────────────────────────────────────────
  /**
   * Clear all cached bootstrap data
   */
  clearCache(): void {
    if (typeof window === 'undefined') return;

    try {
      // Clear all bootstrap cache keys
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('sync-bootstrap')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => {
        localStorage.removeItem(key);
        getContext().logger.debug('Cleared cache key', { key });
      });
    } catch (error) {
      getContext().logger.debug('Failed to clear cache', { error });
    }
  }

  // Cache helpers for offline bootstrap
  private getBootstrapCacheKey(orgId: string): string {
    return `ablo:bootstrap:${orgId}`;
  }
  private saveCachedBootstrap(orgId: string, data: BootstrapData): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(this.getBootstrapCacheKey(orgId), JSON.stringify(data));
    } catch (e) {
      getContext().logger.debug('Failed to cache bootstrap payload', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  private loadCachedBootstrap(orgId: string): BootstrapData | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.getBootstrapCacheKey(orgId));
      if (!raw) return null;
      return JSON.parse(raw) as BootstrapData;
    } catch {
      return null;
    }
  }

  /**
   * Abort ongoing fetch request
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get health status of sync engine
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });

      if (!response.ok) return false;

      const data = await response.json();
      return data.status === 'healthy';
    } catch (error) {
      getContext().observability.breadcrumb('Health check failed', 'sync.bootstrap', 'warning');
      return false;
    }
  }
}
