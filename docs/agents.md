# Agents

> The stateless participant: wake on a trigger, read, claim, commit, go idle.

An agent is a **reactive** participant: it wakes on something happening, reads
what it needs, writes a result, and goes idle. That's a request/response
workload — so agents talk to Ablo over **plain HTTP**, holding no WebSocket. The
credential *is* the identity; the server resolves the org, scope, and actor from
the key on every request (the Stripe server-SDK / Liveblocks-node shape).

Agents get the stateless plane (HTTP). People — when you add the `humans()`
plugin — get the live plane (WebSocket: presence, optimistic, sub-100ms).
**Both operate on the same typed, coordinated state — and coordinate *with each
other*.**

<Note>
Agents transact against your **pushed schema**, same as everyone — `ablo.tasks`
exists because you defined a `task` model and ran `ablo push`. The key
authenticates; the [schema](/quickstart) defines what you can call.
</Note>

## The agent client

Same `Ablo()` entry point as everywhere else — pass `transport: 'http'`. No
socket, no connection state — just your schema (for types) and an API key.

```ts
import Ablo from "@abloatai/ablo";
import { schema } from "./schema";

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, transport: "http" });

// Reads + writes, fully typed off your schema.
// `retrieve` resolves to the row, or `undefined` when none matches.
const open = await ablo.tasks.list({ where: { status: "todo" } });

const task = await ablo.tasks.retrieve({ id: open[0].id });
if (!task) throw new Error("task not found");

console.log(task.title);
await ablo.tasks.update({ id: task.id, data: { status: "done" } });
```

It exposes `retrieve` / `list` / `create` / `update` / `delete`, plus `commits`
and `claim`. It does **not** expose the stateful-only surface (`get` /
`local` reads, `onChange` live subscription) — those need a
live connection, so with `transport: 'http'` the return type narrows and they
are a *compile error*, not a runtime surprise.

## Coordination — claim, queue, reorder

The differentiator. A claim is a **durable lease + FIFO wait-line** on a row —
"who's working on this, who's waiting" — and it's request/response, so an agent
holds it over HTTP. This is how two agents (or an agent and a human) don't
clobber the same record.

```ts
// Acquire a lease, do work with the held row, release on scope exit:
await using claim = await ablo.tasks.claim({ id: taskId });
const task = claim.data;
// …no one else can hold this row while you work…
await ablo.tasks.update({ id: task.id, data: { status: "in_review" } });

await ablo.tasks.claim.state({ id: taskId });   // who holds it now (or null)
await ablo.tasks.claim.queue({ id: taskId });   // the FIFO wait-line behind the holder
await ablo.tasks.claim.reorder({ id: taskId, order: line }); // re-rank the line (privileged)
```

Think of it as a queue per row — a durable, inspectable, reorderable lease line
("SQS for entity contention"). Use `{ queue: false }` for fail-fast dedup: *if
someone else has this job, skip it.*

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
  (a job, a webhook,     read context (list/retrieve)
   a queue message)      claim → work → commit
                         done — no held connection
```

Because it holds nothing open, an agent is a **stateless worker**: deploys and
restarts are free, and you scale by adding workers. A long-running fleet of idle
agents costs nothing on the live plane — that capacity stays for humans.

## What stays on the live (human) plane

`onChange` (live subscriptions) and the `local` reads (local synced-pool
reads) require a WebSocket and a local store — they're for interactive UIs, not
stateless agents. An agent reacts to an external trigger (a job/queue/webhook),
then reads with `list`/`retrieve`. See [client behavior](/client-behavior) for
the full surface and [guarantees](/guarantees) for the coordination semantics.
