/**
 * @ablo/agent/primitives — the verbs.
 *
 * One barrel for every primitive factory + type the package owns.
 * Catalogs (concrete tool/prompt/model bundles) live under
 * `@ablo/agent/catalog/*` and are built on top of these primitives.
 */

// tool() factory
export {
  defineTool,
  defineClientTool,
  type ToolExecuteContext,
  type ToolDefinition,
  type ClientToolDefinition,
} from './tool';

// prompt composition
export { section, compose } from './prompt';

// model middleware
export { withRetry, ToolTimeoutError, type WithRetryOptions } from './middleware';

// sandbox primitive (interface + default impl + backends)
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
} from './sandbox';
export {
  SandboxNotFoundError,
  SandboxReadOnlyError,
  SandboxEditError,
  runInIsolatedVM,
  runInIsolatedVMSync,
  DefaultSandbox,
  type DefaultSandboxOptions,
  ScratchBackend,
  StaticBundleBackend,
  StateProjectionBackend,
  type StaticBundleBackendOptions,
  type StateProjectionBackendOptions,
  type StateProvider,
  type VirtualFsBackend,
} from './sandbox';

// mutation primitive
export type { Mutation } from './mutation';
export {
  AdapterRegistry,
  defaultRegistry,
  type ContentMutationAdapter,
  type SandboxBuildContext,
  type PersistContext,
  type PersistResult,
  CONTENT_TYPES,
  isContentType,
  type ContentType,
  MutationRecorder,
  type MutationRecorderOptions,
  StreamingParser,
  validateParserPattern,
  type MutationIntentEvent,
  type ParserPattern,
} from './mutation';
