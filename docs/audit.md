# Audit log

Every commit becomes one row. Rows are hash-chained per principal —
tamper-evident, queryable, exportable.

## Row shape

```ts
{
  occurredAt:           '2026-05-14T14:22:01.034Z',
  actorKind:            'user' | 'agent' | 'system',
  actorId:              string,
  onBehalfOfKind:       'user' | 'agent' | 'system' | null,
  onBehalfOfId:         string | null,
  capabilityId:         string | null,
  capabilityLabel:      string | null,
  delegationChainRoot:  string | null,    // always points at a human
  causedByTaskId:       string | null,
  actionType:           string,           // e.g. 'task.update'
  modelName:            string | null,    // e.g. 'claude-opus-4-7'
  diffSummary:          unknown,
  // tamper-evident
  chainSeq:             number,
  prevHash:             string,
  rowHash:              string,
}
```

## Delegation chain

`delegationChainRoot` always points at the human who started the chain.
There is no audit row whose root is an agent. Autonomous AI writes are not
a thing in this system; every chain starts with a person.

## Verify

```bash
curl https://<your-app>/api/orgs/<slug>/audit/verify-chain?\
  principalKind=agent\
  &principalId=task-writer-v3
```

Returns either:

```json
{ "ok": true, "rowsChecked": 10472, "fromSeq": 1, "lastSeq": 10472 }
```

or, on tamper:

```json
{ "ok": false, "brokenAtSeq": 8419, "reason": "hash_mismatch",
  "expectedHash": "sha256:…", "foundHash": "sha256:…" }
```

## Filter and paginate

The dashboard at `/[orgSlug]/audit` is the UI for this. The same filters
are available on the API:

```
GET /api/orgs/<slug>/audit?actorKind=agent&since=2026-05-01&limit=100
```

Cursor-paginated. Continue with the `nextCursor` value from the response.

## Export

```bash
curl 'https://<your-app>/api/orgs/<slug>/audit/export?actorKind=agent&since=2026-05-01' \
  > may-agent-writes.csv
```

CSV up to a hard cap per request. For larger windows, paginate.

## Compliance posture

The [audit log landing page](/audit-log) is the marketing-side description.
The verifier's hash algorithm and chain semantics live in the
`@ablo/audit-chain` package — embeddable if you need to verify chains in a
detached service.
