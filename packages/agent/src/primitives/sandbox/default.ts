/**
 * DefaultSandbox — composes VirtualFs + isolated-vm into one Sandbox.
 *
 * This is the default implementation of the {@link Sandbox} interface.
 * Filesystem methods delegate to a {@link VirtualFs} (which routes to
 * backends by path prefix); `execute()` reads the entrypoint from the
 * virtual filesystem and runs it in an isolated V8 isolate using
 * {@link runInIsolatedVM}.
 *
 * ```ts
 * const sandbox = await DefaultSandbox.create({
 *   backends: [
 *     new StaticBundleBackend({ prefix: '/api', files: apiBundle }),
 *     new StateProjectionBackend({ provider, models: ['slides', 'sheets'] }),
 *     new ScratchBackend(),
 *   ],
 *   api: {
 *     layer: { create: createLayer, update: updateLayer },
 *     deck: { createSlide },
 *   },
 *   environmentDetails: 'isolated-vm: 128MB heap, 30s execution',
 * });
 *
 * await sandbox.writeFile('/scratch/main.ts', userCode);
 * const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
 * await sandbox.stop();
 * ```
 *
 * Use the static {@link DefaultSandbox.create} factory rather than `new`
 * directly when you need `afterStart` lifecycle hooks to fire.
 */

import {
  type Sandbox,
  type SandboxType,
  type SandboxHooks,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxStats,
  type Dirent,
  type GrepMatch,
} from './interface';
import { VirtualFs } from './virtual-fs';
import type { VirtualFsBackend } from './virtual-fs';
import { runInIsolatedVM } from './isolated-vm';

export interface DefaultSandboxOptions {
  /** Filesystem backends. Order matters only for paths matching multiple. */
  backends: readonly VirtualFsBackend[];

  /**
   * Bound API exposed inside the isolate. Functions in this object become
   * callable from sandbox code. Nested namespaces (e.g. `layer.create`,
   * `deck.createSlide`) are flattened by the executor's bootstrap.
   *
   * Plain data values (numbers, strings, JSON-serializable objects) are
   * also injected — list their keys in `dataKeys` to control what becomes
   * a global vs a method.
   */
  api: Record<string, unknown>;

  /**
   * Keys in `api` that hold plain data (not method namespaces). Listed
   * keys become `var <key> = ...` globals inside the isolate. Defaults
   * to `[]`. Use this for state/context blobs the agent's code reads.
   */
  dataKeys?: string[];

  /**
   * Method namespaces to skip when auto-registering — e.g. namespaces
   * with non-callable members or that are handled separately. Defaults to `[]`.
   */
  skipMethodKeys?: string[];

  /**
   * Backend identifier used in `Sandbox.type` and tool error messages.
   * Defaults to `'isolated-vm'`.
   */
  type?: SandboxType;

  /** Human-readable description for system prompts. */
  environmentDetails?: string;

  /** Lifecycle hooks. */
  hooks?: SandboxHooks;

  /** Default per-execution memory limit in MB. Default 128. */
  defaultMemoryLimitMb?: number;

  /** Default per-execution timeout in ms. Default 30_000. */
  defaultTimeoutMs?: number;

  /** Proactive sandbox-level timeout in ms — sets `expiresAt`. Default unset. */
  proactiveTimeoutMs?: number;

  /**
   * Working directory the agent operates from — relative paths in tool
   * args resolve against this. Defaults to `/scratch`.
   */
  workingDirectory?: string;
}

export class DefaultSandbox implements Sandbox {
  readonly type: SandboxType;
  readonly workingDirectory: string;
  readonly environmentDetails?: string;
  readonly hooks?: SandboxHooks;
  readonly timeout?: number;
  readonly expiresAt?: number;

  private readonly fs: VirtualFs;
  private readonly api: Record<string, unknown>;
  private readonly dataKeys: string[];
  private readonly skipMethodKeys: string[];
  private readonly defaultMemoryLimitMb: number;
  private readonly defaultTimeoutMs: number;
  private stopped = false;

  /**
   * Construct a sandbox. **Prefer {@link DefaultSandbox.create}** when you
   * have an `afterStart` hook — the factory awaits it before returning.
   * Direct `new` is fine when you don't need async setup.
   */
  constructor(options: DefaultSandboxOptions) {
    this.type = options.type ?? 'isolated-vm';
    this.workingDirectory = options.workingDirectory ?? '/scratch';
    this.environmentDetails = options.environmentDetails;
    this.hooks = options.hooks;
    this.timeout = options.proactiveTimeoutMs;
    if (options.proactiveTimeoutMs) {
      this.expiresAt = Date.now() + options.proactiveTimeoutMs;
    }
    this.fs = new VirtualFs(options.backends);
    this.api = options.api;
    this.dataKeys = options.dataKeys ?? [];
    this.skipMethodKeys = options.skipMethodKeys ?? [];
    this.defaultMemoryLimitMb = options.defaultMemoryLimitMb ?? 128;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /**
   * Async factory that constructs a sandbox and awaits its `afterStart`
   * hook (if configured). Use this when start-up needs async work
   * (warming a connection, fetching credentials, seeding scratch files).
   */
  static async create(options: DefaultSandboxOptions): Promise<DefaultSandbox> {
    const sandbox = new DefaultSandbox(options);
    if (options.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }
    return sandbox;
  }

  // ── Filesystem (delegate to VirtualFs) ────────────────────────────────

  readFile(path: string, encoding: 'utf-8' = 'utf-8'): Promise<string> {
    if (encoding !== 'utf-8') {
      throw new Error(
        `DefaultSandbox.readFile only supports utf-8 encoding (got: ${encoding}).`,
      );
    }
    return this.fs.readFile(path);
  }

  writeFile(
    path: string,
    content: string,
    encoding: 'utf-8' = 'utf-8',
  ): Promise<void> {
    if (encoding !== 'utf-8') {
      throw new Error(
        `DefaultSandbox.writeFile only supports utf-8 encoding (got: ${encoding}).`,
      );
    }
    return this.fs.writeFile(path, content);
  }

  edit(path: string, oldStr: string, newStr: string): Promise<void> {
    return this.fs.edit(path, oldStr, newStr);
  }

  stat(path: string): Promise<SandboxStats> {
    return this.fs.stat(path);
  }

  access(path: string): Promise<void> {
    return this.fs.access(path);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.mkdir(path, options);
  }

  readdir(path: string): Promise<Dirent[]> {
    return this.fs.readdir(path);
  }

  glob(pattern: string): Promise<string[]> {
    return this.fs.glob(pattern);
  }

  grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]> {
    return this.fs.grep(pattern, options);
  }

  // ── Execute (read entrypoint from FS, run in isolated-vm) ─────────────

  async execute(
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult> {
    if (this.stopped) {
      return {
        value: undefined,
        error: { message: 'Sandbox is stopped' },
      };
    }

    // Read the entrypoint code from the virtual filesystem.
    let code: string;
    try {
      code = await this.readFile(request.entrypoint);
    } catch (err) {
      return {
        value: undefined,
        error: {
          message: `Cannot read entrypoint ${request.entrypoint}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    // Build the bound API surface for the isolate. If the caller provided
    // a `context` blob, expose it as `__context` global inside the isolate.
    const sandboxObject: Record<string, unknown> = { ...this.api };
    let dataKeys = [...this.dataKeys];
    if (request.context) {
      sandboxObject.__context = request.context;
      dataKeys = [...dataKeys, '__context'];
    }

    try {
      const value = await runInIsolatedVM(code, sandboxObject, {
        memoryLimit: this.defaultMemoryLimitMb,
        timeout: request.timeoutMs ?? this.defaultTimeoutMs,
        dataKeys,
        skipMethodKeys: this.skipMethodKeys,
      });
      return { value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        value: undefined,
        error: {
          message,
          stack: err instanceof Error ? err.stack : undefined,
          isTimeout: message.toLowerCase().includes('timed out'),
        },
      };
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (err) {
        // beforeStop failures shouldn't prevent cleanup
        console.warn(
          `[default-sandbox] beforeStop hook failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.stopped = true;
  }
}
