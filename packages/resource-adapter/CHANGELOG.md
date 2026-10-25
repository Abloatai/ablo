# Changelog

## 0.1.5

### Native commands gain explicit isolation and publication modes

Directory scans now return entry types without observing the contents of each
child. Membership and type changes still invalidate directory observations;
explicit reads retain their own dependencies.

Trusted hosts can configure concurrent native processes from one to 64, keeping
eight as the default. Publication ownership and validation remain enforced. Use
the matching 0.67.0 transaction package and the documented Linux supervisor,
FUSE and runtime setup.

The optional gVisor backend runs network-isolated noninteractive commands within
the existing protected filesystem boundary, with trusted per-command and
aggregate memory budgets. Project-authorized file publication can acquire exact
leases for the final staged diff after checking the active project/run binding.
Both modes are explicit opt-ins. Follow the
[gVisor setup](https://github.com/Abloatai/ablo/blob/v0.67.0/docs/ops/gvisor-resource-commands.md)
and [publication guide](https://github.com/Abloatai/ablo/blob/v0.67.0/docs/ops/project-file-publication.md)
before enabling them; local unit checks do not establish hosted acceptance.

## 0.1.4

This release uses the matching 0.66.17 browser and transaction packages.

## 0.1.3

### Replacement hosts keep operation identities unique

Restoring durable receipts advances the host allocator past their operation UIDs.
New operations can then run without colliding with restored history. Release
asset generation checks this behavior against the packaged Python authority.

### Native editor cleanup and directory moves

Perl in-place edits now finish kernel-owned unlink cleanup before publication.
Private directory moves preserve open handles and validate every affected path.
Unclaimed leftovers and descendants still reject the whole update.

### Realtime workspace coordination

A Rust coordinator now keeps persistent worker connections and pushes changes
for subscribed dependencies after durable publication. Native execution has a
separate admission limit, keeping capacity available for reads, receipts and
lease maintenance. Slow consumers disconnect and recover through the durable
cursor; lost write responses still require receipt reconciliation.

This changes the public socket protocol. Upgrade the connection helper with the
adapter, and build the shipped Rust source on the Linux host before startup.
The existing SQLite and FUSE authority continues to enforce publication.

### Independent edits retain their context

Content edits no longer invalidate unrelated directory dependencies. Connection
bursts wait behind a bounded handler pool, and occupied resource claims return
`claim_conflict` promptly instead of waiting in the authority queue. Callers that
relied on that implicit wait must retry explicitly. Use the matching SDK build.

## 0.1.2

### Patch Changes

- @abloatai/transaction@0.66.15

## 0.1.1

### Protected native workspaces

The Linux filesystem and Git adapter is now distributed as an installable
archive with Ablo 0.66.14. The archive pins the matching transaction SDK and
includes the compiled supervisor entry point and Python implementation.
Release assets include SHA-256 checksums for both packages.

The adapter enforces claims and read versions before publishing native file
changes and Git refs. Installation requires the documented trusted Linux
supervisor and persistent state; existing runners remain unchanged until
explicitly configured.
