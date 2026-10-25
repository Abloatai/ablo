# Project-authorized native file publication

`startResourceAdapter` workers may opt in with
`projectFiles: { authorize(context): Promise<{ validForMs }> }`.
The trusted callback receives `{ sourceWorkspaceId, workerUid, operationId, signal }`. It must
verify current project **write** membership and the exact active participant/run
binding using the application's authority endpoint. Bind the original operation ID
to its sealed run metadata before native start. Unknown operations and old
operations after worker/run rebinding must be denied; a new run cannot authorize
an older operation. `client.ready()` is cached
initialization and is not an authorization refresh. No callback means existing
static-file behavior. A read-only participant must never receive this option.

The callback is supplied by trusted orchestration, not a model, filesystem path,
JSON field or caller-provided URL. The gateway checks the callback's bounded
lease, keyed by authenticated owner **and operation ID**, (`clockSkewMs < validForMs <= 60000`); missing, expired, revoked, unknown or
unavailable authority fails closed. The Coding source-project registry/endpoint
must supply and validate the complete authenticated binding before enabling this
option in a hosted runner. Require the adapter export
`RESOURCE_PROJECT_FILES === 'publication-v1'` before configuring project mode;
older JavaScript SDKs can otherwise ignore an unknown option. This Core change alone does not establish that wiring
or qualify a hosted deployment. Existing image5 does not support this option.

## Ownership and runtime

This opt-in authorizes private staging anywhere in the enrolled source; it is
not a recursive lease. Static/read-only workers keep their existing rules.
Project mode rejects ref claims and does not authorize Git metadata writes.
The kernel private operation view captures original file revisions, absence and
changed directory membership even when the model did not explicitly read them.
All native descendants stop and are reaped before publication begins. Profile
closure retains native history through the existing ownership boundary.

The trusted supervisor then freezes the entire surviving net diff under the
store lock. It records a versioned `operations.publication` witness separately
from immutable `operations.intent`. The witness contains the diff/premise digest,
exact paths, operation/resource request keys, and returned claim/fence pairs.
Directory renames include every surviving old and new descendant path; claiming
a directory does not cover its children. Temporary paths that disappear are not
published or claimed.

The supervisor releases the SQLite transaction and store lock before requesting
exact `file:path` leases through the existing authenticated gateway/SDK. It uses
skip contention, acquires in sorted path order, and releases a partial grant set
on failure. It refreshes current project authority before acquisition and again
before committing, and heartbeats each exact grant. Publication has a 30-second
budget, excluding already bounded upstream transport failure time. A failed
request never counts as a grant.

Within the final atomic transaction, publication verifies current authority
lease, unchanged frozen diff, captured premises, and each exact lease's owner,
claim, fence and monotonic expiry. Every accepted changed path must have a valid
exact lease. Source bytes, events and applied receipt/witness commit together.
The adapter removes the operation's authority deadline on settlement.
The supervisor finally releases its dynamically acquired leases; the caller
retains responsibility for supplied static claims. The existing gateway holds
unreleased grants until close or lease expiry.

## Conflicts, revocation and recovery

This is optimistic concurrency: two participants may edit the same private file.
A held exact lease excludes the other publication; a changed captured premise
rejects the whole turn. Nothing partially publishes. Authority refresh runs
before native admission, during execution and before publication. Revocation or
refresh failure stops/reaps native descendants and follows existing rejected
history handling. Distributed revocation retains the explicit bounded authority
lease and exact-lease validity assumptions; it is not instantaneous offline
revocation.

A conflict can occur after native tools reported successful private writes.
Existing rejected receipts mark staged evidence unpublished. The application
must use that receipt and its existing stale-context/fresh-profile policy rather
than telling the model its local bytes were accepted or discarding its history.
Source/native profile/Coding ledger must still be captured together only when
all operations are idle, with the existing source-owner retirement fence.

The SDK derives the claim target deterministically from workspace/resource; the
gateway deduplicates by authenticated owner/resource. An unknown acquisition
reply is not a permission to retry native execution. If the gateway received a
grant, it retains that handle for close/expiry; otherwise the original witness
records the attempted exact target and cleanup waits for server reconciliation
or TTL. No new lease authority or mirrored claim table is introduced.

On restart the store invalidates grants and aborts interrupted operations. The
publication witness remains audit evidence, never restored active authority.
After a lost applied reply, reconcile the original operation ID: the durable
receipt includes the same publication witness, with no second command or event.
New image/checkpoint/delta schema validation must retain the nullable publication
column; do not downgrade a live project-mode authority to an older image.

## Focused verification

`npm test --workspace @ablo/resource-adapter` covers publication base/absence and
membership races, partial conflicts, final revocation, unknown acquisition
replies, changed frozen diffs, static rejection and replaced fences, plus real
Unix gateway authority validation. The transaction resource regression checks
publication-witness preservation when an applied reply was lost.

The Linux native tests matching `project files` exercise actual FUSE CRUD without
an operator file list, independent static-reader denial, exact per-path claims,
profile retention and unpublished evidence after conflict, operation-ID replay,
source/profile restart and final revocation. They use an explicit test authority,
not a hosted membership service or a real model. No hosted adoption claim follows
from these local checks.

The FUSE view accepts only idempotent ownership requests naming the admitted
operation UID/GID (or unchanged IDs), with normal mutation authorization. This
supports the gVisor gofer ownership check after file creation; ownership remains
fixed and attempts to transfer it to root or another participant are rejected.
