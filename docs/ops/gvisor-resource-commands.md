# Protected commands in gVisor

The Ablo-owned resource adapter has an opt-in gVisor backend for noninteractive
`runResourceOperation` commands. Source ownership, leases, signed read evidence,
private staging and receipt publication stay in the existing adapter. The default
native backend is unchanged. This option does not enable a pooled runner service
or change Lobby's hosting configuration.

## Operator configuration

Configure `gvisorRootfs`, `gvisorCgroupRoot`, `gvisorMemoryLimitBytes` and
`maxConcurrentProcesses` in `startResourceAdapter`. The delegated jobs subtree
must have a finite memory budget and leave room for the supervisor. See
[command memory isolation](gvisor-command-memory.md) for setup and verification.
These are trusted supervisor settings, never options in a worker's run request.
The adapter requires Linux and root as before. Install the wrapper, coordinator
and all Linux modules from one reviewed adapter build. Pin the image/runtime
versions and drain commands before replacing them.

Install the complete, verified gVisor release at `/usr/local/bin/runsc`, including
its adjacent `gvisor-bin` helpers. The focused qualification uses
`release20261019.0` on arm64/systrap. Keep binaries and the image root-owned and
unmodifiable by workers; executable files must be readable/executable by the
operation UID. Binary and rootfs paths, including ancestors, must not contain
symlinks or group/other-writable components.

Prepare a credential-free filesystem from a pristine approved runtime image,
with the language runtimes and dependencies the commands need. Do not export a
live authority or a logged-in agent. Create an empty directory at the configured
mountpoint inside that image, for example `rootfs/workspace/repository`. Its
`tmp` directory must be root-owned with mode `1777`. The adapter validates these
startup requirements and does not repair or fall back from a bad image.

Only the protected source mount and the operation's disposable scratch/home are
bound read-write. The image is read-only; proc, devices and tmp are virtualized.
The guest receives the supplied command/environment after containment, not in the
trusted launcher. No supervisor state, credential directory or Docker socket is
mounted. Tools that depend on other host paths need an image containing those
tools; arbitrary extra mounts are not supported.

## Identity and publication

The root launcher creates a parent user namespace mapping its root to the
adapter's existing, never-reused operation UID. gVisor runs rootless within that
namespace, with zero guest capabilities and networking disabled. Guest UID zero
is therefore the admitted host operation UID, not host root. Mapping only the
OCI gofer is insufficient: Sentry also reads donated file descriptors, and every
such access must reach FUSE under the same operation identity.

The normal FUSE boundary captures native reads and guards writes. The command's
files remain staged until successful exit, claim/version validation and receipt
publication. Nonzero exit, stale reads, expiry, timeout or teardown failure cannot
publish the staged edit. Existing owner-bound receipt recovery remains the
reconciliation mechanism; an uncertain result is not permission to rerun a write.

On interruption the supervisor stops the launcher's process group before killing
and reaping the UID domain, including detached runtime children. Both the launcher
and namespace child use parent-death signals, rearmed in the child after changing
credentials. Only after that boundary settles are runtime metadata and empty scratch mount targets
removed. Runtime metadata under `/run/ablo-resource-gvisor` is disposable; source
and receipts remain in the existing authority store/checkpoint path. Abrupt
supervisor loss can leave private runtime metadata; remove that metadata only
after the execution host is drained. Interrupted commands still use the existing
receipt/restart reconciliation and are not resumed by this backend.

## Current limits and verification

This backend has no network access or interactive native-provider support.
`startResourceProcess` is rejected with `command_invalid` when it is selected;
there is no fallback. Hosted Codex/Claude with SRT, provider networking, native
history checkpointing and pool placement require separate integration work.
The trusted parent enforces each command's cgroup2 memory budget before releasing
the namespace child. Missing delegation or an overcommitted configured budget
fails closed. Memory containment does not establish CPU, I/O or full hostile
co-tenant isolation.

Run the adapter's Python tests, claim-gateway tests, build and typecheck normally.
For the kernel check, install the matching adapter/coordinator and gVisor in a
throwaway Linux/FUSE-capable container, prepare the image above, then run the
bundled `tests/native.ts` with `ABLO_ADAPTER_GVISOR_ROOTFS`,
`ABLO_ADAPTER_GVISOR_CGROUP_ROOT` and
`ABLO_ADAPTER_GVISOR_MEMORY_LIMIT_BYTES` set and Node's
`--test-name-pattern=gVisor`. It checks automatic dependency evidence, peer-change
rejection, failure rollback/diagnostics, early and active timeouts, interactive
refusal and successful execution after teardown. Its lease backend is mocked;
it does not establish hosted leases or live model acceptance.

For the build/restart case, also place the JavaScript TypeScript compiler and its
standard libraries in the immutable image. Set `ABLO_ADAPTER_GVISOR_TSC` to its
guest `lib/tsc.js` path. The synthetic three-file project uses the real compiler:
two workers edit separate files and build against one shared dependency, with
outputs in separate disposable scratch directories. It then restarts the source
authority, checks durable receipts/source and rebuilds both files in fresh scratch
without write claims. This checks cold build correctness, not a full monorepo
build, warm dependency caching or replacement of the authority host from S3.

The separate `gVisor checkpoint` case supports operator-driven replacement
qualification. Set `ABLO_ADAPTER_RECOVERY_DIRECTORY` to a private checkpoint
directory and run that case with `ABLO_ADAPTER_RECOVERY_PHASE=prepare`. It stops
the authority before using SQLite's backup API to capture `state.sqlite` with
committed WAL data. It writes a test manifest, then removes its original state.
Transfer the checkpoint through private durable
storage, remove the initial compute, and run the same case on fresh compute with
`ABLO_ADAPTER_RECOVERY_PHASE=restore`. No seed directory or host identity registry
is transferred. The check requires the original owner-bound accepted/rejected
receipts, preserved signed reads, unchanged accepted source, a successful cold
compile and a new operation UID above all restored UIDs. Another participant
must see the writer's receipt as absent.

This is an offline test procedure, not automatic S3 checkpointing. Never copy a
database file alone: even after stopping the daemon, committed data can remain
in WAL. Use SQLite's backup API against the drained authority. Checkpoints
contain source and the private evidence-signing key: keep them encrypted,
access-controlled and version-pinned, with a separately trusted integrity hash.
Drain and exclude the old authority before starting a replacement; this test
does not implement distributed authority fencing, continuous durability or
interactive profile capture.

The `gVisor builds the real adapter` case takes
`ABLO_ADAPTER_PACKAGE_SOURCE`, the trusted checkout root containing the adapter's
three source files, package/build configuration, shared TypeScript defaults and
gateway tests. It seeds those actual files into protected source. Install the
matching transaction package and its dependencies, Node typings and `undici-types`
in the immutable image's `/opt/coding-protected/node_modules`, alongside the
compiler described above. The command extends the original build configuration
with scratch output, explicit Node typings and paths to the immutable dependency
declarations. It emits JavaScript/declarations and runs the four existing gateway
tests against the emitted adapter, changing only their import to that output.
Source/configuration reads must appear in the signed receipt and source must
remain unchanged. Dependency image provenance is separate from source evidence.
This qualifies a package build with split dependencies; it does not establish an
unchanged npm workspace build, dependency installation, full Lobby build or
shared cache invalidation. Workspace symlinks escaping source remain prohibited.
