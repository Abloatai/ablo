/**
 * @ablo/agent/primitives/mutation — generic mutation pipeline.
 *
 * Adapter contract + recorder + streaming parser + content-type registry.
 * Adapters (slide, sheet, doc) are product-specific and live in apps/web
 * for now. The runner is web-tied (uses MobX preview store) and stays
 * in apps/web — agent-worker uses these primitives directly via its
 * own loop.
 *
 * Generic over mutation type — apps/web instantiates with their rich
 * `RecordedMutation` discriminated union; agent-worker can use a simpler
 * shape that just satisfies the base `Mutation` interface.
 */

// Base types
export type { Mutation } from './types';

// Adapter contract + registry
export {
  AdapterRegistry,
  defaultRegistry,
  type ContentMutationAdapter,
  type SandboxBuildContext,
  type PersistContext,
  type PersistResult,
} from './adapter';

// Content types
export {
  CONTENT_TYPES,
  isContentType,
  type ContentType,
} from './schemas/content-types';

// Recorder
export {
  MutationRecorder,
  type MutationRecorderOptions,
} from './recorder';

// Streaming parser + patterns
export {
  StreamingParser,
  validateParserPattern,
  type MutationIntentEvent,
  type ParserPattern,
} from './parser';
