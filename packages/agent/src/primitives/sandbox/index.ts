/**
 * @ablo/agent/primitives/sandbox — execution substrate for agent code.
 *
 * Filesystem-shaped sandbox following the open-agents pattern: agents
 * navigate a virtual filesystem of APIs, examples, state projections, and
 * memories. Writing to `/scratch/**` + calling `execute()` is how code
 * gets evaluated against the bound native API.
 *
 * ```ts
 * import { type Sandbox } from '@ablo/agent/primitives/sandbox';
 *
 * async function buildSlide(sandbox: Sandbox) {
 *   const state = await sandbox.readFile('/state/slides/slide-3.json');
 *   const example = await sandbox.readFile('/examples/layer/three-column.ts');
 *   await sandbox.writeFile('/scratch/main.ts', generatedCode);
 *   const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
 *   return result;
 * }
 * ```
 */

export type {
  Sandbox,
  SandboxType,
  SandboxHook,
  SandboxHooks,
  Dirent,
  SandboxStats,
  GrepMatch,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxExecutionLog,
  SandboxExecutionError,
} from './interface';

export {
  SandboxNotFoundError,
  SandboxReadOnlyError,
  SandboxEditError,
} from './interface';

// isolated-vm primitives (low-level — used by DefaultSandbox internally;
// consumers usually want DefaultSandbox or the Sandbox interface instead).
export {
  runInIsolatedVM,
  runInIsolatedVMSync,
} from './isolated-vm';

// Default composed Sandbox — wires VirtualFs + isolated-vm into one object
// satisfying the Sandbox interface.
export {
  DefaultSandbox,
  type DefaultSandboxOptions,
} from './default';

// Re-export backends for convenience — callers often need to construct a
// DefaultSandbox with an inline backend list.
export {
  ScratchBackend,
  StaticBundleBackend,
  StateProjectionBackend,
  type StaticBundleBackendOptions,
  type StateProjectionBackendOptions,
  type StateProvider,
  type VirtualFsBackend,
} from './virtual-fs';
