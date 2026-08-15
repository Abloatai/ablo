# Agent + Human

> An agent that yields the row when a person is already holding it.

A record-writing agent that yields when a person is editing the same record.

## Scenario

The same records are edited by agents and by the people watching them. They must
not collide:

- If a person already holds the row, the agent yields instead of fighting for it.
- While the agent is updating, the UI can show who is active.
- If the record changes mid-run, the commit is rejected instead of overwriting the
  newer edit.

A **claim** does both jobs. Claims don't lock — if another writer holds the row,
`claim` waits for them, re-reads the fresh row, then hands it back to you on
`claim.data`, so two writers serialize instead of clobbering. The handle is an
`AsyncDisposable`: hold it with `await using` and it releases on scope exit. And
once you hold a claim, any `update` you make while it's held is stale-checked for
free: the SDK records the row version you were handed and rejects the write with
a typed error if the row moved underneath you while the agent was busy.

## Schema-Backed Worker

The worker uses the same schema client the app uses. It reads the record from the
server with `get({ id })`, claims the row, and writes through
`ablo.records.update(...)` with a stale-check so a concurrent edit can't be
overwritten.

```ts
import Ablo, { AbloClaimedError, AbloStaleContextError } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  records: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']),
  }),
});

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
});

export async function markDone(recordId: string) {
  await ablo.ready();

  // get({ id }) is an async server read — await it.
  const record = await ablo.records.get({ id: recordId });
  if (!record) return { status: 'not_found' };

  try {
    // queue: false → don't queue behind a current holder. If another
    // participant holds the row, claim resolves null, so the agent yields
    // instead of waiting. Omit it, or pass queue: true, to queue behind them.
    const acquired = await ablo.records.claim({
      id: recordId,
      queue: false,
      description: 'marking_done',
    });
    if (!acquired) return { status: 'yielded' };

    await using claim = acquired;
    if (claim.data.status === 'done') return { status: 'noop' };

    // Inside an active claim, `update` is stale-checked automatically: the SDK
    // attaches the claim's snapshot version as `readAt` and sets
    // `onStale: 'reject'`. The write below is therefore equivalent to passing
    // those options yourself:
    //
    //   ablo.records.update({
    //     id: claim.data.id,
    //     data: { status: 'done' },
    //     readAt: <claim snapshot version>,
    //     onStale: 'reject',
    //   });
    //
    // If a newer version landed mid-run, the row no longer matches `readAt`, so
    // the server rejects this commit with AbloStaleContextError (caught below)
    // instead of clobbering that edit.
    const updated = await ablo.records.update({
      id: claim.data.id,
      data: { status: 'done' },
    });

    return { status: 'done', record: updated };
  } catch (err) {
    // The lease was lost or a foreign holder rejected the write.
    if (err instanceof AbloClaimedError) return { status: 'yielded' };
    // A newer version was saved while we held the claim. The stale-check
    // rejected our commit, so nothing was overwritten — re-run on fresh data.
    if (err instanceof AbloStaleContextError) return { status: 'stale' };
    throw err;
  }
}
```

Keep workers on the same schema-backed client as the app.

## UI

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function RecordRow({ record: serverTask }: Props) {
  const data = useAblo((ablo) => ablo.records.local.get(serverTask.id)) ?? serverTask;
  const holder = useAblo((ablo) => ablo.records.claim.state({ id: serverTask.id }));
  const agentActive = holder?.participantKind === 'agent';

  return (
    <div>
      <span>{data.title}</span>
      {agentActive ? <span>Agent is updating...</span> : null}
    </div>
  );
}
```

## Why It Works

- The claim is visible to everyone: the UI reads it synchronously with
  `claim.state({ id })`, and it also arrives over the live stream.
- `claim({ id })` makes writers take turns instead of racing — with
  `queue: false`, the agent simply yields when someone already holds the row.
- The `update` made while the claim is held is stale-checked automatically, so an
  edit landing mid-run rejects the agent's write with a typed
  `AbloStaleContextError` instead of overwriting it.
- That same write carries the claim, so each accepted change is attributed to the
  run that made it.
