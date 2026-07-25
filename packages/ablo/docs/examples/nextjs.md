# Next.js Example

> App-router setup: the two clients, the session route, and reactive reads.

A production-shaped Next.js app on Ablo — App Router, Server Actions, React
Server Components, and live client subscriptions. It handles three things at
once: a fast initial render from the server, writes that don't overwrite work
already in progress, and a UI that updates the moment data changes.

The key piece is `claim()`. Commit a write through it and Ablo rejects the write
if the record moved since you read it, so nothing is silently clobbered. Claims
don't lock: if another writer holds the row, `claim` waits for them, re-reads the
fresh row, then hands it to you — writers serialize instead of colliding.

## Structure

```txt
app/
  layout.tsx                # wraps the tree in <Providers>
  providers.tsx             # Client: browser Ablo client + <AbloProvider>
  api/
    ablo-session/
      route.ts              # mints a per-user ek_ token for the browser
  tasks/
    [id]/
      page.tsx              # RSC: retrieve + render
      actions.ts            # Server Action: claim, then write
      TaskEditor.tsx        # Client: live updates
lib/
  ablo.ts                   # Server Ablo client (holds ABLO_API_KEY)
  ablo.schema.ts            # shared schema
```

There are **two** Ablo clients, and the split is the whole point:

- **Server** (`lib/ablo.ts`) holds the secret `apiKey` (`sk_`). Used by RSCs,
  Server Actions, and route handlers. Never imported into a client component.
- **Browser** (`app/providers.tsx`) holds **no secret**. It fetches a
  short-lived per-user token (`ek_`) from a backend route via `authEndpoint`.

Skipping the browser half is the most common setup mistake — the client then
has no credential and the engine fails to initialize with `session_expired`.

## Server Client

```ts
// lib/ablo.ts — server-only
import Ablo from '@abloatai/ablo';
import { schema } from './ablo.schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
});
```

## Session Route

The browser can't hold `sk_`, so a backend route mints a scoped, short-lived
`ek_` for the signed-in user. Guard it with your own auth.

```ts
// app/api/ablo-session/route.ts
import { ablo } from '@/lib/ablo';
import { getCurrentUser } from '@/auth';
import {
  credentialEndpointErrorSchema,
  credentialEndpointSuccessSchema,
} from '@abloatai/ablo/auth';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      credentialEndpointErrorSchema.parse({
        error: { code: 'session_expired' },
      }),
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { token, expiresAt } = await ablo.sessions.create({
    user: { id: user.id },
    can: { tasks: ['read', 'create', 'update'] },
  });
  return Response.json(
    credentialEndpointSuccessSchema.parse({
      token,
      expiresAt,
      credentialKind: 'ephemeral',
    }),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
```

## Provider

The browser client points `authEndpoint` at that route and is handed to
`<AbloProvider>` as an instance. Build it once at module scope so the socket
isn't torn down on every render.

```tsx
// app/providers.tsx
'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/lib/ablo.schema';

const ablo = Ablo({
  schema,
  authEndpoint: '/api/ablo-session',
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
```

```tsx
// app/layout.tsx
import { Providers } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

## RSC Initial Render

```tsx
// app/tasks/[id]/page.tsx
import { ablo } from '@/lib/ablo';

export default async function TaskPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ablo.ready();
  const task = await ablo.tasks.get({ id });
  if (!task) return null;

  return <TaskEditor task={task} />;
}
```

## Server Action Commit

```ts
// app/tasks/[id]/actions.ts
'use server';

import { ablo } from '@/lib/ablo';

export async function markDone(id: string) {
  // Claim grants exclusive, ordered access and hands back the fresh row.
  await using claim = await ablo.tasks.claim({ id });

  const task = await ablo.tasks.update({
    id,
    data: { status: 'done' },
    claim,
    wait: 'confirmed',
  });

  return { status: 'done', task };
  // claim auto-releases as the action returns
}
```

The write runs while the claim is held. If anything else commits between the
read and the write, the commit is rejected because the row changed underneath
you — re-fetch and retry.

## Live Client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function TaskEditor({ task: serverTask }: Props) {
  const data = useAblo((ablo) => ablo.tasks.local.get(serverTask.id)) ?? serverTask;
  const holder = useAblo((ablo) => ablo.tasks.claim.state({ id: serverTask.id }));
  const busy = Boolean(holder);

  return (
    <button disabled={busy || data.status === 'done'}>
      {busy ? 'Someone is editing' : 'Mark done'}
    </button>
  );
}
```

## More

- [React reference](../react.md) — every option on `useAblo`.
- [API reference](../api.md) — every option on the write path.
