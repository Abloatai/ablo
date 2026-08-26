# Per-Field Conflict Detection (per-field path)

Maintainer decision doc. Scopes the move from entity-level to field-level stale
detection in `executeCommit`. Library-free; restores Linear parity for the
disjoint-field case while keeping the agent-specific `readAt` reject.

## Problem

`executeCommit` Step 0 (`apps/sync-server/src/mutators/commit.ts`) detects stale
writes at **entity granularity**:

```sql
SELECT MAX(id) FROM sync_deltas WHERE model_name = ? AND model_id = ?
```

If `observed > op.readAt`, the op conflicts. This means two writers touching
**different fields** of the same row collide falsely: agent A sets
`report.status`, human B sets `report.reviewer`, B carried a `readAt` from before A's
write → B is rejected with `AbloStaleContextError`, even though the edits never
overlapped.

This is an over-rejection. It is also stricter than the system we
reverse-engineered from (Linear), which never had this problem.

## Why Linear says this is right

The model is reverse-engineered from Linear's sync engine. Linear's design
confirms every load-bearing choice here:

- **Transactions are property-level.** Linear's `UpdateTransaction` records
  "the name of the changed property and its previous value" — it carries only
  the changed properties, not a whole-object snapshot. Our `changed_fields`
  column re-derives exactly that.
- **Resolution is last-writer-wins, per property, by total order:** `syncId`
  (our `sync_id_seq`) is the total order. A partial transaction applies only its
  properties, so two clients editing **different** properties both win — LWW
  only bites on the **same** property.
- **CRDT is used only for issue descriptions.** Linear keeps LWW-per-property
  for structured fields and reserves a CRDT for the one rich-text body. That is
  the same per-field path / CRDT path line we draw: this doc is per-field path; rich-text bodies
  (TipTap `content_json`) are out of scope and belong to a separate CRDT track.

So per-field path is not a new feature — it **restores Linear parity** at the property
level we had flattened to entity level.

Sources: [reverse-linear-sync-engine (CTO-endorsed)](https://github.com/wzhudev/reverse-linear-sync-engine/blob/main/SUMMARY.md),
[Architectures for Central Server Collaboration — Weidner](https://mattweidner.com/2024/06/04/server-architectures.html).

## The constraint that shapes the design

`sync_deltas.data` stores the **full post-update row**, not the changed columns.
This was a deliberate change (see `feedback_partial_update_delta_ui_drift`) so
the live-pool update path fires MobX reactivity for nested fields. Consequence:
we **cannot** recover "which fields did this delta change" from `data` — a
full-row snapshot does not tell you what moved.

We do have the changed set for free at write time: `Object.keys(snakeInput)` at
`commit.ts` UPDATE branch, after the unknown-column strip and before the
`updated_at` injection. So this is a write-side capture + a read-side
intersection, not a diff-the-snapshots problem.

## Design

### 1. Schema: `sync_deltas.changed_fields text[]` (nullable)

- Populate **only for UPDATE** with the real changed columns
  (`Object.keys(snakeInput)` after strip, before `updated_at`).
- Leave `null` for CREATE / DELETE / ARCHIVE / UNARCHIVE.

`null` is semantically "whole-entity change" and always conflicts. This gives a
**safe migration**: every pre-migration delta is `null`, so detection falls back
to exactly today's entity-level behavior. Field granularity phases in only as
new deltas land — no risky backfill.

We store **field names only**, not previous values. LWW needs no value
comparison (latest `sync_id` wins); names are sufficient for the overlap check
that drives the optional reject. Prev-values would only matter for
"same field, same value ⇒ not a conflict" tie-breaking — defer it.

### 2. Detection rewrite: Step 0 (`commit.ts`)

Replace the scalar `MAX(id)` with a field-aware scan:

```ts
// op's own field set (snake-cased, framework cols excluded)
const opFields = new Set(Object.keys(op.input ?? {}).map(toSnakeCase));

const rows = await tx.unsafe(
  `SELECT id, changed_fields FROM sync_deltas
    WHERE model_name = $1 AND model_id = $2 AND id > $3
    ORDER BY id DESC`,
  [mapping.modelName, op.id, op.readAt] as never[],
);

// Conflict iff a newer delta touched a field this op also writes,
// OR a newer delta is whole-entity (changed_fields IS NULL → CREATE/DELETE).
const overlap = rows.find(
  (r) => r.changedFields === null || r.changedFields.some((f) => opFields.has(f)),
);
if (overlap) {
  conflicts.push({
    /* ...existing fields... */
    observedSyncId: overlap.id,
    conflictingFields: intersect(overlap.changedFields, opFields),
  });
}
```

Disjoint-field concurrent writes now produce **no conflict** — they both apply.
That is LWW-per-field achieved by *not rejecting*; no merge code.

### 3. Policy type: additive (`packages/transaction/src/claims/policy.ts`)

Extend `StaleContextConflict` with:

```ts
readonly conflictingFields?: readonly string[];
```

Pure addition. `defaultPolicy` still rejects; existing policies compile
unchanged. A policy can now reason at field granularity, e.g. allow when the
only conflicting field is cosmetic.

### 4. Scope boundary (honest)

Granularity is **column-level**, not JSON-path. Two writers editing different
keys *inside* one `content_json` column still conflict — that is the rich-text
case (CRDT path / CRDT), not this. JSON Merge Patch (RFC 7386) sub-column
granularity is a later refinement on the same column; v1 stops at columns.

## Relationship to the existing `readAt` reject

Linear is pure LWW-per-property with no stale check. We keep `readAt` /
an explicit `readAt` as an **opt-in** for the agent-reasoned-against-stale-state
case (an LLM that read a stale value and reasoned on it is a real failure mode
humans rarely hit). After per-field path:

- **No `readAt`** → LWW-per-field, Linear parity: disjoint fields never conflict.
- **`readAt` set** → reject only if a newer delta touched a field this op also
  writes. The `changed_fields` column makes that intersection computable.
- **No read premise** → skips stale detection; the assignment is unconditional.

## Index

Verify a `(model_name, model_id, id)` index exists on `sync_deltas` (the old
`MAX(id)` relied on it too). The new query is a bounded range scan (`id >
readAt`, usually a small recent window) on the same index prefix.

## Tests (vitest, sync-server)

- Disjoint fields (A: `status`, B: `assignee`, same row, both stale `readAt`) →
  **both commit, no `AbloStaleContextError`** — the regression that proves the win.
- Same field, both stale → still rejects (default policy unchanged).
- DELETE after `readAt` → conflicts regardless of op fields (`null`).
- Pre-migration delta (`null`) in the window → conflicts (back-compat).
- no read premise → still skips detection.

## Touch list

- `sync_deltas` migration — add `changed_fields text[]`.
- `commit.ts` — Step 0 detect rewrite + UPDATE write path populates
  `changed_fields` + `deltaInfos` shape.
- `apps/sync-server/src/db/deltas.ts` — insert path carries `changed_fields`.
- `packages/transaction/src/claims/policy.ts` — additive `conflictingFields`.
- vitest in sync-server.
