# React

> Provider, hooks, and reactive reads for the interfaces people watch agent work arrive in.

The React bindings for `@abloatai/ablo`. Use them when you want live
data on the client without writing fetch + WebSocket plumbing yourself.

For the full app structure, including server loads, existing backends, and
agents, start with [Integration Guide](/docs/integration-guide).

## Installation

The React bindings ship with the main package — no extra install.

```ts
import { useAblo } from '@abloatai/ablo/react';
```

## Building the client

You build the Ablo client once — that's where the schema, the session endpoint,
and connection config live — then hand it to the provider. The provider takes
the already-built `client`; it no longer takes `schema`, `url`, `apiKey`, etc.
as props. Construct the client once, then pass that instance to the provider.

```ts
// lib/ablo.ts
import Ablo from '@abloatai/ablo';
import { createAbloReact } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

// The browser never holds your API key. It mints a short-lived session token
// from your own server route (see Identity below).
export const ablo = Ablo({
  schema,
  authEndpoint: '/api/ablo-session',
});

// The typed binding: capture the schema once, and every component imports
// born-typed hooks from this file — `useAblo()` takes no type arguments,
// and a selector's `ablo` parameter knows your models.
export const { AbloProvider, useAblo } = createAbloReact(schema);
```

Import `AbloProvider` and `useAblo` from `lib/ablo` rather than from the
package, and the schema generic never appears at a call site again — the
same one-binding-file convention as tRPC's `createTRPCReact` or
react-redux's typed hooks.

## AbloProvider

Mount it once near the root of your tree. It owns the connection, the local
pool, and the engine lifecycle; everything below it reads with `useAblo`.

```tsx
'use client';

import { AbloProvider } from '@abloatai/ablo/react';
import { ablo } from '@/lib/ablo';

export function Providers({
  children,
  user, // resolved server-side from YOUR auth
}: {
  children: React.ReactNode;
  user: { id: string };
}) {
  return (
    <AbloProvider client={ablo} userId={user.id} fallback={<AppSkeleton />}>
      {children}
    </AbloProvider>
  );
}
```

`client` is the only required prop. The rest are situational:

| Prop        | Default          | Purpose                                                                                                   |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `client`    |: | **Required.** The `Ablo({ schema, apiKey })` instance. It carries the schema and connection config. |
| `userId`    | resolved from auth | App participant id for app-owned fields and your `identityRoles`. Not the security boundary.            |
| `fallback`  | neutral spinner  | Rendered during the *first* bootstrap only. Pass a branded skeleton, `null`, or `'passthrough'`.          |
| `onError`   |: | Engine / WebSocket / bootstrap errors. Wire to Sentry / Datadog.                                          |

Everything that used to be a provider prop — `schema`, `url`, `apiKey`,
`teamIds`, `syncGroups`, `persistence`, `bootstrapMode` — now lives on
the `Ablo({ ... })` client you build before mounting the provider. Where the
identity comes from, and why the API key never reaches the browser, is the whole
of [Identity & Sync Groups](./identity.md) — read that if it isn't obvious how
org / team / user map to what a participant can see.

## useAblo: model client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportView({ report: serverReport }: { report: { id: string; location: string } }) {
  const report = useAblo((ablo) => ablo.weatherReports.local.get(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claim.state({ id: serverReport.id }));
  const claimed = Boolean(active);

  return <article>{report.location}</article>;
}
```

The hook:

1. Uses the same `ablo.<model>.local.get(id)` / `.local.list()` methods you'd call anywhere
   else in the SDK — the hook just makes them reactive.
2. Tracks the model fields read by the selector and re-renders when confirmed
   deltas arrive.
3. Lets Server Component data stay outside the hook: use `?? serverReport` when a
   parent already loaded the row.
4. Works for coordination state too, such as `ablo.weatherReports.claim.state({ id })`.

Use the zero-argument form only when you need the full client for callbacks,
effects, or writes:

```tsx
const abloClient = useAblo();
```

Prefer selector reads like `useAblo((ablo) => ablo.<model>.local.get(id))`. Older hooks
also accept a string model name; prefer the selector form shown above.

For collections, keep the selector on the model client too:

```tsx
const reports = useAblo((ablo) =>
  ablo.weatherReports.local.list({
    where: { projectId },
    filter: (report) => report.status !== 'ready',
    state: 'live',
  }),
);
```

## Server Load

```tsx
const report = await ablo.weatherReports.get({ id });
```

Use `retrieve` in Server Components when the row may not be in the local pool
yet — it hydrates from the local store and the server, and returns a Promise, so
`await` it. (Server reads come in two shapes: `get({ id })` for one row and
`list({ where })` for many; both are async. The synchronous local reads are
the `local` reads, used in render below.)

## Writes

For Server Actions and route handlers, call the SDK directly:

```ts
import { ablo } from '@/lib/ablo';

const snap = ablo.snapshot({ weatherReports: id });
await ablo.weatherReports.update({
  id,
  data: patch,
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
  await ablo.weatherReports.update({
    id,
    data: { status: 'ready' },
    readAt: snap.stamp,
    onStale: 'reject',
    wait: 'confirmed',
  });
}
```

The selector form is for render-time reads. The zero-argument form is for
imperative work after an event or effect.

See [API reference](/docs/api) for the full options surface.

## useJoin: scoped presence + read interest

`useJoin` is the React form of `ablo.<model>.join`. It joins multiplayer for a
scope on the engine's existing socket (one TCP connection, N logical
sub-syncgroup participants) and returns the reactive participant facade. Use it
when a mount should both *see* who else is on an entity and, optionally, declare
write interest in it.

```tsx
'use client';

import { useJoin } from '@abloatai/ablo/react';

export function DeckPresence({ workspaceId }: { workspaceId: string }) {
  const { peers, claims, status } = useJoin({
    scope: { slideDecks: workspaceId },
    claim: true,   // I intend to write — pin the scope + let peers observe the claim
    hydrate: true, // backfill the workspace's current rows if not already loaded
  });

  if (status !== 'joined') return <span>connecting…</span>;
  return <span>{peers.length} other{peers.length === 1 ? '' : 's'} here</span>;
}
```

Options (`UseJoinOptions`):

| Option | Default | Effect |
| --- | --- | --- |
| `scope` |: | Model-form scope (`{ slideDecks: id }`), resolved through the schema. Omit for engine-wide. |
| `claim` | `false` | Acquire a write-claim on the scope (sent so peers observe it; pins the scope so it never warm-drops while held). A viewer is not a claimant: leave `false` for read-only. |
| `hydrate` | `false` | Backfill the scope's current rows into the pool once on enter, then keep them fresh via the live tail. Set `true` for deep-linked / never-opened entities. Single-flight; soft-fails. |
| `ttlSeconds` |: | Lease TTL for the scope claim. |
| `paused` | `false` | Tear down and don't re-join while true. |

Returns (`UseJoinReturn`): `{ participant, peers, claims, status, error }`.
`peers` is everyone else on the scope's sync groups; `claims` is their active
write-claims; `status` is the join lifecycle. Auto-cleans up on unmount or when
`paused` flips true.

## usePeers: read-only presence

`usePeers` is a *pure reader* of the presence stream already flowing on the
connection. Unlike `useJoin`, it does **not** enter/leave a scope (no
`update_subscription`, no warm-TTL churn) — so reading it never changes what the
connection is subscribed to.

```tsx
'use client';

import { usePeers } from '@abloatai/ablo/react';

export function CursorBroadcaster({ workspaceId }: { workspaceId: string }) {
  const peers = usePeers({ slideDecks: workspaceId });
  const alone = !peers.some((p) => p.participantKind === 'user');
  // suppress live-cursor broadcasts while alone
}
```

Pass `scope` to narrow to a sync group's peers, or omit it for everyone on the
engine's groups. Returns `ReadonlyArray<Peer>`, where each `Peer` carries
`participantKind` (`'user' | 'agent' | 'system'`), `participantId`, optional
`label`, `syncGroups`, `activity`, `lastActive`, and optional `activeClaims`.

Reach for `usePeers` (not a second `useJoin`) when some **other** mount already
owns the scope's read interest — scope `leave` is not reference-counted, so a
second `useJoin` on the same scope would warm-drop the owner's subscription on
unmount.

## Next.js

The Next.js [App Router landing](./examples/nextjs.md) walks through Server Components
+ Server Actions + `useAblo` together.
