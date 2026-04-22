/**
 * PostBootstrapRegistry
 *
 * Singleton registry for hooks that run after ObjectPool hydration
 * but before `dataReady = true`. This allows data prefetching to
 * complete during the skeleton phase, preventing jank during the
 * entry animation.
 *
 * Hooks are fire-and-forget: failures are logged as warnings and
 * never block the bootstrap flow.
 */

import { Model } from './Model';
import type { ObjectPool } from './ObjectPool';
import type { Database } from './Database';
import type { BootstrapHelper } from './sync/BootstrapHelper';
import { getContext } from './context';

/** Constructor type for Model subclasses (matches SyncedStore's type) */
type ModelConstructor<T extends Model> = abstract new (...args: never[]) => T;

/**
 * Context passed to every post-bootstrap hook.
 *
 * Exposes the raw infrastructure pieces (`pool`, `db`, `orgId`) so hooks
 * can call any data-loader or query helper they need — plus a single
 * typed `allModelsOfType` convenience that hooks commonly use to
 * enumerate hydrated models.
 *
 * This is structurally a superset of the `{ pool, db, orgId }` shape
 * accepted by the app-side pure loader functions (`ensureVaultFiles`,
 * `prefetchSlideLayers`, `ensureDataroomFiles`, etc.), so hooks can
 * pass `ctx` directly to them without adapter code.
 */
export interface PostBootstrapContext {
  pool: ObjectPool;
  db: Database;
  orgId: string | undefined;
  /** Pre-configured query helper for lazy-loading data from the sync server. */
  helper: BootstrapHelper;
  allModelsOfType(modelClass: ModelConstructor<Model>): Model[];
}

/**
 * @deprecated Use `PostBootstrapContext`. Kept as an alias for one release
 * so existing external consumers don't break on the rename.
 */
export type PostBootstrapStoreAPI = PostBootstrapContext;

/** Signature for a post-bootstrap hook function */
export type PostBootstrapHook = (ctx: PostBootstrapContext) => Promise<void>;

class PostBootstrapRegistryImpl {
  private _hooks = new Map<string, PostBootstrapHook>();
  private _executed = false;

  /** Register a named hook. Duplicates (by name) are silently ignored. */
  register(name: string, hook: PostBootstrapHook): void {
    if (this._hooks.has(name)) return;
    this._hooks.set(name, hook);
  }

  /**
   * Execute all registered hooks in parallel.
   * Wraps the batch in a timeout to guarantee forward progress.
   * Idempotent — subsequent calls are no-ops until `reset()`.
   */
  async executeAll(ctx: PostBootstrapContext, timeoutMs = 5000): Promise<void> {
    if (this._executed || this._hooks.size === 0) return;
    this._executed = true;

    const entries = Array.from(this._hooks.entries());
    const hookPromises = entries.map(async ([name, hook]) => {
      try {
        await hook(ctx);
        getContext().logger.debug(`[PostBootstrap] Hook "${name}" completed`);
      } catch (err) {
        getContext().logger.warn(`[PostBootstrap] Hook "${name}" failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        getContext().logger.warn(`[PostBootstrap] Timed out after ${timeoutMs}ms — proceeding`);
        resolve();
      }, timeoutMs);
    });

    await Promise.race([Promise.allSettled(hookPromises), timeout]);
  }

  /** Reset the executed flag. Called on store reset / abort. */
  reset(): void {
    this._executed = false;
  }
}

/** Singleton instance */
export const postBootstrapRegistry = new PostBootstrapRegistryImpl();
