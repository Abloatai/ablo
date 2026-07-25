/**
 * MutationRecorder — collects mutations from the sandbox API during an
 * execute run. Generic over the mutation type so consumers (apps/web's
 * RecordedMutation, agent-worker's simpler shape) plug in their own.
 *
 * Lifecycle:
 *   1. Runner creates one recorder per execute run.
 *   2. Adapter sandbox APIs receive the recorder via `buildSandboxNamespace`.
 *   3. Each API call validates inputs, constructs a typed mutation,
 *      and calls `recorder.record(mutation)`.
 *   4. After execute, runner reads `recorder.getAll()` and routes
 *      mutations to the right adapter's `persistMutations`.
 *
 * The recorder enforces a max mutation cap (default 1000) to prevent
 * runaway loops from generating millions of mutations and OOMing the host.
 */

import type { Mutation } from './types';

export interface MutationRecorderOptions {
  /** Hard cap on mutations per run. Defaults to 1000. */
  maxMutations?: number;
}

export class MutationRecorder<TMutation extends Mutation = Mutation> {
  private mutations: TMutation[] = [];
  private readonly maxMutations: number;

  constructor(options: MutationRecorderOptions = {}) {
    this.maxMutations = options.maxMutations ?? 1000;
  }

  /**
   * Append a mutation to the run. Throws if the cap is exceeded so the
   * sandbox can surface a clear error message instead of silently dropping.
   */
  record(mutation: TMutation): void {
    if (this.mutations.length >= this.maxMutations) {
      throw new Error(
        `Maximum mutations (${this.maxMutations}) exceeded — refusing to record more.`,
      );
    }
    this.mutations.push(mutation);
  }

  /** All mutations recorded so far, in insertion order. */
  getAll(): readonly TMutation[] {
    return this.mutations;
  }

  /** Number of mutations recorded so far. Cheap to call inside hot loops. */
  count(): number {
    return this.mutations.length;
  }

  /** Reset the recorder. */
  clear(): void {
    this.mutations = [];
  }
}
