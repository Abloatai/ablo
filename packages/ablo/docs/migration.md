# Upgrade Guide

> A safe workflow for upgrading the pre-1.0 SDK.

Ablo is pre-1.0, so a minor release may contain a breaking API change. Patch
releases normally remain compatible within the same minor line. The 0.64.1
release includes the explicit React and collaboration migrations below.

## Upgrading to 0.67.1

Source connector `baseURL` and authenticated network probe `baseUrl` overrides
must use HTTPS or WSS for remote hosts. Overrides using plaintext HTTP or WS
outside loopback are now rejected before credentials are read or a connection
opens. Configure TLS on the remote endpoint before upgrading. HTTP and WS on
loopback addresses remain supported for local development. URL-embedded usernames
and passwords are rejected; keep the Ablo credential in the existing API-key
option.

Windows CLI login now opens its approval URL without a command shell. No CLI
configuration change is required.

## Upgrading to 0.67.0

Pin the Ablo, Transaction, Humans and CLI package family to 0.67.0 together.
This minor release changes custom store undo integration and reserves the
internal field-history table name. It also introduces versioned fields and
supersedes development APIs for reactive field buffers. Applications using
ordinary string and value updates retain those semantics until they opt in.

### Reactive field editors and pending writes

The new reactive text and counter editors use the primary model mutation
journal, normal observable rows and ordinary UndoScope. If you evaluated the
earlier development buffers, replace these preview APIs:

| Earlier preview buffer API | Reactive editor in 0.67.0 |
| --- | --- |
| `state` and `persist` options | Normal client persistence; recover unresolved preview buffers with the SDK build that created them |
| `exportState()` | Use the primary model journal for pending writes; reactive editors have no exported buffer state |
| Buffer `undo()` and `redo()` | The application's ordinary UndoScope |
| `dispose()` | Releases the editor view; queued primary writes remain journaled |

Do not erase browser storage to force an upgrade through unresolved legacy
buffer records. The new runtime retains unresolved legacy records and stops
rather than silently dropping or resubmitting them. Resolve or recover preview
work with the SDK build that created it first. UndoScope history is local to its client
session; durable pending writes do not make undo history survive a restart.

Standalone HTTP editors retain `state`, `persist`, `exportState()`, `undo()`
and `redo()`. They remain explicit staging buffers. Their commit outbox protects
dispatched requests, while unsent buffer work requires the `persist` callback.
See [Operation fields](./operation-fields.md#reconciliation-and-recovery).

Custom store implementations must forward the optional local `undoScopeId`
from save, write and delete into their mutation events. Row-based replay
suppression no longer identifies undo work; dropping this provenance can record
an undo as a fresh edit or suppress an unrelated edit.

### Versioned field types and authority prerequisites

Creation accepts ordinary string and integer values. Updates to `field.text()`
require `$text` versioned operations; a raw replacement string is rejected.
Counters accept `$increment` or a replacement safe integer. Replacing a counter
starts a new history epoch, so older pending intent requires explicit recovery.
Migrate all writers before opting an existing field into these semantics.

Deploy compatible authority support and install the versioned-text-field and
accepted-operation-reference migrations, with their operation-history RLS
policies, before enabling these schema fields. This SDK does not apply those
migrations or deploy either server runtime. Connected customer sources remain
unsupported for semantic operations. Plain-text operations do not merge
rich-text formatting or establish product validity. An application model mapped
to the newly reserved `sync_text_fields` table must be renamed before upgrading.

One explicit commit can combine semantic operations on distinct rows with
ordinary writes. Each semantic row accepts one field operation and one update
entry; multiple aliases of one physical row do not bypass this limit. Reuse the
original request identity and operations after an ambiguous outcome. Recover
expired field bases and external forks explicitly with pending intent preserved.
See [Atomic operations on distinct rows](./operation-fields.md#atomic-operations-on-distinct-rows).

### Browser and native adapter behavior

A failed bootstrap refresh now retains the existing IndexedDB replica rather
than replacing it with a cached response. Cache fallback is reserved for cold
starts and full snapshots. Held claims survive reconnect only while the server
retains their leases; continue handling `claim_lost` and reacquiring when needed.

The native adapter remains opt-in. Install its matching release archive and
0.67.0 transaction package on the trusted Linux host. Directory scan observations
cover membership and entry types; explicit reads still cover file content.
Native execution defaults to eight processes and accepts an explicit limit
from one to 64. These changes do not relax publication ownership checks.

Optional gVisor commands require trusted rootfs and cgroup memory configuration
and reject interactive providers. Project-file publication requires a trusted
callback that refreshes the exact project/run authorization binding; it acquires
exact file leases before atomic publication. These opt-ins require separate
operator qualification. See the
[adapter guide](https://github.com/Abloatai/ablo/blob/v0.67.0/packages/resource-adapter/README.md)
for setup and limits.

## Versioned text fields

The engine's `sync_text_fields` journal is reserved. An application schema that
already uses that table name must rename its table before upgrading.

Existing string fields keep their behavior until you explicitly choose
`field.text()`. Before opting in, migrate all writers and text undo code to
`ablo.<model>.text({ id, field })`: whole-value updates of an opted-in field
are rejected. This first path supports required, non-null strings on Ablo-owned
storage. Connected-source text transforms remain unavailable. See
[Versioned text fields](./text-fields.md) for persistence and recovery limits.

## React and package boundaries after 0.64

Run `npx ablo upgrade` for migration hints before editing. It previews changes;
`--write` applies only mechanical rewrites. React changes requiring application
judgment are reported with their replacements.

| Previous API | Current API |
| --- | --- |
| `useSync()` or zero-argument `useAblo()` | `useAbloClient()` for actions; await `client.ready()` when initialization is required |
| `useSyncStatus()` | `useAblo(client => client.status)` |
| `usePeers()` | `useAblo(client => client.presence.others)` |
| Scoped peers | `usePresence(client => client.records, id, { excludeSelf: true })` |
| `useMutationFailureListener(listener)` | `useMutationFailure(listener)` |
| `useErrorListener()` | `AbloProvider`'s `onError` prop for startup errors |
| `useCurrentUserId()` | Your application's authentication context |
| `useSDKSyncStore()` / `useSyncStore()` | Public client operations; `getAbloStore(client)` from `/client` for custom local-store adapters |
| `ClientSideSuspense` / `DefaultFallback` | Application UI through the provider's `fallback` prop |
| `GroupScope` for presence | Model and record arguments |

`useAblo(selector)` returns detached snapshots for rendering. They have no model
methods or relation accessors. `useAbloClient()` returns the writable client and
does not subscribe to row changes. Do not perform writes inside a selector.

### Presence, activities and claims

`Activity` is replaced by `Ablo.PresenceActivity`, including for agents. A session
is `Ablo.PresenceSession`: identify the execution with `presenceSessionId` and its
actor with `participant.id` and `participant.kind`. A participant can have several
sessions, so exclude self by session rather than user ID.

`presence.active` contains this session's activities; `presence.others` contains
other sessions, each with an `activities` array. `forModel(model, id)` includes
self by default; pass `{ excludeSelf: true }` as its third argument to omit self.
The same option on `usePresence` still announces the component's reading activity
and cleans it up on unmount.

An activity has `operation`, `target`, `source`, and ISO timestamp fields.
Read the model and row from `activity.target.model` and `.id`; field-specific
activity uses `.field` or `.fields` (never both, and always with a row ID).
Activities describe visible work; they do not grant write authority.

Claims are acquired through `await using claim = await client.records.claim({ id })`.
The protected row is `claim.data`; pass `claim` to the write. Claim lookup uses
`client.records.claim.state({ id })` and `.queue({ id })`. Claim metadata is on
`claim.target.meta`, and a multi-field claim uses `fields` in the claim target.
Do not reconstruct a claim handle from a presence activity. See [Claims](./claims.md).

### Imports and schema ownership

The root factory creates a headless client; `/client` creates the reactive client.
Import the `Ablo` type namespace beside the factory you use. Both expose the
shared schema, presence-activity and claim types. Reactive-only types such as
`Ablo.Status`, `Ablo.Reads`, `Ablo.Store`, and `Ablo.Mutator` belong to `/client`
(or `/react` for its re-exported reactive factory).

Prefer explicit schema inference:

```ts
import { defineMutators } from '@abloatai/ablo/client';
import { useMutators, useUndoScope } from '@abloatai/ablo/react';
import { schema } from './schema';

const definitions = defineMutators(schema, {
  records: {
    rename: async ({ tx, args }: {
      tx: import('@abloatai/ablo/client').Ablo.Mutator.Transaction<typeof schema>;
      args: { id: string; title: string };
    }) => tx.mutations.records.update({ id: args.id, title: args.title }),
  },
});

function useRecordActions() {
  const { scope } = useUndoScope(schema, 'record-editor');
  return useMutators(schema, definitions, { undoScope: scope });
}
```

Ambient registration remains available for a single application. Its module must
be included in that TypeScript program and import `@abloatai/ablo` before
augmenting `Register`. The public registration now reaches the downstream
Transaction and Humans resolvers through the emitted declarations. A package
compiled independently cannot inherit a consuming app's ambient declaration.

### Structural collaboration adapters

Generic `subscribe(event, handler)` preserves exactly the argument tuples in your
event map. Receive optional server attribution through the session's
`collaboration.subscribe(event, (payload, context) => ...)`; low-level transport
adapters use `subscribeCollaboration`. Model-scoped `client.records.events.on`
continues to supply authenticated context as its second callback argument.
Legacy servers may omit context on application events; handle `undefined` there.

## Upgrade safely

1. Pin the version you run instead of depending on a floating range.
2. Read the changelog entries between your installed and target versions.
3. Use the documentation bundled with the target package while changing code.
4. Run type-checks and tests before updating a production branch.
5. Run the three-state deployment plan, then push the exact reviewed plan.

```bash
npm install --save-exact @abloatai/ablo@<version> @abloatai/cli@<version>
npx ablo docs
npx ablo docs api
npx ablo plan
npx ablo plan --json
```

`npx ablo docs` is version-matched to the installed package. Prefer it during an
upgrade: the hosted website documents the newest release, which may expose a
method your pinned package does not yet contain.

## What to review

Pay particular attention when a release changes:

- model method signatures or return values;
- claim acquisition, contention, or release behavior;
- credential scope or session minting;
- schema serialization and push validation;
- database connection or Data Source setup;
- error codes your application handles explicitly.

The release changelog names required edits next to the feature that changed.
Avoid branching on credential prefixes or undocumented internals; use exported
types and server-confirmed identity instead.

## Schema and database safety

An SDK upgrade and a database migration are separate operations coordinated by
one deployment plan.

- `ablo plan` compares source, the active Ablo artifact, and PostgreSQL without
  changing any of them. Its fingerprint pins all three observations.
- `ablo push` consumes that reviewed fingerprint and refuses if any state moved.
- `ablo check` is the database-compatibility view of the same plan.
- Your ORM or migration tool remains responsible for tables, columns,
  constraints, and application data migrations.

When both need to change, deploy the database migration in a backwards-compatible
form first, push the compatible Ablo schema, then remove old application paths.
For a live rename or required-field change, keep expand, dual-write, resumable
backfill, verification, switch, and contract as explicit gates. Contract is a
later, separately approved deployment—not the tail of expand.

## If an upgrade fails

Use the typed error code and request ID rather than matching message text. The
[Errors](./errors.md) reference gives the recovery step for each public error.
If a failure only occurs on the new minor version, keep the previous pinned
version in production while reproducing it against an isolated branch.

See the release changelog for version-specific changes and
[Deployment](./deployment.md) for the production rollout sequence.

## Shared operation reconciliation

Install the accepted-operation-reference migration before running this server
release. `sync_deltas.operation` is nullable metadata; existing value-only
consumers continue reading ordinary row values. Existing text history and
exported buffer shapes keep their epochs and IDs.

The humans client now restores unsent field buffers from its local transaction
journal and refreshes them automatically. It shares one active buffer per field;
dispose it before explicitly restoring another state or persistence callback.
An explicit operation `readAt` is enforced as a decision premise; transform
availability no longer bypasses its field-overlap check. Callers that only need
merge reconciliation should use the field epoch/version supplied by the buffer
and omit a decision premise they did not actually use.

`field.counter()` and `model.counter({ id, field })` opt into checked integer
increments. Replacing a counter through normal update starts a new epoch and
requires older buffers to recover explicitly. See [Operation fields](./operation-fields.md).
