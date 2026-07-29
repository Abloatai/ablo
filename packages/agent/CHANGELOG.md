# @ablo/agent

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
