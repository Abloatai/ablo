# Operation fields

> Write versioned text edits and integer increments through ordinary model updates, with shared persistence and undo.

Ablo's commit path accepts declared operations as well as ordinary field
replacements. The authority reconciles each operation with accepted history,
checks permissions and decision premises, validates the resulting value, and
records the accepted operation atomically with the row update.

Text edits and safe integer increments share this lifecycle. Text uses Unicode
operational transformation; increments use checked arithmetic. Ordinary fields
keep their existing replacement and stale-write behavior.

## Write intent through the model

`model.update({ id, data })` accepts a versioned operation on a declared field.
Create still takes values. A text update takes `$text`; a counter update takes
`$increment` or a replacement integer. Ordinary fields keep their value types.

For an independent versioned write, obtain its accepted basis from a stateless
HTTP editor (`transport: 'http'`):

```ts
const body = await ablo.documents.text({ id: 'document-1', field: 'body' });
const { snapshot } = body.exportState();
await ablo.documents.update({
  id: 'document-1',
  data: {
    body: { $text: {
      id: crypto.randomUUID(),
      epoch: snapshot.epoch,
      baseVersion: snapshot.version,
      operation: ['Hello '],
    } },
    title: 'Updated title',
  },
});
body.dispose();
```

On the humans client these writes use the normal mutation journal, sealed
commit envelope and observable row. Accepted collaborator operations rebase
queued intent without rewriting an already sealed request. The ordinary
UndoScope records semantic writes alongside value changes. It reverses the
actual accepted operation, preserving intervening collaborators' contributions;
redo reverses that accepted undo. An expired undo basis rejects and retains the
undo entry for recovery.

## Declare and use a counter

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, field } from '@abloatai/ablo/schema';

const schema = defineSchema({
  tasks: model({ title: field.string(), notes: field.text(), votes: field.counter() }),
});
const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

// Create the row with ordinary values first.
await ablo.tasks.create({ id: 'task-1', data: { title: 'Review', notes: '', votes: 0 } });
const votes = await ablo.tasks.counter({ id: 'task-1', field: 'votes' });
await votes.increment(1);
console.log(votes.value); // Optimistic value, including local pending increments.
await votes.flush();
votes.dispose();
```

A counter must be required and non-null. Its initial value, increments and
results must be safe JavaScript integers, between `Number.MIN_SAFE_INTEGER` and
`Number.MAX_SAFE_INTEGER`. An overflow rejects. This is an integer counter,
not a money or inventory reservation API; product rules still decide whether
an otherwise valid increment is allowed.

A normal update can replace a counter's value. It starts a new history epoch.
An older pending context rejects and remains in the primary mutation journal
for explicit recovery. Reopening an editor does not discard that context or
invent a new basis. External database replacements that disagree with retained
history also reject; they are not silently treated as new bases.

## Reconciliation and recovery

Reactive `model.text({ id, field })` and `model.counter({ id, field })` expose
`value`, `flush()`, `refresh()`, `error` and `dispose()`. Text has
`edit(operation)`; counters also have `increment(amount)`. Their value is the
normal observable model field, including queued intent. Edits enter the normal
mutation queue immediately; the edit promise resolves after journaling and
`flush()` waits for confirmation. Disposing the editor releases its view and
does not cancel or erase a queued model write.

The primary mutation record retains the context of edits made on top of earlier
local edits. Before sealing, the queue reconciles that context with actual
accepted history. A later local edit acquires its real server basis after its
predecessor is accepted. Retries replay the original immutable envelope. Opening
and disposing a field creates no separate buffer journal. Use the ordinary
UndoScope for these edits, including groups with ordinary field changes.

**Reactive editor API change:** `state`, `persist`, `exportState()`, `undo()` and
`redo()` belong to standalone HTTP buffers, not reactive model editors. Recover
unresolved buffers with the previous SDK before upgrading. The new runtime
retains unresolved legacy records and stops rather than silently dropping or
resubmitting them. Use normal client persistence for reactive pending writes;
UndoScope history remains scoped to its client session.

HTTP editors remain explicit staging buffers. They refresh explicitly and can
persist `exportState()` with the `persist` option. Their durable commit outbox
protects dispatched requests; it does not persist an unsent HTTP buffer without
that callback. Use their `undo()`/`redo()` and `flush()` for standalone buffer
history. For reactive editors, accepted-operation history feeds the ordinary
UndoScope instead.

Accepted row deltas carry an optional small `operation` reference: its stable
ID, `kind`, `field`, `epoch` and field `version`. The operation payload remains
in bounded history, read under the row's current read permission. Clients that
only understand row values continue using ordinary deltas. Log cursors and
field versions are different coordinates. A checkpoint, expired field basis,
delete/recreate or external fork requires explicit recovery with pending intent
preserved, even for an increment whose arithmetic would otherwise commute.

## Atomic operations on distinct rows

Use the existing `commits.create` when several actions must all land or none
may land. Each action keeps its own field epoch, version and operation ID.
For example, on a stateless HTTP client with both task rows already present:

```ts
const notes = await ablo.tasks.text({ id: 'task-1', field: 'notes' });
const votes = await ablo.tasks.counter({ id: 'task-2', field: 'votes' });
const noteBase = notes.exportState().snapshot;
const voteBase = votes.exportState().snapshot;

await ablo.commits.create({
  idempotencyKey: crypto.randomUUID(),
  operations: [
    { action: 'update', model: 'tasks', id: 'task-1', data: {
      notes: { $text: { id: crypto.randomUUID(), epoch: noteBase.epoch,
        baseVersion: noteBase.version, operation: ['Reviewed '] } },
    } },
    { action: 'update', model: 'tasks', id: 'task-2', data: {
      votes: { $increment: { id: crypto.randomUUID(), epoch: voteBase.epoch,
        baseVersion: voteBase.version, operation: 1 } },
    } },
  ],
});
```

The authority prepares all actions before product validation, then writes every
value, journal and accepted reference in the existing transaction. A bad later
basis or failing write rejects the entire batch. The HTTP and humans commit
adapters use the same contract. The configured durable commit outbox seals the
whole request before dispatch. For manual retries, construct the request once
and reuse its exact key, operation IDs, bases and payloads; rebuilding it from
fresh reads under the old key is not a replay.

Reactive editors observe these actions through normal row reconciliation.
The atomic request does not consume their queued intent. Ordinary queue batching
may combine distinct-row writes, but use one explicit request when atomicity
is required. Same-row semantic sequencing within one request remains unsupported.

## Authority and compatibility

These operations currently require Ablo-owned database or hosted log storage,
with the accepted-operation-reference migration installed. Connected-source
semantic operations reject before writing. The existing internal
`sync_text_fields` table now holds both kinds of field history; its name and
existing text rows stay in place, so enabling this release does not reset text
sessions. The table remains reserved and cannot be an application model.

A commit can contain semantic operations on distinct rows, mixed with ordinary
writes. Each semantic row may have one field operation and one update entry;
combine ordinary fields into that same entry rather than repeating its row.
Aliases of the same physical row count as the same target. Existing commit
size limits still apply. Claims, fencing, read
dependencies and product validation remain in the existing commit path. An
explicit `readAt` remains a decision premise and can reject even when the
operation's own transform basis is available. Undo is an ordinary authorized
operation, not a way around those checks. Counter replacement begins a new undo
context; an inverse from the previous epoch cannot be applied over that reset.

See [Versioned text fields](./text-fields.md) for Unicode operations and the
shared bounded-history limits.
