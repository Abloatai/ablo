# Agent + Human

A report-writing agent that yields when a human is editing the same report.

## Scenario

A product queue has reports that humans and agents both update. They must not
collide:

- If the user is editing, the agent waits or yields.
- If the agent is updating, the UI can show who is active.
- If the report changes mid-run, the commit rejects instead of overwriting newer
  state.

## Schema-Backed Worker

Use the same schema client the app uses. The worker loads the report, claims the
row, and writes through `ablo.weatherReports.update(...)`.

```ts
import Ablo from '@abloatai/ablo';
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

  const [report] = await ablo.weatherReports.load({ where: { id: reportId } });
  if (!report) return { status: 'not_found' };

  const updated = await ablo.weatherReports.claim(
    reportId,
    async (claimed) =>
      ablo.weatherReports.update(
        claimed.id,
        { status: 'ready' },
        { wait: 'confirmed' },
      ),
    { wait: false, action: 'marking_ready' },
  );

  return { status: 'ready', report: updated };
}
```

Keep workers on the same schema-backed client as the app.

## UI

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportRow({ report: serverReport }: Props) {
  const data = useAblo((ablo) => ablo.weatherReports.retrieve(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claimState(serverReport.id));
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

- Claims are visible through `claimState(id)` and over the live stream.
- `claim(id, work)` lets agents wait for active work instead of racing.
- `readAt` plus `onStale: 'reject'` turns mid-flight changes into typed errors.
- Audit rows tie each accepted write back to the run that caused it.
