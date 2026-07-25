# Agent Orchestration

Do not model parent and child agents as directly talking to each other over WebSocket.

Model them as actors coordinating through models:

```txt
parent creates job -> child claims job -> child commits result -> parent reads result
```

The WebSocket is delivery infrastructure. The product model is shared state.

## Model Shape

A parent creates a job through its typed model client:

```ts
const jobId = `forecast:${runId}`;
await ablo.agentJobs.create({
  id: jobId,
  idempotencyKey: `job:${runId}`,
  data: {
    status: 'open',
    kind: 'forecast_report',
    target: { model: 'weatherReports', id: 'report_stockholm', field: 'forecast' },
  },
  wait: 'confirmed',
});
```

The child claims the job. If another worker holds it, the claim waits fairly,
then returns the fresh row:

```ts
await using claim = await ablo.agentJobs.claim({
  id: jobId,
  description: 'complete',
  ttl: '5m',
});
const job = claim.data;

await ablo.agentJobs.update({
  id: job.id,
  data: {
    status: 'completed',
    result: { text },
  },
});
```

The child commits completion through the normal `update`, which is stale-guarded
under the held claim. The claim releases when its scope exits.

The parent retrieves the job result by model ID. Later, `ablo.events` can make that reactive, but the state model does not change.

## Rule

Nested agents should create or complete models. They should not require a separate agent-to-agent protocol for normal work.
