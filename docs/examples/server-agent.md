# Server Agent

A server agent is backend code — a cron job, a queue worker, an AI task — that
reads and writes your app's records outside the browser. The hard part is doing
it without racing the live UI: if your worker and a user edit the same report at
once, one write clobbers the other. This is what `claim()` is for. Below, a
worker finishes a weather report by claiming it, writing the result, and
releasing it automatically when the claim goes out of scope.

`claim({ id })` takes the record for your worker and returns a disposable handle:
the fresh post-lease row is on `claim.data`, and holding the handle with
`await using` releases the claim on scope exit (or call `claim.release()`). Claims
don't lock. If another writer holds the row, `claim` waits for them, re-reads the
fresh row, then hands it to you — so two writers serialize instead of clobbering.

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

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

export async function completeReport(reportId: string) {
  await ablo.ready();

  const report = await ablo.weatherReports.retrieve({ id: reportId });
  if (!report) return { status: 'not_found' };

  await using claim = await ablo.weatherReports.claim({
    id: reportId,
    queue: false,
    reason: 'completing',
  });
  const claimed = claim.data;

  const updated = await ablo.weatherReports.update({
    id: claimed.id,
    data: { status: 'ready' },
    wait: 'confirmed',
  });

  return { status: 'ready', report: updated };
}
```

`retrieve({ id })` is an async server read — it hits the server and returns the
row (or `null`, which the early `not_found` guard handles). The update runs while
the claim is held, and `wait: 'confirmed'` makes that update resolve only once
the server has accepted it.

The two options on the claim:

- `queue: false` — skip this record if another claim is already in progress,
  rather than queueing behind it. (The default queues.)
- `reason: 'completing'` — a human-readable label for what your worker is doing,
  visible to anyone reading `claim.state({ id })`.

Because the worker uses the same schema and `claim()` as the UI, its writes sync
to every connected client in real time and never collide with edits already in
progress.
