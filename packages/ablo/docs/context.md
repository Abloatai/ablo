# Context

> Assemble the current information for an action and carry its authoritative
> Ablo reads into the model write or atomic commit that follows.

`context()` is a standalone SDK function. It does not run a model, keep a
conversation, search documents, or create memory. The application chooses the
values; Ablo awaits them and identifies the exact returned rows that can guard
a later model write or atomic commit.

## Context, model, write

This is the complete shape. `loadMemories()` and `parseTaskUpdate()` are
application functions; they are not Ablo APIs.

```ts
import { context } from '@abloatai/ablo/context';
import { contextMessage } from '@abloatai/ablo/ai-sdk';
import { generateText } from 'ai';

const ctx = await context({
  ablo,
  data: {
    record: ablo.records.read({ id: recordId }),
    records: ablo.records.list({ where: { recordId } }),
    memory: loadMemories(recordId),
  },
});

if (!ctx.data.record) throw new Error('Record not found');

const result = await generateText({
  model,
  messages: [...history, contextMessage(ctx)],
  tools,
});

await ablo.records.update({
  id: ctx.data.record.id,
  data: parseTaskUpdate(result.text),
  reads: ctx.reads,
});
```

The same captured rows guard an atomic batch. There is no second read format
and no manual conversion step:

```ts
await ablo.commits.create({
  operations: [
    { action: 'update', model: 'records', id: recordId, data: update },
    { action: 'create', model: 'auditEvents', id: eventId, data: event },
  ],
  reads: ctx.reads,
  idempotencyKey: runId,
});
```

Both the stateless HTTP client and the reactive WebSocket client resolve these
captured rows into canonical `{ model, id, readAt }` dependencies before the
commit reaches the transport. A claim returned by a typed model resource can
also be passed directly as the batch `claim`.

If an authoritative row moves during the model call, the update rejects with
`AbloStaleContextError`. Rebuild the context before trying again. The model is
not called or retried by `context()`.

## Choose the protection separately

Context assembly and concurrency policy answer different questions. Choose the
protection according to the work:

| Situation | Use | Why |
|---|---|---|
| Bring several current values into one model call | `context()` | Awaits the selected values and collects their evidence. |
| Reject if any selected Ablo row moves | `reads: ctx.reads` | Checks those premises when a model write or atomic commit reaches the server. |
| Avoid paying for a model call while another participant owns the row | `claim()` | Waits first, then supplies fresh state. |
| Compute a patch from one current row without external work | Functional `update()` | Re-reads and retries the pure calculation. |

A stale guard detects a change after the work has happened. When the work is
slow or costly and must be exclusive, take a claim before assembling context.
See [Coordination](./coordination.md) for the full choice.

## Result

The result has three members:

| Member | Meaning |
|---|---|
| `data` | The selected values, with nested promises resolved. |
| `reads` | Exact Ablo rows accepted by a model write or atomic commit's `reads` option. |
| `onChange` | Calls a listener once if any exact row in `reads` changes. Returns a function that stops listening. |

If a row in `ctx.reads` moves before a model write or atomic commit, the server
rejects the operation as stale. Plain values remain in `ctx.data`, but only
exact Ablo reads appear in `ctx.reads` and gain that guarantee.

## Stop work when context changes

`onChange` lets long-running work stop early without changing the write rule:

```ts
const controller = new AbortController();
const stop = ctx.onChange((error) => controller.abort(error));

try {
  const result = await generateText({
    model,
    abortSignal: controller.signal,
    messages: [contextMessage(ctx)],
  });

  await ablo.records.update({
    id: ctx.data.record.id,
    data: parseTaskUpdate(result.text),
    reads: ctx.reads,
  });
} finally {
  stop();
}
```

The first listener starts delivery and all listeners on that context share it.
The last returned `stop` closes it. A context with no reads opens nothing. The
first matching change calls every listener with `AbloStaleContextError`, then
delivery closes. The final create, update, or delete must still receive
`reads: ctx.reads`; that check remains authoritative if delivery races the
write or is disconnected.

## External context

Provider results pass through without an adapter or provider dependency. The
functions below belong to the application; they may call Mem0, Turbopuffer,
Reducto, or another system behind their own interfaces.

```ts
const ctx = await context({
  ablo,
  data: {
    record: ablo.records.read({ id: recordId }),
    memory: loadMemories({ query, userId }),
    related: findRelatedChunks({ projectId, query }),
    evidence: extractEvidence({ recordId }),
  },
});
```

These values are informational. Search ranking, citation versions, and memory
quality remain guarantees of their own systems. They do not become canonical
Ablo state unless the application writes them to an Ablo model and reads that
row back.

One rejected promise rejects the whole `context()` call. Requested information
is never omitted silently.

An absent row remains absent. It contributes no read evidence, so check required
rows before calling a model. `context()` does not turn a missing read into a
create-if-absent guard.

## AI SDK

The optional formatter produces a user message. It does not turn retrieved
content into a system instruction and does not take ownership of the run.

```ts
import { contextMessage } from '@abloatai/ablo/ai-sdk';
import { generateText } from 'ai';

await generateText({
  model,
  messages: [
    ...history,
    contextMessage(ctx, { include: ['record', 'documents', 'memory'] }),
  ],
  tools,
});
```

Selection, trimming, token budgets, conversation history, and model execution
remain application or framework policy. Applications may format `ctx.data`
themselves.

## Current limits

The first version deliberately has no:

- search or memory API;
- provider registry or provider-specific adapter;
- context session, persistence, or sharing lifecycle;
- token counting, trimming, summarisation, or model call;
- guarantee that a person or model understood the included information.

`context` remains available as a schema model name. The helper lives at
`@abloatai/ablo/context`; it does not add `ablo.context()` or reserve a member
of the schema-backed client.
