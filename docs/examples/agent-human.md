# Agent + Human

A report-writing agent that yields when a human is editing the same report.

## Scenario

The same reports are edited by both humans and agents. They must not collide:

- If a human already holds the row, the agent yields instead of fighting for it.
- While the agent is updating, the UI can show who is active.
- If the report changes mid-run, the commit is rejected instead of overwriting
  the human's newer edit.

A **claim** does both jobs. Claims don't lock — if another writer holds the row,
`claim` waits for them, re-reads the fresh row, then hands it back to you on
`claim.data`, so two writers serialize instead of clobbering. The handle is an
`AsyncDisposable`: hold it with `await using` and it releases on scope exit. And
once you hold a claim, any `update` you make while it's held is stale-checked for
free: the SDK records the row version you were handed and rejects the write with
a typed error if the row moved underneath you while the agent was busy.

## Schema-Backed Worker

The worker uses the same schema client the app uses. It reads the report from
the server with `retrieve({ id })`, claims the row, and writes through
`ablo.weatherReports.update(...)` with a stale-check so a human's concurrent edit
can't be overwritten.

```ts
import Ablo, { AbloClaimedError, AbloStaleContextError } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
  }),
});

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

export async function markReady(reportId: string) {
  await ablo.ready();

  // retrieve({ id }) is an async server read — await it.
  const report = await ablo.weatherReports.retrieve({ id: reportId });
  if (!report) return { status: 'not_found' };

  try {
    // queue: false → don't queue behind a current holder. If a human already
    // holds the row, claim rejects with AbloClaimedError (caught below), so the
    // agent yields instead of waiting. Omit it, or pass queue: true, to queue
    // behind them. reason → the label observers see while we work.
    await using claim = await ablo.weatherReports.claim({
      id: reportId,
      queue: false,
      reason: 'marking_ready',
    });
    const claimed = claim.data;

    // Inside an active claim, `update` is stale-checked automatically: the SDK
    // attaches the claim's snapshot version as `readAt` and sets
    // `onStale: 'reject'`. The write below is therefore equivalent to passing
    // those options yourself:
    //
    //   ablo.weatherReports.update({
    //     id: claimed.id,
    //     data: { status: 'ready' },
    //     wait: 'confirmed',
    //     readAt: <claim snapshot version>,
    //     onStale: 'reject',
    //   });
    //
    // If a human saved a newer version mid-run, the row no longer matches
    // `readAt`, so the server rejects this commit with AbloStaleContextError
    // (caught below) instead of clobbering their edit.
    const updated = await ablo.weatherReports.update({
      id: claimed.id,
      data: { status: 'ready' },
      wait: 'confirmed',
    });

    return { status: 'ready', report: updated };
  } catch (err) {
    // A human already holds the row — yield this run and let them finish.
    if (err instanceof AbloClaimedError) return { status: 'yielded' };
    // A human saved a newer version while we held the claim. The stale-check
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

export function ReportRow({ report: serverReport }: Props) {
  const data = useAblo((ablo) => ablo.weatherReports.get(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claim.state({ id: serverReport.id }));
  const agentActive = active?.participantKind === 'agent';

  return (
    <div>
      <span>{data.location}</span>
      {agentActive ? <span>Agent is updating...</span> : null}
    </div>
  );
}
```

## Why It Works

- The claim is visible to everyone: the UI reads it synchronously with
  `claim.state({ id })`, and it also arrives over the live stream.
- `claim({ id })` makes writers take turns instead of racing — with
  `queue: false`, the agent simply yields when a human already holds the row.
- The `update` made while the claim is held is stale-checked automatically, so a human's
  edit landing mid-run rejects the agent's write with a typed
  `AbloStaleContextError` instead of overwriting it.
- That same write carries the claim, so each accepted change is attributed to
  the run that made it.
