# Context

> Assemble the current information for an action and carry its authoritative
> Ablo reads into the write that follows.

`context()` is a standalone SDK function. It does not run a model, keep a
conversation, search documents, or create memory. The application chooses the
values; Ablo awaits them and identifies the exact returned rows that can guard
a later write.

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
    task: ablo.tasks.get({ id: taskId }),
    documents: ablo.documents.list({ where: { taskId } }),
    memory: loadMemories(taskId),
  },
});

if (!ctx.data.task) throw new Error('Task not found');

const result = await generateText({
  model,
  messages: [...history, contextMessage(ctx)],
  tools,
});

await ablo.tasks.update({
  id: ctx.data.task.id,
  data: parseTaskUpdate(result.text),
  reads: ctx.reads,
});
```

If an authoritative row moves during the model call, the update rejects with
`AbloStaleContextError`. Rebuild the context before trying again. The model is
not called or retried by `context()`.

## Choose the protection separately

Context assembly and concurrency policy answer different questions. Choose the
protection according to the work:

| Situation | Use | Why |
|---|---|---|
| Bring several current values into one model call | `context()` | Awaits the selected values and collects their evidence. |
| Reject if any selected Ablo row moves | `reads: ctx.reads` | Checks those premises when the write reaches the server. |
| Avoid paying for a model call while another participant owns the row | `claim()` | Waits first, then supplies fresh state. |
| Compute a patch from one current row without external work | Functional `update()` | Re-reads and retries the pure calculation. |

A stale guard detects a change after the work has happened. When the work is
slow or costly and must be exclusive, take a claim before assembling context.
See [Coordination](./coordination.md) for the full choice.

## Result

The result has four members:

| Member | Meaning |
|---|---|
| `data` | The selected values, with nested promises resolved. |
| `reads` | Exact Ablo rows accepted by a write's `reads` option. |
| `cursor` | The greatest watermark among those authoritative reads, or `null`. |
| `sources` | One provenance summary for each top-level value. |

If a row in `ctx.reads` moves before the write, the server rejects the write as
stale. A plain value can inform the action, but it does not gain that guarantee.
This distinction is visible in `sources`:

```ts
ctx.sources;
// [
//   { key: 'task', kind: 'ablo', guarantee: 'guardable', cursor: 42 },
//   { key: 'memory', kind: 'value', guarantee: 'informational', cursor: null },
// ]
```

A top-level value may contain both kinds. It is then marked `mixed` and only
its exact Ablo rows appear in `ctx.reads`:

```ts
// data: { briefing: { task, memory } }
// sources: [
//   { key: 'briefing', kind: 'mixed', guarantee: 'partial', cursor: 42 },
// ]
```

`partial` does not weaken the included Ablo rows. It says the surrounding value
also contains information Ablo cannot guard.

## External context

Provider results pass through without an adapter or provider dependency. The
functions below belong to the application; they may call Mem0, Turbopuffer,
Reducto, or another system behind their own interfaces.

```ts
const ctx = await context({
  ablo,
  data: {
    task: ablo.tasks.get({ id: taskId }),
    memory: loadMemories({ query, userId }),
    related: findRelatedChunks({ projectId, query }),
    evidence: extractEvidence({ documentId }),
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
    contextMessage(ctx, { include: ['task', 'documents', 'memory'] }),
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
- `since` cursor or incremental `changes` result;
- context session, persistence, or sharing lifecycle;
- token counting, trimming, summarisation, or model call;
- guarantee that a person or model understood the included information.

Store `ctx.cursor` in application-owned state if it is useful. Incremental
context is not yet derived from it.

`context` remains available as a schema model name. The helper lives at
`@abloatai/ablo/context`; it does not add `ablo.context()` or reserve a member
of the schema-backed client.
