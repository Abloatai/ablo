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

/**
 * One flush batch on the wall clock. Wall time (`Date.now`) rather than
 * `performance.now`, because rows cross the worker boundary and each thread
 * has its own `performance` origin — the drain-tail stamps learned the same
 * lesson. Stage entries are the batch's own share of each pipeline stage.
 */
export interface DrainBatchRow {
  readonly startedAtWallMs: number;
  readonly endedAtWallMs: number;
  readonly deltas: number;
  readonly stages: Readonly<Partial<Record<DrainStage, number>>>;
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
  /**
   * The most recent flush batches, oldest first, capped — enough to cover a
   * drain tail. Optional because derived profiles (window subtraction, fleet
   * merges) drop it; only a worker's own snapshot carries rows.
   */
  readonly recentBatches?: readonly DrainBatchRow[];
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

/** Ring of recent batch rows. ~50 batches/sec at benchmark rates, so this covers seconds of tail. */
const BATCH_ROW_CAP = 128;
let batchRows: DrainBatchRow[] = [];
interface OpenBatchRow {
  startedAtWallMs: number;
  deltas: number;
  stages: Partial<Record<DrainStage, number>>;
}
/**
 * The batch currently being flushed. Module-global like the totals above, so
 * an isolate hosting several stores attributes interleaved awaits to whichever
 * batch is open — the same per-isolate approximation the totals already make.
 */
let currentRow: OpenBatchRow | null = null;

/**
 * Wall-stamped persisted-cursor advances, oldest first. The benchmark's drain
 * gate reads THESE rather than observing the cursor from a timer or a
 * cross-thread poll: any observation that has to be scheduled onto the
 * worker's event loop queues behind the very drain burst it is measuring and
 * reports the queue's latency as drain. A stamp taken synchronously inside
 * the acknowledge stage cannot be deferred by anything.
 */
export interface AcknowledgeStamp {
  readonly syncId: number;
  readonly atWallMs: number;
}
const ACK_STAMP_CAP = 512;
let ackStamps: AcknowledgeStamp[] = [];

/**
 * Record a persisted-cursor advance. Called by the pipeline's acknowledge
 * stage. Unlike every stage timer here, this is NOT gated on the profiler
 * flag: it is one wall-clock read and one bounded push per flush batch —
 * nothing against the batch's own work — and the certification benchmark
 * runs unprofiled (the profiler costs ~15%), so the honest drain stamp must
 * exist without it.
 */
export function observeDrainAcknowledge(syncId: number): void {
  ackStamps.push({ syncId, atWallMs: Date.now() });
  if (ackStamps.length > ACK_STAMP_CAP) ackStamps.shift();
}

/** The recorded persisted-advance stamps, oldest first. */
export function drainAcknowledgeStamps(): readonly AcknowledgeStamp[] {
  return [...ackStamps];
}

/** Begin a batch row. Called by the pipeline at flush entry when profiling. */
export function openDrainBatchRow(deltaCount: number): void {
  if (!enabled) return;
  currentRow = { startedAtWallMs: Date.now(), deltas: deltaCount, stages: {} };
}

/** Close the open batch row and commit it to the ring. */
export function closeDrainBatchRow(): void {
  if (!enabled || currentRow === null) return;
  batchRows.push({
    startedAtWallMs: currentRow.startedAtWallMs,
    endedAtWallMs: Date.now(),
    deltas: currentRow.deltas,
    stages: currentRow.stages,
  });
  if (batchRows.length > BATCH_ROW_CAP) batchRows.shift();
  currentRow = null;
}

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
  if (currentRow !== null) {
    currentRow.stages[stage] = (currentRow.stages[stage] ?? 0) + elapsedMs;
  }
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
    recentBatches: [...batchRows],
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
  batchRows = [];
  currentRow = null;
  ackStamps = [];
}
