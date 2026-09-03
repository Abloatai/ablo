# @ablo/agent

## 0.61.0

## 0.60.0

## 0.59.2

## 0.59.1

## 0.59.0

## 0.58.0

### Minor Changes

- Separate observation from decision input: `ablo.<model>.get({ id })` returns a
  plain current row, while `ablo.<model>.read({ id })` privately retains compact
  model, id, and watermark evidence that can
  be passed through a mutation's `reads` option and retained in its attributed
  commit record without copying row contents.

  Remove the older `retrieve` and durable `track` model surfaces. A row returned by
  `read` has one stale behavior when carried into a mutation: the stale mutation
  does not land. `get` and `list` remain observational, and live `onChange` remains
  the socket-based notification path.

  This is an announced public-surface break with no compatibility aliases. Replace
  `retrieve({ id })` with `get({ id })` for observation or `read({ id })` when a
  later mutation depends on the row. Replace `track(...)`, `CommitContext.track`,
  and mutation `track` / `onStale` options with captured rows passed through the
  mutation's `reads` option. Stale premises now always reject the mutation;
  stateful WebSocket clients can use `onChange` to observe subsequent updates.

  Schema-level conflict policy configuration and its `agents*`, `humans*`, and
  `system*` policy constants are removed, along with the supporting conflict,
  stale-notification, persisted-read-set, and internal read-set exports. Use an
  active claim when work needs exclusive row access, and use `read` plus `reads`
  for optimistic premise checks. AI SDK `ToolModel.get` is likewise replaced by
  `ToolModel.read`.

## 0.57.0

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.0

## 0.52.0

## 0.51.0

## 0.50.0

## 0.49.0

## 0.48.0

## 0.47.0

## 0.46.0

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.0

## 0.39.0

## 0.38.0

- Narrowed `@ablo/agent` to internal AI SDK composition and Ablo coordination
  adapters.
- Moved isolated execution, the sandbox contract, and virtual filesystem
  backends to `@ablo/execute-sandbox/runtime`.
- Moved shared agent prompt sections to `@ablo/prompts/agent`.
- Moved the provider and model catalog to `@ablo/ai`.
- Removed the old agent-owned sandbox, prompt, and model export paths instead of
  leaving compatibility re-exports. These concerns are internal implementation
  details and now have one owner each.
- Moved the application AgentJob runtime into `apps/web` and the concrete tool
  catalog into `apps/agent-worker`; removed the old package export paths.
- Replaced private perception HTTP calls with an injected transaction-backed
  source using authoritative `get()` and canonical claim state/queue reads.
  Freshness failures now stop guarded work instead of being reported as fresh.
- Removed the check-then-act `wrapTool` path. Public enforced model tools now
  live at `@abloatai/ablo/ai-sdk`.

## 0.37.1

## 0.37.0
