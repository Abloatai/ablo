# Audit log

The audit log records who changed what in your org, and when — including
changes an AI agent made on a person's behalf. Every change is one row, and the
rows are signed in a chain so you can later prove the history wasn't altered.
You can filter it, page through it, and export it.

Every commit becomes one row.

## Row shape

```ts
{
  occurredAt:           '2026-05-14T14:22:01.034Z',
  actorKind:            'user' | 'agent' | 'system',
  actorId:              string,
  onBehalfOfKind:       'user' | 'agent' | 'system' | null,
  onBehalfOfId:         string | null,
  capabilityId:         string | null,    // the API key/capability used for the write
  capabilityLabel:      string | null,    // its human-readable name, for scanning the log
  delegationChainRoot:  string | null,    // always points at a human
  actionType:           string,           // e.g. 'weatherReport.update'
  modelName:            string | null,    // e.g. 'claude-opus-4-7'
  diffSummary:          unknown,
  // tamper-evident
  chainSeq:             number,
  prevHash:             string,
  rowHash:              string,
}
```

## Delegation chain

Every action traces back to a human. Even when an agent makes the change,
`delegationChainRoot` names the person who set that work in motion — there is no
audit row whose root is an agent.

## Verify

```bash
curl https://<your-app>/api/orgs/<slug>/audit/verify-chain?\
  principalKind=agent\
  &principalId=weather-agent-v3
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

One request exports CSV up to a hard row cap. If your window is larger than the
cap, the response is truncated at the cap rather than erroring — so for large
windows, split the window by date and request each slice, or page through the
JSON `GET` endpoint above using `nextCursor`.

## Compliance posture

The [audit log landing page](/audit-log) is the marketing-side description.
The verifier's hash algorithm and chain semantics live in the
`@ablo/audit-chain` package — embeddable if you need to verify chains in a
detached service.
