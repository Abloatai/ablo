# Changelog

## 0.22.1

### Patch Changes

- Expose the functional `update(id, current => next)` overload on the stateless
  HTTP client type (`HttpModelClient` / `AbloHttpClient`).

  0.22.0 wired the functional update at runtime on every transport and added the
  overload to `ModelOperations` (WebSocket) and `ModelClient`, but the
  `Ablo({ transport: 'http' })` client resolves its models to `HttpModelClient`,
  whose `update` type still declared only the `update({ id, data })` form. So
  server-side agents — the primary callers — saw a type error on
  `update(id, fn)` even though it worked. Add the overload to that type.

## 0.22.0

### Minor Changes

- Add the functional update form: `ablo.<model>.update(id, current => next)`.

  The `setState(prev => next)` of the data layer. Pass a function of the latest
  row and the SDK owns everything that used to be the caller's problem under
  contention: it reads the freshest row, runs your updater, writes it as a
  compare-and-swap against the row's watermark, and re-reads + re-runs on any
  concurrent write. No claim, no per-participant identity, and no
  `stale_context` / `claim_*` codes ever surface — correctness rides on the
  watermark, so concurrent writers reconcile instead of silently clobbering. The
  write either lands or throws a single `AbloContentionError` once its reconcile
  budget is spent.

  Identical guarantee on both transports (HTTP and WebSocket share one reconcile
  loop). Return `null`/`undefined` from the updater to skip the write. Tune with
  `{ retries, signal }`. Exports: `AbloContentionError`, `ModelUpdater`,
  `ContentionOptions`, `DEFAULT_CONTENTION_RETRIES`.

  The classic `update({ id, data })` form is unchanged.

## 0.21.0

### Minor Changes

- Coordination observability now fires on BOTH transports. Previously `captureClaim`/`captureConflict` were emitted only by the WebSocket transport, so a `ClaimLog` (or any `observability` provider) handed to a stateless HTTP client — the transport server-side agents use via `Ablo({ transport: 'http' })` — stayed empty, and even on WebSocket a hard commit rejection went unrecorded. Fixed:
  - **HTTP transport now emits.** `Ablo({ transport: 'http', observability })` records `claim` acquisition (`captureClaim`) and coordination-conflict rejections (`captureConflict`, code `stale_context` / `claim_conflict` / `entity_claimed`) on BOTH HTTP write doors (`commits.create` and per-model `ablo.<model>.update/create/delete`). The conflict names the collided rows — from the server's `conflicts` detail when present, otherwise the ops the write attempted. `observability` is now a documented option on the HTTP client.
  - **WebSocket rejections now recorded.** A commit rejected by the conflict policy (`mutation_result` `success: false` with a coordination code) now calls `captureConflict`, mirroring the existing notify-on-success path. So `ClaimLog.collisions()` no longer silently misses rejected writes.

  Net effect: a `ClaimLog` behaves identically regardless of transport — `entries`, `collisions()`, and `onChange` reflect the real coordination timeline for headless agent evals and live activity feeds alike.

## 0.20.2

### Patch Changes

- Extend the `HeldClaim` return type to the HTTP transport. 0.20.1 fixed `await using` on the WebSocket client's `claim()` but missed the stateless HTTP client (`HttpClaimApi`) used by server-side agents, which still returned the looser `Claim<T>`. Both transports' `claim()` now return `HeldClaim<T>`, so `await using held = await ablo.<model>.claim(...)` typechecks regardless of transport.

## 0.20.1

### Patch Changes

- Fix `await using held = await ablo.<model>.claim(...)` failing to typecheck. `claim()` now returns a `HeldClaim<T>` — a `Claim<T>` with `data`, `release`, `revoke`, and the async disposer made `Required` (they're optional on the base `Claim<T>`, which also models observed peer claims that lack them). A held claim is therefore assignable to `AsyncDisposable`, so the `await using` auto-release pattern compiles. Observed claim surfaces still return the looser `Claim<T>`. `HeldClaim` is exported.

## 0.20.0

### Minor Changes

- Reactive reads now work out of the box. A read like `useAblo((a) => a.documents.get(id))` re-renders when a live delta updates the row — including in-place field updates (the common collaborative case), which previously fired no reaction and left the UI silently stale.

  Two changes make this work:
  - **Models are reactive by default.** Schema fields are now MobX-observable without opting in. `json` fields stay `observable.ref` (one atom for the whole blob, not a deep atom tree per node), so the default is cheap. Opt out per model with `lazyObservable: false` for very large read-only list models where the QueryView's entry-replaced reactivity is enough.
  - **`useAblo` returns a plain row snapshot** (via the new `Model.toReactiveSnapshot()`) instead of the live model instance. Reading the fields inside the tracked function is what subscribes the reaction (MobX tracks property access, not values), and the fresh snapshot identity lets the hook detect the change. Consumers get plain row objects and never touch a MobX observable directly.

  Also new: `deepEqual` and `stableStringify` exports for comparing `field.json()` values. A `jsonb`-backed json field round-trips with reordered object keys (Postgres `jsonb` does not preserve key order), so a naive `JSON.stringify(a) === JSON.stringify(b)` comparison is unreliable when reconciling against external state (e.g. a rich-text editor). These helpers compare key-order-insensitively.

## 0.19.0

### Minor Changes

- **Claim observability — a `ClaimLog` you can print or assert on.** A new
  `observability` provider hook lets you tap every claim event and stale-write
  collision the client sees. Hand `new ClaimLog()` to `Ablo({ observability })`
  and it collects an ordered, readable log — `formatClaim` / `formatConflict`
  render one line per event, and `collisions()` returns the conflicts for eval
  assertions. New exports: `ClaimLog`, `formatClaim`, `formatConflict`,
  `noopObservability`, and the types `ClaimLogEntry`, `ClaimEvent`,
  `ConflictEvent`, `SyncObservabilityProvider`. Spread `noopObservability` to
  override only the hooks you care about.

  **AWS-shaped CLI credential store + `ablo config`.** Local CLI state is now split
  into two files, matching `~/.aws/config` vs `~/.aws/credentials`: `config.json`
  holds non-secret settings (active environment + active project) and is safe to
  print or let an agent read; `credentials.json` holds the keys (0600, never
  printed), keyed by project profile then environment. Per-project profiles follow
  Stripe's model — `ablo projects use <slug>` selects the active profile, and a
  key's project is fixed at mint so selecting a project never re-scopes an existing
  key. `ablo status` now reports the resolved profile and environment.

  **Schema JSON-column reconciliation.** `generateJsonColumnReconciliation` (new
  export) emits the DDL to reconcile JSON-backed columns when adopting or evolving
  an existing schema.

  **Breaking (0.x):**
  - The claim handle type `ClaimHandle` is renamed to **`Claim`**, and its
    identifier field is `id` (was `claimId`). Update type imports and any code
    reading `.claimId`.
  - The ai-sdk `claimBroadcastMiddleware` (and `./ai-sdk/claim-broadcast`) is
    removed — coordination broadcast is handled by `coordinationContextMiddleware`.
    Import `ClaimTarget` from the package root or `@abloatai/ablo` ai-sdk's
    `coordination-context` instead of `claim-broadcast`. The inline-claim option is
    `reason` (not the pre-0.12 `action`); the ai-sdk docs are corrected to match.

## 0.18.0

### Minor Changes

- **Client observability — `debug` / `logLevel`, off by default.** The SDK used to
  emit a `debug` line per model and per property during schema registration (a
  firehose). It now defaults to a quiet `warn` threshold and exposes two new
  `Ablo()` options to opt back in:
  - `logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent'` — `'info'` surfaces
    coordination and connection events without the per-model registration noise;
    `'debug'` is everything. Precedence: explicit `logLevel` → `debug: true` →
    `ABLO_LOG_LEVEL` env → default `warn`. Supplying your own `logger` bypasses both.
  - `debug: boolean` — shorthand for `logLevel: 'debug'`.

  Coordination is now traceable at `info`: claims that are **rejected** or **lost**
  (preempted/expired), and your position **advancing in a claim queue**, each log
  once per change with a readable target (`documents:abc.title`) — quiet lowercase
  lines, no shouty tags.

  **New: canonical wire-egress contract export.** `errorEnvelope`, `statusForType`,
  and the `ErrorEnvelope` type are now exported from the package root. Server
  consumers (e.g. a self-hosted sync server) can assert against the one source of
  truth for the error-envelope shape and the `AbloError`-subclass→HTTP-status
  table instead of keeping a copy that silently drifts.

  **Structured CLI error rendering.** CLI failures render as a titled block with a
  reason code and per-code remediation (`--verbose` for the stack) instead of a
  console wall-of-text; `AbloError.toString()` produces a leak-proof one-liner.

  **`ABLO_API_KEY` resolution + sandbox key scopes.** The key is now resolved from
  `.env.local` / `.env` (not just the process env), and sandbox keys are granted
  `schema:push` by default so `ablo push` works out of the box in a fresh sandbox.

## 0.17.0

### Minor Changes

- **Bring-your-own database is now one model.** Ablo connects to your Postgres and
  never operates it. There used to be two confusing BYO paths, and the
  connection-string one would create roles, force row-level security, transfer
  table ownership, and push you to run `ablo migrate` before anything worked. That
  cascade is gone. Ablo now follows the shape every serious "sync over your own
  Postgres" engine uses (ElectricSQL, PowerSync, Zero): it reads your database via
  Postgres logical replication and never runs DDL, creates roles, forces RLS, or
  rewrites your `DATABASE_URL`. You own your schema; Ablo reads it.
  - **New: `ablo connect`.** One command prints the exact, copy-pasteable setup for
    your own Postgres — enable `wal_level=logical`, create the `ablo_publication`
    publication and a least-privilege `ablo_replicator` role — and
    `ablo connect --check` validates readiness (wal level, publication, replication
    grant, replica identity). This is the single supported way to connect a real
    database.
  - **`ablo migrate` left the happy path.** It no longer creates roles, transfers
    ownership, or rewrites your connection string, and `ablo dev` no longer attempts
    a scoped-role creation on every watch loop. `migrate` is now an optional escape
    hatch for generating starter DDL (`--dry-run` prints the SQL).
  - **Clearer failures.** `ablo push` permission errors lead with the server's actual
    reason code and per-code remediation instead of a generic "needs `schema:push`
    scope," and the schema-conflict message names which environment/version a prior
    push came from and when.
  - **Logical-replication runtime is in Preview.** The setup (`ablo connect`) and the
    connection model are live; the server-side WAL consumer that streams your changes
    is implemented and journey-tested but not yet generally available.

  The previous connection-string-operate and adapter/outbox modes are demoted to a
  clearly-labeled **Legacy / not recommended** section — they still work, but new
  integrations should use logical replication.

## 0.16.3

### Patch Changes

- **Docs.** The bundled SDK docs are now the single source for the documentation
  site, and several pages were expanded or corrected:
  - The sessions/identity model is reframed around **projects** — push one schema
    to a project, mint an `ek_` per user (your users need no Ablo account), and
    all of them commit to that one schema. Per-customer org isolation
    (`schemaProject`) is presented as the add-on it is, not the default.
  - The declarative `conflict` schema axis (Axis 3) is now documented.
  - The agent docs were corrected to the current claim vocabulary
    (`reason`/`queue`, not the pre-0.12.0 `action`/`wait`).

  No code changes.

## 0.16.2

### Patch Changes

- **`mintUserSessionKey`: name the shared-schema binding around the project.** The
  two flat options added in 0.16.0 (`schemaOwnerOrgId` + `schemaProjectId`) are
  replaced by one project-centric option — `schemaProject: { organizationId, projectId }` —
  naming "the project that owns the schema" as a single concept. The wire format
  is unchanged (the SDK still sends the same keys), so no server redeploy is
  needed. Released as a patch: the replaced options shipped in 0.16.0 and have no
  external consumers yet.

  ```ts
  // before
  mintUserSessionKey({ organizationId, schemaOwnerOrgId, schemaProjectId, ... });
  // after
  mintUserSessionKey({
    organizationId,                                  // data org
    schemaProject: { organizationId, projectId },    // the project that owns the schema
    ...
  });
  ```

## 0.16.1

### Patch Changes

- **Fix `ablo login` against the standalone auth server.** The device flow now
  targets two origins instead of one: the RFC 8628 device endpoints
  (`/api/auth/device/*`) go to the identity server (`auth.abloatai.com`, override
  `ABLO_AUTH_URL`), while the human approval page (`/cli`), sign-up, and the
  key-handoff route (`/api/cli/provision-key`) go to the dashboard host
  (`www.abloatai.com`, new override `ABLO_DASHBOARD_URL`). Previously every step
  ran against `www`, where the device endpoints no longer resolve —
  producing "Couldn't start login… Is the dashboard reachable?". The CLI now also
  builds the approval URL itself rather than trusting the server's
  `verification_uri`, which (being a relative `/cli`) resolved against the auth
  server's origin to a 404.

## 0.16.0

### Minor Changes

- **Axis 3 — declare write-conflict behaviour in the schema (new).** A model can now
  state what happens when a commit collides with a foreign claim or a stale snapshot —
  per committer kind (`user` / `agent` / `system`) — right next to its fields, using the
  same `overwrite | reject | notify` vocabulary as the `onStale` write guard. It is a
  third axis, orthogonal to `policy` (read access) and `groups` (delta routing).
  - **`conflict` on `model()`** — a plain, serializable disposition map. Pure data, so it
    round-trips through the schema registry to the server; the generic engine interprets it
    at the commit chokepoint (no per-model logic in the engine).

    ```ts
    // "a human's edit always wins (never blocked); an agent yields"
    conflict: { user: 'overwrite', agent: 'reject' }
    ```

  - **Composable authoring helpers (new, from `@abloatai/ablo/schema`)** — disposition
    functions plus a `cn`/`cx`-style combinator, so conflict policy reads like the rest of
    the DSL (`relation.belongsTo()`) and like modern config (`plugins: [admin(), …]`):

    ```ts
    import { coordination, humansOverwrite, agentsReject } from '@abloatai/ablo/schema';

    conflict: coordination(humansOverwrite(), agentsReject());
    // → { user: 'overwrite', agent: 'reject' }
    ```

    Exports: `coordination`, `humansOverwrite` / `humansReject` / `humansNotify`,
    `agentsOverwrite` / `agentsReject` / `agentsNotify`,
    `systemOverwrite` / `systemReject` / `systemNotify`, and the `ConflictRule` type.

  - An omitted committer kind falls through to the engine default (reject; honor
    `onStale: 'notify'`), so this is fully additive — existing schemas are unchanged.
    New public types `ConflictAxis` (also `Ablo.Conflict.Axis`) and the
    `interpretConflictAxis` interpreter are exported for custom policy composition.

- **First-party shared schema for ephemeral keys (new).** `mintUserSessionKey` now accepts
  `schemaProjectId` + `schemaOwnerOrgId`, binding the minted `ek_` to a schema owner-org +
  project so **schema** resolves org-independently (one schema serves all of an integrator's
  end-user orgs) while **data** stays scoped to `organizationId`. Requires the `sk_` to carry
  `ephemeral:mint-any-org`; omit both for the existing per-org (BYO) behaviour.

## 0.15.1

### Patch Changes

- Loud 0-row writes: surface unmatched UPDATE/DELETE ids and add `AbloNotFoundError`

  A commit now reports the ids of any UPDATE/DELETE that matched zero rows on
  `CommitReceipt.missingIds`, and the new exported `AbloNotFoundError` lets typed
  write wrappers throw instead of silently treating a missed write as success.
  Additive and back-compatible (the field is omitted when nothing missed). This
  unblocks the slides-sdk name-addressing / own-your-id work, which relies on a
  loud failure when a stale id is written.

## 0.15.0

### Minor Changes

- **Notify-instead-of-abort: non-coercive conflict handling + read-set (the "did anything I looked at change?" layer).**

  The principle: on a stale-context conflict the engine now **surfaces the current state and lets the actor — agent or human — resolve it**, instead of forcing an outcome. See `docs/concurrency-convention.md`.

  **`onStale` redesigned — Stripe-aligned values (BREAKING).**

  The mode set is now `'reject' | 'overwrite' | 'notify'`. Each value names its outcome:
  - **`notify` (new, non-coercive)** — the conflicting write is **held** (not applied) and the commit returns a `StaleNotification` carrying the conflicting field's _current_ value, so the actor reconciles and re-commits rather than losing work. The rest of the batch still commits.
  - **`overwrite`** (was `force`) — blind last-writer-wins, no signal.
  - **`reject`** (default, unchanged) — throws `AbloStaleContextError`.

  Migration:
  - `onStale: 'force'` → `onStale: 'overwrite'`.
  - `onStale: 'flag'` / `onStale: 'merge'` → `onStale: 'notify'` (both removed; `notify` is the single hold-and-surface mode).

  **`StaleNotification` — the new advisory signal.** New public type + `staleNotificationSchema`:
  `{ object: 'stale_notification', model, id, readAt, observedSyncId, conflictingFields, currentValues, writtenBy, group? }`. Delivered two ways:
  - on the receipt — `CommitReceipt.notifications` (and `CommitResult.notifications`);
  - on a new SDK event — **`conflict:notified`** `{ clientTxId, notifications }` (mirrors `reconciliation:needed` / `sync:rollback`).

  **Read-set (`reads[]`) — declare what you looked at, not just what you write (new).** A commit may carry batch-level read dependencies; a moved premise fires that entry's `onStale` over the whole batch (`notify` holds every write + notifies, `reject` aborts, `overwrite` proceeds). Two granularities:
  - **Row** — `{ model, id, readAt, fields? }`: did this row (optionally these fields) change?
  - **Group** — `{ group, readAt }`: did anything in this sync group (`deck:abc`, `org:X`) change? — the same unit a participant watches and claims.

  New public type `ReadDependency` + `readDependencySchema`; available on `ablo.commits.create({ operations, reads })` and the lower-level write options. This closes the gap the write-target check alone could not: a premise that changed without the written row changing.

  **Conflict policy.** `ConflictDecision` gains `{ action: 'notify' }`; `defaultPolicy` maps `onStale: 'notify'` → notify-and-hold, everything else → reject. `StaleContextConflict.requestedMode` is added so custom policies can honor the caller's declared intent.

- **Data Source reverse-channel connector (new).** A customer Data Source can now **dial out** to the engine over a single outbound WebSocket (`ablo.source.v1` subprotocol) instead of exposing an inbound HTTP endpoint — the deployment shape private/VPC stores need.
  - **`createSourceConnector({ apiKey, handler, baseURL? })`** (new public API, exported from the root and `/source`) — opens one outbound socket (Node global `WebSocket`, no new dependency), with reconnect/backoff, and serves the customer's existing Data Source `handler`.
  - Server side: a connector registry + `/v1/source/listen` upgrade route bridge requests down / responses up, teed into `SourceClient` through the storage resolver.
  - **Trust model unchanged:** the Standard-Webhooks HMAC is signed _above_ the transport, so the socket carries the signed envelope byte-for-byte and the customer's `verifyAbloSourceRequest` is untouched. Transport changes, trust model doesn't.
  - Opt-in per source via `reverse_channel_prod` (migration `20260622150000`); gated in `authorizeUpgrade`.

## 0.14.0

### Minor Changes

- Claim API consistency + coordination docs
  - **React:** document `useWatch` (scoped presence + read-interest, with `claim`/`hydrate`/`paused` options) and `usePeers` (read-only presence) — previously exported but undocumented.
  - **HTTP claim surface:** `HttpClaimApi` is now a mechanically derived async projection of the reactive `ClaimApi` (`AwaitedClaimMethod`), so the two transports can never drift. No behavior change — the only difference remains the `Promise` wrapper that statelessness forces on `state`/`queue`/`reorder`.
  - **Naming:** unified the claim read verb to `state` across every layer (the internal `ModelCollaboration.observe` is now `state`, matching the public `ablo.<model>.claim.state({ id })`).
  - **Docs:** corrected the `Claim` object reference — the field is `reason` (serialized on the wire as `action`), and `createdAt`/`expiresAt` are `number` (epoch-ms), not strings; corrected the claim options to `reason` and `queue`.

## 0.13.0

### Minor Changes

- Schema authoring: split model routing into two orthogonal axes — `policy` (row access) and `groups` (sync-group routing).

  **Breaking (schema authoring).** The flat, collision-prone model options are replaced by two namespaced ones:
  - **`policy`** — row-access / tenant isolation (named after Postgres/Supabase RLS policies: the rule that scopes which rows a tenant may read). A discriminated union on `by` replaces the old `orgScoped` / `scopedVia` / `orgColumn` trio:
    - `{ by: 'column' }` — row-local tenancy column (the default when omitted; column name still overridable).
    - `{ by: 'parent', fk, parent }` — inherit tenancy through a foreign key when the table has no tenancy column of its own (e.g. `slide_layers` → `slides`).
    - Type `TenancyInput` is renamed `PolicyInput`; `policyInputSchema` / `resolvePolicy` are now exported.
  - **`groups: { root, grants, roles }`** — which delta channels a row fans into (orthogonal to `policy`, which governs read access). One namespaced object replaces the old flat `scope` / `grants` / `entityRoles`:
    - `root` (was `scope`) — mark a model a scope root; its records form the group `<kind>:<id>`. Renamed so it no longer collides with the old `scopedVia` tenancy sugar or the inner `grants.scope` relation name.
    - `grants` — a membership edge granting an identity access to a scope root.
    - `roles` (was `entityRoles`) — explicit non-relational record→group roles; accepts one role or an array.
    - `groupsInputSchema` / `GroupsInput` are now exported.

  **CLI.** `config.json` now stores per-project profile key pairs (`profiles: Record<string, ProfileKeys>`) instead of a single top-level pair; older flat layouts are folded into the active profile automatically on read, so existing logins keep working. `login` / `projects` updated to the profile model.

## 0.12.0

### Minor Changes

- Canonicalize the claim API to one vocabulary, plus DX fixes (breaking).
  - BREAKING: claim phase field `action` → `reason` on every claim surface
    (`Claim`, `ClaimHandle`, `ClaimCreateOptions`, `ModelClaim`, ...). The wire
    is unchanged (still `action`, healed on read) — no server redeploy needed.
  - BREAKING: claim contention flag `wait` → `queue` (one word everywhere).
  - BREAKING: React hook `useParticipant` → `useWatch` (aligns with `ablo.<model>.watch`).
  - `ClaimDeclaration.ttlSeconds` is now `number` (was a `Duration`).
  - Docs: `retrieve` HTTP envelope (`.data`/`.stamp`) called out; `syncGroups`
    reworded (provisional, not deprecated); `orgScoped` cross-tenant security
    warning; React error strings point at `<AbloProvider>`.

## 0.11.2

### Patch Changes

- a35d935: Fix stream-recorded undo capturing the wrong "before" value for updates. A second
  update to the same field before the first sync-ack re-captured the original
  pre-session value (first-old-wins + clear-only-on-ack), so undo of a quick second
  edit jumped all the way back instead of one step. The queue now re-baselines a
  field's tracked `.old` once its before-image is frozen into the committed
  transaction.

  Also close the create/update undo asymmetry: an update whose written key had no
  in-place mutation produced an empty `previousData`, which made the inverse
  un-revertible (a create's `delete` inverse never is). Before-image capture now
  falls back to the last loaded/acked snapshot.

  Internally, the two undo paths (stream-recorded and manual `RecordingTransaction`)
  now share one before-image implementation via `Model.capturePreviousValues` /
  `Model.consumeModifiedFields`, so they can no longer drift.

- One-correct-way consolidation (breaking; no external consumers yet, so released as a patch):
  - Credentials collapse to a single `apiKey` — a string, or a `() => Promise<string | null>` that
    fetches a per-user token. Removed `getToken` / `authEndpoint` / public `authToken`.
  - `ablo.<model>.watch(ids, { ttl })` replaces the top-level `ablo.participants.join({ scope })` —
    model-scoped read-interest + presence (WebSocket only).
  - Read claim-gating is `ifClaimed: 'return' | 'fail'` (removed `'wait'`); waiting is the claim
    primitive's job (`ablo.<model>.claim`).
  - The stateless client is `Ablo({ transport: 'http' })`; `createAbloHttpClient` is no longer a
    public export (the factory uses it internally).
  - Read-option types renamed: `ServerReadOptions` (server `retrieve`/`list`) and `LocalReadOptions`
    (local `get`/`getAll`).
  - `defineSchema` throws a clear error on a reserved-field collision; the MCP/docs API surface is
    now compile-time bound to the real exported types (can't drift).

## 0.11.1

### Patch Changes

- 7f91f6e: DX hardening from a real onboarding session — onboarding, CLI, coordination, types, and docs.

  **Client behavior**
  - `databaseUrl` is now an explicit, server-only option: `Ablo(...)` no longer auto-reads `process.env.DATABASE_URL`. A stray `DATABASE_URL` (common — Prisma/Drizzle/docker set it) no longer silently flips the client into connection-string mode; a one-time warning points at the explicit option. Passing `databaseUrl: process.env.DATABASE_URL` explicitly is unchanged.
  - Claims/presence are now observable from any client (including Node agents): reading a row enters its entity sync group (read-interest) and claiming pins it (write-intent), so `ablo.<model>.claim.state({ id })` reports co-participants without any manual subscribe step — whether the observer arrives before the claim (live delta) or after it (subscribe-time backfill). The claim **holder** now also sees its own claim via `claim.state`. **Requires a coordinated `sync-server` deploy** (the subscribe-time claim backfill + the entity-scope subscription gate that lets an org-authority agent key narrow into a row's group live server-side); the client package change alone does not deliver cross-client agent observation.

  **CLI**
  - `ablo init` detects the `src/app` layout (routes + the `@/ablo` import alias resolve correctly), writes the **real** stored sandbox key into `.env.local` instead of a placeholder, and scaffolds `ablo/register.ts` (a regular module, not a colliding `ablo.d.ts`).
  - `ablo <command> --help` / `-h` now prints usage instead of erroring with "unknown flag", and `migrate` is listed in the top-level help.
  - `ablo dev --no-watch` now exits after one push instead of watching forever.

  **Types**
  - Name the client with `typeof sync` (the value-inferred idiom, like tRPC's `typeof appRouter` / Drizzle's `typeof db`) — `ReturnType<typeof Ablo>` collapses to the untyped client and should not be used. No bespoke client-type generic is needed.
  - `model_claim_not_configured` message clarified: claiming needs no per-model schema configuration; every model is claimable through the standard client.

  **Docs**
  - Reconciled the self-contradictory `databaseUrl` story (it is an explicit, server-only option, not auto-read from the environment; consistent casing), documented that the sandbox can host rows (apiKey only, no database), explained why a localhost Postgres can't be the system of record, and led the connect-your-database flow with `ablo pull`/`ablo check` over `ablo migrate`. Fixed stale `api.md` vocabulary (`object: 'claim'`, `participantKind: 'user' | 'agent' | 'system'`).

- 7f91f6e: Docs: document the completed `intent` → `claim` rename. Adds a 0.11.0 migration entry (`useIntent` → `useClaim`, `Register.Intents` → `Register.Claims`, `Ablo.Intent.*` → `Ablo.Claim.*`, and the coordinated client/server deploy for the `claim_*` wire frames), a `useClaim` section in the React reference, and fixes the stale `participantKind` union to the canonical `'user' | 'agent' | 'system'`.

## 0.11.0

### Minor Changes

- Canonical `claim` vocabulary, sync-group area-of-interest, and richer claim-rejection errors.
  - **`intent` → `claim` everywhere.** The coordination primitive is now a `Claim` across the public surface: `useClaim` replaces `useIntent`, the `Ablo.Claim.*` namespace replaces `Ablo.Intent.*`, and module augmentation registers `Claims` instead of `Intents` on the `Register` interface. The underlying wire frames moved from `intent_*` to `claim_*` — clients and servers must run a `claim_*`-aware build together.
  - **Sync-group area of interest.** A client's read interest is no longer frozen at connect: the new `update_subscription` frame drives live re-indexing, and `enterScope` / `leaveScope` / `pinScope` / `unpinScope` let a store narrow or widen what it streams. `AreaOfInterestManager` adds hysteresis (warm-TTL), claim-pinning, reconcile coalescing, and an LRU cap so narrowing the view never shrinks the write allowlist.
  - **Richer claim-rejection errors.** Rejections (over WebSocket and HTTP) now carry `heldByClaim` and `policyReason`, and `AbloClaimedError` exposes a typed `claims` array so callers can see exactly who holds the contested rows.
  - **Coordination vocabulary consolidation.** Participant identity is canonical `user` | `agent` | `system`; the server stamps `participantKind` on every presence emit and clients read it, so non-human peers surface correctly.

## 0.10.1

### Patch Changes

- Docs: add the 0.10.0 entry to the Version History & Migration Guide — the `test`/`live` → `sandbox`/`production` environment enum rename (key prefixes unchanged) and the new `transport: 'http'` stateless client.

## 0.10.0

### Minor Changes

- Rename environment enum values to `production` and `sandbox` while preserving the existing `*_live_`/`*_test_` key prefix format.

### Patch Changes

- Stateless HTTP transport for server-side actors, and a canonical environment vocabulary.
  - **`Ablo({ transport: 'http' })`** returns a stateless `AbloHttpClient` for agents, workers, and serverless — the same `ablo.<model>` surface and coordination plane with no websocket: each call is one HTTP round-trip and identity rides the Bearer credential. The return type narrows so stateful-only APIs (`get`/`getAll`/`onChange`) are compile errors instead of latent runtime gaps.
  - **Canonical `production` / `sandbox` environments** (new `environment.ts`, exported from the root): `sk_test_` / `sk_live_` remain the wire-level key prefixes but now map to `production` / `sandbox` everywhere — key parsing, source `mode`, and the CLI (which drops the legacy test/live config migration).
  - **Source-mode commit scoping**: `commit` now forwards `projectId`, `accountScope`, and `environment` to customer storage resolvers, so per-project and sandbox/production traffic can be routed to distinct stores.
  - **Fixes**: the WebSocket bearer credential is sent in the `ablo.bearer.<token>` subprotocol (never in the URL or proxy logs); `Model` no longer fabricates an `updatedAt` of "now" for records that arrive with only `createdAt`.

## 0.9.15

### Patch Changes

- Package metadata: set the npm description to "The Collaboration Layer For AI Agents" (matching the GitHub repo About) so it stops reverting to the old "State control API…" text on publish.

## 0.9.14

### Patch Changes

- README: replace the `schema -> ablo.<model>...` pseudo-diagram with a real typed snippet (`create`/`retrieve`/`update`/`claim`), and tidy the Get-started line.

## 0.9.13

### Patch Changes

- Per-project axis: schemas, planes, routing, and enforcement scoped per project. Adds the control plane, per-project key scoping with identity threading, a `remove_model` gate, and the CLI/docs to drive it.

## 0.9.12

### Patch Changes

- README: point the Docs / Quickstart / API header links at `docs.abloatai.com` (the real docs) instead of `abloatai.com`, which 307-redirects to the marketing site.

## 0.9.11

### Patch Changes

- `Model<'name'>` type helper via the `Register` binding — name your model in one parameter (`Model<'tasks'>`) instead of restating `typeof schema`; `Model<S, 'name'>` is also supported and `InferModel` is deprecated. CLI: retire the stale `dev` wording from the login outro and `push` header. Docs: cover the `Register` binding end-to-end and document the `pk_` publishable key + the `/v1/commits` HTTP path.
- 3024593: Fix `sessions.create({ user })` 403 — user sessions now mint via the sk\_-gated ephemeral-key door
  - `sessions.create({ user })` mints an `ek_` user session via `/auth/ephemeral-keys` (was wrongly routed through `/auth/capability`, which rejects human participants — writes were being attributed to agents).
  - Control-plane calls always present your original `sk_`, never the client's exchanged sync credential.
  - `sessions.create({ agent, can })` no longer requires hand-built `syncGroups` — the org anchor is the server default — and the `can` allowlist is now honored at commit time (model-alias matching).
  - New: `ablo.organizationId` (resolved after `ready()`), `ablo status --json`, typed sync-group inputs (`SyncGroupInput` + `invalid_sync_group` rejection for malformed groups).

## 0.9.10

### Patch Changes

- README: add a centered brand header (Ablo banner, tagline, doc nav links, and status badges).

## 0.9.9

### Patch Changes

- Docs: version history & migration guide refinements plus changelog, audit, and link fixes.

## 0.9.8

### Patch Changes

- Docs: add a Version History & Migration Guide, bring the changelog current, and sync doc trees. Drop the dormant `causedByTaskId` from the audit-row docs and fix the `ablo mode` argument vocabulary.

## 0.9.7

### Patch Changes

- Docs: fix the `commits.create` operation shape to the public `{ action, model, data }` form.

## 0.9.6

### Patch Changes

- CLI quickstart simplification (3 commands). `init` now owns login, `migrate` is dropped from the direct-`databaseUrl` quickstart (dev handles it), and the `dev` command is renamed to `push` for honest naming with headless-safe login. **Note:** `ablo dev` is now `ablo push` — update any scripts. Also fixes 3 production bugs surfaced by the new end-to-end journey test harness.

## 0.9.5

### Patch Changes

- Scoped-role automation + tenant-routing fix. `ablo migrate` now auto-creates the RLS-gated scoped role (zero SQL) with a log-safe SCRAM-SHA-256 password verifier, plus a Neon/Supabase scoped-role `databaseUrl` recipe. Fix a jsonb double-encode that corrupted per-tenant routing and silently fell back to the shared pool.

## 0.9.4

### Patch Changes

- Sync-position correctness + CLI hardening. Consolidate five scattered sync cursors into one typed `syncPosition` (persisted/applied/acked with a derived `readFloor`), fixing a claim taken right after an ack-confirmed write reading stale against that write's own delta. Add transaction ack-confirmation, schema DDL-first-push, and a reworked CLI (config/dev/login/mode/drizzle-pull).

## 0.9.3

### Patch Changes

- Onboarding: quickstart leads with your-own-database (Drizzle Data Source), drop Ablo-managed mode, add `ablo push` step; context7 library-claim config.

## 0.9.2

### Patch Changes

- Developer-onboarding overhaul so an LLM or a person gets a working integration on the first try.
  - **`ablo init` scaffolds a project that builds and is current-API.** The Next.js scaffold now ships `app/providers.tsx` + an `app/api/ablo-session` route, uses `useAblo` (the removed `withSync` is gone), object-param verbs, and never bundles your `sk_` key into the browser. The webhook receiver moved off the `[...all]` catch-all.
  - **Agent docs are accurate and ship.** `AGENTS.md`, `llms.txt`, and `llms-full.txt` are on the 0.9.x API (object-param `create`/`update`/`delete`/`retrieve`, disposable `await using claim`, `AbloProvider client` prop), lead with `ablo init`, and `AGENTS.md` now ships in the package.
  - **`ablo push` is self-documenting.** Writing to a model the server hasn't seen now fails with an error that tells you to run `ablo push` (the `server_execute_unknown_model` / `unknown_model` messages), instead of a cryptic "unknown model."
  - **`intents` is deprecated in favor of `claim`** everywhere the docs and the MCP scaffold/prompts teach or generate coordination; the public `ablo.intents` accessor is marked `@internal`.
  - Docs say Node 24+, and the `drizzle-orm` peer floor is `>=0.44`.

- a88747a: Remove the `turn` primitive and the agent-work `tasks` resource from the client surface — the SDK is now purely `ablo.<model>` + `claim`.

  **Breaking**
  - `engine.beginTurn()`, the `Turn` handle interface, and the `Ablo.Turn` type are removed. `AbloApi.beginTurn` and the HTTP client's `beginTurn` are gone too.
  - `CommitCreateOptions.causedByTaskId` is removed. (Lineage is no longer stamped from the client.)
  - The engine no longer exposes a `protocol` accessor or a public `tasks` work-unit resource. `ablo.tasks` is, and always was, the schema `tasks` model proxy.
  - The **`agent().run()` helper and the low-level agent/task type family are removed**: `AbloApi.agent(id, options)` and `AbloApi.tasks` (the `TaskResource`), plus the exported types `Agent`, `AgentOptions`, `AgentRunOptions`, `AgentRunResult`/`Done`/`Failed`/`Cancelled`, `AgentRunStatus`, `AgentRunContext`, `AgentModelClient`, `AgentModelReadOptions`, `AgentModelMutationOptions`, `AgentIntentOptions`, `AgentIntentInput`, `Task`, `TaskResource`, `TaskCreateOptions`, `TaskCloseOptions`, `TaskCloseResult` (and the `Ablo.*` namespace aliases for all of them). The `Ablo.Auth.Agent` principal constructor and the schema-backed `tasks` model are unaffected.

  **Why**

  `turn`/`agent_tasks` was a second coordination-and-attribution mechanism living alongside `claim`. It is redundant on the client:
  - `claim` already serializes writers **and** carries the causal link — its `intent` id rides on every guarded write.
  - The server stamps `actor` / `onBehalfOf` / `capabilityId` onto each delta from the auth context.
  - Per-run token/cost is recorded in Langfuse, not the `agent_tasks` table.

  So the only thing the client lost is the audit pane's "show everything this exact prompt produced" filter, which keyed off `caused_by_task_id`; new writes leave that column null.

  **Migration**

  Agents stop opening/closing tasks — just issue `ablo.<model>` writes (schema-backed) or `ablo.commits.create(...)` (schema-less) under a `claim`. Replace `Ablo({ apiKey }).agent(id, opts).run(prompt, handler)` with: mint a scoped credential via `sessions.create({ agent })`, then `claim` the row and `update` / `commits.create`.

  The **server** `agent_tasks` table, the `caused_by_task_id` delta column, the `/api/sync/commit` wire field, and the `agent_actions_log` compliance hash-chain remain in place but **dormant** (client writes leave the field null) — they are load-bearing for the tamper-evident audit chain and historical-row audit JOINs, so they are intentionally NOT dropped. The dead `/v1/tasks` + `/api/agent/turn` route handlers ARE removed (zero live callers).

## 0.9.1

### Patch Changes

- 90b656c: `drizzleDataSource` now takes `(db, schema)` and derives snake_case columns from your schema, so it composes with `ablo migrate` with no parallel Drizzle table. Update calls from `drizzleDataSource(db, tables)` → `drizzleDataSource(db, schema)`. Also adds the `snakeToCamel` export and provisions the adapter's `ablo_outbox` / `ablo_idempotency` tables via `ablo migrate`.

## 0.9.0

A single options object for every model verb, and a disposable `claim` handle.

### Breaking Changes

- **One options object per verb.** `create`, `update`, `delete`, and the async
  server `retrieve` each take a single options object instead of positional
  arguments, so the id, the data, and every modifier live as named siblings:
  `create({ data, id? })`, `update({ id, data, ...options })`,
  `delete({ id, ...options })`, `retrieve({ id, ...options })`. Reactive local
  reads stay on `get(id)` (synchronous) —
  `useAblo((ablo) => ablo.tasks.get(id))`.

  ```diff
  - await ablo.tasks.update(id, { status: 'done' }, { wait: 'confirmed' })
  + await ablo.tasks.update({ id, data: { status: 'done' }, wait: 'confirmed' })

  - await ablo.tasks.retrieve(id)
  + await ablo.tasks.retrieve({ id })

  - useAblo((ablo) => ablo.tasks.retrieve(id)) ?? serverTask
  + useAblo((ablo) => ablo.tasks.get(id)) ?? serverTask
  ```

- **`claim` returns a disposable handle** instead of taking a callback. The
  handle exposes the fresh row on `.data` and is released on scope exit
  (`await using`) or explicitly via `.release()`. `claim.state`, `claim.queue`,
  `claim.release`, and `claim.reorder` also take the options object.

  ```diff
  - await ablo.tasks.claim(id, async (task) => {
  -   await ablo.tasks.update(task.id, { status: 'in_review' })
  - })
  + await using claim = await ablo.tasks.claim({ id })
  + const task = claim.data
  + await ablo.tasks.update({ id: task.id, data: { status: 'in_review' } })
  ```

## 0.8.0

A callable `claim` coordination namespace and bring-your-own-database support
via a new `databaseUrl` option.

### Minor Changes

- **Callable `claim` coordination namespace.** Taking a claim and inspecting its
  state now live under one accessor: `claim(id, work)` acquires a claim and runs
  `work` while it's held, and `claim.state(id)`, `claim.queue(id)`,
  `claim.release(id)`, and `claim.reorder(id, order)` cover the surrounding
  lifecycle. The README leads with the problem (who is allowed to act, and in
  what order) and the Quick Start now demonstrates `claim` directly.

- **Bring-your-own-database via `databaseUrl`.** Point a project at your own
  Postgres with `Ablo({ schema, apiKey, databaseUrl })`. Ablo writes synced rows
  back into your database, so your data stays canonical. Server-side only;
  defaults to `process.env.DATABASE_URL`. See the data-sources guide for setup
  and role requirements.

### Breaking

- The flat coordination methods `claimState`, `queue`, `release`, and `reorder`
  are removed in favor of the `claim` namespace above.

  ```diff
  - await ablo.task.claimState(id)
  - await ablo.task.release(id)
  + await ablo.task.claim.state(id)
  + await ablo.task.claim.release(id)
  ```

## 0.7.0

### Minor Changes

- Structured error contract, schema/migration engine, and a full `ablo` CLI.
  - **Structured error contract across HTTP + WS planes.** A closed, canonical
    error-code registry is now the `code` tier of a Stripe-style error model. A
    single HTTP egress funnel converts every throw to a canonical
    `{ type, code, message, doc_url, request_id, ...details }` envelope; the WS
    plane narrows mutation/claim error codes to the same union.
  - **Versioned contract + drift guard.** `ERROR_CONTRACT_VERSION` (date-based)
    ships in `errors.json` and on the `Ablo-Version` response header, so consumers
    detect contract changes without diffing docs. Generated `errors.mdx` /
    `errors.json` plus a CI drift guard keep the docs, OpenAPI spec, and SDK from
    silently diverging from the registry.
  - **Always-on request correlation.** Every response carries a `req_…` request id
    (honoring an inbound `x-request-id`), stamped into the envelope's `request_id`.
  - **OpenAPI parity.** The stale `{ error, reason }` schema is replaced by the
    canonical envelope plus a generated `ErrorCode` enum.

  CLI + schema:
  - **Schema diff + migration planning engine** (`generateProvisionPlan` /
    `generateMigrationPlan` in `@abloatai/ablo/schema`) — pure diff, classify,
    apply, and constant-value backfill for required-field migrations.
  - **`ablo generate`** — emit TypeScript types from the pushed schema.
  - **Full `ablo` CLI suite**, Stripe-CLI-shaped: `init`, `login` / `logout` /
    `status`, `mode [test|live]`, `dev` (push schema to the test sandbox + watch),
    `logs` (tail your scope's commit activity), and the data-source commands below.
    Authentication is the OAuth 2.0 device flow; `login` provisions and stores a
    test and a live key, and `mode` switches the active one.
  - **Database-URL structure (bring-your-own-database).** The CLI is split by where
    it writes:
    - `ablo pull` / `ablo check` / `ablo migrate` operate on **your own
      `DATABASE_URL`** — `pull` introspects it to emit `defineSchema(...)` from
      existing tables (read-only, like `prisma db pull`), `check` verifies tables
      fit the schema with no DDL, and `migrate` applies DDL to `DATABASE_URL`.
    - `ablo schema push` / `ablo dev` target the **hosted** test/live sandbox; the
      server diffs, migrates, and activates the uploaded schema. `dev` never
      touches live data.

  **BREAKING** — removed the legacy React hooks `useQuery` / `useOne` / `useMutate`
  / `useReader`. Use `useAblo()` + `ablo.<model>.*` instead. The `MutateActions`,
  `ReaderActions`, and `ReaderFindOptions` types are still re-exported for callers
  that referenced them.

## 0.6.0

### Minor Changes

- 0f663e7: Coordination surface: fair queue, reactive wait-line, and lease renewal.
  - **Claims acquire through a server FIFO queue.** On contention a claim waits its turn and re-reads before proceeding; reads are never blocked. Writes blocked by another participant's claim throw a typed `AbloBusyError`.
  - **`ablo.<model>.queue(id)`** — reactive read of the wait-line behind a row: who's queued, their action, and FIFO position. Synced to peers like `activity(id)`.
  - **Backpressure on `claim`** — `{ wait: false }` skips instead of waiting if the row is already held (claim-or-skip dedup); `{ maxQueueDepth: n }` bails with `AbloBusyError('queue_too_deep')` rather than joining a line already that deep.
  - **Lease renewal** — a held claim renews automatically while the holder's connection is alive, so you never size a TTL; it lapses only after the holder goes silent. A queued claim that's abandoned is dequeued (no ghost waiters).
  - **Reads are never gated by a claim**, including for agents.
  - Intent vocabulary cleanup: a waiting claim is an `Intent` with `status: 'queued'` (`position` carries its place in line). Removed the unbuilt `whenFree`.

- **BREAKING — API renames** (apply when upgrading from 0.5.1):
  - Change-listeners renamed to `.onChange(...)`: `ablo.<model>.subscribe(cb)`, `presence.subscribe()`, `intents.subscribe()` → `.onChange(...)`. (`subscribe` is reserved for an upcoming scope-grant verb.)
  - Row-access API renamed Resource → Model: `Ablo.Resource.*` → `Ablo.Model.*`, `ablo.resource(name)` → `ablo.model(name)`, `ModelTarget.resource` → `ModelTarget.model`, error code `resource_not_found` → `model_not_found`.

## 0.5.1

### Patch Changes

- Docs: add a React quick-start (provider + `useAblo`), plain-language rewrite, and a "Set up with Claude Code" section.

## 0.5.0

### Minor Changes

- 9154c1b: Rename intent handle methods to a clearer claim vocabulary; add `AbloProvider` `bootstrapMode`.

  BREAKING — on the model intent handle (`ablo.<model>.intent(id)`):
  `acquire`→`claim`, `acquireOrAwait`→`claimOrWait`, `settled`→`whenFree`,
  `release`→`finish`, `revoke`→`cancel`. The lower-level `IntentHandle` /
  `IntentLeaseHandle` (`ablo.intents.*`) are unchanged.

  Also: `AbloProvider` gains a `bootstrapMode` prop (`'full' | 'none'`) to skip the
  baseline pull on read-light pages; `StaleContextConflict` gains an optional
  `conflictingFields`; README + JSDoc clarity pass and a new HTTP API section.

## 0.4.0

### Minor Changes

- Per-entity coordination intents on the model accessor.

  Coordinate writes to an entity through the same accessor you read it with —
  `ablo.<model>.intent(id)`, returning a `ModelIntentHandle`. Intent state is one
  self-describing object (`{ object: 'intent', id, status, target, action, heldBy,
participantKind, createdAt?, expiresAt? }`) with a single lifecycle:
  `status: 'active' | 'committed' | 'expired' | 'canceled'`. An `active` intent is
  the lock.

  ### Added
  - `ablo.<model>.intent(id)` → `ModelIntentHandle<T>`, beside `create` / `update`
    / `retrieve` / `load` on every model.
    - Read side (any participant, synchronous + reactive): `current` (the holder's
      intent, or `null`), `status` (`'idle'` when free), `settled()`.
    - Write side (the holder): `acquire()`, `acquireOrAwait()`, lease-guarded
      `update()`, `release()`, `revoke()`.
    - `AsyncDisposable`: `await using lock = ablo.<model>.intent(id)` auto-releases
      on scope exit.
  - `acquireOrAwait()` — serialize-on-contention: take the lease, or wait out the
    current holder, re-read the changed row, then take it. The caller never branches
    on who holds the target — it just gets the target safely. Bind it to an agent's
    write-tool boundary so agents never reason about coordination.
  - New exports: `ModelIntentHandle`, `ModelIntentAcquireOptions`.

  ### Changed
  - `acquire()` is fire-and-forget over the socket — it does not throw on conflict.
    Resolve contention with `acquireOrAwait()` (wait) or read `current` for a
    reactive "who's editing" badge, rather than catching a rejection.

  ### Deprecated
  - Participant-level `intents.claim()` / `onRejected()` and the `intent_rejected`
    wire frame still work but are superseded by the per-model handle. Their removal
    is a future breaking change.

## Unreleased

Schema-driven identity sync-group composition, plus a terser capability surface.

The convention for deriving a participant's allowed sync-groups from its identity is now declared on the consumer's schema as an open registration. Consumers with a `{ regionId, customerId }` identity shape declare their own roles instead of receiving any built-in prefixes from the SDK.

Capability fields shed their redundant `allowed` prefix to match the surrounding vocabulary — capability inputs always describe what the bearer _can_ touch, so the prefix was doing no disambiguation work for the consumer.

### Added

- `DefineSchemaOptions.identityRoles?: readonly IdentityRole[]` — open registration of identity-anchored sync-group roles on `defineSchema(...)`. Each `IdentityRole` declares `{ kind, template, extract }`: a diagnostic label, a `'<prefix>:{id}'` template, and a pure extractor function from an opaque identity context to zero-or-more ids. No closed enum; consumers fully control both the template strings and the extraction logic.
- `composeIdentitySyncGroups(identity, schema)` exported from `@abloatai/ablo/schema` — walks the schema's registered `identityRoles`, calls each extractor, and substitutes ids into templates. Stable, deduped output. Returns `[]` when no roles are registered.
- `Schema.identityRoles: readonly IdentityRole[]` — the registered list, accessible on every `defineSchema(...)` result.
- New exported types: `IdentityRole`, `IdentityContext`.

### Breaking

- `capabilities.create({ allowedSyncGroups, allowedOperations })` → `capabilities.create({ syncGroups, operations })`. Both fields renamed at every public surface — capability create input, capability retrieve response, capability record, Identity returned from `AuthProvider`. Hard rename, no alias. Update the call sites; the field semantics are unchanged.

  ```ts
  // Before
  await api.capabilities.create({
    allowedSyncGroups: ['org:acme'],
    allowedOperations: ['tasks.update'],
    lease: '10m',
  });

  // After
  await api.capabilities.create({
    syncGroups: ['org:acme'],
    operations: ['tasks.update'],
    lease: '10m',
  });
  ```

### Changed

- `docs/integration-guide.md` §1 now shows `identityRoles` in the canonical `defineSchema` example plus a "Declaring scope on a model" subsection covering `orgScoped` / `scopedVia` / `syncGroupFormat`. `docs/capabilities.md`, `docs/api.md`, `docs/mcp.md`, and `AGENTS.md` cross-reference the `identityRoles` section and use the renamed fields throughout.

## 0.3.0 (2026-04-22)

Umbrella `<AbloProvider>` for React apps. One provider component now owns the full lifecycle — singleton rotation on auth change, Strict-Mode-safe bootstrap, `beforeunload` cleanup, session-expiry IndexedDB wipe, post-bootstrap hooks, mesh client construction. Replaces the ad-hoc provider glue every consumer had to write themselves.

Declarative props absorb every class of lifecycle glue; the status hook returns a tagged union so impossible states are unrepresentable. The reference integration shrank from 515 LOC of hand-rolled singleton/AbortController/beforeunload/reaction-bridge wiring to a 60-LOC thin wrapper that just passes props through.

### Added

- `<AbloProvider>` — umbrella provider at `@abloatai/ablo/react`. Props include data config (`schema`, `url`, `userId`, `organizationId`), auth (`capabilityToken` / `apiKey` / session cookie fallback), declarative behavior (`preventUnsavedChanges`, `lostConnectionTimeout`, `postBootstrap`), callbacks (`onSessionExpired`, `onError`, `resolveUsers`), and DI escape hatches.
- `<SyncGroupProvider id="matter:...">` + `useSyncGroup()` — per-entity scope context.
- `<ClientSideSuspense fallback={...}>` — gate renders until the engine reports `connected`. Phase-1 non-Suspense; phase-2 upgrades to real Suspense.
- `useSyncStatus()` rewritten as a tagged union: `{ name: 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'needs-auth', ... }`. Impossible states are unrepresentable.
- `useCurrentUserId()` — returns the `userId` prop. Replaces downstream consumers' defineProperty hacks on the store.
- `useErrorListener(cb)` — imperative error callback (Sentry/Datadog).
- `useSync<R>()` and `useSyncStore<T>()` accept generic parameters so consumers can widen to their concrete schema types without `as unknown` casts at call sites.
- `BaseSyncedStore.purge()` / `SyncEngine.purge()` — disconnect + wipe every `ablo_*` / `ablo-*` IndexedDB. Called automatically on session expiry.
- `SyncEngine.onSessionError(listener)` — subscribe to session-error events. Multiple subscribers supported.
- Commit payload projection built into `TransactionQueue`. Mutations are automatically projected onto the model's schema-declared fields (dropping framework internals `__class` / `__typename` / `clientId` / `syncStatus` and anything not declared), with `field.json()` values auto-stringified for TEXT columns and `undefined` dropped on updates. No config port, no consumer hook — the SDK derives correct wire payloads from the schema alone. Apps that previously maintained hand-rolled extractor tables can delete them entirely.

### Breaking (continued)

- Removed `SyncEngineConfig.extractCreateInput` and `SyncEngineConfig.buildUpdateInput`. The SDK's built-in projection replaces them. Consumers who passed these in `configOverrides` should delete the override; the default now covers 100% of identity-column mutations. The `configOverrides` prop still exists but its remaining fields are all deprecated (see below) and scheduled for removal in v0.4.

### Deprecated (vestigial — removal in v0.4)

- `SyncEngineConfig.modelCreatePriority`, `defaultCreatePriority`, `defaultNonCreatePriority` — never read at runtime.
- `SyncEngineConfig.batchableModels` — never read at runtime.
- `SyncEngineConfig.dedicatedDeleteModels` — never read at runtime.
- `SyncEngineConfig.preserveCaseModels` — never read at runtime.
- `SyncEngineConfig.essentialFields` — used only in debug logging, no behavioral effect.
- `SyncEngineConfig.classNameFallbackMap` — dead path; `ModelRegistry.registerModelsFromSchema` registers by constructor identity, bypassing the class-name fallback entirely.

### Breaking

- Removed `<SyncProvider>` — folded into `<AbloProvider>`. Migrate by swapping the provider and passing `userId`/`organizationId`/`url` instead of a pre-constructed store.
- Removed `createAbloContext()` factory and its returned `AbloProvider` / `useAblo` / `useParticipant` triple. Mesh is now always-on inside `<AbloProvider>`; `useAblo()` and `useParticipant(opts)` are always available. Schema-typed mesh hooks are on the roadmap.
- Removed `withSync` (no-op alias of `observer`). Import `observer` from `mobx-react-lite` directly if needed.
- Removed `useSyncContext` from the public surface (never used outside the SDK's test helpers).
- `useSyncStatus()` return shape changed from six booleans to a tagged union. Migration: `const { isReady } = useSyncStatus()` → `const status = useSyncStatus(); const isReady = status.name === 'connected'`.
- `SyncStoreContract` gained six sync-status getters and a `syncStatus` field. Third-party classes implementing the contract must add these (additive for callers).

### Migration

```tsx
// Before (0.2.x)
const { AbloProvider, useAblo, useParticipant } = createAbloContext<typeof schema>();

function Root() {
  const sync = createSyncEngine({ url, schema, user });
  const ablo = new Ablo({ schema });
  return (
    <SyncProvider store={sync._store} organizationId={orgId}>
      <AbloProvider ablo={ablo}>
        <App />
      </AbloProvider>
    </SyncProvider>
  );
}

// After (0.3.0)
function Root() {
  return (
    <AbloProvider
      schema={schema}
      url={url}
      userId={userId}
      organizationId={orgId}
      preventUnsavedChanges
      onSessionExpired={() => router.replace('/signin')}
    >
      <ClientSideSuspense fallback={<Skeleton />}>
        <App />
      </ClientSideSuspense>
    </AbloProvider>
  );
}
```

No breaking change to `useQuery` / `useOne` / `useMutate` / `useReader` / `useMutators` / `useUndoScope` / `usePresence` / `useIntent` — call sites remain source-compatible.

## 0.2.1 (2026-04-22)

React bindings hardening. Fixes two infinite-loop classes that surfaced in downstream apps as React error #185 ("Maximum update depth exceeded"), and exposes sync-status reactivity as a first-class observable + hook.

### Fixed

- **`useQuery` / `useOne` no longer loop on `getSnapshot`.** The `useSyncExternalStore` adapter was returning a fresh `view.results.slice()` on every call, which React's post-commit consistency check interpreted as "store updated mid-render" — scheduling another render, another snapshot, another mismatch, ad infinitum. The snapshot is now cached in a ref and only refreshed inside the subscribe callback right before `onChange()` fires. Affected every tree with multiple simultaneous `useQuery` subscribers.

### Added

- **`BaseSyncedStore` sync status is now properly observable.** `syncStatus` and `dataReady` are annotated `observable`; `isReady`, `isSyncing`, `isOffline`, `isReconnecting`, `isError`, `hasUnsyncedChanges` are `computed`. Before, these were plain getters over plain fields — `reaction(() => store.isReady, ...)` silently never fired. Existing `observer` / `reaction` call sites that relied on the implicit `pool.size` trigger will continue to work; new call sites should read these observables directly.
- **`useSyncStatus()` React hook.** Returns `{ isReady, isSyncing, isOffline, isReconnecting, isError, hasUnsyncedChanges }` as a reactive snapshot, bridged via `useSyncExternalStore` with a correctly-cached snapshot. Replaces hand-rolled `reaction` bridges in consumer providers. See `docs/react.md`.
- **`SyncStoreContract` surfaces the status getters** so TypeScript autocomplete works from the `useSyncContext()` return value without a cast.

### Documentation

- **`llms.txt` and `docs/react.md`** gained a "Common pitfalls" section covering the three traps this release addresses: don't wrap providers in `observer()`, `getSnapshot` must return a cached reference, and sync-status fields are real observables (don't watch `pool.size` as a proxy).

### Migration

No breaking changes. Optional: replace any local `reaction(() => store.isReady, setReady, { fireImmediately: true })` bridges in your own providers with `const { isReady } = useSyncStatus()` for consumers below the store provider.

## 0.2.0 (2026-04-21)

Mesh SDK — the canonical agent-multiplayer surface. Locked at this release; further work is consolidation, not expansion.

### What's frozen

The SDK covers exactly three integration shapes. Each has a canonical example in [`examples/`](./examples/):

1. **Server agent** — `new Ablo({ schema })` reads `ABLO_API_KEY`, joins and works. ([`examples/server-agent.ts`](./examples/server-agent.ts))
2. **Browser app** — server mints a scoped capability, browser holds it via `new Ablo({ schema, capabilityToken })`. No API key in bundle, no session cookies, no allowed-origins registration required. Stripe `client_secret` shape. ([`examples/browser-app.ts`](./examples/browser-app.ts))
3. **Sub-agent** — `parent.join(child, opts)` attenuates from the parent's capability. ([`examples/sub-agent.ts`](./examples/sub-agent.ts))

### Ergonomics (package-wide)

- **`Ablo` class** — `import Ablo from '@abloatai/ablo'` / `new Ablo({ schema })`. Matches `new Stripe()` / `new OpenAI()` / `new Anthropic()` pattern. `createMesh(opts)` stays available as the functional alias.
- **Model-scoped joins** — `ablo.matters.join(id, { label })` desugars to the generic `join`. Proxy-based so the namespace adapts to any schema. Collisions with reserved admin fields (`roles`, `members`, `audit`, `capabilities`) throw at construction time.
- **Flat scope form** — `scope: { matters: id }` alongside the array form.
- **`as` alias** — `{ as: session({...}) }` replaces the security-jargon `onBehalfOf`; both still accepted.
- **Auto-connect** — `join()` returns a connected participant. `autoConnect: false` to opt out.
- **Duration strings** — `ttl: '3m'`, `ttlSeconds: '24h'` accepted alongside numbers.
- **Descriptive generics** — every public type uses `TSchema` / `TAgent` / `ModelName` instead of `S` / `A` / `K`. Zero `unknown` in public types.

### Coordination primitives

- **Presence verbs** — `participant.presence.editing(target)` / `viewing(target)` / `idle()`. Plus `update({...})` escape hatch for custom actions.
- **Intent verbs** — `participant.intents.editing(target, opts)` / `writing(target, opts)`. Returns an `IntentHandle` with `Symbol.asyncDispose` so `await using work = ...` auto-revokes.
- **Snapshots** — `const snap = await participant.snapshot({ clauses: [id] })`. Flat shape: `snap.clauses[id]` (typed from schema via `InferModel`, not `unknown`), `snap.stamp`, `snap.signal` (AbortSignal).
- **Async iterables** — `for await (const peers of participant.presence)`, `for await (const openIntents of participant.intents)`, `for await (const delta of participant.deltas)`.

### Env / config

- `ABLO_API_KEY` — required for server-side use.
- `baseURL` — optional override for private deployments / local-dev (defaults to `wss://api.abloatai.com`).
- `organizationId` — **no longer required** in `createMesh`. The API key or session binds the caller to one org; the capability mint response echoes it back.
- `createMeshFromEnv` — removed. `new Ablo({ schema })` auto-reads env.

### Test coverage

- 53 mesh unit tests across 8 suites (`__tests__/unit/mesh/`)
- New E2E test `e2e-browser-capability-token.ts` proves the server-mints / browser-holds flow end-to-end
- Existing 12 mesh E2E tests (token refresh, watermark, chinese wall, etc.) still pass

---

## 0.1.0 (2026-04-10)

Initial release.

### Features

- **Schema DSL**: Zero-codegen schema definition with full TypeScript inference (`defineSchema`, `field`, `relation`)
- **React Hooks**: `useModels`, `useModel`, `useMutations`, `withSync` for reactive data binding
- **Consumer API**: `createSyncEngine()` — one-liner setup that hides all internal wiring
- **Offline-first**: IndexedDB persistence with automatic offline mutation queue and FK-safe flush
- **Real-time sync**: WebSocket delta streaming with optimistic updates and rollback
- **AI Agent SDK**: `SyncAgent` for backend/AI agent participation as first-class sync citizens
- **Pluggable auth**: `AuthProvider` interface with built-in API key, JWT, and session providers
- **Security**: IndexedDB cleanup on session expiry and sync group revocation
- **Testing utilities**: `@abloatai/ablo/testing` subpath with mocks, fixtures, and harness

### Test Coverage

- 231 unit/integration/property/contract tests
- 50 E2E tests against real Go server + PostgreSQL + Redis
- Property-based testing via fast-check
