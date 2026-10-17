# Managed filesystems and Git

> Coordinate native file edits and Git publication with enforced ownership, versioned reads and durable receipts.

Ablo can enforce ownership and read-version checks for files and Git refs in a
managed Linux workspace. Ordinary shell, editor and Git commands run against a
private view. Their changes become visible together only after all held claims
and earlier read versions pass validation. A durable receipt records the result.

## Install the matching release

Use SDK 0.66.14 with the adapter from the
[0.66.14 release](https://github.com/Abloatai/ablo/releases/tag/v0.66.14).
Download `adapter.tgz`, `transaction.tgz` and `manifest.json`. The manifest maps
each archive name to its SHA-256 digest; verify both before installation.

```sh
npm install @abloatai/ablo@0.66.14 ./adapter.tgz
```

The adapter package is named `@ablo/resource-adapter` and is distributed through
GitHub release assets rather than the npm registry. It pins the matching
`@abloatai/transaction` SDK. Runners using the checksum-verified private installer
can continue to supply the two named archives and manifest.

## Provide the protected workspace

Run one trusted root supervisor per workspace on Linux with FUSE, mount
namespaces, Python 3, fusepy, Git and util-linux. Give it private persistent state,
a persistent host UID registry and a tenant-unique workspace ID. Seed the Git
checkout once. The supervisor owns authoritative contents and refs; workers must
be unprivileged, have distinct UIDs and lack access to supervisor state and
sockets. Docker or mount privileges must never be passed to workers.

The Ablo server must support the `$ablo_resource` claim namespace. Scoped worker
credentials explicitly grant `$ablo_resource.update`; ordinary model permissions
do not grant filesystem authority. No application coordination table is needed.
Keep the server and adapter clocks within the configured bound (one second by
default). See the version-pinned
[adapter setup](https://github.com/Abloatai/ablo/blob/v0.66.14/packages/resource-adapter/README.md)
for supervisor configuration and the complete execution contract.

## Claim, read and write

The trusted service starts the supervisor and registers authenticated workers.
Within a registered worker process:

```ts
import { connectResourceWorkspace } from '@ablo/resource-adapter';

const workspace = connectResourceWorkspace('/run/ablo/workspace.sock');
const file = ablo.resource(workspace, 'src/example.ts');
await using claim = await file.claim();
const before = await file.read();
await file.write({ claim, reads: [before], content: updatedContent });
```

Here `ablo` is the authenticated HTTP client registered for that worker. The
socket binds the request to its kernel UID; the SDK checks the matching identity.
Native commands use `runResourceOperation`; persistent provider integrations use
`startResourceProcess` for bounded turns. Git publication additionally requires
claims for affected files and the destination ref.

## Preserve evidence and recover outcomes

Carry the signed reads that informed the worker into subsequent operations,
including reads visible in model history. A new claim cannot make stale context
current. On `stale_context`, reread the named dependencies and regenerate the
edit. Rejected private writes can also invalidate saved context.

Persist an operation UUID before launching a write. If the response is lost,
query `getResourceReceipt` with that UUID. Only `applied` confirms publication;
`running` requires reconciliation, and rejected or aborted operations publish
nothing. Do not launch a replacement operation merely because a reply was lost.
Use `getResourceChanges` for durable change notifications.

When reopening restored workspace state, the host UID allocator advances beyond
all retained operation UIDs. Existing receipts remain queryable and new operations
receive fresh UIDs, including on a replacement host. This does not fence another
authority: stop the previous authority before activating a restored copy.

Directory enumeration bounds nested listings to the requested path subtree using
the path index. It merges private staged additions and deletions without changing
the directory evidence captured by native reads. A bounded 1,024-entry cache keys published names by directory membership
revision; staged additions and deletions remain private to their operation. Cold
root listings still scan the path set. Content changes do not evict a valid
listing, while membership changes force a fresh one. File attribute reads query
metadata and blob length without loading file content; private staged metadata
still takes precedence over published metadata. Native mounts use the identity
from their admitted operation snapshot, avoiding an unlocked identity lookup on
the shared database connection during concurrent mount startup.

Filesystem modification times are persisted wall-clock values, separate from
read-evidence revisions. Publication updates file times and membership changes
update directory times; restart preserves them. This lets watcher startup checks
recognize an edit accepted while compilation was in progress. Legacy state adds
`mtime` columns on first open and conservatively initializes existing paths to
the upgrade time without changing their revisions or receipts. Back up state
before upgrading; older adapters cannot write the expanded table schema.
Preview transports may reduce timestamp precision: SFTP v3 carries whole seconds,
so subsecond same-size edits need revision-based invalidation rather than an
mtime-only polling guarantee.


## Supported scope

This release supports one trusted Linux supervisor per workspace, regular files,
directories and the documented Git operations. Files are limited to 16 MiB.
Hard links, symlinks, writable mmap, ordinary inotify publication notifications,
macOS/Windows mounts and multi-host filesystem authority are unsupported.
Persistent state, receipts and UID allocation need host storage quotas.

Existing writable checkouts are unaffected. A runner must explicitly route
reads and writes through the adapter, preserve signed evidence across resumes
and withhold success until an applied receipt arrives. Shell hooks or permission
prompts alone do not enforce this boundary. The Coding runner integration is
opt-in; production kernel and live-provider acceptance remain deployment gates.
