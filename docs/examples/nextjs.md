# Next.js Example

Building collaborative state in a Next.js app means handling three things at
once: a fast initial render from the server, writes that don't overwrite a
teammate's change, and a UI that updates the moment data changes. This example
wires all three with Ablo Sync. The key piece is `claim()` — commit a write
through it and Ablo rejects the write if someone edited the same record since
you read it, so you never silently clobber another person's work.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering.

The app uses three layers, mapped to three files: a React Server Component reads
and renders, a Server Action claims and writes, and a client component shows
live updates.

## Structure

```txt
app/
  reports/
    [id]/
      page.tsx          # RSC: retrieve + render
      actions.ts        # Server Action: write that's rejected if someone else edited first
      ReportEditor.tsx    # Client: live updates
  lib/
    ablo.ts             # Schema-backed Ablo client for server actions
```

## RSC Initial Render

```tsx
// app/reports/[id]/page.tsx
import { ablo } from '@/lib/ablo';

export default async function ReportPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ablo.ready();
  const report = await ablo.weatherReports.retrieve({ id });
  if (!report) return null;

  return <ReportEditor report={report} />;
}
```

## Server Action Commit

```ts
// app/reports/[id]/actions.ts
'use server';

import { ablo } from '@/lib/ablo';

export async function markReady(id: string) {
  await using claim = await ablo.weatherReports.claim({
    id,
    wait: false,
    action: 'marking_ready',
  });
  const claimed = claim.data;

  const report = await ablo.weatherReports.update({
    id: claimed.id,
    data: { status: 'ready' },
    wait: 'confirmed',
  });

  return { status: 'ready', report };
}
```

The write runs while the `claim` is held. If another participant commits
between the read and the write, the commit is rejected because the row changed
underneath you. The action can re-fetch and ask the user to retry.

## Live Client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportEditor({ report: serverReport }: Props) {
  const data = useAblo((ablo) => ablo.weatherReports.get(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claim.state({ id: serverReport.id }));
  const claimed = Boolean(active);

  return (
    <button disabled={claimed || data.status === 'ready'}>
      {claimed ? 'Someone is editing' : 'Mark ready'}
    </button>
  );
}
```

## More

- [Next.js landing](/nextjs) — the product overview.
- [React reference](/docs/react) — every option on `useAblo`.
- [API reference](/docs/api) — every option on the write path.
