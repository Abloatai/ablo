# AI SDK Tool

Use AI SDK for the loop and Ablo for the state boundary inside the tool.

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z as schemaZ } from '@abloatai/ablo/schema';
import { streamText, tool } from 'ai';
import { z } from 'zod';

const schema = defineSchema({
  weatherReports: model({
    location: schemaZ.string(),
    status: schemaZ.enum(['pending', 'ready']),
    forecast: schemaZ.string().optional(),
  }),
});

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

const updateReport = tool({
  description: 'Update a weather report in the product database.',
  inputSchema: z.object({
    reportId: z.string(),
    status: z.enum(['pending', 'ready']).optional(),
    forecast: z.string().optional(),
  }),
  execute: async ({ reportId, status, forecast }) => {
    await ablo.ready();

    const [report] = await ablo.weatherReports.load({ where: { id: reportId } });
    if (!report) return { ok: false, reason: 'not_found' };

    // claim is advisory: if another participant holds the row, it waits for
    // them to finish and re-reads before entering the callback. Released when
    // the callback returns or throws.
    return ablo.weatherReports.claim(
      reportId,
      async (claimed) => {
        // update is stale-guarded under the held claim
        const updated = await ablo.weatherReports.update(claimed.id, {
          status: status ?? claimed.status,
          forecast: forecast ?? claimed.forecast,
        });

        return { ok: true, report: updated };
      },
      { action: 'editing', ttl: '2m' },
    );
  },
});

export async function POST(req: Request) {
  const { messages, model } = await req.json();

  return streamText({
    model,
    messages,
    tools: { updateReport },
  }).toUIMessageStreamResponse();
}
```

The important part is not the model provider. The important part is that the
tool:

- loads the latest weather report,
- claims the row (advisory — serializes behind any current holder, then re-reads),
- writes through the normal stale-guarded `update`,
- releases the claim automatically when the callback returns or throws,
- waits for server confirmation.
