# Protected workspace resources

This package supplies a managed Linux filesystem and Git adapter for Ablo's
claim → read → write → release workflow. The SDK owns the resource API; this
package owns the supervisor, kernel mount, durable publication and conformance
checks. It is distributed as the `adapter.tgz` asset of the Ablo GitHub release,
with a matching transaction SDK archive and SHA-256 manifest. It remains private
on npm; installing it does not enable a hosted service or protect existing runners.

Start at [src/index.ts](src/index.ts). The Rust coordinator is owned by [runtime/src/main.rs](runtime/src/main.rs).
The Linux authority sits beneath the supervisor in [linux/daemon.py](linux/daemon.py); persistence, filesystem enforcement, Git
validation and host identity allocation each have one owned file there.

## Execution contract

Run one trusted root supervisor per workspace on Linux, with FUSE, mount
namespaces, Python 3, fusepy, Git and util-linux. Build the coordinator for the
host architecture using stable Rust (edition 2024): run `npm run build:runtime`
from the installed adapter package. The release archive ships locked Rust source;
it does not ship a macOS executable or fall back to Python admission. The test
Dockerfile builds the Linux executable in a separate Rust stage. Supply a private persistent
state directory and a stable, tenant-unique workspace ID. The supervisor owns
all authoritative file contents and Git metadata in SQLite. Import a seed
checkout once; subsequent starts use persisted state. Do not mount two separate
state directories as authorities for the same workspace ID.

The public mount is readable by registered workers and rejects every native
write. A write operation receives a fresh host-wide UID and private FUSE mount,
bound to the same workspace path in a private mount namespace. Normal Bash,
Python, editor executables and Git operate there unchanged. Their changes stay
private until the command exits successfully and every claim and read version
passes admission. One SQLite transaction publishes files, Git refs, change
events and the receipt. Failed or interrupted operations publish nothing.

For ordinary native commands, a nonzero exit produces a durable `rejected`
receipt with `code: command_failed`, `exitCode` and combined stdout/stderr (the
existing 1 MiB capture limit). Claims and read versions are validated first:
stale context or lost ownership still takes precedence. Staged files and Git
refs are not published. Receipt lookup remains owner-bound and survives restart.
Output is diagnostic evidence, not accepted source or reusable read context.
Failed-command output follows the existing unpruned SQLite receipt retention.
Only the final process exit status is checked: `failing-test; echo done` can
return zero. Run validation alone or explicitly preserve its exit status; a
successful shell receipt does not establish that every inner command passed.
Streaming processes continue to deliver output through their stream; their
failure protocol is unchanged. No schema or configuration change is required.

The SDK still throws `ResourceError` for rejected operations. Consumers retrieve
the operation's receipt to display diagnostics; they must not convert the failure
into success or automatically retry a mutation. Upgrade the adapter and the
consumer together to expose these existing optional receipt fields. Focused
checks: `tests/test_command_receipts.py` exercises SQLite rollback/restart/privacy
with a mocked command runner; `tests/native.ts` covers real failure output, output
bounds and unchanged source through Linux FUSE.


The root supervisor, its authenticated SDK clients and its state are trusted.
Workers must have distinct kernel UIDs, run without privilege, and have no access
to supervisor sockets or state. The host-wide identity registry at
`/var/lib/ablo-resource-adapter` must persist and be shared by every adapter on
that host. Registered UIDs cannot change authenticated scope; operation UIDs
are never reused. Do not hand workers the Docker socket or mount capabilities.
The test container grants those capabilities to its supervisor only.

A claim becomes usable only after the adapter durably installs its fence.
Takeover rejects the previous grant at publication and at subsequent writes to
its private view. Expiry is shortened by the configured clock-skew bound
(default one second); monotonic deadlines prevent local clock rollback from
extending a grant. Deployments must maintain that server/adapter skew bound.
Long native operations renew their grants, and renewal failure stops admission.

## Optional gVisor commands

`startResourceAdapter` accepts `gvisorRootfs` for network-isolated, noninteractive
commands under the existing protected filesystem boundary. Interactive native
providers are rejected in this mode. See the [operator setup, identity boundary
and kernel verification](../../docs/ops/gvisor-resource-commands.md).

## SDK and supervisor

Use the existing Ablo client for each authenticated worker. Scoped credentials
must explicitly permit `$ablo_resource.update`; no application model or
coordination table is required. That permission covers the configured workspace,
so issue it only to workers authorized to edit it. Normal model permissions do
not grant external resource claims.

```ts
import { Ablo, runResourceOperation, getResourceReceipt } from '@abloatai/transaction';
import { defineSchema } from '@abloatai/transaction/schema';
import { startResourceAdapter, connectResourceWorkspace } from '@ablo/resource-adapter';

const ablo = Ablo({ schema: defineSchema({}), apiKey: workerKey, baseURL, transport: 'http' });
const adapter = await startResourceAdapter({
  workspaceId: 'tenant/project/branch/workspace',
  stateDirectory: '/var/lib/workspace-1',
  mountpoint: '/work/workspace',
  socketPath: '/run/workspace-1/public/workspace.sock',
  seedDirectory: '/seed/repository',
  workers: [{ uid: 1001, client: ablo }],
});
// Inside worker UID 1001: the kernel authenticates the socket connection.
const workspace = connectResourceWorkspace('/run/workspace-1/public/workspace.sock');
const file = ablo.resource(workspace, 'src/api.ts');
await using claim = await file.claim();
const before = await file.read();
await file.write({ claim, reads: [before], content: updatedContent });

// A trusted runner launches the worker's unchanged native tool in this context.
await runResourceOperation(workspace, {
  claims: [claim], reads: [await file.read()], argv: ['python3', 'edit.py'],
});
```

The supervisor supplies credentials and owns adapter startup; worker processes
use their assigned UID to call the public socket. `workerUid` on the connection
helper is exclusively a root-supervisor option, never an authentication method
for unprivileged callers. The `ablo.resource` facade additionally checks that its
resolved Ablo identity matches the socket's registered worker.

For a native Git commit, include claims for changed source files and
`{ kind: 'ref', name: 'refs/heads/main' }`. Supply the ref read when an expected
commit came from earlier context. Native `git update-ref` also checks its own
expected commit. Incoming merges and ref-only updates reject when an affected
file has another active claim. Git config and hooks cannot be edited in an
operation; Git validation runs under safe supervisor configuration. Configure
seed repositories with `git config core.createObject rename`, because this
adapter deliberately rejects hard links.

A runner must pass earlier read evidence into each tool invocation, including
reads used in model prompts. Native reads are pinned automatically during that
invocation, including missing paths and directory listings. Starting an agent
once and allowing unrestricted edits against a normal writable checkout does
not satisfy this contract. Integrating Claude Edit or Codex requires their
runner to execute each write tool in an adapter operation; the separate Coding runner integration must be explicitly enabled.

## Notifications and interrupted writes

`getResourceChanges(workspace, { after: cursor, reads })` pages durable changes
and names stale reads with `action: 'reread'`. Carry the returned cursor forward.
For realtime delivery, keep one `connectResourceWorkspace` connection per worker:

```ts
const subscription = await workspace.watch(['file:src/app.ts', 'file:src'], {
  after: savedCursor,
  onChanges(batch) { /* invalidate matching context; persist batch.cursor */ },
  onError(error) { /* resync_required: reconnect and watch from savedCursor */ },
});
// await subscription.close(); workspace.close();
```

Each connection supports one subscription with up to 256 resource dependencies.
Subscribe to every file, missing path and directory dependency retained in context.
Directory events describe membership changes. The initial catch-up and live feed
overlap safely by durable sequence; reconnect explicitly from the last processed
cursor. Slow or interrupted subscribers receive `resync_required` or disconnect,
never a silent drop. Callbacks are synchronous; persist processed cursors as part
of the caller's context handling. Notifications prompt invalidation; signed reads
are still validated atomically at publication.

A `stale_context` error rejects the whole write; reread every named dependency
and regenerate the edit. Ordinary filesystem watchers do not receive publication
notifications through this FUSE implementation; use the event feed.

Use a stable UUID `operationId` for a write. `outcome_unknown` carries that UUID;
call `getResourceReceipt(workspace, operationId)` before deciding what to do next.
It means the write may have completed but its reply was lost. A disconnected
read or claim reports `connection_lost` instead; reconnect and retry it.
`applied` means the durable write completed. `aborted` or `rejected` means it did
not publish. `running` means wait and check again. `absent` means this authority
has no record; retry only the identical intent with the same UUID, which is
bound to the original owner and exact request. A restart retains terminal
receipts, aborts unfinished staging and requires fresh claims.

Stop the daemon before releasing its claim gateway; `adapter.close()` does both.
The API is text-oriented; native tools may read binary files. Files are limited
to 16 MiB. Native operations have a five-minute maximum, capture at most 1 MiB
of output and terminate all processes with their operation UID on completion.
Keep quotas on the execution domain and persistent volume: retained operation
receipts, events and identity allocations currently have no pruning policy.

## Checks

From the repository root:

```sh
npm run test --workspace @ablo/resource-adapter
node packages/resource-adapter/scripts/test-linux.mjs
npm run test:journeys --workspace @ablo/sync-server -- src/__journeys__/resource-adapter.journey.test.ts
```

The Linux script builds a disposable image and exercises real kernel mounts,
peer credentials, writes, rename/delete, expiry, takeover, stale reads, Git,
concurrency and restart recovery. The journey repeats that suite with real
Postgres/Redis-backed Ablo leases and scoped credentials. Build the image first;
the journey does not silently replace enforcement with mocks.

File modification and change timestamps reflect durable revisions rather than
wall-clock dates, so native Git can detect same-size content changes.

The supported filesystem subset rejects writable mmap, new symlinks, hard
links, special files, Git worktrees/submodules and alternate
object stores. Directory moves require claims for every removed and surviving
subtree path; nonempty destination replacement is rejected. Git seed repositories use the standard SHA-1 object format.
This is a managed execution domain for the verified subset, with fail-closed
errors for unsupported operations. General POSIX compatibility, macOS/Windows
mounts, multi-host filesystem authorities and transparent integration with
existing agent tool servers are outside this implementation.

## Native read evidence for persistent callers

Native `run` accepts `claims: []` for a bounded read-only invocation. The same
kernel mutation checks deny filesystem and Git writes without claims. Each
terminal receipt retains `reads` (resource, revision, signed evidence), including
missing paths, directory listings and earlier supplied reads. Receipts never
contain dependency file contents. Persist this evidence beside the exact
model-visible tool result and pass it into later operations across resumes.
Public-mount reads still do not produce receipts; a runner must route model-visible
reads through bounded operations too.

Receipt evidence attests the original dependency revision, even when the same
operation subsequently writes that resource, rejects or is interrupted. Do not
replace earlier context with current reads at claim time. On `stale_context`,
explicitly reread affected dependencies and regenerate the edit; only then may
the runner retire that old context. Mixing old and new versions rejects with
`read_evidence_conflict`. Successful claim-free reads have status `applied` but
publish no file changes. Interrupted operations retain any captured evidence
alongside their terminal receipt; they never publish staging.

## Protected native turns

`startResourceProcess` supplies stdin, stdout and stderr for one native CLI turn.
Use a root-owned `connectResourceWorkspace` transport and persist `operationId`
before launch. Supply scoped claims, signed earlier reads, a UUID `profileId`,
the unchanged CLI/SRT command and a deadline up to five minutes. The exported
`RESOURCE_PROFILE_HOME` is the stable logical home used when constructing the
caller’s sandbox policy. Do not supply HOME, CODEX_HOME, CLAUDE_CONFIG_DIR or
TMPDIR overrides: the adapter binds an owner-specific profile at that path in
the private mount namespace and sets those variables itself.

The returned handle has `stdin`, `stdout`, `stderr`, `homePath`, `completed`,
`complete()` and `abort()`. Streams each accept up to 16 MiB; overflow aborts
rather than truncating native protocol messages. Only the authenticated root
transport may complete a turn. Completion closes stdin and allows up to five
seconds within the deadline for native history flushing and sandbox cleanup.
Failed graceful shutdown rejects publication. It then kills its never-reused UID domain,
waits for all live processes to exit, syncs the private profile, validates
ownership and dependency versions, and atomically publishes the durable receipt.
The CLI’s own completion notification is provisional until that receipt is
`applied`. Cancellation, deadline, early process exit and disconnection discard
staged writes and preserve signed dependency evidence. If a reply is lost, query
the existing operation ID through `getResourceReceipt`; never launch a replacement
operation blindly. Duplicate IDs do not start another child.

Rejected or aborted staging marks the affected evidence as unpublished context.
Native history may retain tool success for bytes that never reached the public
workspace. Reusing that evidence rejects even when the canonical version is
unchanged; explicitly reread and regenerate instead. Receipt recovery preserves
this marker rather than silently re-attesting the current canonical version.

Profiles are exclusive, bound to the worker’s full authenticated identity, and
stored beneath the supervisor’s root-only state directory. A fresh UID receives
the profile through a private bind mount each turn; teardown restores root
ownership. The private `tmp` subtree is discarded after domain teardown, including
sandbox sockets; persistent provider history remains strict. Other workers cannot
open the profile. Missing registered profiles,
links in required profile directories, hardlinks and special files fail closed.
The provider must finish flushing its history before requesting completion;
native resume errors must be surfaced rather than silently starting fresh.
CLI history remains in native provider format; the adapter does not repair it.

The runner must preserve signed reads alongside model-visible history, gate final
success on publication, and start a fresh protected process each turn. After
stale-context rejection it must explicitly discard/regenerate affected context;
reacquiring a claim is insufficient. Permission hooks and PATH shims alone do
not provide these guarantees. Lobby integration is owned by the separate Coding
repository; enabling this API does not protect existing persistent sessions.

`npm pack --workspace @ablo/resource-adapter` produces an installable private
package containing compiled JavaScript and the Linux implementation. Install it
alongside the matching transaction SDK version. The release assets contain
`adapter.tgz`, `transaction.tgz` and `manifest.json` for checksum-verified runner
installation. Packing does not publish a release or enable production runners.

The release asset builder runs the replacement-host regression against the
archive's Python authority before writing its checksum manifest. Restored receipts
must survive, the first new operation must receive a fresh UID, and reopening
must not lower the host allocator. To check an existing downloaded asset, run
`python3 packages/ablo/scripts/verify-resource-recovery.py /path/to/adapter.tgz`.

## Concurrent admission and context precision

Rust owns the public Unix socket and authenticates kernel peer UIDs. Each worker
uses one persistent connection with request IDs; interactive native processes use
dedicated streams. The private Python socket is root-only. Do not mix an old
one-request transport with the new public protocol; upgrade the adapter and its
connection helper together.

The coordinator admits at most 2,048 connections and 16 pending requests per
connection. Read/control, urgent receipt/heartbeat/release, mutation, and native
execution lanes have 8, 4, 8, and 8 active slots respectively. The trusted host
may set `startResourceAdapter({maxConcurrentProcesses: 10, ...})` to change only
the execution lane (integer 1–64; default 8). This budget is shared by native
streams and command operations. Size it for host memory/CPU; exhaustion still
returns `adapter_busy`, while receipt, release and heartbeat capacity remains
reserved. The coordinator accepts the same optional fourth CLI argument; workers
cannot change it through requests. Restart the authority to change capacity. Non-native admission
waits at most two seconds behind a bounded 1,024-request queue. An execution above the configured budget (the ninth by default)
receives `adapter_busy` immediately. This separates connected agents
from simultaneous native processes; it does not promise 1,000 running sandboxes.
The private Python authority retains its 32-handler bound.

Input and retained replies have separate 64 MiB wire-size budgets, not a total
process RSS guarantee. Slow socket writes expire after five seconds. The shared
feed retains 256 batches of at most 100 events. The authority wakes one durable
change reader after commit, including when the writer loses its response. Rust
shares those batches among matching subscribers; idle subscriptions do not poll
SQLite or rebuild context. Startup reads the latest durable cursor before
admitting subscribers; it does not scan historical events. Initial subscription
and reconnect do durable catch-up from the caller's saved cursor.
Lost mutation replies retain `outcome_unknown`; reconcile the operation receipt
instead of automatically replaying a write.

The supervisor stops admission if either coordinator or authority exits. Graceful
shutdown removes the public socket. After an unclean process kill, startup takes
an exclusive lock and reclaims only an owned, inactive socket. Active listeners
and ordinary files are preserved. Keep the adjacent `.lock` file in place; the
kernel releases its lock when the process exits. The socket directory must be
supervisor-owned and not writable by workers. Filesystem durability and fenced publication remain in the
existing SQLite/FUSE authority.

Directory revisions change when a child is added, removed or changes type.
Editing an existing child's contents does not invalidate a directory listing or
an unrelated file's context. The edited file's revision still changes; reads of
that file remain stale, including after change-and-revert. Missing-path and
membership evidence remains protected against intervening creation or deletion.

Managed resource claims now request non-queued acquisition. An occupied resource
returns `claim_conflict`; callers can choose another task or retry explicitly.
Network and authority failures remain `claim_unavailable`. Existing holders still
renew and release through the same fenced authority. Direct SDK
`claims.acquireResource` keeps its existing wait default; callers can pass
`contention: { mode: 'skip' }` to reject contention without joining the queue.
Deploy the adapter with the matching SDK build containing this option.

For work that should wait its turn, configure the supervisor's worker SDK clients
with `transport: 'websocket'`, then use `await resource.claim({ waitMs: 10000 })`.
The authority queues the request and pushes its grant to that worker. Rust parks
the wait without a Python handler or a read/write/receipt/execution slot, then
passes the granted fence to the private installer. It does not poll claim state
or reread file contents. Read the needed files after the grant; earlier signed
reads remain unchanged and may correctly fail with `stale_context`.

Waits accept 1–30,000 milliseconds and have a separate 1,024-request limit;
16 acknowledged connection handshakes at a time protect the private gateway
backlog. A duplicate pending wait for the same worker/resource returns
`claim_pending`; excess waits return `adapter_busy`. HTTP-only clients return
`realtime_claims_required` rather than silently polling. Queue timeouts return
`grant_timeout`. At the deadline the SDK makes one WebSocket heartbeat check,
allowing up to two seconds for a current held fence to recover a missed grant.
This is not periodic polling; failure still uses confirmed claim cleanup.
Disconnecting a worker cancels an ungranted wait; a grant already
handed to the installer may survive a lost reply until release or expiry. Repeat
acquisition as the same worker to recover that held grant, never replay a write.


The focused suite includes a queued 64-connection burst with a 32-handler cap,
16 distinct owners publishing disjoint edits from unchanged contexts after an
unrelated edit, directory membership invalidation and prompt gateway conflicts.
The previous backlog and store fail the new regressions. These local tests do
not replace the Linux FUSE and two-VM acceptance run.

Build Rust and run `npm run test:coordinator --workspace @ablo/resource-adapter`
with a host file-descriptor limit above 4,096 (for example `ulimit -n 8192`). This
check uses 1,000 logical worker identities and real Rust/SQLite on local sockets;
FUSE and native execution are explicit test doubles. It covers notification fanout,
16 disjoint writes, saturated execution, durable catch-up, a lost writer response,
fragmented frames, a slow reader, coordinator crash recovery and authority restart
with committed receipts, interrupted operations and revoked leases. It does not establish production latency,
real kernel UID isolation on macOS, Linux sandbox capacity, or multi-host scale.

Recorded local results and scope: [1,000-worker evidence](tests/evidence/2026-10-13-coordinator.json).

AWS Linux acceptance passed all 26 real FUSE/native tests and the 1,000-logical-worker
coordinator suite, including process crash recovery. The same crash check fails on
the previous coordinator with `AddrInUse`. This remains single-host acceptance;
the scale fixture still substitutes native execution and claim installation.
Environment, measurements and limits: [AWS evidence](tests/evidence/2026-10-13-aws-recovery.json).

Follow-up [claim-wait acceptance](tests/evidence/2026-10-13-aws-claim-waits.json)
passed 28 Linux native tests, five Rust tests (including 1,024 parked waits),
two gateway tests and the existing 1,000-worker recovery suite. The upstream
claim service is simulated in these adapter checks; live cross-host grants
and hosted claim throughput remain separate acceptance work.

The hosted Node claim authority forwards targeted `claim_granted` and `claim_lost`
notifications through its existing Redis fanout. A waiter connected to another
server therefore receives promotion without polling. The cross-replica regression
covers a three-participant handoff, fencing-token delivery, branch/tenant isolation,
and no duplicate local echo, using in-process hubs and mocked Redis.

[AWS claim-delivery acceptance](tests/evidence/2026-10-13-aws-grant-recovery.json)
uses real Redis, WebSockets and two coordinator processes on one isolated host.
It verifies ordinary handoff, one deliberately dropped grant recovered by the
SDK's single deadline check, and 1,000 queued identities completing their handoffs.
Identities are admitted sequentially; this is not a connection-burst benchmark.
Authentication, SQL, and fence minting use fixtures; Rust/FUSE and native agents
are not part of this test. Cross-host network partitions remain unverified.

Run the fixture against disposable Redis on loopback with
`node --import tsx apps/sync-server/scripts/claim-delivery-acceptance.ts`.
`CLAIM_TEST_REDIS_URL` defaults to `redis://127.0.0.1:6379/15`; the fixture uses
unique keys and never flushes the database. `CLAIM_TEST_WAITERS=0` selects only
the normal and lost-publication checks (the default is 1,000).

The authority cancels an admitted claim atomically across its queued and held
states, so promotion cannot slip between a status read and cleanup. WebSocket
queues track their originating connection; disconnect cancels its pending tickets,
including enqueue replies that arrive after closure. Successful promotion is not
mistaken for cancellation when its notification precedes the enqueue reply.

[Redis fault and cancellation acceptance](tests/evidence/2026-10-13-aws-claim-cancellation.json)
adds real Redis subscriber disconnection, twenty cancellation/promotion races,
and queued-client disconnect cleanup to the same isolated AWS fixture. It does
not exercise full hosted Hub catch-up, process death, or cross-host partitions.

[Two-host recovery acceptance](tests/evidence/2026-10-13-aws-twohost-recovery.json)
runs the claim coordinators on separate AWS hosts with real Redis across the
private network. Cancellation now covers authorization and acquisition, including
an authority reply arriving after the client leaves. Expiry checks use Redis's
clock atomically, so a timer cannot revoke a remotely renewed lease. Waiting
replicas retain expiry responsibility across promotion; a dead granting server
need not leave its queue stranded. The SDK also survives reconnect errors when
no caller is listening for an error event.

The fixture verifies 1,000 sequentially admitted identities, renewal on the other
host, and `SIGKILL` recovery with one-second test leases. Production recovery
still waits for its configured lease deadline. Fixture authentication and fencing
remain substitutes for hosted authorization and Aurora; neither full network
partitions nor 1,000 executing agents are established by this result.

For isolated two-host acceptance, set `CLAIM_TEST_PRIVATE_NETWORK=1` and
`CLAIM_TEST_REDIS_URL` on both hosts, with the same `CLAIM_TEST_RUN`. Start the
peer with `CLAIM_TEST_BIND` set to its private `10.x` address and
`CLAIM_TEST_PORT=3001`, running the fixture with `server` as its argument. Run
the driver on the other host with `CLAIM_TEST_PEER_URL=http://PRIVATE_IP:3001`.
Permit Redis and the fixture port only between those disposable hosts.

[Authority-outage acceptance](tests/evidence/2026-10-13-aws-authority-outages.json)
checks TCP resets, silent packet loss and a Redis restart with AOF retained.
Failed expiry work now retries with backoff from 250 ms to five seconds;
healthy leases are not polled. Releasing the claim or disposing the coordinator
cancels its retry. Each four-second interruption covered 16 independent targets
across the two hosts: none granted during isolation, and all completed through
pushed grants after restoration without client probes.

The fault run uses `appendonly yes` and `appendfsync always` to retain the queue
through restart. Its throughput must not be compared directly with the earlier
non-persistent fixture. The evidence includes a separate default-persistence
control on the same hosts. This tests retained-state restart, not replica
failover or loss of acknowledged Redis writes.

To repeat the fault checks, run the two-host fixture with `CLAIM_TEST_FAULTS=1`
and keep the driver's stdin open. It prints `faultControl` JSON with a `fault`
(`reset`, `drop`, or `restart`) and an `action` (`isolate` or `restore`). Apply
that action, then send one line on stdin to acknowledge completion. For `reset`
and `drop`, insert an OUTPUT rule on **both disposable hosts** matching TCP
port 6379 with `REJECT --reject-with tcp-reset` or `DROP`, respectively; remove
the same rule on restore. For `restart`, stop and start the fixture's Redis
container without deleting its AOF data. The driver waits four seconds between
isolation and restoration and asserts both absence of grants while isolated and
successful handoff afterward. These checks do not exercise the production Hub's
connection closure and catch-up policy during a Redis gap.

The Hub's planned fan-out recovery reconnect now retains pending queue tickets
until their existing expiry. The SDK recognizes that specific close reason,
reauthenticates and resumes the same claim ID. Resume reads current Redis state
atomically: it cannot create a missing ticket, extend its expiry, change its
FIFO position or mint a replacement fence. Expired or canceled tickets fail;
ordinary disconnects still cancel their pending requests. Existing wait deadlines
and abort signals apply throughout reconnect. Clients that never return leave
only the already bounded lease lifetime, not a permanent reservation.

`apps/sync-server/src/hub/Hub.claimReconnect.realws.test.ts` exercises the full
Hub and SDK over real loopback WebSockets and disposable Redis. Two queued
identities survive two subscriber interruptions with unchanged queue timestamps,
fresh authentication and ordered grants. Run it with `REDIS_REAL_TEST=1` and
`REDIS_REAL_URL` pointing at a disposable Redis instance; the test disconnects
that instance's pub/sub clients. Authentication and SQL delta replay are fixture
implementations. This verifies claim recovery, not production authorization,
database catch-up or network partitions.

Set `CLAIM_RECONNECT_WAITERS=1000` to exercise simultaneous recovery at scale
(the initial queue is admitted sequentially). On an isolated AWS c7g.xlarge,
the original full-Hub run timed out after five minutes before reconnect testing:
every enqueue sent the growing queue snapshot to every worker. The worker session
API has no peer queue view, so it now explicitly opts out of those snapshots on
each connection. Legacy transports and reactive queue views still receive them;
individual queue positions, grants and losses are unaffected.

The same AWS fixture then completed 1,000 queued claims through two simultaneous
reconnect waves, preserving FIFO and enqueue timestamps. Measurements and limits:
[AWS full-Hub reconnect evidence](tests/evidence/2026-10-14-aws-hub-reconnect.json).
The host ran the Hub, all SDK clients and Redis together; authentication, SQL
replay and fence minting were fixtures. Rust/FUSE execution was not exercised
by this test.

Queue delivery now follows interest. A changed queue sends a small invalidation
across Hub instances; a Hub with no full-line viewers does not read or publish
the line. Interested Hubs coalesce refreshes and send versioned append/remove
patches after an initial snapshot. The SDK applies those changes to its local
line and builds a public array only when `queueFor` is read. Redis admission
uses an expiry index and assigns strictly increasing scores when arrivals share
one millisecond, preserving FIFO order without scanning every waiter. Set
`CLAIM_QUEUE_INCREMENTAL_READY=1` only after every Hub writer runs the
index-writing version; the first rolling deployment scans and repairs the index
so old writers cannot leave invisible waiters behind.

On a temporary AWS c7g.2xlarge, 1,000 sequentially admitted workers with no
full-line interest and the indexed path completed admission in 0.88 seconds, with zero queue reads
and zero queue frames; a post-measurement read verified the exact FIFO line.
With all 1,000 clients observing the entire line, admission took 9.90 seconds
and all observers converged, but the run still sent 229 MB of queue frames and
used 1.56 GB combined process RSS. The latter is a deliberately demanding
full-view workload, not the worker-session path. See the exact fixture, checks
and limits in [AWS queue-interest evidence](tests/evidence/2026-10-14-aws-queue-interest.json).

Blocked admissions and renewals now avoid minting an unused Aurora fencing
token. A fresh grant first checks Redis, mints only when needed, then atomically
rechecks ownership before publishing the lease. This adds one Redis check to
fresh grants while removing a database call from contention and renewal. Full
queue JSON is serialized only when a recipient needs it. A local 1,000-worker
check reduced fence mint calls from 1,000 to zero; its wall time was roughly
unchanged and does not establish a production latency gain. See
[local claim-mint evidence](tests/evidence/2026-10-14-local-claim-mint.json).

See [directory evidence](../../docs/ops/resource-directory-evidence.md) for the
publication rule, restart behavior and focused native/store regressions that
separate independent sibling edits from real membership conflicts.

AWS verification for this diagnostic path: the old daemon failed the new native
exit-code assertion; the patch passed 31 native, 29 Python and five Rust checks.
Ten real Claude CLI agents then received rejected assertions, repaired ten
independent modules and passed independent retests in 19.4 seconds. The initial
model arm masked failures with trailing shell commands and did not cover this
path; it remains recorded. This is a small synthetic fixture with local claims,
not full-repository or cross-host source acceptance. See the
[diagnostic evidence](tests/evidence/2026-10-15-command-diagnostics.json) for
exact revisions, trace sequences, controls and limits.

Directory listings return entry types as well as names. This avoids an `lstat`
fallback per child in `scandir`/ripgrep traversal and guards the observed names
and types with the parent membership revision. Explicit `stat`, `open` and file
reads still capture file evidence; creation, deletion, rename and type changes
still invalidate directory evidence. This does not solve retained native context
becoming stale after its own successful write.

For explicitly project-authorized native CRUD without a pre-enumerated file list,
see [project-file publication](../../docs/ops/project-file-publication.md).
This opt-in still acquires exact server-backed leases before atomic publication.
