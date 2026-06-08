# Data Source Example

End-to-end demo of the Data Source contract — the path customers take
when they want Ablo to coordinate writes against rows stored in
**their** database.

## What's in here

| File                  | Side               | Purpose                                                       |
| --------------------- | ------------------ | ------------------------------------------------------------- |
| `schema.ts`           | Shared             | The Zod schema both Ablo and the customer compile against     |
| `customer-server.ts`  | Customer           | The `dataSource(...)` handler — copy as a skeleton            |
| `ablo-driver.ts`      | Ablo Cloud         | Signs requests the way Ablo Cloud does in production          |
| `run.ts`              | Orchestrator       | Drives load -> commit -> list -> events round-trip            |

## Run

```bash
cd packages/sync-engine
npx tsx examples/data-source/run.ts
```

Run from the package root, not `examples/`: the `examples/` folder has
no `package.json`, so Node resolves the entry path against the package
root and a bare `data-source/run.ts` won't be found.

No network port, no env vars, no cloud credentials. The orchestrator
calls the handler in-process. Signer and verifier still exchange
signed bytes — flip the API key and you'll see a 401.

## What it proves

1. **Signer/verifier interop.** Ablo Cloud's
   `signAbloSourceRequest` and the customer's `dataSource(...)`
   speak the same wire format (Standard Webhooks v1).
2. **All four request types** — `load`, `list`, `commit`, `events`
   — share one handler.
3. **The customer DB stays canonical.** Ablo never sees rows
   directly; it only sees the response payload from the customer's
   handler.
4. **The outbox feed.** Every committed app-row change gets an outbox marker.
   Ablo filters markers for commits it already appended and uses the same feed
   to repair a failed post-commit append.

## Production wiring

The customer's handler is a Fetch-API function:
`(req: Request) => Promise<Response>`. Drop it anywhere that speaks
that contract.

### Next.js App Router

```ts
// app/api/ablo/source/route.ts
export { handleAbloSource as POST } from '@/lib/ablo-source';
```

### Hono / Cloudflare Workers

```ts
import { Hono } from 'hono';
import { handleAbloSource } from './ablo-source';

const app = new Hono();
app.post('/api/ablo/source', (c) => handleAbloSource(c.req.raw));
```

### Node `http` server

```ts
import { createServer } from 'node:http';
import { handleAbloSource } from './ablo-source';

createServer(async (req, res) => {
  const body = await new Promise<string>((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => resolve(chunks));
  });
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body,
  });
  const response = await handleAbloSource(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(3000);
```

## Migration checklist for an existing backend

Replace the `Map`-based store in `customer-server.ts` with your real
data layer. The handler shape stays the same:

- `tasks.load({ id })` -> `db.task.findUnique({ where: { id } })`
- `tasks.list({ query })` -> `db.task.findMany({ take, cursor })`
- `tasks.commit({ operations, clientTxId })` -> `db.$transaction` that
  applies each `op` and writes an outbox marker with `clientTxId` before commit
- `events({ cursor, limit })` -> read from your outbox table, return
  rows with their `clientTxId` (Ablo dedupes its own commits) and the
  resume cursor

See `docs/examples/existing-python-backend.md` for the same pattern
expressed against a Python backend.
