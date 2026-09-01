# Transports

> Transport follows identity: API-key services use HTTP and scoped sessions use one multiplexed WebSocket.

A session is not a WebSocket. It is the short-lived credential that identifies
an actor and bounds its authority. `Ablo()` owns the client lifecycle, and the
credential decides the normal transport; `transport: 'http'` is the explicit
escape hatch for bounded work that still needs a distinct session identity.

| Workload | Select | Lifetime |
|---|---|---|
| API-key route handler, job, cron, or serverless invocation | HTTP (default) | No persistent connection; dispose after bounded work. |
| Wait for one captured context to become stale | HTTP + `context().onChange` | One POST/SSE response, closed after the first matching change or cancellation. |
| Scoped user or agent session | WebSocket (default) | One reconnecting connection per client and Ablo cell, held until `dispose()`. |
| Human reactive interface | `humans()` / React client | One WebSocket owned by the long-lived client instance. |

## API-key services use HTTP

An API key identifies trusted service work, so no session or socket is needed:

```ts
const worker = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
try {
  await run(worker);
} finally {
  await worker.dispose();
}
```

For bounded work that must have a distinct agent identity, create a session and
explicitly select HTTP:

```ts
import Sessions from '@abloatai/ablo/sessions';

const sessions = Sessions({ schema, apiKey: process.env.ABLO_API_KEY });
const session = await sessions.create({
  agent: { id: runId },
  can: workerAccess,
  groups: [workspaceGroup],
});

const worker = Ablo({ schema, session, transport: 'http' });
```

Reads and administrative resources remain HTTP even when a session client also
has a WebSocket. The separate `Sessions(...)` issuer always uses HTTP. The
public model API does not change with the carrier.

## A session owns one reconnecting WebSocket

Use a session provider when the client must outlive one credential:

```ts
const session = () => sessions.create({
  agent: { id: stableWorkerId },
  can: workerAccess,
  groups: [workspaceGroup],
});

const agent = Ablo({
  schema,
  session,
  groups: [workspaceGroup],
  cursorStore,
});

await agent.ready();
try {
  for await (const delta of agent.observe()) {
    await apply(delta);
    await delta.checkpoint();
  }
} finally {
  await agent.dispose();
}
```

The provider represents one stable actor and grant. The client caches its
returned session, pre-mints a replacement before `expiresAt`, uses the newest
credential for later requests and reconnects, and prevents HTTP bootstrap plus
WebSocket setup from minting twice. A transient mint failure retries; only a
provider returning no session ends the logical session. Do not reuse one
provider across different actors, workspaces, or capability sets.

The socket reconnects after transient disconnects and requests replay from the
last durably checkpointed cursor. Uncheckpointed deltas may be delivered again.
An active observer has a bounded backlog and fails explicitly if its consumer
cannot keep up.

The session survives socket replacement, but socket-bound operations have
deliberate boundaries:

| State | After reconnect |
|---|---|
| Durable observation cursor | Replayed from the last checkpoint; duplicates before the checkpoint are discarded. |
| Active observer | Continues across a renewable credential expiry or transient socket loss. |
| Last acknowledged subscription | Restored on the replacement socket. |
| Presence | Re-announced after the replacement socket opens. |
| Commit awaiting a receipt | Rejects as `commit_no_result`; Ablo never guesses whether the server accepted it. Retry with the same idempotency key. |
| Row claim or queued claim | Ends with the socket. Re-read and acquire a fresh claim after reconnecting. |

A static session cannot renew itself. When its bearer expires, the session is
terminal and operations reject instead of reconnecting forever with the same
credential.

## Where SSE fits

SSE is not the session transport. On an HTTP client,
`context().onChange` opens one authenticated POST/SSE request and closes it when
one captured dependency changes. On a WebSocket client, the same operation
reuses the existing connection, so a long-running agent does not open a
side-channel SSE stream.

## Groups are two related boundaries

`sessions.create({ groups })` narrows what the credential may access.
`Ablo({ session, groups })` selects the initial subset that the
connection observes. Connection groups can narrow delivery but can never widen
the session's authority. The wire protocol still calls this field
`syncGroups`; that name does not escape into the application-facing options.

See [Sessions](./sessions.md) for issuance and renewal, [Agents](./agents.md) for
worker patterns, and [Options](./options.md) for connection tuning.
