/**
 * isolated-vm backend — V8-isolate-based code execution.
 *
 * Implements the `execute()` primitive of the Sandbox interface (the
 * filesystem methods come from the virtual-fs layer; see
 * `../virtual-fs/`). The composed Sandbox class (in `../default.ts`,
 * step 36) wires both together.
 *
 * Two entry points are exported, matching how apps/web has used them:
 *
 * - `runInIsolatedVM` — full async dispatch with PendingSlide proxy,
 *   used by the main mutation pipeline.
 * - `runInIsolatedVMSync` — sync-only variant, used by slide-file
 *   evaluators that don't need async I/O.
 *
 * Both are pure — no internal state, safe to call concurrently with
 * separate sandbox objects.
 */

export { runInIsolatedVM, runInIsolatedVMSync } from './isolated-executor';
