# Integrations

> Compose Ablo's authoritative shared-state operations with the runtimes that
> execute, schedule, or ingest work in your application.

Integrations live at the application edge. Ablo continues to own typed reads
and writes, idempotency, claims, and authoritative confirmation; the external
runtime keeps owning the job it was designed for.

[Context](./context.md) is the small composition point for values returned by
those systems. It carries Ablo read evidence without turning an external result
into authoritative application state.

| Category | Integration | Status | Use it for |
|---|---|---|---|
| Agent execution | [Anthropic Sandbox Runtime](./integrations/sandbox-runtime.md) | Available | Restricting the filesystem, network, sockets, and inherited authority of an agent process |
| Long-running records | [Temporal](./integrations/temporal.md) | Available | Durable Workflows, Activity retries, timers, cancellation, and durable AI SDK calls |
| Long-running records | [Inngest](./integrations/inngest.md) | Available | Event-driven durable functions, retriable steps, flow control, and checkpointed AI SDK calls |
| Data ingestion | Connector runtimes | Planned | Bringing external data into Ablo-backed models without creating a second write authority |

An integration gets its own guide when there is runnable application code and
the boundary has been tested. A dedicated package comes later still: only
repeated production integrations that reveal substantial reusable behavior
justify adding another public runtime dependency.

## Agent execution

Use [Anthropic Sandbox Runtime](./integrations/sandbox-runtime.md) to enforce the
boundary around an agent process. The runtime owns filesystem and network
access. Ablo remains below it and owns typed shared-state operations, claims,
idempotency, and confirmation. The runnable example lives in
`examples/sandboxed-agent`.

## Long-running records

Use [Temporal](./integrations/temporal.md) when work must survive process
failure, retry Activities, wait on timers, or preserve a durable model loop.
Temporal owns execution history. Each tool or Activity that touches shared
state calls the branded Ablo model API at the application edge.

The complete example lives in `examples/temporal-agent` and includes retry,
replay, cancellation, claim release, and Workflow-bundle tests.

Use [Inngest](./integrations/inngest.md) when durable work starts from events
and should be expressed as independently retriable steps behind an application
HTTP endpoint. Inngest owns event delivery, step checkpoints, and flow control.
Each `step.run()` that touches shared state calls the same branded Ablo model
API used elsewhere in the application.

The complete example lives in `examples/inngest-agent` and includes
confirmed-write response-loss replay, key/body conflict, checkpoint reuse,
claim cleanup, and endpoint-discovery tests.

## Data ingestion

Data ingestion is separate from the Inngest durable-execution integration. A
connector or ingestion runtime belongs in this section when its public contract
exists. The same ownership rule will apply:

- the ingestion runtime owns connectors, polling, checkpoints, parsing, and
  backpressure;
- Ablo owns validated model writes, idempotency, coordination, and confirmed
  outcomes;
- the consuming application owns field mapping and business policy.

Until that contract and a runnable example exist, this page records the
category without publishing placeholder imports or configuration.
