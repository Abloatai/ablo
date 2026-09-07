# Account multiplayer

> Assemble account isolation, two humans, one agent, presence and reconnect in one runnable app.

The maintained reference lives in
[`examples/account-multiplayer`](https://github.com/Abloatai/ablo/tree/main/examples/account-multiplayer).
Start at `src/index.ts`, then follow its owned `accounts`, `agent` and `workspace`
boundaries. Its README contains the install, isolated-branch setup and test commands.

For the full participant lifecycle and its current cache behavior, see
[Groups and shared context](../groups.md).

## One account, one authorization rule

“People in this account can see its chats” requires both a row rule and a
server-verified session grant:

```ts
const schema = defineSchema({
  conversations: model({
    accountId: z.string().min(1),
    title: z.string(),
    executionOwner: z.string().nullable(),
    executionState: z.enum(['idle', 'generating']),
  }, { subject: { field: 'accountId', group: 'account' } }),
});
```

The subject rule maps the row's `accountId` to the required `account:<id>`
membership. This is authorization, distinct from optional group routing. Push
the schema to your isolated branch before using it. When connecting your own
database, apply the subject policies through the supported connection setup too.

```ts
const POST = sessions.handler({
  authenticate: request => authenticateApplicationCookie(request),
  async grant({ principal, request }) {
    const member = await verifyRequestedAccountMembership(principal, request);
    if (!member) return null;
    return {
      user: { id: member.user.id },
      groups: [syncGroup('account', member.accountId)],
      can: { conversations: ['read'] },
    };
  },
});
```

Your application authenticates the person and verifies membership on every
mint. The subject rule authorizes rows; `groups` proves membership; `can`
authorizes operations. Synchronization delivers the authorized data. A list
filter helps select a view but does not establish any of these permissions.
The provider's `userId` prop is informational, not an authentication mechanism.

## Browser reads and server writes share the scope

The browser creates an application-owned React client with the account-specific
session endpoint. It receives only read authority. The server uses its secret key
only to mint credentials, then creates a scoped client for the actual operation:

```ts
const session = await sessions.create({
  user: { id: member.user.id },
  groups: [syncGroup('account', member.accountId)],
  can: { conversations: ['read', 'create', 'update'] },
});
const client = Ablo({ schema, session, transport: 'http' });
try {
  await client.conversations.create({ data: {
    accountId: member.accountId,
    title: 'New chat', executionOwner: null, executionState: 'idle',
  } });
} finally {
  await client.dispose();
}
```

Resolve `member` on the server for this request. Do not accept a submitted account
ID as proof of membership. Do not reuse a privileged singleton for account writes.

On account switching, unmount the old account tree, dispose its client, and create
a new client pointed at the newly authorized account endpoint. The example keys
the component by account and creates each client in an effect, so Strict Mode
cleanup cannot dispose an instance that a later setup reuses. See [React](../react.md)
for both singleton and component-owned patterns and startup status.

## Long-running ownership

The example's `agent/index.ts` owns account-scoped run receipts;
`agent/execution.ts` owns the typed claim and writes. Its
`agent/lifetime.ts` owns a process handle with `done` and `stop()`; the handle can
outlive the function that started it. Server shutdown and normal stream completion
join the same completion promise.

The agent session carries account membership and `read`/`update` authority. See
[claim permissions](../coordination.md#claim-permissions): selecting claim fields
does not limit which fields that session can update.

The lifecycle follows these rules:

1. Acquire with `contention: { mode: 'skip' }`; a null grant means another agent
   owns the task. Dispose the unused client.
2. Install heartbeat loss handling during acquisition. Loss aborts application
   execution; every later model write also passes the held claim so the server
   rejects stale ownership.
3. Put initialization and the first write inside the cleanup boundary.
4. Make execution cooperate with its abort signal. Shutdown aborts execution and
   waits for it to settle before releasing ownership. Cancellation cannot undo
   an external side effect already performed.
5. Release in `finally`, and dispose in the release's own `finally`. A failed
   release must never prevent client disposal. Failed release falls back to TTL
   expiry; report the failure rather than presenting immediate release as certain.

The long-running agent takes an id-only lease with `claim(id, options)`, then
reads the row before each mutation and passes `reads: [current]` alongside the
claim. The lease supplies exclusion and fencing; each read supplies fresh
conflict evidence. The object-form `claim({ id, ... })` also captures a snapshot,
whose write guard remains fixed at acquisition even after your own writes.

The example claims both `executionOwner` and `executionState`, writes with the
claim, simulates generating, then stays idle while still holding ownership.
The `executionOwner` row value is historical metadata after release; the UI uses
`useAblo(client => client.conversations, id).claimed` for reactive ownership.
Both the row form and `useAblo(client => client.conversations.claim.state({ id }))`
subscribe to claim events. Applications decide how to recover
an interrupted execution-state field; a lease is not proof of ongoing generation.

Text buffering, tool execution and queued-message scheduling belong to the
application. They are deliberately outside this reference's coordination owner.

## Presence semantics

`usePresence(client => client.conversations, id)` declares a read lease while the
chat is mounted and returns sessions, including the current connection. Two tabs
can represent one person. Count people by participant identity; use
`presenceSessionId` when displaying sessions. Human and agent identities have a
`participant.kind` as well as an ID.

A read lease means “viewing”; a claim means “owns this chat”; application execution
state means “generating.” None substitutes for the others. Navigation releases
the previous read lease. Reconnect reannounces active reads. A disconnected
participant can remain visible until lease expiry.

## What proves the composition

The reference's tests cover membership, contention, initialization failure, first
write failure, ownership loss, duplicate cleanup, release failure and shutdown
during acquisition. Its Playwright scenario signs in two humans and an outsider,
checks forbidden account session/write requests and observes multiple tabs. Two
distinct agent identities contend on the exact conversation created by the test:
one executes and one skips, then another acquires after release. Bob renames the
chat while Alice is offline; reconnect must deliver that title to Alice. Selectors
use the conversation ID, so existing rows cannot change which chat is tested.

CI runs the browser scenario twice against the same isolated credential, alongside
the three subject-authorization journey suites. The existing journey harness
mints the key in temporary Postgres, starts real Redis and the sync server, pushes
the reference schema, and passes the credential only to the app's server process.
Missing infrastructure fails the lane. Run it from the monorepo root with
`npm run test:multiplayer --workspace=@ablo/sync-server`. This verifies the
checked-out server, not a deployed fleet; the browser suite can separately target
a deployed isolated branch.

The sync server's `subject-authorization` journeys test authorization beneath the
UI across hosted SQL/RLS, log-fold and endpoint paths, including direct-ID access,
lists, writes and claims. Run those alongside the browser test for the deployment
plane you use. A filtered UI hiding another account's row is not an isolation test.
