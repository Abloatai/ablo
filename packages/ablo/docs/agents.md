# Agents

> The stateless participant: wake on a trigger, read, claim, commit, go idle.

## Stateless HTTP reads

Use `get` to read one task row by id and `list` to find matching rows. Agents
and other stateless workers use the HTTP client directly, without a
synchronization step or a `.data` wrapper.

```ts
const task = await ablo.tasks.get({ id: taskId });
if (!task) throw new Error('task not found');
console.log(task.title);

const matching = await ablo.tasks.list({ where: { title } });
if (!matching[0]) throw new Error('task not found');
console.log(matching[0].title);
```

These are observational reads. Use `read({ id })` only when a later Ablo write
depends on that exact version and will pass it through `reads`.

Most agents wake on a trigger, read what they need, write a result, and go idle.
That is a request/response workload, so they use plain HTTP. A resident agent
that needs pushed deltas, queued-claim grants, or presence selects
`transport: 'websocket'`. The credential is the identity on both carriers; the
server resolves the org, scope, and actor from it.

Short-lived agents use HTTP. Long-running agents may add a multiplexed
WebSocket without installing the human materializer. People add the `humans()`
plugin for a local reactive graph. All three operate on the same typed,
coordinated state and enter the same server-side commit and claim paths.

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'websocket',
  cursorStore,
});

await ablo.ready();

for await (const delta of ablo.observe()) {
  await applyToAgentState(delta);
  await delta.checkpoint(); // persist the cursor, then acknowledge it
}
```

The selected WebSocket is shared by commits, row claims and releases,
subscription changes, pushed deltas, presence, and collaboration events.
Reconnect sends the last checkpointed position, so an uncheckpointed delta is
eligible for redelivery. An unsupported protocol version closes explicitly
instead of silently falling back to a different wire dialect.

The client retains no delta backlog while `observe()` is inactive. Starting an
observer requests replay from the durable checkpoint. An active observer has a
bounded in-memory backlog; if it falls behind that bound, observation fails
explicitly and can be restarted from the same durable checkpoint.

The public operation names do not change with the carrier. For example,
`ablo.records.update(...)` and `ablo.records.claim(...)` are the same calls on
HTTP and WebSocket. HTTP remains available for point reads and administrative
resources; `context().onChange` uses POST/SSE when HTTP is selected and reuses
the socket when WebSocket is selected.

<Note>
Agents transact against your **pushed schema**, same as everyone — `ablo.records`
exists because you defined a `record` model and ran `ablo push`. The key
authenticates; the [schema](/installation) defines what you can call.
</Note>

## The agent client

Same `Ablo()` entry point as everywhere else — pass `transport: 'http'`. No
socket, no connection state — just your schema (for types) and an API key.

```ts
import Ablo from "@abloatai/ablo";
import { schema } from "./schema";

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, transport: "http" });

// Reads + writes, fully typed off your schema.
// `get` resolves to the row, or `undefined` when none matches.
const open = await ablo.records.list({ where: { status: "todo" } });

const record = await ablo.records.read({ id: open[0].id });
if (!record) throw new Error("record not found");

console.log(record.title);
await ablo.records.update({ id: record.id, data: { status: "done" } });
```

It exposes `get` / `list` / `create` / `update` / `delete`, plus `commits`
and `claim`. It does **not** expose stateful-only `local` reads or model
`onChange` subscriptions. `context().onChange` is separate: it reuses the
selected WebSocket transport, or holds one POST/SSE response until the context
changes on the HTTP transport.

## Managed scoped agents

When this process owns the secret client and also runs the agent, prefer
`agents.create`. It mints the restricted credential, returns a schema-typed
client, and renews that credential for a long run. `sessions.create({ agent })`
is the raw-token path for handing identity to another runtime.

Derive identity and groups from the run row or trusted job payload—not from
model output or an HTTP request body. A serverless handler normally creates and
disposes one child per invocation:

```ts
const run = await control.runs.read({ id: verifiedRunId });
if (!run) throw new Error('run not found');

const agent = await control.agents.create({
  id: `run:${run.id}`,
  name: 'run-worker',
  can: { records: ['read', 'update'] },
  syncGroups: [`workspace:${run.workspaceId}`],
});
try {
  await executeRun(agent, run);
} finally {
  await agent.dispose();
}
```

Use a stable id only when one logical run is serialized; two concurrent workers
that share an id appear as the same participant. For independent concurrent
work, omit `id` and let Ablo create distinct identities.

A long-running worker may cache one managed client per stable scope, but the
cache owns lifecycle: evict idle clients, call `dispose()` on eviction, and
dispose every client during graceful shutdown. Never cache a client and later
reuse it for a different workspace or capability set.

```ts
const agents: Record<
  string,
  Awaited<ReturnType<typeof control.agents.create>> | undefined
> = {};

async function agentFor(run: Run) {
  const key = `${run.workspaceId}:${run.workerSlot}`;
  const cached = agents[key];
  if (cached) return cached;
  const created = await control.agents.create({
    id: `worker:${key}`,
    can: { records: ['read', 'update'] },
    syncGroups: [`workspace:${run.workspaceId}`],
  });
  agents[key] = created;
  return created;
}
```

## AI SDK tools

Keep AI SDK in charge of the model loop and expose only the Ablo operations the
model needs:

```ts
import { generateText } from 'ai';
import {
  createTool,
  deleteTool,
  readTool,
  updateTool,
} from '@abloatai/ablo/ai-sdk';

const tools = {
  getTask: readTool(ablo.records, {
    description: 'Read the current record.',
    inputSchema: z.object({ recordId: z.string() }),
    id: ({ recordId }) => recordId,
  }),
  createTask: createTool(ablo.records, {
    description: 'Create a record.',
    inputSchema: z.object({ requestId: z.string(), title: z.string() }),
    id: ({ requestId }) => requestId,
    data: ({ title }) => ({ title, status: 'todo' }),
  }),
  updateTask: updateTool(ablo.records, {
    description: 'Update a record without overwriting concurrent work.',
    inputSchema: z.object({ recordId: z.string(), status: z.string() }),
    id: ({ recordId }) => recordId,
    apply: (_current, { status }) => ({ status }),
  }),
  deleteTask: deleteTool(ablo.records, {
    description: 'Delete a record after taking its claim.',
    inputSchema: z.object({ recordId: z.string() }),
    id: ({ recordId }) => recordId,
    // Destructive tools require AI SDK approval by default.
  }),
};

await generateText({ model, messages, tools });
```

These are adapters over the same typed resources used by ordinary backend
code. Ablo does not own the planner, prompt system, memory, provider, worker,
or workflow runtime.

## Coordination: claim, queue, reorder

The differentiator. A claim is a **durable lease + FIFO wait-line** on a row —
"who's working on this, who's waiting" — and it's request/response, so an agent
holds it over HTTP. This is how two agents (or an agent and a human) don't
clobber the same record.

```ts
// Acquire a lease, do work with the held row, release on scope exit:
await using claim = await ablo.records.claim({ id: recordId });
const record = claim.data;
// …no one else can hold this row while you work…
await ablo.records.update({
  id: record.id,
  data: { status: "in_review" },
  claim,
});

await ablo.records.claim.state({ id: recordId });   // who holds it now (or null)
await ablo.records.claim.queue({ id: recordId });   // the FIFO wait-line behind the holder
await ablo.records.claim.reorder({ id: recordId, order: line }); // re-rank the line (privileged)
```

Think of it as a queue per row — a durable, inspectable, reorderable lease
line. Use `contention: { mode: 'skip' }` for fail-fast dedup: *if someone else
has this job, skip it.*

## Messaging between agents

Use claim `description` and `meta` for live "what I am doing now" context. Use
ordinary synced rows for handoffs, status notes, and requests that must survive
reconnects or be readable by HTTP agents. The recipe is a `messages` model
scoped by the same syncGroup field as the work row, with `aboutIntentId` linking
a message back to the claim it discusses.

See [Agent Messaging](/agent-messaging) for the schema and setup details.

## When a person is in the loop

There's no separate "agent mode" — and no separate human mode either. The bare
client is the coordination layer; `humans()` is the plugin that adds the live
plane on top of it. An agent acting over HTTP and a person editing over their
socket share the same typed state and the same coordination: the agent can claim
the row that person is holding (and wait in line), and they see the agent's
committed changes stream in **live** over their own socket, even though the
agent committed over HTTP.

There is no `agents()` plugin, and the absence is the point — an agent is the
default caller here, not a bolt-on.

## How an agent runs

```text
something happens ──▶ your agent (HTTP, no socket)
  (a job, a webhook,     read context (list/get/read)
   a queue message)      claim → work → commit
                         done — no held connection
```

Without `context().onChange`, an agent holds nothing open and remains a
**stateless worker**: deploys and restarts are free, and you scale by adding
workers. Each active context listener is explicit connection capacity and must
be stopped when its work ends.

## What stays on the live (human) plane

Model `onChange` and `local` reads require a WebSocket and a local store —
they're for interactive UIs. An HTTP agent normally reacts to an external
trigger, then reads with `list`/`get`. For costly work, `context().onChange` can
stop that one run early while the final write still uses `context().reads`.
See [client behavior](/client-behavior) for the full surface and
[guarantees](/guarantees) for the coordination semantics.
