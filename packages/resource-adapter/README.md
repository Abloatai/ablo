# Protected workspace resources

This package supplies a managed Linux filesystem and Git adapter for Ablo's
claim → read → write → release workflow. The SDK owns the resource API; this
package owns the supervisor, kernel mount, durable publication and conformance
checks. It is distributed as the `adapter.tgz` asset of the Ablo GitHub release,
with a matching transaction SDK archive and SHA-256 manifest. It remains private
on npm; installing it does not enable a hosted service or protect existing runners.

Start at [src/index.ts](src/index.ts). The Linux implementation sits beneath it
in [linux/daemon.py](linux/daemon.py); persistence, filesystem enforcement, Git
validation and host identity allocation each have one owned file there.

## Execution contract

Run one trusted root supervisor per workspace on Linux, with FUSE, mount
namespaces, Python 3, fusepy, Git and util-linux. Supply a private persistent
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
A `stale_context` error rejects the whole write; reread every named dependency
and regenerate the edit. Ordinary filesystem watchers do not receive publication
notifications through this FUSE implementation; use the event feed.

Use a stable UUID `operationId` for a write. `outcome_unknown` carries that UUID;
call `getResourceReceipt(workspace, operationId)` before deciding what to do next.
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
links, directory rename, special files, Git worktrees/submodules and alternate
object stores. Git seed repositories use the standard SHA-1 object format.
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
