# Ablo dogfooding friction log

This is the durable feedback loop from first-party agent work into the Ablo
package. When our own agents hit a surprising API, misleading result, hidden
prerequisite, or manual recovery step, record the product-level problem here
and route the implementation to the package that owns it.

The log is not a workaround guide. An entry is closed only when the normal
public path becomes obvious, safe, diagnosable, and covered by a regression
test.

## Capture rule

For every friction event, record:

- the user intent and public import path;
- the call that looked reasonable;
- the observed error or misleading success;
- the hidden distinction the user had to discover;
- the owning package and permanent behavior we want;
- the regression test or executable diagnostic that will prove it fixed.

Operational failures belong here when a public SDK behavior caused them. Pure
AWS/Terraform runner failures stay with the runner's own operator contract.

## 2026-09-04 — distributed claim lifecycle dogfood

### HTTP and reactive clients looked interchangeable but were not

**Intent:** create session-scoped agents that execute
`claim({ id, queue: true })`, a protected update, and `release()` without live
subscriptions affecting the measurement.

**Reasonable call:** construct the familiar reactive `Ablo` client with
`transport: 'http'`.

**Observed behavior:** fixture creates appeared to succeed locally, but no row
was persisted. All later claims failed with `Entity not found`. Switching to the
transaction client crossed the HTTP API as intended.

**Product problem:** two constructors expose substantially overlapping model
surfaces, while a transport-looking option suggests they can be substituted.
The branded package should make headless HTTP and reactive client ownership
unambiguous in imports, types, docs, and runtime validation. A reactive client
must reject an unsupported HTTP configuration instead of accepting it and
producing local-only success.

**Owners:** `packages/ablo` for the public entrypoint and guidance;
`packages/humans` for reactive option validation; `packages/transaction` for
the headless client.

**Proof:** a package-level test must either persist through the documented HTTP
constructor or fail construction with an actionable message naming the correct
import.

### WebSocket lifecycle hooks leaked onto the headless HTTP path

**Observed behavior:** after moving to the transaction client, generic adapter
code called `waitForFlush()` and later `_ws.isConnected()`. The seed phase
failed with `Cannot read properties of undefined (reading 'isConnected')`.

**Product problem:** structural overlap let code treat HTTP and reactive clients
as one client even though their settlement and reconnection contracts differ.
The public types should carry an explicit transport capability, and methods
that require a WebSocket must not be callable on a headless HTTP client.

**Owners:** `packages/transaction` contract and `packages/humans` reactive
client.

**Proof:** typetests reject `waitForFlush`/socket reconnect on a headless client,
and runtime errors name the invalid capability rather than dereferencing an
internal field.

### Setup failure cascaded into sixty misleading operation failures

**Observed behavior:** one seed failure was followed by sixty `not found`
errors, obscuring the cause and spending most of the run on invalid work.

**Product problem:** batch/fleet users need a setup boundary that fails closed.
Confirmed creation must be distinguishable from local enqueue, and orchestration
should be able to assert authoritative fixture readiness before releasing a
workload barrier.

**Owners:** `packages/transaction` confirmation semantics and the first-party
testkit adapter.

**Proof:** an injected seed failure yields one setup error, zero measured
operations, and no inspection cascade.

The same run revealed a workload-design version of this problem: a twenty-agent
"fast" rung seeded fifty rows, spending admission capacity on fixtures while
barely exercising a queue. The fast profile now uses four shared rows. Scale
rungs must state the actor-to-row contention ratio as part of their evidence.

### Admission protection did not explain whether retry was safe

**Observed behavior:** inspection returned `The server is protecting established
work. Retry shortly.` During the same run, transport classification attempted a
WebSocket reconnect even though the request was stateless HTTP.

**Product problem:** overload errors need typed retry scope: request retry,
session reissue, reconnect, or do not retry. Generic prose is not enough for an
agent to choose safely.

**Owners:** `packages/transaction` errors and retry metadata.

**Proof:** the error exposes a stable code, retry-after information, and a typed
retry action; the HTTP client never suggests socket recovery.

**Resolution:** the public `AbloError` surface now exposes `recovery`,
`retryable`, and `retryAfterSeconds`. Both ordinary headless requests and
session issuance preserve the server's `Retry-After` header. The headless
transport waits for that duration and replays the exact rejected request below
the public operation boundary; the first-party fleet does not turn a stateless
HTTP rejection into a socket reconnect or restart a stateful claim workflow.

### A transport retry restarted the whole claim workflow

**Observed behavior:** after setup began succeeding, the first live rung
completed only 20 of 60 lifecycles. The fleet caught an admission rejection
above `claim → update → release` and ran that whole function again. This created
new claims while older queue entries were still moving and eventually reused
one idempotency key with a newly computed update body. The visible results were
`claim_lost`, duplicate active-claim, and idempotency-conflict errors rather
than one transient capacity error.

**Product problem:** a transient HTTP response says the exact rejected request
is replayable; it does not authorize replaying surrounding application logic.
Retry ownership must sit at the lowest boundary that still has the byte-identical
request and idempotency key.

**Owner:** `packages/transaction` headless HTTP transport.

**Resolution and proof:** the HTTP transport now honors `Retry-After` and
replays the same method, URL, and body inside the original `timeoutMs` deadline.
A regression test rejects the first request with `instance_at_capacity`, then
asserts the successful second request is identical. The fleet retains its
outer retry only for clients too old to expose the server-directed delay.

### HTTP polling mistook a queue handoff for permanent claim loss

**Observed behavior:** exact request replay removed the idempotency mismatch and
raised completed lifecycles from 20 to 31, but 29 of 60 still failed mostly as
`claim_lost`. Claim acquisition p99 reached 70.2 seconds while four hot rows
advanced through their queues.

**Product problem:** the shared claim authority deliberately releases a holder
and promotes its successor as separate operations. During that bounded gap,
lookup by claim id can momentarily see neither holder. The HTTP waiter treated
the first miss as final, abandoned a live queue ticket, and left a ghost that
could later be promoted. A documented non-atomic handoff requires matching
transition semantics at the polling boundary.

**Owner:** `packages/transaction` HTTP claim grant waiter; the authoritative
fence remains the server's correctness backstop.

**Rejected workaround:** a five-second grace raised completion from 31 to 50 of
60 lifecycles, but claim acquisition p95 was 85.0 seconds and live tickets still
surfaced as `claim_lost`. A timer cannot repair a lookup that discarded known
identity, and increasing it would only delay genuine loss.

**Resolution and proof:** the model client now heartbeats a queued ticket through
the model-and-row route it acquired from. That route addresses the queue
directly instead of rediscovering the target from whichever holder happens to
be visible. Fence minting still creates a smaller remove-to-publish transition;
enqueue and every successful queued heartbeat are server acknowledgements that
the ticket remains live for one lease window, so the waiter tolerates a miss
only inside that promised window. A regression test verifies the normal model
claim path uses the target-aware heartbeat through queued and granted states;
a ticket that remains absent after its acknowledged lease expires is abandoned
once. No guessed grace duration is involved.

The next identical run completed 58 of 60 lifecycles. The remaining
`claim_lost` coincided with admission shedding: the global v1 admission gate
classified claim heartbeat, polling, and release as new agent work. Under a
long queue, repeated admission delays can exceed the 60-second lease even
though the waiter is healthy.

**Resolution and proof:** claim continuation requests are now classified as
`established` work. Admission can still reject a new acquire, but once accepted
it preserves heartbeat, poll, and release through emergency pressure. Route
classification tests cover both id-only and model-target claim lifecycles and
prove a new acquire remains ordinary agent work.

The first subsequent rung still lost tickets because fence minting briefly
removes a waiter before publishing the holder. The package now treats enqueue
and successful queued heartbeat as explicit liveness acknowledgements: it
continues through a visibility miss only until that acknowledged lease window
ends. The identical next rung completed 60/60 with no unexpected errors or
mutual-exclusion violations.

### Successful report emission did not mean the client lifecycle was complete

**Observed behavior:** the Fargate controller had to stop the container after
the simulator report appeared because runtime handles remained alive.

**Product problem:** disposing session-scoped HTTP clients must deterministically
release timers, polling waits, abort controllers, and connection resources.

**Owner:** `packages/transaction`.

**Proof:** a process-level test creates sessions, claims/releases rows, disposes
all clients, and exits naturally within a bounded drain time.

## Open product improvements

1. Make `@abloatai/ablo` the unmistakable headless default and
   `@abloatai/ablo/client` the unmistakable reactive surface in generated code,
   examples, option types, and error messages.
2. Add transport capability discrimination so HTTP and WebSocket-only hooks
   cannot be mixed structurally.
3. Make authoritative setup confirmation a named operation with a fleet-ready
   diagnostic.
4. Guarantee and test bounded process drain after disposing HTTP/session claim
   clients.
5. Remove transport-shaped reconnect accounting from stateless HTTP profiles;
   the first correct rung still recorded one disconnect and a no-op reconnect.
