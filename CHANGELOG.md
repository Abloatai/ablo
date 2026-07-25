# Changelog

## 0.37.1

### A clearer introduction to Ablo

The package README now explains Ablo from the problem outward: humans already
coordinate shared work by seeing who is active, agreeing on ownership, waiting,
and looking again before continuing; Ablo gives agents those same practical
capabilities in software.

It also makes the headless product explicit. The TypeScript SDK is backed by a
pure HTTP transaction API, so agents, services, jobs, command-line tools, and
interactive applications can use the same coordination model without requiring
a browser or reactive client.

### Lower overhead on busy write paths

Large create batches now return only the inserted identifiers needed for
idempotency handling instead of sending every inserted column back to the
server. Live clients also bypass reconciliation work when a publication frame
contains one change per entity.

These changes reduce server response volume and client materialization work.
There are no public API changes in 0.37.1.

## 0.37.0

### One Ablo SDK for humans, agents, and backend systems

Ablo is now presented and shipped as the transaction and coordination layer for
shared application state—not only as a realtime synchronization library.

Install `@abloatai/ablo` as the single public SDK:

- `@abloatai/ablo` provides the pure HTTP path for agents, services, workers,
  jobs, server actions, and other headless runtimes.
- `@abloatai/ablo/client` adds live local state, optimistic interaction,
  persistence, and presence for human-facing applications.
- `@abloatai/ablo/react` provides the React bindings.

Every entrypoint uses the same schema, capabilities, commits, claims,
idempotency, settlement, and ordered changes. Authoritative reads use
`model.get({ id })`; local reactive snapshots use `model.local.get(id)`.

### Coordination now matches the unit applications can safely write

Claims can coordinate an entire row or a typed set of fields. Two actors
working on different fields of the same row can proceed concurrently, while
overlapping work takes turns.

Sub-field `path` and `range` claims have been removed because the write path
cannot yet guarantee independent updates within one field. Applications using
those options should claim the containing field instead and keep any
cursor/range information in claim metadata for display.

### Safer authority for browser applications

Browser sessions now use one typed, short-lived credential flow and require a
non-empty schema-typed `can` grant. Applications specify the exact model
operations a session may perform instead of issuing ambient all-data access.

Use `authEndpoint` for the browser credential endpoint. The supported routes
are `/v1/ephemeral_keys` and `/v1/capabilities`; the former `apiKey` endpoint
option and legacy route aliases are removed. Credential callbacks now use the
`CredentialProvider` type.

### Verified throughput without dropping coordination guarantees

The strict AWS benchmark sustained more than 10,000 committed operations per
second across create, mixed-create, update, and delete workloads, with zero
write errors and sub-second publication drain.

The result covers the documented single-plane, 12-client, 500-operation test
topology. Atomic commits, authorization, idempotency, conflict handling, audit
delivery, ordered observation, replay, and authoritative confirmation remained
enabled throughout the run.

Release notes are generated from the repository changesets.
