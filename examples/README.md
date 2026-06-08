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
- read with `ablo.weatherReports.load`
- mark long-running AI work with `ablo.weatherReports.edit`
- write with `ablo.weatherReports.update`
- wait for confirmation when the write must be durable before continuing

Use schema-less resources and `commits.create` only for advanced runtimes that
intentionally cannot import the app schema.

## Running

Run from the package root, not `examples/` — the `examples/` folder has
no `package.json`, so Node resolves the entry path against the package
root and a bare `quickstart.ts` won't be found.

```bash
cd packages/sync-engine
ABLO_API_KEY=sk_test_... npx tsx examples/quickstart.ts
```

## Data Source (customer-owned database)

`data-source/` is a self-contained, runnable end-to-end demo of the
HTTP contract Ablo Cloud uses to talk to a customer's database. It
needs no API key, no cloud connection, and no open ports: the
orchestrator drives the customer handler in-process so signer and
verifier exchange real signed bytes without leaving the process.

```bash
cd packages/sync-engine
npx tsx examples/data-source/run.ts
```

See `data-source/README.md` for what each file teaches and the
production wiring snippets (Next.js, Hono, Cloudflare Workers,
plain Node).
