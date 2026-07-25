# Concurrency Convention: Open Decisions

Maintainer notes for [`concurrency-convention.md`](../concurrency-convention.md).
These are decisions the team has deliberately not made yet. They change public
behaviour, so they are tracked here rather than in the public contract, where an
unmade decision reads as an unsettled guarantee.

## Default disposition for agents

Should an agent-participant guarded write default to `notify` (philosophy
aligned: surface, do not overwrite) instead of `reject` (back-compat)?

The trade-off is alignment against a behaviour change for existing agent
callers. Today a guarded write with `readAt` but no `onStale` defaults to
`reject` for every participant kind.

## Batch premises through the policy seam

Should premise conflicts also pass through `ConflictPolicy`, or stay on the
direct `onStale` mapping?

Routing them through the seam requires a group-aware conflict shape, because a
batch premise can name a sync group rather than a row. Custom `ConflictPolicy`
functions currently see write-target conflicts only (`stale_context` /
`claim_held`); batch-premise conflicts resolve directly through each entry's
`onStale`.

## The serializability floor

A batch premise is a sound check, not a full precedence-graph guarantee: it
catches only what the caller declared. A caller that declares nothing gets no
check at all, because write-target checking needs a `readAt` to check against,
and a plain write is last-writer-wins.

The floor is therefore zero, and closing that gap is the subject of ADR 0018.
The public page states the resulting behaviour as a limit; the framing of it as
a gap to be closed belongs here.
