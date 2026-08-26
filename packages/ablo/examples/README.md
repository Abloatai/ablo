# @abloatai/ablo Examples

The examples teach the same path as the README and docs: declare a schema,
create or load typed models, and write through `ablo.<model>`.

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
```

Then:

- create with `ablo.weatherReports.create`
- read with `ablo.weatherReports.get` or `ablo.weatherReports.list`
- coordinate long-running work with `ablo.weatherReports.claim`
- write with `ablo.weatherReports.update`
- dispose the client when the worker finishes

For read-reason-write work, pass the exact returned rows that informed the
decision. Their watermarks stay opaque:

```ts
const record = await ablo.records.read({ id: recordId });
const policy = await ablo.policies.read({ id: policyId });
const result = await model({ record, policy });
await ablo.records.update({
  id: record.id,
  data: result,
  reads: [record, policy],
});
```

This means: apply the update only if the rows used to produce it have not
changed. Incidental reads do nothing, and cloned or fabricated rows are
rejected locally.

`agent-turn.ts` is the cheap read/write path. `expensive-agent-turn.ts` adds a
heartbeating claim, post-grant model input, durable commit inspection, automatic
release, and a released-claim fencing check.

Import the same schema in every runtime. Use `commits.create` only when several
typed row operations must land atomically; ordinary writes stay on
`ablo.<model>.create/update/delete`.

## Running

Run from the package root, not `examples/` — the `examples/` folder has
no `package.json`, so Node resolves the entry path against the package
root and a bare `quickstart.ts` won't be found.

```bash
cd packages/ablo
ABLO_API_KEY=sk_... npx tsx examples/quickstart.ts
ABLO_API_KEY=sk_... RECORD_ID=record_... npx tsx examples/agent-turn.ts
ABLO_API_KEY=sk_... JOB_ID=job_... npx tsx examples/expensive-agent-turn.ts
```

## Data Source (customer-owned database)

`data-source/` is a self-contained, runnable end-to-end demo of the
HTTP contract Ablo Cloud uses to talk to a customer's database. It
needs no API key, no cloud connection, and no open ports: the
orchestrator drives the customer handler in-process so signer and
verifier exchange real signed bytes without leaving the process.

```bash
cd packages/ablo
npx tsx examples/data-source/run.ts
```

See `data-source/README.md` for what each file teaches and the
production wiring snippets (Next.js, Hono, Cloudflare Workers,
plain Node).
