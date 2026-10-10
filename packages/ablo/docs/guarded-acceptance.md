# Guarded acceptance

> Prepare a durable, immutable intent with current Ablo evidence, then reconcile its application in an external system.

This application pattern composes existing SDK operations. It is not a new
transaction spanning Ablo and Git. Start with one project, one repository, and
exact-base Git admission. The accepting service owns policy and authorization;
Ablo validates declared row dependencies and commits the preparation atomically.

## Copy the operation

The typed [acceptance example](../examples/guarded-acceptance/README.md) implements
this lifecycle on existing SDK APIs. Copy its directory into the accepting
service, connect candidate verification and your protected Git broker, and use:

```ts
const acceptance = createAcceptance({ client, accountId, verify, broker });
const prepared = await acceptance.prepare({ candidate, workerId });
if (!prepared.ok) return prepared; // error.code and error.recovery
return acceptance.reconcile({ proposalId: prepared.value.proposalId });
```

`pending({ repositoryId, limit, cursor })` supplies bounded restart recovery.
The module owns fresh evidence, generation/revision checks, proposal identity,
atomic preparation and acknowledgement, receipt binding, and structured recovery
results. Its README defines the two application integrations and model setup.
No new Ablo server primitive is required. See that README for the source's
distribution status; an installed older package will not contain the example.

## Trust and evidence

Workers submit a proposal identity, immutable candidate reference, expected
base, declared premise IDs and application revisions, ownership generation, and
verification reference. Authenticate the submitting worker independently of
that payload. The service must validate that the declared dependencies are
complete for its policy; Ablo cannot discover an omitted dependency.

Create the authorized writing client **before** reading. Through that same
instance, `read` the task, assignment, policy, and every declared premise.
Compare the returned application revisions or content hashes with those bound
to the candidate. Reject a mismatch: merely rereading does not make work based
on an older premise valid. Then pass those exact returned rows in `reads` to
`commits.create`. A change between this validation and preparation rejects the
whole commit with `stale_context`.

Never pass a worker's captured rows, a different server client's captured rows,
serialized rows, or fabricated read watermarks as the service's evidence.
`read_evidence_client_mismatch` rejects foreign captured rows locally, even
when the two clients have identical credentials. See
[Switching clients](./api.md#switching-clients).

Keep two identities distinct. The credential determines the actual committing
actor in Ablo's audit trail. Store the authenticated proposing worker and run
on the immutable proposal as application provenance. Do not grant the worker
acceptance access just to make it appear as the committing actor. If the
service uses a separately issued attributed credential, that client must have
the required model/group permissions and must perform its own reads.
Worker credentials must not write assignments, prepared intents, or acceptance
acknowledgements. A secret key is not a bypass for model/group access policy.

## Durable records

These are application-owned records and fields, not SDK resources:

| Record | Contents and rule |
|---|---|
| Assignment | Project/repository/task, owner, monotonically increasing generation, allowed/revoked state. Only the authority changes it. |
| Proposal | Stable proposal ID, authenticated worker/run, assignment generation, exact base and candidate SHA, premise revisions, verification digest and policy revision. Create once; never update the payload. |
| Application intent | Proposal ID, payload digest, `prepared` or `acknowledged`, external receipt and accepted SHA when acknowledged. Only the service changes it. |
| Acceptance slot | The task or repository's current prepared proposal. Guard its previous row when reserving it so competing proposals cannot both take the slot. |

The copyable example combines task, assignment and slot in `acceptanceTasks`,
and proposal plus application intent in `acceptanceProposals`. Its immutable
payload stays unchanged when status/outcome changes; `acceptancePremises` owns
the declared dependency revisions. Separate models are needed only when the
application's existing ownership boundaries require them.

Retain proposal IDs (or immutable tombstones) for the required deduplication
lifetime. Use strict `create` with caller-selected IDs, not an upsert.
Ablo's transport idempotency is scoped to the participant and has a retention
window; it cannot by itself enforce permanent business identity across service
replacement. See [Idempotency](./idempotency.md).

## Prepare, apply, acknowledge

1. Read an existing proposal by its tenant-scoped identity. If it exists,
   compare the complete canonical payload or its verified digest. An identical
   proposal resumes its existing intent; different content under that ID is an
   application conflict. Check caller access before returning either result.
2. If it is new, read and validate all current premises through the accepting
   client. Missing required rows reject. An absent read does not guard absence;
   strict creation and a guarded existing acceptance slot arbitrate races.
3. In one `commits.create({ operations, reads, idempotencyKey, wait: 'confirmed' })`,
   create the immutable proposal, create its prepared intent, and reserve the
   slot. The reads include assignment, task, policy, slot, and premises. Do not
   use partial/notify conflict handling. Preparation must be confirmed before
   the service permits external application.
4. The protected Git broker loads that prepared identity and checks the exact
   base, immutable candidate, verification and policy binding. It atomically
   applies the accepted ref update and writes its durable receipt using the
   proposal ID. Workers cannot invoke an unguarded application path.
5. After verifying the Git receipt against proposal ID, digest, repository,
   base and accepted SHA, the service reads the intent and slot afresh. In a
   second guarded atomic commit, acknowledge the receipt, publish the accepted
   SHA in application state, and release the matching slot. Keep the proposal
   immutable. Duplicate acknowledgements with the same receipt return the
   stored result; a different receipt is a conflict.

Use distinct stable preparation and acknowledgement request keys. Persist the
canonical proposal and request identity before submission. Retry an uncertain
write with its original key and identical intent. Do not silently rebuild a
different request under that key. On `entity_already_exists`, read the durable
proposal and compare its payload; a racing create is not automatically success.
When a definitive stale rejection requires replanning, create a new proposal
identity. A fresh attempt to prepare the same unchanged candidate still needs
full validation; reconcile any uncertain prior attempt first.

The first commit is the admission point. It records that the premises were
valid **at preparation**, not that they stay frozen until Git application.
If policy requires validity at the exact Git update, Lobby must serialize or
fence the relevant changes through the broker. An Ablo reread immediately
before Git still leaves a cross-system race.

## Ownership and revocation

Assignment, execution claims, and prepared authorization have separate lives:

| Event | Required behavior |
|---|---|
| Assignment revoked or replaced before preparation | Update its generation/state through the authority. The service rejects an already obsolete generation; a concurrent change invalidates the guarded read. |
| Worker execution claim expires or is taken over | Stop that worker's claimed operations. Ablo rejects writes using a lost claim. An execution lease is not a durable assignment or external fencing mechanism. |
| Service loses its own claim before its guarded write | Pass the actual service-owned claim to the write and handle `claim_lost`/`fence_token_stale`. Never borrow the worker's claim or treat `claim.state` as atomic authorization. |
| Worker loses authority after preparation | In this pattern the service may finish the already prepared proposal. A replacement worker cannot alter it or reuse its ID. Worker revocation prevents new preparation through the assignment guard; it does not retract durable admission. |
| Revocation must cancel even prepared work | Lobby must fence cancellation against Git application in the same broker authority. A canceled Ablo row alone cannot stop an in-flight external write. |
| Authority changes after Git application | Reconcile and acknowledge the matching receipt through the recovery service. Do not replay or roll back Git merely because the original worker lost access. |

The accepting service checks durable assignment authority, not the liveness of
the worker's execution lease. If lease loss must revoke submission rights,
the application must connect takeover to a guarded assignment-generation
change and fence the old worker at its execution boundary. Revoking only a
worker session does not revoke a separate service credential. Record access
revocation in the guarded assignment/policy as well as revoking credentials.

## Bounded recovery

Persist application intents as ordinary model rows. Use the existing paginated
model `list` with a project/repository filter, `status: 'prepared'`, and a fixed
`limit` (for example, 100). Process a bounded number of pages per run, preserve
`nextCursor` with the same filter/order, and periodically restart the scan so
concurrent changes or inserts are not stranded. Lists are observational, not
snapshot transactions: reread each intent before changing it. Avoid `listAll`
for an unbounded recovery worker.

For each intent, look up the Git receipt by proposal identity first:

| Durable evidence | Recovery |
|---|---|
| No confirmed preparation | Do not apply Git. Reconcile the Ablo outcome first. |
| Prepared; receipt authoritatively absent | Resume the same proposal through the broker's retry-safe exact-base admission. If the base moved, record a terminal application rejection through guarded policy; do not rebase under the same ID. |
| Prepared; matching receipt exists | Acknowledge it without applying Git again. |
| Acknowledged; matching receipt exists | Return the stored accepted SHA. |
| Receipt lookup unavailable, mismatching receipt, or uncertain Git outcome | Keep unresolved, back off or escalate; absence of a response is not proof of non-application. |

Keep failed or canceled intents as durable terminal records too; do not delete
their proposal identities to make retries appear new. The two-state successful
path above does not prescribe Lobby's terminal failure names.

`commits.list` and `commits.get` expose Ablo commit outcomes; they do not
replace the application outbox. Commit records redact mutation data, and a
confirmed preparation says nothing about Git application. Git receipts prove
application; Ablo acknowledgement records that the service reconciled it.

## Rejections callers can act on

Branch on structured `code`, not message text. Preserve request/proposal
correlation and permitted conflict details; never leak inaccessible premises.

| Result | Action |
|---|---|
| `read_evidence_client_mismatch`, `write_options_invalid` | Fix client/evidence construction, reread through the writer, then revalidate. |
| `stale_context` | Reread the named conflicts and replan if candidate premises changed. Do not retry stale evidence blindly. |
| `decision_contended` | Another transaction is checking the same decision rows. Retry the unchanged request with bounded backoff; it may then reject as stale after the winner commits. |
| `claim_lost`, `fence_token_stale`, `claim_conflict` | Stop stale execution; reacquire only if assignment still authorizes it. |
| `precondition_failed` | Reread the guarded state and classify the failed application condition. |
| Permission/authentication rejection | Stop; re-establish authorized access through the authority. Do not substitute a broader client. |
| `entity_already_exists` | Reconcile the existing proposal; compare immutable payload before declaring a duplicate. |
| `idempotency_conflict` | Reconcile the original request; distinguish an identical in-flight retry from changed intent. |
| Transport timeout, disconnect, `replication_lag_timeout` | Outcome may be unknown. Reconcile with the same identity before any external action. |
| `idempotency_key_expired`, `source_transport_pinned` | Reconcile retained intent/original route; never mint a new key merely to force execution. |

Distinguishing `premise_changed`, `ownership_changed`, `access_revoked`,
`proposal_conflict`, and `outcome_unknown` is the accepting application's result
contract, not a new set of Ablo error codes. A `stale_context` error can name an
assignment or a content premise; the service knows which role that row plays.

## Conformance boundary

Test actual event order and persisted rows, not only returned success values:

- Two real SDK clients must reject foreign evidence before transport and allow
  a freshly validated writer-owned read. See the SDK `httpClient.test.ts` suite.
- Database-backed `executeCommit.guardedAcceptance.test.ts` checks atomic
  preparation, stale premises/assignment, duplicate and conflicting preparation,
  and durable state across acknowledgement interruption. Its external receipt
  is a test fixture, not a Git implementation.
- `guarded-acceptance.journey.test.ts` runs the copyable module through the real
  local SDK/server, subject-scoped credentials, PostgreSQL, and actual Git ref
  transactions. It injects response/application interruptions and uses a test
  verification callback; it does not certify sandbox verification or process death.
- Existing database suites cover read-set serialization, idempotency,
  strict creation, claim enforcement and tenant isolation. Session revocation
  and hosted claim takeover require their real authorization/lease tests.
- Lobby must additionally run its protected service with restricted worker
  credentials, real Git receipts, process termination at both boundaries,
  assignment takeover, session revocation and cross-tenant requests. The SDK
  and database tests do not certify that production integration.

Use [hosted coordination conformance](./examples/coordination-conformance.md)
for real participant identity, heartbeat, release and expiry. Report separately
which local, hosted and customer integration checks actually ran.
