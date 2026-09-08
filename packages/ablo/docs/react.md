# React

> Provider, hooks, and reactive reads for the interfaces people watch agent work arrive in.

The React bindings for `@abloatai/ablo`. Use them when you want live
data on the client without writing fetch + WebSocket plumbing yourself.

For the full app structure, including server loads, existing backends, and
agents, start with [Integration Guide](/docs/integration-guide).

## Installation

The React bindings ship with the main package — no extra install.

```ts
import { useAblo, useAbloClient } from '@abloatai/ablo/react';
```

React uses the same objects and operations as core Ablo. Read `ablo.status`
with `useAblo(ablo => ablo.status)`, select `ablo.presence.others` for other
sessions, and call ordinary model methods from event handlers. React owns the
subscription or component lifetime; the client owns the behavior.

For mutation failures, let the hook own the subscription:

```tsx
import { useMutationFailure } from '@abloatai/ablo/react';

useMutationFailure(reportFailure);
```

`reportFailure` receives `Ablo.MutationFailure`. Read application identity from
your auth provider; Ablo's authenticated authority comes from its session.

## Types follow their owners

Most calls infer their types from your schema. For wrapper components or explicit
annotations, use the name you already imported:

```tsx
import { Ablo, AbloProvider, useAblo } from '@abloatai/ablo/react';
import { schema } from './schema';

type Models = (typeof schema)['models'];
type Chat = Ablo.Schema.InferRow<typeof schema, 'chats'>;

function Provider(props: AbloProvider.Props<Models>) {
  return <AbloProvider {...props} />;
}

function ChatView({ result }: { result: useAblo.Result<Chat> }) {
  return <p>{result.data?.title}</p>;
}
```

The React annotation types are `AbloProvider.Props`, `useAblo.Options`,
`useAblo.Result`, `useMutators.Options`, `useMutators.Result` and
`useUndoScope.Result`. Core types remain under `Ablo`, including `Ablo.Options`,
`Ablo.Reads`, `Ablo.Status` and `Ablo.PresenceSession`. Import annotation owners
from the SDK entry point; functions destructured from an app binding infer their
call types but do not create new TypeScript namespaces in the app module.

`createAbloReact(schema)` specializes types and returns the existing provider and
hooks. Define your binding at module scope. It creates no client, React context
or component identity. Hooks always read the nearest provider: use the binding
that matches that provider's client schema.

## Building the client

You build the Ablo client once — that's where the schema, the session endpoint,
and connection config live — then hand it to the provider. The provider takes
the already-built `client`; it no longer takes `schema`, `url`, `apiKey`, etc.
as props. Construct the client once, then pass that instance to the provider.

```ts
// lib/ablo.ts
import { Ablo } from '@abloatai/ablo/react';
import { createAbloReact } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

// The browser never holds your API key. It mints a short-lived session token
// from your own server route (see Identity below).
export const ablo = Ablo({
  schema,
  session: { endpoint: '/api/ablo-session' },
});

// The typed binding: capture the schema once, and every component imports
// born-typed hooks from this file — `useAbloClient()` takes no type arguments,
// and a selector's `ablo` parameter knows your models.
export const { AbloProvider, useAblo, useAbloClient, usePresence, useMutationFailure } = createAbloReact(schema);
```

Import `AbloProvider`, `useAbloClient`, `useAblo`, and `usePresence` from `lib/ablo` rather than from the
package, and the schema generic never appears at a call site again — the
same one-binding-file convention as tRPC's `createTRPCReact` or
react-redux's typed hooks.

## AbloProvider

Mount it once near the root of your tree. **The application owns the client
and must dispose it.** The provider starts readiness and binds React to the
client; unmounting the provider does not dispose a shared client.

```tsx
'use client';

import { AbloProvider } from '@abloatai/ablo/react';
import { ablo } from '@/lib/ablo';

export function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AbloProvider client={ablo} fallback={<AppSkeleton />}>
      {children}
    </AbloProvider>
  );
}
```

`client` is the only required prop. The removed `userId` prop is no longer accepted;
read application identity from your authentication context. Ablo authority comes
from the client session. The remaining props are situational:

| Prop        | Default          | Purpose                                                                                                   |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `client`    |: | **Required.** The `Ablo({ schema, apiKey })` instance. It carries the schema and connection config. |
| `fallback`  | neutral spinner  | Rendered during the *first* bootstrap only. Pass a branded skeleton, `null`, or `'passthrough'`.          |
| `onError`   |: | Engine / WebSocket / bootstrap errors. Wire to Sentry / Datadog.                                          |

Everything that used to be a provider prop — `schema`, `url`, `apiKey`,
`teamIds`, `syncGroups`, `persistence`, `bootstrapMode` — now lives on
the `Ablo({ ... })` client you build before mounting the provider. Where the
identity comes from, and why the API key never reaches the browser, is the whole
of [Identity & Sync Groups](./identity.md) — read that if it isn't obvious how
org / team / user map to what a participant can see.

## Client lifetime and account switching

For an application-owned singleton, create it once as above. Your application
session owner calls `await ablo.dispose()` on logout or before replacing that
client. Provider remounts can reuse it. Never share a browser singleton across
server requests. When changing accounts, remove the old account UI and create a
fresh client whose session endpoint grants the newly verified membership.
Query filters and application identity state do not change authorization.

For a component-owned client, create and dispose the instance in the same effect.
React Strict Mode can replay setup and cleanup, so each setup creates a fresh
instance rather than reusing one that cleanup already disposed:

```tsx
const createClient = (accountId: string) => Ablo({
  schema,
  persistence: 'memory',
  session: { endpoint: `/api/accounts/${encodeURIComponent(accountId)}/ablo-session` },
});

function AccountWorkspace({ accountId }: { accountId: string }) {
  const [owned, setOwned] = useState<{
    accountId: string;
    client: ReturnType<typeof createClient>;
  } | null>(null);

  useEffect(() => {
    const client = createClient(accountId);
    setOwned({ accountId, client });
    return () => { void client.dispose().catch(reportError); };
  }, [accountId]);

  // Never render an old account's client under the new account's heading.
  if (!owned || owned.accountId !== accountId) return <AppSkeleton />;
  return <AbloProvider key={accountId} client={owned.client}><Workspace /></AbloProvider>;
}
```

Import `useEffect` and `useState` from React. The endpoint must verify membership
for the requested account on every mint; the URL itself grants no access.
See the [account multiplayer walkthrough](./examples/account-multiplayer.md)
for the complete ownership boundary and runnable component.

Use `onError` to show a startup failure outside the bootstrap gate. After a
transient failure, remount the provider with the same client to retry readiness;
failed `ready()` attempts are retryable. After logout or an account change,
create a fresh client instead. Strict Mode may create two client instances in
development; each instance owns its own credential lifecycle.

## Render immediately with connection status

`useAblo(ablo => ablo.status)` works during provider startup, in passthrough children and in
custom fallbacks. It observes the client's status before row scope is available.
It still requires a provider. Data hooks that require authenticated scope must
wait for readiness.

```tsx
import { useAblo } from '@abloatai/ablo/react';

function ConnectionIndicator() {
  const status = useAblo(ablo => ablo.status);
  return <span role="status">{
    status?.name === 'initial' || status?.name === 'connecting'
      ? 'Connecting…' : status?.name
  }</span>;
}

<AbloProvider client={ablo} fallback="passthrough">
  <ConnectionIndicator />
  <ExistingWorkspace />
</AbloProvider>
```

## useAblo: model client

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportView({ report: serverReport }: { report: { id: string; location: string } }) {
  const { data: report, claimed } = useAblo(
    ablo => ablo.weatherReports,
    serverReport.id,
    { initial: serverReport },
  );

  if (!report) return <p>This report is not in the local cache.</p>;
  return <article>{report.location}{claimed && <span>Claimed</span>}</article>;
}
```

The row form subscribes to both data and claim events. It returns `data`,
`claims`, and `claimed`, and accepts an initial server-rendered row.

For data-only reads, selectors such as
`useAblo(ablo => ablo.weatherReports.local.get(id))` track model fields.
Claim selectors subscribe too: `useAblo(ablo => ablo.weatherReports.claim.state({ id }))`
updates when ownership changes. Use the row form when you want data and claims together.

Selectors must be pure synchronous reads. Ablo copies selected rows, arrays and plain
records into frozen snapshots, including nested data and computed fields. Unchanged
data retains its snapshot identity across renders. Treat copied dates as read-only;
model API handles and other class instances retain their original identity. Read
data inside the selector to subscribe to it. Selector errors reach React error boundaries.

`initial` supplies the server HTML and first hydration render; React then reads the
current local row. Once a local row has appeared, removing it returns `undefined`
instead of restoring the seed, so `data` remains optional even with `initial`.

A local cache miss (`undefined` or an empty list) does not prove that the server has
no matching data. Local reads do not fetch rows, and connection status does not
indicate query completeness. Use your route loader and an awaited server read, such
as `await ablo.weatherReports.get({ id })`, to establish server results and handle
request errors before passing an initial row to React.

Use the zero-argument form only when you need the full client for callbacks,
effects, or writes:

```tsx
const abloClient = useAbloClient();
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
const report = await ablo.weatherReports.read({ id });
```

Use `get` in Server Components when the row may not be in the local pool
yet — it hydrates from the local store and the server, and returns a Promise, so
`await` it. (Server reads come in two shapes: `read({ id })` for one row and
`list({ where })` for many; both are async. The synchronous local reads are
the `local` reads, used in render below.)

## Writes

For Server Actions and route handlers, call the SDK directly:

```ts
import { ablo } from '@/lib/ablo';

const report = await ablo.weatherReports.read({ id });
if (!report) throw new Error('report not found');
await ablo.weatherReports.update({
  id,
  data: patch,
  reads: [report],
});
```

For client event handlers, get the application-owned client and call the same
model client:

```tsx
const ablo = useAbloClient();

async function markReady() {
  if (!ablo) return;
  const report = await ablo.weatherReports.read({ id });
  if (!report) return;
  await ablo.weatherReports.update({
    id,
    data: { status: 'ready' },
    reads: [report],
  });
}
```

The selector form is for render-time reads. The zero-argument form is for
imperative work after an event or effect.

See [API reference](/docs/api) for the full options surface.

## usePresence: viewers and active participants

`usePresence` declares that the mounted component is reading one model record
and returns the live sessions active on that record. Use the selector form with
the schema-bound hook:

```tsx
import { usePresence } from '@/lib/ablo';

export function ChatView({ chatId }: { chatId: string }) {
  const viewers = usePresence((ablo) => ablo.chats, chatId);

  return viewers.map((session) => (
    <Avatar
      key={session.presenceSessionId}
      participantId={session.participant.id}
      kind={session.participant.kind}
    />
  ));
}
```

The component chooses the model and record. Ablo owns the authenticated
session identity, read lease, refresh, reconnect re-announcement, and removal
on cleanup. Multiple tabs remain separate sessions, and human and agent
participants use the same result shape. Do not build a separate `chat:view`
event, heartbeat, or stale-viewer timer in the app.

If you already have the client, the direct model form is equivalent:

```tsx
const viewers = usePresence(ablo.chats, chatId);
```

The hook returns the complete matching session projection, including the
current session. Use `session.participant` for identity and inspect
`session.activities` when the UI needs to distinguish reading from claiming or
writing.

A presence session is a connection, not a unique person. Two tabs can share
`participant.id` while having different `presenceSessionId` values. For a people
count, deduplicate by both `participant.kind` and `participant.id`; retain the
sessions when displaying connection details. Reading declares attention; claiming
declares ownership. Neither proves that an agent is generating text. Label a held
claim “Agent owns this chat.” Drive “Generating” from application execution state.
On navigation, the hook releases its old read lease. After a lost connection,
remote presence may remain until its lease expires; disappearance is not immediate.

## Model events: cursors and selections

Use the `events` namespace already attached to each model for transient UI
signals. The model and record choose the authorized sync group; the payload
does not need routing fields or caller-authored identity.

```tsx
const ablo = useAbloClient();

useEffect(() => {
  if (!ablo) return;
  return ablo.slideDecks.events.subscribe(deckId, 'cursor', (cursor, context) => {
    drawRemoteCursor(context.sender.presenceSessionId, cursor);
  });
}, [ablo, deckId]);

function onPointerMove(x: number, y: number) {
  ablo?.slideDecks.events.send(deckId, 'cursor', { slideId, x, y });
}
```

The same shape works for code editors:

```ts
ablo.files.events.send(fileId, 'selection', { anchor, head });
```

Events are lossy and are not replayed after reconnect, which fits cursor and
live-selection updates. Ablo enters and leaves the record scope with each
subscription, routes only inside that scope, and delivers authenticated
`sender` and `sentAt` context separately from the application payload. Use
durable model fields when state must survive reconnects. The sending connection
does not receive its own event. Coalesce or throttle pointer movement in the
application; model events do not currently declare a per-event `maxHz`.

## Presence: the same core read

Select `ablo.presence.others` for the other sessions visible to this client, or
filter by a model and record. These reads subscribe to changes without starting
an activity or claiming ownership.

```tsx
import { useAblo } from '@abloatai/ablo/react';

function Readers({ conversationId }: { conversationId: string }) {
  const sessions = useAblo(ablo => ablo.presence.forModel('conversations', conversationId)) ?? [];
  const people = new Set(sessions.filter(session => session.participant.kind === 'user')
    .map(session => session.participant.id));
  return <span>{people.size} people, {sessions.length} sessions</span>;
}
```

`usePresence(ablo => ablo.conversations, conversationId)` additionally owns a
reading activity for the component's lifetime. Use it when mounting the component
should announce that this session is reading the record. Core code owns the same
lifecycle explicitly with `ablo.conversations.presence.read(conversationId)` and
its returned cleanup function.

## Next.js

The Next.js [App Router landing](./examples/nextjs.md) walks through Server Components
+ Server Actions + `useAblo` together.

## Separate packages and monorepos

Put the schema in an application-owned package, with a public export for its
value and type. Put the React binding in a client module which imports that
schema, and export its inferred declarations. Components import their hooks from
that binding package. Build the schema package before its dependents and test the
emitted declarations without workspace source aliases.

```ts
'use client';
import { createAbloReact } from '@abloatai/ablo/react';
import { schema } from '@app/schema';

export const { AbloProvider, useAbloClient, useAblo, usePresence, useMutationFailure } =
  createAbloReact(schema);
```

Use one binding per schema, and mount its hooks under a provider for that schema.
The binding specializes types; it does not create an isolated runtime context or
validate that a different binding's provider has the same schema. Keep React and
the Ablo package family deduplicated across packages. Reusable libraries should
accept a schema or typed binding rather than declare an application-global schema.
An app's ambient registration cannot retroactively change a separately compiled
library. Use `defineMutators(schema, definitions)`, `useMutators(schema, definitions)`
and `useUndoScope(schema, name)` across those boundaries.

## Mutation failures and scoped collaborators

```tsx
const peers = usePresence(client => client.records, id, { excludeSelf: true });
useMutationFailure(({ error }) => showToast(error.message));
```

`useMutationFailure` uses the latest committed callback, moves its subscription
when the provider client changes, and unsubscribes on unmount. For non-React
callers, `client.onMutationFailure` returns the cleanup function.

For a custom framework adapter, `getAbloStore(client)` from
`@abloatai/ablo/client` returns the supported `Ablo.Store` contract: local pool
access, mutation observation, and scope management. Ordinary writes, confirmation,
reconnection and model events already have public client methods; they do not
require a store adapter.
