# Memory budgets for protected gVisor commands

The resource adapter's optional, noninteractive gVisor backend requires trusted
supervisor configuration alongside `gvisorRootfs`:

```ts
{
  gvisorRootfs: '/opt/ablo-gvisor/rootfs',
  gvisorCgroupRoot: '/sys/fs/cgroup/pool/jobs',
  gvisorMemoryLimitBytes: 256 * 1024 * 1024,
  maxConcurrentProcesses: 2,
}
```

The per-command budget is a positive integral number of MiB expressed as bytes.
Workers cannot select or increase it. A build adapter needs its own measured,
larger budget and matching aggregate capacity; the example is a small command
pool, not a full application build configuration. Native/SRT execution is unchanged.

The operator supplies an empty, root-owned cgroup2 subtree below
`/sys/fs/cgroup`, with `memory` enabled in `cgroup.subtree_control`, finite
`memory.max`, and no supervisor processes or child cgroups inside it. Give each
adapter its own dedicated jobs root. A non-inheritable directory lock excludes
other supervisors; stale child cgroups require operator drain before restart,
even after the previous supervisor's lock is released. All path ancestors must be
root-owned, without symlinks or worker write permission. The aggregate must cover
`maxConcurrentProcesses * gvisorMemoryLimitBytes` and be strictly below every
finite enclosing budget. At least one finite enclosing budget is required.
Reserve the difference for the source authority, controller, image/cache and
runtime overhead, using measured peaks rather than assuming a small fixed reserve
suffices. The adapter validates the topology and budgets; it never changes the
host's controller configuration or silently falls back to unlimited execution.

For a disposable container, prepare the immutable image and files before starting
the controller. Use a private cgroup namespace and a finite container memory limit.
Its initial PID1 can make only that namespace's cgroup mount writable, move itself
into a `supervisor` child, enable memory on the now-empty container root, and create
the bounded memory-enabled `jobs` sibling. Start the adapter as a descendant of
`supervisor`. Later `docker exec` normally tries to join the internal container
root and can fail once subtree controllers are enabled; use the initial controller
and mounted evidence directory instead. Never remount or alter the shared host's
global hierarchy for this setup.

Each operation receives a root-owned child with `memory.max`, zero swap, and
`memory.oom.group=1`. The trusted launcher moves its namespace child into this
group and checks membership while the child is blocked at the existing mapping
gate. Only then may gVisor run or fork the guest payload. The controller remains
outside the jobs aggregate. An OOM rejects the receipt and discards staged source
writes. Existing UID/process reaping is followed by `cgroup.kill`, population
verification and directory removal, including after launcher SIGKILL. Failed setup
or teardown prevents publication. After abrupt supervisor loss, drain the host
before removing orphan runtime/cgroup metadata; this is not automatic pool recovery.

Run `npm test`, `npm run typecheck` and `npm run build` in the adapter workspace.
On a configured Linux/FUSE host set `ABLO_ADAPTER_GVISOR_ROOTFS`,
`ABLO_ADAPTER_GVISOR_CGROUP_ROOT`, `ABLO_ADAPTER_GVISOR_MEMORY_LIMIT_BYTES` and
optionally `ABLO_ADAPTER_GVISOR_CONCURRENCY` (test fixture default: two). Run the
bundled native tests with `--test-name-pattern='gVisor memory isolation'`.
`ABLO_ADAPTER_GVISOR_EVIDENCE` optionally records the synthetic result. The check
forces a kernel OOM, verifies an independent peer and accepted source survive,
kills an active trusted launcher, verifies rollback and subsequent execution,
and requires all job cgroups removed. Inspect `memory.events.local` at the jobs
aggregate and controller parent: hierarchical OOM counters and Docker's
`OOMKilled` flag also reflect expected descendant OOMs.

This qualifies command memory isolation, not CPU, PID, I/O or source-controller
request-cost isolation, live model execution, hosted pool integration or fleet scale.
