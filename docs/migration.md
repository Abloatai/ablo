# Version History & Migration Guide

The breaking-changes-first companion to the [Changelog](../CHANGELOG.md). The
changelog tells the story of each release; this page tells you exactly what to
change when you upgrade.

> Ablo is pre-1.0, so minor versions (`0.x.0`) may carry breaking changes. Patch
> versions (`0.x.y`) never do. Pin a minor and read this page before bumping it.

## Breaking changes at a glance

| Version | What changed | What to do |
|---|---|---|
| **0.9.2** | `turn` primitive + agent-work `tasks` resource removed | Coordinate with `claim`; mint a scoped session instead of `agent().run()` |
| **0.9.2** | `intents` deprecated in favor of `claim` | Use `ablo.<model>.claim`; `ablo.intents` is now `@internal` |
| **0.9.0** | One options object per verb | `update(id, data, opts)` → `update({ id, data, ...opts })` |
| **0.9.0** | `claim` returns a disposable handle | `await using claim = await ablo.x.claim({ id })` |
| **0.8.0** | Flat coordination methods removed | `ablo.x.claimState(id)` → `ablo.x.claim.state({ id })` |
| **0.7.0** | Legacy React hooks removed | `useQuery`/`useOne`/`useMutate`/`useReader` → `useAblo()` + `ablo.<model>.*` |
| **0.6.0** | `subscribe` → `onChange`; `Resource` → `Model` rename | Rename listeners and `ablo.resource()` → `ablo.model()` |
| **0.5.0** | Intent-handle method renames | `acquire`→`claim`, `acquireOrAwait`→`claimOrWait`, … |
| **0.3.0** | `<SyncProvider>` / `createAbloContext()` / `withSync` removed | Use the umbrella `<AbloProvider>` |

---

## 0.9.2 — `turn` / agent-`tasks` removed; `intents` deprecated

The SDK's coordination surface is now exactly two things: `ablo.<model>` writes
and `claim`. The parallel `turn` / agent-`tasks` mechanism was redundant —
`claim` already serializes writers **and** carries the causal link (its `intent`
id rides on every guarded write), and the server stamps `actor` / `onBehalfOf` /
`capabilityId` onto every delta from the auth context.

**Removed:** `engine.beginTurn()`, the `Turn` handle and `Ablo.Turn` type,
`AbloApi.beginTurn`, `CommitCreateOptions.causedByTaskId`, the `agent().run()`
helper, and the agent/task type family (`Agent`, `AgentOptions`,
`AgentRunResult`, `Task`, `TaskResource`, …).

> **Note:** `ablo.tasks` is — and always was — the schema `tasks` **model**
> proxy. Only the agent-work *resource* of the same name was removed. If you have
> a `tasks` model in your schema, it is unaffected.

```diff
- const turn = await engine.beginTurn();
- await Ablo({ apiKey }).agent(agentId, opts).run(prompt, handler);
+ // Mint a scoped credential, then claim + write under it.
+ const { token } = await ablo.sessions.create({ agent: { id: agentId } });
+ const agent = Ablo({ schema, apiKey: token });
+ await using claim = await agent.tasks.claim({ id });
+ await agent.tasks.update({ id, data: { status: 'done' }, wait: 'confirmed' });
```

Per-run token/cost now lives in Langfuse, not an `agent_tasks` table. The only
capability the client loses is the audit pane's "show everything this exact
prompt produced" filter (it keyed off `caused_by_task_id`); new writes leave that
column `null`. The server-side `agent_tasks` table, the `caused_by_task_id` delta
column, and the `agent_actions_log` hash-chain are intentionally **kept but
dormant** — they are load-bearing for the tamper-evident audit chain. The dead
`/v1/tasks` and `/api/agent/turn` route handlers were removed.

### `intents` → `claim`

```diff
- const lock = ablo.intents.editing(target);
+ await using claim = await ablo.documents.claim({ id });
```

`ablo.intents` still exists but is marked `@internal`. Use `ablo.<model>.claim`
everywhere you coordinate concurrent work.

---

## 0.9.0 — one options object per verb; disposable `claim`

Every model verb takes a single options object, so the id, the data, and every
modifier are named siblings. Reactive local reads stay on the synchronous
`get(id)`.

```diff
- await ablo.tasks.update(id, { status: 'done' }, { wait: 'confirmed' })
+ await ablo.tasks.update({ id, data: { status: 'done' }, wait: 'confirmed' })

- await ablo.tasks.retrieve(id)
+ await ablo.tasks.retrieve({ id })

- useAblo((ablo) => ablo.tasks.retrieve(id)) ?? serverTask
+ useAblo((ablo) => ablo.tasks.get(id)) ?? serverTask
```

`claim` now returns a disposable handle instead of taking a callback. The handle
exposes the fresh row on `.data` and releases on scope exit.

```diff
- await ablo.tasks.claim(id, async (task) => {
-   await ablo.tasks.update(task.id, { status: 'in_review' })
- })
+ await using claim = await ablo.tasks.claim({ id })
+ const task = claim.data
+ await ablo.tasks.update({ id: task.id, data: { status: 'in_review' } })
```

`claim.state`, `claim.queue`, `claim.release`, and `claim.reorder` also take the
options object.

---

## 0.8.0 — callable `claim` namespace

The flat coordination methods are gone; everything lives under `claim`.

```diff
- await ablo.task.claimState(id)
- await ablo.task.release(id)
+ await ablo.task.claim.state(id)
+ await ablo.task.claim.release(id)
```

This release also added the `databaseUrl` option for the direct Postgres
connector — additive, no migration required.

---

## 0.7.0 — legacy React hooks removed

The query/mutation hooks were replaced by the single `useAblo()` accessor over
typed model methods.

```diff
- const { data } = useQuery('task', { where: { done: false } })
+ const ablo = useAblo()
+ const tasks = ablo.task.list({ where: { done: false } })
```

Removed: `useQuery`, `useOne`, `useMutate`, `useReader`. The `MutateActions`,
`ReaderActions`, and `ReaderFindOptions` types are still exported for callers
that reference them. This release also replaced the `{ error, reason }` error
shape with the canonical `{ type, code, message, doc_url, request_id }` envelope.

> **Note:** This — not 0.9.x — is the release where `useAblo()` became the one
> React read path. If you are coming from a 0.6.x or earlier app, this is your
> biggest hook migration.

---

## 0.6.0 — `onChange` and the Resource → Model rename

```diff
- ablo.tasks.subscribe(cb)
+ ablo.tasks.onChange(cb)

- ablo.resource('tasks')
+ ablo.model('tasks')
```

Also renamed: `Ablo.Resource.*` → `Ablo.Model.*`, `ModelTarget.resource` →
`ModelTarget.model`, and error code `resource_not_found` → `model_not_found`.
(`subscribe` is reserved for an upcoming scope-grant verb.)

---

## 0.5.0 — intent-handle method renames

On the model intent handle (`ablo.<model>.intent(id)`):

```diff
- handle.acquire()         + handle.claim()
- handle.acquireOrAwait()  + handle.claimOrWait()
- handle.settled()         + handle.whenFree()
- handle.release()         + handle.finish()
- handle.revoke()          + handle.cancel()
```

The lower-level `IntentHandle` / `IntentLeaseHandle` (`ablo.intents.*`) were
unchanged at this release. (They were later folded under `claim` in 0.9.2.)

---

## 0.3.0 — umbrella `<AbloProvider>`

One provider component now owns the full React lifecycle. `<SyncProvider>`,
`createAbloContext()`, and `withSync` were removed.

```diff
- const { AbloProvider, useAblo } = createAbloContext<typeof schema>();
- <SyncProvider store={sync._store} organizationId={orgId}>
-   <AbloProvider ablo={ablo}>{children}</AbloProvider>
- </SyncProvider>
+ <AbloProvider schema={schema} url={url} userId={userId} organizationId={orgId}>
+   {children}
+ </AbloProvider>
```

`useSyncStatus()` changed from six booleans to a tagged union:

```diff
- const { isReady } = useSyncStatus()
+ const isReady = useSyncStatus().name === 'connected'
```

Import `observer` from `mobx-react-lite` directly if you used `withSync`.

---

## The `intent` → `claim` evolution

Coordination has converged on one verb over several releases. If you are reading
old code or old docs, this is the through-line:

| Release | State of coordination |
|---|---|
| 0.4.0 | `ablo.<model>.intent(id)` introduced — per-entity intent handle |
| 0.5.0 | Intent-handle methods renamed to claim vocabulary (`acquire`→`claim`, …) |
| 0.8.0 | Callable `claim` namespace (`claim(id)`, `claim.state`, `claim.queue`, …) |
| 0.9.0 | `claim` returns an `await using` disposable handle |
| 0.9.2 | `intents` deprecated and made `@internal` — **`claim` is the one coordination API** |

For the full chronological history, see the [Changelog](../CHANGELOG.md).
