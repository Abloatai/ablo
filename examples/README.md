# @ablo/sync-engine — canonical examples

Three integration shapes. Pick the one that matches your process model.

| File | Shape | Runs where |
|---|---|---|
| [`server-agent.ts`](./server-agent.ts) | Long-lived backend agent (AI worker, cron, daemon) | Your server |
| [`browser-app.ts`](./browser-app.ts) | Browser app — Stripe-style server-mints, browser-holds | Server + browser |
| [`sub-agent.ts`](./sub-agent.ts) | Parent agent spawning an attenuated child | Your server |

## Running

Each file is a standalone TypeScript program. Set `ABLO_API_KEY` (server path) or follow the in-file instructions (browser path):

```bash
cd packages/sync-engine/examples
ABLO_API_KEY=sk_test_... npx tsx server-agent.ts
```

## Shared schema

All three examples use the same toy schema so you can focus on the flow, not the data model. Your production code brings your own schema — `defineSchema({...})` is the only boundary between Ablo and your domain.

```ts
import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  matters: mutable.lazy(
    { name: z.string() },
    { syncGroupFormat: 'matter:{id}' },
  ),
});
```
