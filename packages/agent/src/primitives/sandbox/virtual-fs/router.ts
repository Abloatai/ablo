/**
 * VirtualFs — routes Sandbox filesystem ops to the right backend.
 *
 * Composition pattern (see DefaultSandbox in ../default.ts):
 *
 *   const fs = new VirtualFs([
 *     new StaticBundleBackend({ ... }),     // /api, /examples, /skills
 *     new StateProjectionBackend({ ... }),   // /state
 *     new ScratchBackend(),                  // /scratch
 *   ]);
 *
 * The Sandbox class delegates fs methods to this router. Each method
 * looks up the backend by path prefix and forwards.
 *
 * For glob and grep with no `path` option, the router fans out to all
 * backends in parallel and merges the results — the agent searches the
 * whole virtual fs at once, like ripgrep across a project.
 */

import {
  SandboxNotFoundError,
  type Dirent,
  type GrepMatch,
  type SandboxStats,
} from '../interface';
import {
  UnsupportedOperationError,
  type VirtualFsBackend,
} from './types';

export class VirtualFs {
  constructor(private readonly backends: readonly VirtualFsBackend[]) {
    if (backends.length === 0) {
      throw new Error('VirtualFs requires at least one backend.');
    }
  }

  // ── Path-routed operations ───────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const backend = this.findBackend(path);
    if (!backend.readFile) {
      throw new UnsupportedOperationError(backend.name, 'readFile', path);
    }
    return backend.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const backend = this.findBackend(path);
    if (!backend.writeFile) {
      throw new UnsupportedOperationError(backend.name, 'writeFile', path);
    }
    return backend.writeFile(path, content);
  }

  async edit(path: string, oldStr: string, newStr: string): Promise<void> {
    const backend = this.findBackend(path);
    if (!backend.edit) {
      throw new UnsupportedOperationError(backend.name, 'edit', path);
    }
    return backend.edit(path, oldStr, newStr);
  }

  async stat(path: string): Promise<SandboxStats> {
    const backend = this.findBackend(path);
    if (!backend.stat) {
      throw new UnsupportedOperationError(backend.name, 'stat', path);
    }
    return backend.stat(path);
  }

  async readdir(path: string): Promise<Dirent[]> {
    const backend = this.findBackend(path);
    if (!backend.readdir) {
      throw new UnsupportedOperationError(backend.name, 'readdir', path);
    }
    return backend.readdir(path);
  }

  async access(path: string): Promise<void> {
    const backend = this.findBackend(path);
    if (backend.access) return backend.access(path);
    // Fallback: try stat — if it doesn't throw, the path exists.
    if (backend.stat) {
      await backend.stat(path);
      return;
    }
    throw new UnsupportedOperationError(backend.name, 'access', path);
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const backend = this.findBackend(path);
    // mkdir defaults to a no-op for backends that don't implement it —
    // paths are flat keys in our virtual fs, no real directories to create.
    if (backend.mkdir) return backend.mkdir(path, options);
  }

  // ── Multi-backend operations (glob, grep) ────────────────────────────

  async glob(pattern: string): Promise<string[]> {
    const candidates = this.backendsThatMightMatch(pattern);
    const results = await Promise.all(
      candidates
        .filter((b) => b.glob)
        .map((b) =>
          b.glob!(pattern).catch((err: unknown) => {
            // One failing backend should not crash the whole glob
            console.warn(
              `[virtual-fs] glob on backend "${b.name}" failed:`,
              err,
            );
            return [] as string[];
          }),
        ),
    );
    return results.flat();
  }

  async grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]> {
    // If a path is provided, route to the matching backend
    if (options?.path) {
      const backend = this.findBackend(options.path);
      if (!backend.grep) {
        throw new UnsupportedOperationError(backend.name, 'grep', options.path);
      }
      return backend.grep(pattern, options);
    }

    // No path → fan out to every backend
    const results = await Promise.all(
      this.backends
        .filter((b) => b.grep)
        .map((b) =>
          b.grep!(pattern, options).catch((err: unknown) => {
            console.warn(
              `[virtual-fs] grep on backend "${b.name}" failed:`,
              err,
            );
            return [] as GrepMatch[];
          }),
        ),
    );
    return results.flat();
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private findBackend(path: string): VirtualFsBackend {
    const backend = this.backends.find((b) => b.matches(path));
    if (!backend) {
      // Surface "no backend" as "not found" — never reveal which prefixes
      // the agent doesn't have access to. Permission denied indistinguishable
      // from missing path is the correct security posture (same as how Unix
      // hides files agents can't read by returning ENOENT-style errors).
      throw new SandboxNotFoundError(path);
    }
    return backend;
  }

  /**
   * Backends whose prefix could match a glob pattern. Conservative —
   * if we can't tell, include it. The backend's own glob handles
   * non-matching paths.
   */
  private backendsThatMightMatch(pattern: string): VirtualFsBackend[] {
    // Strip everything after the first wildcard to get the static prefix
    const wildcardIdx = pattern.search(/[*?[]/);
    const staticPrefix =
      wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);

    return this.backends.filter((b) => {
      // If the backend's prefix is contained in or contains the static prefix,
      // it's a candidate.
      return (
        staticPrefix.startsWith(b.prefix) ||
        b.prefix.startsWith(staticPrefix)
      );
    });
  }
}

// Re-export errors for convenience — callers catching errors from the router
// often want to discriminate on these.
export {
  UnsupportedOperationError,
  SandboxNotFoundError,
};
