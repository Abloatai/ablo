# Next.js Example

A production-shaped Next.js + Ablo Sync app. App Router, Server Actions, React
Server Components, and live client subscriptions.

## Structure

```txt
app/
  reports/
    [id]/
      page.tsx          # RSC: retrieve + render
      actions.ts        # Server Action: schema update with stale-state check
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
}: { params: { id: string } }) {
  await ablo.ready();
  const [report] = await ablo.weatherReports.load({ where: { id: params.id } });
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
  const report = await ablo.weatherReports.claim(
    id,
    async (claimed) =>
      ablo.weatherReports.update(
        claimed.id,
        { status: 'ready' },
        { wait: 'confirmed' },
      ),
    { wait: false, action: 'marking_ready' },
  );

  return { status: 'ready', report };
}
```

If another participant commits between the read and the write, the commit
rejects. The action can re-fetch and ask the user to retry.

## Live Client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportEditor({ report: serverReport }: Props) {
  const data = useAblo((ablo) => ablo.weatherReports.retrieve(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claimState(serverReport.id));
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
