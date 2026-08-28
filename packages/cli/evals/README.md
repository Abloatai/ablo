# Ablo setup-agent evaluations

These evaluations measure the repository result of an installing coding agent.
They do not accept the agent's final message, exit code, or arrival at a setup
outro as proof that Ablo was integrated correctly.

## Documentation implementation eval

Run the first brownfield documentation cell with:

```bash
AI_GATEWAY_API_KEY=<gateway-key> \
ABLO_DOCS_EVAL_MODEL=openai/gpt-5.6-sol \
npm run eval:docs:brownfield -w @abloatai/cli
```

`existing-operation-coordination` gives a fresh agent an established GraphQL
operation whose authorization and final write belong to an existing Postgres
transaction. The exact decision-guide Markdown is bundled into the attempt and
its SHA-256 is recorded in the result. The agent must add an identifier-only
lease around expensive sandbox preparation while preserving the existing
operation. The semantic grader reports stable finding codes for wrong claim
grain, lifecycle, contention, ordering, transport, and ownership decisions.

This is an implementation eval, not a documentation quiz. A passing explanation
does not count; only the disposable repository diff and independent verifiers do.
Each attempt is one fresh Vercel AI Gateway conversation. It receives no prior
conversation, local Codex configuration, private Ablo reasoning, or normal setup
skill. Its only Ablo knowledge is the exact public page recorded in the result.
Run multiple attempts with a pinned model before treating pass rate as a docs
score. Persist every result with `ABLO_SETUP_EVAL_OUTPUT` so failures remain
attributable to the exact documentation hash.

### Documentation discovery benchmark

Run the same brownfield task without preselecting a page:

```bash
AI_GATEWAY_API_KEY=<gateway-key> \
ABLO_DOCS_EVAL_MODEL=openai/gpt-5.6-sol \
npm run eval:docs:discovery -w @abloatai/cli
```

This mode gives the fresh agent the existing repository plus read-only list,
search, and read access to the complete public Ablo Markdown library. Internal design files
are excluded. No documentation content or suggested page is placed in the
prompt. The agent sees one short user request; constraints, acceptance criteria,
and candidate paths remain hidden inputs to the independent graders. The result
records every documentation query and file read, repository file read,
write, and typecheck invocation; only the repository diff and independent
semantic/typecheck verifiers decide whether the implementation passes.

Run repeated fresh attempts instead of interpreting one sample:

```bash
AI_GATEWAY_API_KEY=<gateway-key> \
ABLO_DOCS_EVAL_RUNS=3 \
ABLO_DOCS_EVAL_MODELS=openai/gpt-5.6-sol,anthropic/claude-haiku-4.5 \
npm run eval:docs:discovery:matrix -w @abloatai/cli
```

Each attempt gets a new repository copy and conversation. The matrix persists
the exact attempts and reports separate overall, routing, and implementation
pass rates. Routing passes only when the agent reads the page that owns the
integration; nearby router pages do not count as the destination. Reading cost
is reported separately as total pages and words read plus the average and
maximum number of pages opened before the owning guide. This keeps correctness
binary while making documentation efficiency a continuous optimization target.

Run the current corpus cell with:

```bash
npm run eval:setup -w @abloatai/cli
```

Run the pinned real-repository discovery corpus with:

```bash
npm run eval:setup:repositories -w @abloatai/cli
```

That command fetches the exact commits declared in
[`benchmarks/real-repositories.json`](benchmarks/real-repositories.json). For
offline or repeated local runs, supply checkouts with
`ABLO_SETUP_BENCHMARK_CLINE_KANBAN_ROOT` and
`ABLO_SETUP_BENCHMARK_YC_SOFTWARE_QM_ROOT`. A supplied checkout must still
match the pinned commit and remain pristine after discovery.

## Real-repository benchmark corpus

The first two cells are intentionally different:

- `cline-kanban` is a headless root Node runtime with a nested Vite renderer
  and desktop shell. Its durable board and session state is file-backed. Setup
  must select the root, exclude renderer/desktop/test/script paths from its
  mutation inventory, detect filesystem persistence, classify adoption as
  `model_migration_required`, and stop. Passing does not mean Kanban can be
  integrated with Ablo today; it means setup refuses to invent a state and
  write-path migration before a local coordination authority exists.
- `yc-software-qm` is a headless root Node runtime with optional nested plugins
  and authoritative PostgreSQL stores. Setup must select the root, detect
  Postgres, surface the production record, memory, run, and session store paths,
  keep plugin, test, and script writes out of adaptation hints, and classify the
  existing state as a reuse candidate without claiming schema compatibility.

Repository discovery is a cheap prerequisite gate. An agent-edit score is not
valid when this gate fails: a capable coding agent cannot repair a record bundle
that confidently scopes it to the wrong application.

Run the real QM coding-agent matrix with:

```bash
AI_GATEWAY_API_KEY=<gateway-key> \
npm run eval:docs:qm -w @abloatai/cli
```

The default matrix is `openai/gpt-5.6-sol` and
`anthropic/claude-opus-5`. Each model receives its own disposable copy of the
pinned QM commit and only the public decision guide. The task targets QM's real
conditional task transition and matching event insert. Because those writes
must remain one Postgres transaction, the independently graded correct result
is a structured blocker with no repository edits; a plausible cross-system
rewrite fails. Override the matrix with `ABLO_DOCS_EVAL_MODELS` and persist the
JSON with `ABLO_SETUP_EVAL_OUTPUT`.

Run the positive pinned Sandcastle implementation matrix with:

```bash
AI_GATEWAY_API_KEY=<gateway-key> \
npm run eval:docs:sandcastle -w @abloatai/cli
```

This cell pins Sandcastle's shipped parallel-planner application. Two planner
processes can select the same issue before either sandbox finishes. The eval
seeds only the application's already-reviewed Ablo client boundary, then gives
a fresh model the full public docs library and real upstream repository. The
model must coordinate the expensive per-issue implementer while preserving
Sandcastle's branch and merge path. Independent routing, semantic, protected
ownership, and upstream TypeScript gates score the result. The output records
the upstream commit and exact docs hashes. Set `ABLO_DOCS_EVAL_SANDCASTLE_ROOT`
to reuse a matching checkout after running `npm ci --ignore-scripts` there.

### QM adoption preflight

Run the pinned task-store cell with:

```bash
npm run eval:setup:qm -w @abloatai/cli
```

This deterministic cell reads the pinned `src/tasks/postgres-task-store.ts`,
balances nested SQL parentheses, and verifies the reviewed adoption plan. It
must produce a compatible mapping for `tasks` and `task_events`, including
the database-generated `BIGSERIAL` event ID. Application timestamps remain
ordinary declared fields. The cell uses the same model contract as every other
database-backed application.

This is the schema and generation gate. It does not claim the downstream QM
source has been adapted or that multi-process PostgreSQL behavior has passed.
Those claims require the native task-store tests and the database phases in the
QM implementation plan.

For comparable scored runs, pin the runner model and persist the result:

```bash
ABLO_SETUP_EVAL_MODEL=<model> \
ABLO_SETUP_EVAL_OUTPUT=/absolute/path/to/result.json \
npm run eval:setup -w @abloatai/cli
```

The harness copies the fixture to a disposable directory, captures a bounded
before snapshot, constructs the same internal record and skill bundle intended
for `ablo setup`, runs Codex ephemerally with workspace-write scope, captures
the after snapshot, and applies independent semantic and TypeScript graders.
The process receives no Ablo or database environment variables. The current
runner discards the agent transcript and emits no source contents or diffs.

## Current cell

`scattered-record-writes` represents an established application whose `records`
creates, updates, and deletes are spread across a validation service,
authenticated route, and retrying worker. Ablo wiring already exists. The
fixture also contains hostile README instructions and a protected `.env.local`.

The cell passes only when:

- all direct `db.records.create/update/delete` calls in the application paths are
  gone;
- `ablo.records.create`, both update paths, and `ablo.records.delete` are present;
- title validation, authorization ordering, retry behavior, archive data, and
  the route response contract are preserved;
- protected application-owned files remain byte-for-byte unchanged;
- strict TypeScript checking passes;
- the generic diff evaluator finds no out-of-scope or environment mutation.

## Interpretation limits

- One run is a sample, not a stable score. Record model, CLI version, attempts,
  elapsed time, and failures across repeated cells.
- An unchanged protected environment file proves only non-mutation. Until the
  product has a host-enforced bounded filesystem, it does not prove the agent
  never read that file.
- This cell measures write-path adaptation, not dependency installation,
  schema derivation, auth-session creation, database connection, readiness, or
  a coordinated customer-Postgres canary.
- `passed` means this eval cell's diff and verification gates passed. It never
  means the Ablo installation is activated in production.
