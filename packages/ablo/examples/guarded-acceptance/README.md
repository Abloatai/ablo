# Trusted acceptance for Lobby

Copy this directory into the server operation that owns acceptance. It uses the
existing Ablo 0.66.12 SDK and adds no dependency. Its three calls are:

```ts
import Ablo from '@abloatai/ablo';
import { createAcceptance, schema } from './acceptance/index.js';

const client = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, transport: 'http' });
const acceptance = createAcceptance({
  client,
  accountId: authenticatedAccountId,
  verify: verifyCandidate,
  broker: protectedGitBroker,
});

const prepared = await acceptance.prepare({ candidate: request.body, workerId: authenticatedWorkerId });
if (!prepared.ok) return prepared; // { error: { code, recovery } }
return acceptance.reconcile({ proposalId: prepared.value.proposalId });
```

`verifyCandidate` and `protectedGitBroker` are your existing application
boundaries, described below. The account and worker IDs come from your
authenticated server context. Neither constructing this helper nor supplying
an ID authenticates a request. Authorize the account on every request, including
retries and status reads. Run reconciliation as a protected service operation.

## What the module handles

- `prepare` parses the candidate, rereads task/assignment and premises through
  the accepting client, checks owner/generation/revisions, verifies the candidate,
  and atomically creates the proposal and reserves the task's acceptance slot.
- Duplicate identity with identical content returns the existing state. Changed
  content under that identity returns `proposal_conflict`. The proposing worker
  is stored separately from the credential that authorizes Ablo's commit.
- `reconcile` checks durable broker evidence first, applies only when the broker
  reports authoritative absence, verifies the outcome binding, then atomically
  acknowledges and publishes the accepted SHA or records a terminal rejection.
- `pending` returns one page of unresolved proposal IDs and a cursor, capped at
  100 rows. No unbounded scan or background process starts automatically.
- Every call returns `{ ok: true, value }` or
  `{ ok: false, error: { code, recovery } }`. Recovery is `reread`, `replan`,
  `reconcile`, `retry`, or `stop`. Unknown outcomes never count as failed writes.

Candidates accept at most 64 unique declared premises. A busy task returns
`acceptance_pending` with `error.proposalId` naming the proposal to reconcile.

## Model setup

Merge `schema.models` into your application's schema or adapt the three named
models to your existing ownership boundary. Keep subject authorization on
`accountId`. Provision your application's tables with its normal migrations
and register the matching schema using the normal reviewed Ablo setup. Do not
replace a production schema with this example's three-model schema.

The example combines task state, durable assignment, policy revision, and the
acceptance slot in `acceptanceTasks`. Seed it with the actual owner, monotonically
increasing generation, task and policy revisions, current accepted Git SHA,
`revoked: false`, and `pendingProposalId: null`. Ownership, access, task content
and policy changes must update that row through the trusted authority. A
separate policy row in your app must also be reread and included in the commit's
read set when adapting this example.

`acceptancePremises` stores stable dependency IDs and application revisions;
the application updates these when the underlying premise changes. Every
required dependency must be declared. A cached mirror that is updated later
does not make external state atomic with acceptance.

`acceptanceProposals` stores the immutable serialized candidate and digest
alongside its mutable status/outcome. Only the accepting service may write it;
never modify the candidate payload or delete its identity. Worker grants should
allow only the necessary reads, with no writes to these three control models.
The service needs account-scoped reads and writes; a secret key alone does not
bypass subject policy. A customer database must enforce the same boundary for
direct writes outside Ablo.

## Two application integrations

`verifyCandidate({ candidate, workerId, task, premises })` returns `true` only
after checking an immutable candidate and its verification evidence. It must
verify the exact candidate SHA, base SHA, policy revision, verification digest,
and completeness of the dependency list. It receives snapshots; it cannot
replace the helper's captured evidence. Returning `false` prevents preparation.
This helper cannot establish whether a test result is truthful or code is
semantically correct.

The `GitBroker` interface has two methods:

```ts
lookup(candidate: PreparedCandidate): Promise<ApplicationOutcome | null>;
apply(candidate: PreparedCandidate): Promise<ApplicationOutcome>;
```

`lookup` returns `null` only for authoritative absence; failures throw.
`apply` must accept only protected service calls, enforce exact-base admission,
and atomically persist the accepted ref and receipt. Both methods must bind the
decision permanently to proposal ID and digest. Concurrent calls and retries
return the same durable decision. An applied outcome includes repository, base,
accepted SHA and receipt ID. A terminal rejection includes `base_changed` or
`verification_failed` and must be durable and mutually exclusive with applying
that same proposal. Unknown or in-flight work must throw, never claim rejection.

Prepared work remains authorized after the original worker is revoked. The
recovery service completes that durable decision. To cancel prepared work,
implement cancellation in the same broker authority that fences application;
updating an Ablo row or expiring a worker lease cannot cancel a Git update.
Execution leases remain separate from durable assignment generations.

## Restart recovery

```ts
const page = await acceptance.pending({ repositoryId, limit: 100, cursor });
if (!page.ok) return page;
for (const proposalId of page.value.proposalIds) {
  const outcome = await acceptance.reconcile({ proposalId });
  // Persist/report outcome.error when !outcome.ok; retain unresolved work.
}
// Persist page.value.nextCursor. Periodically restart with no cursor.
```

Keep the same proposal ID and candidate after an unknown outcome. `reconcile`
never recomputes or rebases a candidate. Its acknowledgement uses fresh service
evidence and never reuses captured worker reads. A replacement service can
recover persisted proposals using a newly authorized client.

| Call that failed | Next operation |
|---|---|
| `prepare` with an unknown outcome | Retry `prepare` with the identical candidate and authenticated worker. It looks for the existing durable proposal before attempting preparation. |
| `prepare` with `acceptance_pending` | Reconcile `error.proposalId`, which names the task's current reservation. |
| `reconcile` with an unknown outcome or stale acknowledgement | Retry `reconcile` with the same proposal ID. Receipt lookup comes before external application. |
| Changed premises/ownership or rejected verification | Reread and replan or stop as indicated; never regenerate an ID to bypass the failed condition. |

After a terminal rejection, reread the real Git head and update the trusted
task revision/base before creating a new proposal ID. Do not retry a rejected
proposal under a new transport key to force it through.

## Verification and distribution

From the Ablo monorepo:

```sh
npm run typecheck --workspace=@abloatai/ablo
npm run test:journeys --workspace=@ablo/sync-server -- guarded-acceptance.journey
```

The journey runs this exact module through the real SDK, local server,
PostgreSQL, restricted credentials, and disposable Git repositories with atomic
receipt refs. It checks duplicate/conflicting requests, stale premises and
ownership, tenant denial, interrupted responses, Git-application recovery,
receipt mismatches and bounded enumeration. Candidate verification is a test
callback; interruptions are injected, not machine termination.

This is application-owned example code, not a new SDK namespace. Copying it
works with SDK 0.66.12 or later; no Ablo server deployment is needed. SDK 0.66.13
bundles this directory under `node_modules/@abloatai/ablo/examples/guarded-acceptance`.
Copy it into your application rather than importing it as an SDK subpath.
The consuming app still needs its schema integration and deployment.
