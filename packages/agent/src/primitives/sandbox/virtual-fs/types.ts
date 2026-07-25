/**
 * Virtual filesystem backend contract.
 *
 * Each backend owns a set of paths (e.g., `/api/**`, `/state/**`,
 * `/scratch/**`) and implements the subset of filesystem operations
 * that make sense for that backend. The router (see ./router.ts)
 * dispatches Sandbox method calls to the matching backend.
 *
 * Methods are optional — a backend declares what it supports. Calling
 * an unsupported method throws `UnsupportedOperationError` from the
 * router, which surfaces as a tool error to the agent.
 */

import type {
  Dirent,
  GrepMatch,
  SandboxStats,
} from '../interface';

/**
 * One backend in the virtual filesystem.
 *
 * Implementations live in this directory:
 * - `static-bundle.ts` — `/api`, `/examples`, `/skills` (read-only static)
 * - `state-projection.ts` — `/state` (read-only, derived from entity state)
 * - `scratch.ts` — `/scratch` (in-memory writable, ephemeral)
 */
export interface VirtualFsBackend {
  /** Identifier used in error messages and logs. */
  readonly name: string;

  /**
   * Path prefix this backend handles, e.g. `/api`.
   * The router uses this for prefix-based routing.
   */
  readonly prefix: string;

  /**
   * Whether this backend handles the given absolute path.
   * Default semantics: `path === prefix || path.startsWith(prefix + '/')`.
   */
  matches(path: string): boolean;

  // ── Filesystem operations ────────────────────────────────────────────
  // Backends declare what they support. Missing methods throw at the router.

  readFile?(path: string): Promise<string>;
  writeFile?(path: string, content: string): Promise<void>;
  edit?(path: string, oldStr: string, newStr: string): Promise<void>;
  stat?(path: string): Promise<SandboxStats>;
  /** Existence check. Throws SandboxNotFoundError if path doesn't exist. */
  access?(path: string): Promise<void>;
  /**
   * Create a directory. For virtual backends with no real directory concept,
   * this is typically a no-op that succeeds (paths are flat keys).
   */
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir?(path: string): Promise<Dirent[]>;

  /**
   * Glob matching scoped to this backend's paths. The router calls this
   * on EVERY backend (whose prefix could match the pattern) and merges
   * the results. Backends without `glob` are skipped.
   */
  glob?(pattern: string): Promise<string[]>;

  /**
   * Grep within this backend's paths. The router calls this on every
   * backend (or just the one whose prefix matches `options.path`) and
   * merges results. Backends without `grep` are skipped.
   */
  grep?(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]>;
}

/** Thrown when the matching backend does not support the requested operation. */
export class UnsupportedOperationError extends Error {
  constructor(backendName: string, operation: string, path: string) {
    super(
      `Backend "${backendName}" does not support ${operation}() on "${path}".`,
    );
    this.name = 'UnsupportedOperationError';
  }
}
