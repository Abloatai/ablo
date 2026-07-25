/**
 * Sandbox interface — the contract every execution substrate must satisfy.
 *
 * Shape ported from vercel-labs/open-agents — filesystem + code execution.
 * Open-agents' tool baseline (readFileTool, writeFileTool, globTool, grepTool,
 * editFileTool, bashTool, askUserQuestionTool, todoWriteTool, skillTool)
 * expects a sandbox with these primitives; by matching their surface, we can
 * port those tools nearly verbatim and compose new domain-specific tools
 * (executeTool, renderChartTool) on top.
 *
 * Divergence from open-agents: our sandbox's filesystem is **virtual**.
 * Instead of real disk files in a VM, paths route to backends:
 *   - `/api/**`, `/examples/**`       — static content bundled with the package
 *   - `/state/**`                     — read-only projections of entity state
 *   - `/memories/**`, `/skills/**`    — backed by our own memory/skills store
 *   - `/scratch/**`                   — in-memory, ephemeral per sandbox instance
 *
 * Backends plug into the Sandbox via a routing layer (see virtual-fs/).
 * Tools never know which backend they're hitting — they just call the
 * filesystem methods on the Sandbox.
 *
 * The one non-filesystem primitive is `execute()`: given an entrypoint
 * path (typically `/scratch/main.ts`), evaluate the file with the bound
 * API namespace and return the result. This is how mutations happen —
 * the agent writes scratch code, executes it, the mutation pipeline
 * applies results through the sync engine.
 */

// ── Backend identifier ────────────────────────────────────────────────────

/** Backend identifier — add new variants as backends are added. */
export type SandboxType = 'isolated-vm' | 'cloud' | (string & {});

// ── Lifecycle hooks ───────────────────────────────────────────────────────

export type SandboxHook = (sandbox: Sandbox) => Promise<void> | void;

export interface SandboxHooks {
  /** Fires after the sandbox is created and ready to execute. */
  afterStart?: SandboxHook;
  /** Fires before the sandbox is stopped — cleanup opportunity. */
  beforeStop?: SandboxHook;
  /** Fires when the sandbox is about to time out (before beforeStop). */
  onTimeout?: SandboxHook;
  /** Fires after the sandbox's timeout has been successfully extended. */
  onTimeoutExtended?: (
    sandbox: Sandbox,
    additionalMs: number,
  ) => Promise<void> | void;
}

// ── Filesystem types ──────────────────────────────────────────────────────

/** Subset of node:fs Dirent that open-agents' tools rely on. */
export interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Stat result — mirrors the subset of fs.Stats used by tools. */
export interface SandboxStats {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

/** One match from a grep operation. */
export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

// ── Code execution types ──────────────────────────────────────────────────

export interface SandboxExecutionRequest {
  /** Path to the file to evaluate — typically `/scratch/main.ts`. */
  entrypoint: string;
  /** Timeout in ms for this execution. Overrides default. */
  timeoutMs?: number;
  /** Abort signal — forwarded from the tool `execute` options when present. */
  signal?: AbortSignal;
  /**
   * Data blob injected into the sandbox global scope as read-only context.
   * Used to pass entity IDs, user IDs, etc. to bound API functions.
   */
  context?: Record<string, unknown>;
}

export interface SandboxExecutionLog {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface SandboxExecutionError {
  message: string;
  stack?: string;
  /** Whether the error was a timeout rather than a runtime exception. */
  isTimeout?: boolean;
}

export interface SandboxExecutionResult {
  /** Final expression result of the evaluated code (JSON-serializable). */
  value: unknown;
  /** Console output captured during execution. */
  logs?: SandboxExecutionLog[];
  /** Error caught during execution, or undefined on success. */
  error?: SandboxExecutionError;
  /**
   * Mutations recorded during execution — shape is backend-agnostic,
   * interpreted by the mutation runner.
   */
  mutations?: unknown[];
}

// ── Sandbox ───────────────────────────────────────────────────────────────

/**
 * The agent's environment.
 *
 * Satisfied by isolated-vm (browser-safe) today; future server-side backends
 * (Vercel Sandbox, E2B) satisfy the same interface. Tools depend on this
 * contract, not any particular backend.
 */
export interface Sandbox {
  /** Identifier for the backend implementation. */
  readonly type: SandboxType;

  /**
   * The agent's "home" — relative paths in tool args resolve from here.
   * Mirrors `Sandbox.workingDirectory` in vercel-labs/open-agents.
   * Defaults to `/scratch` if the implementation doesn't override.
   */
  readonly workingDirectory: string;

  /** Human-readable description injected into agent system prompts. */
  readonly environmentDetails?: string;

  /** Lifecycle hooks configured at sandbox creation time. */
  readonly hooks?: SandboxHooks;

  /** Unix timestamp (ms) after which the sandbox will be proactively stopped. */
  readonly expiresAt?: number;

  /** Initial configured proactive timeout in milliseconds. */
  readonly timeout?: number;

  // ── Filesystem operations (open-agents-shaped) ──────────────────────────
  //
  // Backends decide per-path which operations are permitted. Writing to a
  // read-only path throws `SandboxReadOnlyError`; reading a nonexistent path
  // throws `SandboxNotFoundError`. Tools propagate these as tool errors.
  //
  // The encoding parameter is accepted for API familiarity (matches Node fs
  // and open-agents); only `utf-8` is supported — others throw.

  /** Read a file. Paths are absolute (`/api/layer.ts`). */
  readFile(path: string, encoding?: 'utf-8'): Promise<string>;

  /**
   * Write a file. Some backends (static, state-projection) reject writes.
   * Idempotent: writing the same content is a no-op at the mutation level.
   */
  writeFile(path: string, content: string, encoding?: 'utf-8'): Promise<void>;

  /**
   * Targeted in-place edit. Replaces the first occurrence of `oldStr` with
   * `newStr`. Throws if `oldStr` is not found or appears multiple times.
   * Matches open-agents' editFileTool semantics.
   */
  edit(path: string, oldStr: string, newStr: string): Promise<void>;

  /** File metadata. Throws on missing path. */
  stat(path: string): Promise<SandboxStats>;

  /**
   * Throws if the path doesn't exist. Cheaper than `stat` when you just
   * need an existence check. Matches Node fs.access.
   */
  access(path: string): Promise<void>;

  /**
   * Create a directory. Mostly a no-op for our virtual fs (paths are
   * keys, not real directories) but accepted for API familiarity — agents
   * call it before writing nested paths out of habit.
   * The `recursive` option is honored when relevant; absent it, behaves
   * as if `recursive: true` (always succeeds idempotently).
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /** List directory entries. */
  readdir(path: string): Promise<Dirent[]>;

  /** Glob match — returns absolute paths matching the pattern. */
  glob(pattern: string): Promise<string[]>;

  /** Grep — search file contents for a regex pattern. */
  grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]>;

  // ── Code execution ──────────────────────────────────────────────────────

  /**
   * Evaluate the file at `request.entrypoint` in the sandbox runtime.
   * Runtime errors are returned in `result.error`; only infrastructure
   * failures throw.
   */
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Stop the sandbox and release its resources. Idempotent. */
  stop(): Promise<void>;

  /**
   * Extend the sandbox timeout. Optional — backends without proactive
   * timeouts (like in-process isolated-vm) may omit it.
   */
  extendTimeout?(additionalMs: number): Promise<{ expiresAt: number }>;

  /**
   * Get a backend-specific state snapshot for persistence across restarts.
   * Optional — used by durable backends (Vercel Sandbox) to hibernate.
   */
  getState?(): unknown;
}

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when a path doesn't exist or isn't accessible. */
export class SandboxNotFoundError extends Error {
  constructor(path: string) {
    super(
      `Path not found: ${path}. Use readdir() or glob() to discover available paths.`,
    );
    this.name = 'SandboxNotFoundError';
  }
}

/** Thrown when attempting to write to a read-only path. */
export class SandboxReadOnlyError extends Error {
  constructor(path: string) {
    super(
      `Path is read-only: ${path}. Writable paths: /scratch/**, /memories/**. ` +
        `State and static content cannot be modified directly — use execute() to produce mutations.`,
    );
    this.name = 'SandboxReadOnlyError';
  }
}

/** Thrown when edit() can't find the old string or finds multiple matches. */
export class SandboxEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxEditError';
  }
}
