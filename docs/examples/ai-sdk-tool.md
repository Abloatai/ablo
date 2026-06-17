# AI SDK Tool

When an AI agent updates a shared record from inside a tool call, you have a concurrency problem: another agent or a user might be editing the same row, and a naive write silently overwrites their change. This example shows the safe pattern — read the record, claim the row so anyone else waits their turn, write through a version-checked update, and release the claim automatically.

Claims don't lock. If another writer holds the row, `claim` waits for them, re-reads the fresh row, then hands it to you — so two writers serialize instead of clobbering.

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z as schemaZ } from '@abloatai/ablo/schema';
import { anthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, streamText, tool, type UIMessage } from 'ai';
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

    // retrieve hits the server for the latest row (async — await it).
    const report = await ablo.weatherReports.retrieve({ id: reportId });
    if (!report) return { ok: false, reason: 'not_found' };

    // If another agent or user already holds this row, claim waits for them
    // to finish, re-reads the fresh row, then hands it back on `claim.data`.
    // The claim is released automatically when it goes out of scope.
    await using claim = await ablo.weatherReports.claim({
      id: reportId,
      reason: 'editing',
      ttl: '2m',
    });
    const claimed = claim.data;

    // Because you hold the claim, this update is rejected if the row
    // changed underneath you, instead of silently overwriting it.
    const updated = await ablo.weatherReports.update({
      id: claimed.id,
      data: {
        status: status ?? claimed.status,
        forecast: forecast ?? claimed.forecast,
      },
    });

    return { ok: true, report: updated };
  },
});

export async function POST(req: Request) {
  // `useChat` posts UIMessage[]; the model is a server-bound provider instance,
  // never read off the request body.
  const { messages }: { messages: UIMessage[] } = await req.json();

  return streamText({
    model: anthropic('claude-sonnet-4-6'),
    messages: await convertToModelMessages(messages),
    tools: { updateReport },
  }).toUIMessageStreamResponse();
}
```

The model provider is interchangeable — swap `anthropic(...)` for any
server-bound provider instance. What matters is that the route binds the model
on the server (never trusting one sent in the request body), converts the
incoming `UIMessage[]` with `convertToModelMessages`, and that the tool:

- reads the latest weather report with `retrieve` (a server read),
- claims the row — if someone else holds it, the claim waits for them, then re-reads,
- writes through `update`, which is rejected if the row changed underneath you,
- releases the claim automatically when the handle goes out of scope,
- waits for server confirmation.
