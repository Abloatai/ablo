/**
 * Where the drain's seconds go.
 *
 * A commit's receipt is confirmed the moment its PostgreSQL transaction
 * commits, but an observer is not caught up until it has applied the last
 * delta. Server publication p95 is single-digit milliseconds while the final
 * observer takes seconds, so the gap is client-side and has never been
 * attributed to a stage. Two fixes aimed at wire bytes (project filtering,
 * patch-only UPDATE delivery) each returned well under a third, which is
 * evidence the dominant term is a per-delta or per-batch fixed cost rather
 * than payload size.
 *
 * This times the stages a delta actually passes through so a benchmark run can
 * state the attribution instead of inferring it. It is off unless
 * `ABLO_PROFILE_DRAIN=true`, and every entry point returns before doing work
 * when off, mirroring the server's commit profiler.
 *
 * The stage vocabulary derives from {@link PipelineStage}; `parse` is the one
 * addition, because wire validation happens in the transport before a delta
 * reaches the pipeline at all.
 */

import type { PipelineStage } from '../../plugin.js';

/** The pipeline's own stages plus the transport-level wire validation ahead of them. */
export type DrainStage = 'parse' | PipelineStage;

export interface DrainStageTotals {
  /** Accumulated wall time attributed to this stage. */
  readonly totalMs: number;
  /** How many times the stage ran. Per-delta for `parse`, per-batch for the rest. */
  readonly calls: number;
}

export interface DrainProfile {
  /** Flush batches drained. The per-batch fixed cost multiplies by this. */
  readonly batches: number;
  /** Deltas that reached the pipeline. The per-delta fixed cost multiplies by this. */
  readonly deltas: number;
  /** Deltas dropped by the dedupe stage before persistence. */
  readonly deduplicated: number;
  /** Wall time from the first observed stage to the last. */
  readonly spanMs: number;
  readonly stages: Readonly<Record<DrainStage, DrainStageTotals>>;
}

const DRAIN_STAGES: readonly DrainStage[] = [
  'parse',
  'receive',
  'dedupe',
  'persist',
  'apply',
  'acknowledge',
  'notify',
];

interface MutableTotals {
  totalMs: number;
  calls: number;
}

function emptyTotals(): Record<DrainStage, MutableTotals> {
  const totals = {} as Record<DrainStage, MutableTotals>;
  for (const stage of DRAIN_STAGES) totals[stage] = { totalMs: 0, calls: 0 };
  return totals;
}

let totals = emptyTotals();
let batches = 0;
let deltas = 0;
let deduplicated = 0;
let firstMark: number | undefined;
let lastMark = 0;

/**
 * Read once. A profiler that consults the environment on every delta would
 * itself become a per-delta cost in the path it is measuring.
 */
const enabled: boolean = (() => {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env?.ABLO_PROFILE_DRAIN === 'true';
})();

/** Whether drain profiling is on. Callers skip their own bookkeeping when it is not. */
export function drainProfilingEnabled(): boolean {
  return enabled;
}

function mark(elapsedMs: number): void {
  const now = performance.now();
  firstMark ??= now - elapsedMs;
  lastMark = now;
}

/** Attribute already-measured wall time to a stage. */
export function observeDrainStage(stage: DrainStage, elapsedMs: number): void {
  if (!enabled) return;
  const entry = totals[stage];
  entry.totalMs += elapsedMs;
  entry.calls += 1;
  mark(elapsedMs);
}

/** Time a synchronous stage. Returns the callback's value untouched. */
export function timeDrainStage<T>(stage: DrainStage, run: () => T): T {
  if (!enabled) return run();
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    observeDrainStage(stage, performance.now() - startedAt);
  }
}

/** Time an asynchronous stage. Returns the callback's value untouched. */
export async function timeDrainStageAsync<T>(
  stage: DrainStage,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    observeDrainStage(stage, performance.now() - startedAt);
  }
}

/**
 * Record one drained batch: how many deltas entered it and how many survived
 * deduplication. Batch count is the multiplier on every per-batch cost, so it
 * is reported alongside the timings rather than derived from them.
 */
export function observeDrainBatch(received: number, survived: number): void {
  if (!enabled) return;
  batches += 1;
  deltas += received;
  deduplicated += Math.max(0, received - survived);
}

/** The totals accumulated since the last reset. */
export function drainProfileSnapshot(): DrainProfile {
  const stages = {} as Record<DrainStage, DrainStageTotals>;
  for (const stage of DRAIN_STAGES) {
    stages[stage] = { totalMs: totals[stage].totalMs, calls: totals[stage].calls };
  }
  return {
    batches,
    deltas,
    deduplicated,
    spanMs: firstMark === undefined ? 0 : lastMark - firstMark,
    stages,
  };
}

/** Clear the totals so a phase measures only its own traffic. */
export function resetDrainProfile(): void {
  totals = emptyTotals();
  batches = 0;
  deltas = 0;
  deduplicated = 0;
  firstMark = undefined;
  lastMark = 0;
}
