# Server Agent

Most server agents should import the app schema and use the same model methods
as the product UI.

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

  const [report] = await ablo.weatherReports.load({ where: { id: reportId } });
  if (!report) return { status: 'not_found' };

  const updated = await ablo.weatherReports.claim(
    reportId,
    async (claimed) =>
      ablo.weatherReports.update(
        claimed.id,
        { status: 'ready' },
        { wait: 'confirmed' },
      ),
    { wait: false, action: 'completing' },
  );

  return { status: 'ready', report: updated };
}
```

Use the schema-backed version for server agents so the worker, app, and React UI
share the same model methods.
