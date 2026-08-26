# Agent Integration Decision Guide

> Choose one integration route before reading an example. Most existing products should coordinate one existing operation first; they should not copy the document pipeline.

## Start with the operation you already own

Name one existing application operation, such as `completeTask`, `approveInvoice`,
or `publishReport`. Keep its authorization, database transaction, constraints,
and public API in place. Add Ablo at that operation boundary.

Use this routing table for the decisions that are easy to conflate:

| Question | Choose | When |
|---|---|---|
| What is being coordinated? | Identifier-only claim | Work has a stable business identity, but the authoritative row and final write remain in the existing service or Postgres. |
|  | Row-backed claim | The coordinated row is an Ablo schema model and the final write goes through that model resource. |
| Did the decision depend on previously read rows? | Captured reads | Read the premises with `read(...)`, then pass those returned rows through `reads`. Use this even when the written row is different from a premise row. |
| Must several Ablo mutations either all land or none land? | Atomic commit | Put the mutations, captured reads, and any typed claim handles in one `commits.create(...)`. Separate mutation calls are independently successful or failed. |
| Where should the final write happen? | Existing database write | Keep it when the current service owns the transaction, constraints, or rollout switch. Ablo's lease does not join a transaction running in another process. Re-read and validate inside the database transaction. |
|  | Ablo-routed write | Use it for declared schema models after the database connection and server schema are configured. Guard decision-dependent writes with a held claim or captured reads. |
| Who is participating? | Stateless HTTP client | Agents, jobs, and request/response server handlers. Give each concurrent participant its own scoped credential. |
|  | Reactive WebSocket client | Human-facing applications that need live state, presence, or local reactive reads. This transport is not required for worker coordination. |

These choices compose. For example, a stateless worker can take an
identifier-only claim, perform slow work, and then call an existing Postgres
operation. Another worker can take a row-backed claim and submit an atomic Ablo
commit guarded by captured premise rows.

## Choose the smallest example

### Coordinate existing work

Start with
[`examples/graphql-existing-backend`](../../../examples/graphql-existing-backend/README.md)
when an application already owns its API, operation, and Postgres write.

It demonstrates:

- GraphQL delegating to a named application operation;
- an identifier lease around expensive work;
- the existing service retaining its authoritative transaction and re-read;
- an operation-level switch between existing and coordinated paths; and
- recovery and contract parity without replacing the application's API.

Use
[`examples/coordination-conformance`](../../../examples/coordination-conformance/README.md)
alongside it to verify real hosted lease behavior independently of the domain.

### Build evidence-backed document state

Read
[`examples/existing-document-pipeline`](../../../examples/existing-document-pipeline/README.md)
only when the feature genuinely needs versioned source evidence, citations,
guarded review decisions, atomic multi-row review writes, and retained search
projections.

That example is an advanced reference application. Its document ingestion,
search, review, projection-retention, and append-only event policies are not
prerequisites for adopting Ablo.

## Know which owner makes each promise

| Ablo responsibility | Application responsibility |
|---|---|
| Participant-scoped claims, lease expiry, wait/skip behavior, heartbeat, release, and commit-time fencing | Choosing the business claim identity and issuing distinct participant credentials |
| Capturing model-row versions returned by `read(...)` and rejecting a guarded write when those premises are stale | Choosing every row that is a premise of the decision |
| Atomicity among mutations submitted in one Ablo commit | Database transactions and constraints outside that commit; never presenting separate writes as an atomic batch |
| Request idempotency within the documented identity, retention, and identical-request rules | Durable workflow idempotency and deduplication of external effects |
| Synchronizing declared model rows and serving reactive state | Uploads, search semantics, projections, workflow execution, review policy, and external APIs |
| Credentials, participant attribution, and schema-declared scope enforcement | Existing application authentication and authorization at the operation boundary |

Claims coordinate cooperative participants; they are leases, not absolute locks.
A writer outside the coordinated path can still change Postgres. Database
constraints and a commit-time guarded re-read remain the final backstop.

## Minimum integration contract

Write down these answers next to the operation before implementing it:

1. **Existing operation:** Which named operation and public API remain stable?
2. **Claim identity:** Which stable model row or business identifier represents the contested work?
3. **Participant identity:** Which distinct scoped credential does each concurrent human, agent, or worker use?
4. **Premises:** Which exact rows does the decision depend on, and which of them must use `read(...)`?
5. **Atomic boundary:** Which writes must all succeed together? Are they one Ablo commit, one existing database transaction, or deliberately independent?
6. **Persistence owner:** What remains in Postgres and which writes, if any, are routed through Ablo?
7. **Failure behavior:** What happens on contention, lease expiry, stale evidence, request retry, partial completion, and an external side-effect failure?
8. **Proof:** Which local contract test and which hosted or staging test proves each claimed guarantee?

If an answer is unknown, keep the existing write path available. Do not broaden
the schema or copy an advanced example to hide the missing decision.

## Guarantee-to-test matrix

The examples prove different layers. A local fixture proves application behavior;
it does not prove hosted infrastructure. Conversely, hosted claim conformance
does not prove a domain transition or a real Postgres transaction.

| Statement | Proof level | Executable evidence |
|---|---|---|
| GraphQL keeps the same result while the named operation changes implementation | Local application contract | `examples/graphql-existing-backend/tests/graphql.test.ts` and `tests/pilot.test.ts` — `the GraphQL resolver delegates one typed input to the named operation`; `the operation switch preserves the uncontended GraphQL contract` |
| Coordination moves expensive work outside the retained database critical section | Local application contract; real DB timing requires staging | `examples/graphql-existing-backend/tests/pilot.test.ts` — `coordination moves expensive work outside the retained critical section`; optional `npm run test:live:postgres` |
| Contenders do not duplicate expensive work, and failure releases the path | Local application contract | `examples/graphql-existing-backend/tests/pilot.test.ts` — `two coordinated workers pay for expensive work once`; `a failed owner releases coordination so the existing path remains available` |
| Distinct hosted participants exclude one another, heartbeat, release, and recover after expiry | Hosted infrastructure | `examples/coordination-conformance`: `npm run test:live`; its live runner also executes the exit-without-release expiry probe |
| A decision based on changed source evidence is rejected | Local application contract using Ablo-shaped guards | `examples/existing-document-pipeline/tests/processDocument.test.ts` — `a source change rejects stale extracted output`; `tests/review.test.ts` — `guarded mutations reject stale evidence and release claims for retry` |
| Several review records submitted as one commit are atomic; separate calls can partially complete | Local application contract | `examples/existing-document-pipeline/tests/review.test.ts` — `requesting review atomically creates durable issue state and an event`; `independent review writes expose partial completion and retry only the stale target` |
| Rebuilding search does not remove a complete snapshot referenced by durable review evidence | Local application policy | `examples/existing-document-pipeline/tests/search.test.ts` — `publishing a rebuild retains the complete projection snapshot referenced by review`; `an unreferenced superseded projection becomes removable as one snapshot` |
| The documented ownership tree, public exports, dependency direction, and lack of cycles match disk | Local structure contract | Each focused example's `tests/structure.test.ts`; the document fixture additionally validates exact inventory and dependency direction from `structure.json` |
| Authorization, latency, database locking, and external-effect behavior match the production application | Partner staging | Run the operation against the real auth, Postgres schema, workload, and provider sandbox. No repository fixture can establish this claim. |

## Safe first adoption

For an existing product, the default sequence is:

1. Wrap one named operation without changing its public API.
2. Use an identifier-only claim if the existing database remains authoritative.
3. Keep the Postgres transaction, lock, validation, and constraints in place.
4. Verify participant-scoped lease behavior with coordination conformance.
5. Add captured reads or an atomic Ablo commit only when the operation actually needs them.
6. Move more persistence through Ablo only after the guarded hosted write path and staging behavior are proven for that operation.

Continue with the [Integration Guide](./integration-guide.md) for setup and API
details, or [Concurrency Convention](./concurrency-convention.md) for the exact
guarding rules.
