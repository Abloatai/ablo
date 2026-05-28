# React

The React bindings for `@abloatai/ablo`. Use them when you want live
data on the client without writing fetch + WebSocket plumbing yourself.

For the full app structure, including server loads, existing backends, and
agents, start with [Integration Guide](/docs/integration-guide).

## Installation

The React bindings ship with the main package — no extra install.

```ts
import { useAblo } from '@abloatai/ablo/react';
```

## AbloProvider

Mount it once near the root of your tree. It owns the connection, the local
pool, and the engine lifecycle; everything below it reads with `useAblo`.

```tsx
'use client';

import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

export function Providers({
  children,
  user, // resolved server-side from YOUR auth
}: {
  children: React.ReactNode;
  user: { id: string; teamIds: string[] };
}) {
  return (
    <AbloProvider
      schema={schema}
      userId={user.id}
      teamIds={user.teamIds}
      fallback={<AppSkeleton />}
    >
      {children}
    </AbloProvider>
  );
}
```

`schema` is the only required prop. The rest are situational:

| Prop                | Default                | Purpose                                                                                                   |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `schema`            | —                      | **Required.** From `defineSchema()`. Determines the typed hook surface.                                   |
| `userId`            | resolved from auth     | App participant id for app-owned fields and your `identityRoles.extract`. Not the security boundary.      |
| `teamIds`           | resolved from auth     | Team ids expanded into team sync groups via `identityRoles`.                                               |
| `syncGroups`        | full allowed set       | **Narrows** the subscription to a subset of what auth allows (e.g. `['deck:abc123']`). Never widens it.   |
| `url`               | hosted endpoint        | WebSocket URL of the sync server (`wss://…`). Hosted apps omit it.                                         |
| `apiKey`            | session/cookie         | Bootstrap auth. Browser apps **omit this** — the key stays server-side. See Identity below.               |
| `fallback`          | neutral spinner        | Rendered during the *first* bootstrap only. Pass a branded skeleton, `null`, or `'passthrough'`.          |
| `bootstrapMode`     | `'full'`               | `'full'` pulls the org's baseline before ready; `'none'` skips the baseline and processes live deltas only.|
| `persistence`       | `'volatile'`           | `'indexeddb'` opts into a durable browser cache that survives reloads.                                     |
| `onSessionExpired`  | —                      | Fired after the engine has already purged on a rejected session — use for redirect-to-sign-in.            |
| `onError`           | —                      | Engine / WebSocket / `postBootstrap` errors. Wire to Sentry / Datadog.                                    |

Where `userId` / `teamIds` / `syncGroups` come from, and why the API key never
reaches the browser, is the whole of
[Identity & Sync Groups](./identity.md) — read that if it isn't obvious how org
/ team / user map to what a participant can see.

## useAblo — model client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportView({ report: serverReport }: { report: { id: string; location: string } }) {
  const report = useAblo((ablo) => ablo.weatherReports.retrieve(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claimState(serverReport.id));
  const claimed = Boolean(active);

  return <article>{report.location}</article>;
}
```

The hook:

1. Reads through the same `ablo.<model>` methods as the rest of the SDK.
2. Tracks the model fields read by the selector and re-renders when confirmed
   deltas arrive.
3. Lets Server Component data stay outside the hook: use `?? serverReport` when a
   parent already loaded the row.
4. Works for coordination state too, such as `ablo.weatherReports.claimState(id)`.

Use the zero-argument form only when you need the full client for callbacks,
effects, or writes:

```tsx
const abloClient = useAblo();
```

Prefer selector reads like `useAblo((ablo) => ablo.<model>.retrieve(id))`.
String model names are kept on older hooks for compatibility, but first examples
should use the same model-client shape as the rest of the SDK.

For collections, keep the selector on the model client too:

```tsx
const reports = useAblo((ablo) =>
  ablo.weatherReports.list({
    where: { projectId },
    filter: (report) => report.status !== 'ready',
    state: 'live',
  }),
);
```

## Server Load

```tsx
const [report] = await ablo.weatherReports.load({ where: { id } });
```

Use `load` in Server Components when the row may not be in the local pool yet.

## Writes

For Server Actions and route handlers, call the SDK directly:

```ts
import { ablo } from '@/lib/ablo';

const snap = ablo.snapshot({ weatherReports: id });
await ablo.weatherReports.update(id, patch, {
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

For client event handlers, get the provider-owned client and call the same
model client:

```tsx
const ablo = useAblo();

async function markReady() {
  if (!ablo) return;
  const snap = ablo.snapshot({ weatherReports: id });
  await ablo.weatherReports.update(
    id,
    { status: 'ready' },
    { readAt: snap.stamp, onStale: 'reject', wait: 'confirmed' },
  );
}
```

The selector form is for render-time reads. The zero-argument form is for
imperative work after an event or effect.

See [API reference](/docs/api) for the full options surface.

## Next.js

The Next.js [App Router landing](/nextjs) walks through Server Components
+ Server Actions + `useAblo` together.
