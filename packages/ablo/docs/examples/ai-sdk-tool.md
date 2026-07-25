# AI SDK Tool

> Put a claim-and-commit loop inside an AI SDK tool call.

Use AI SDK for the agent loop and Ablo for the state boundary inside the tool.
When an agent updates a shared record from inside a tool call you have a
concurrency problem: another agent may be editing the same row, and a naive write
silently overwrites it. This is the safe pattern — read the record, claim the row
so anyone else waits their turn, write through a checked update, and release the
claim automatically.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering.

```ts
// app/api/chat/route.ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z as schemaZ } from '@abloatai/ablo/schema';
import { anthropic } from '@ai-sdk/anthropic';
import {
  streamText,
  tool,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from 'ai';
import { z } from 'zod';

export const runtime = 'nodejs';

const schema = defineSchema({
  tasks: model({
    title: schemaZ.string(),
    status: schemaZ.enum(['todo', 'doing', 'done']),
    summary: schemaZ.string().optional(),
  }),
});

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
});

const updateTask = tool({
  description: 'Update a task in the product database.',
  inputSchema: z.object({
    taskId: z.string(),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    summary: z.string().optional(),
  }),
  execute: async ({ taskId, status, summary }) => {
    await ablo.ready();

    // retrieve hits the server for the latest row (async — await it).
    const task = await ablo.tasks.get({ id: taskId });
    if (!task) return { ok: false, reason: 'not_found' };

    // If another agent already holds this row, claim waits for them to finish,
    // re-reads the fresh row, then hands it back on `claim.data`. The claim is
    // released automatically when it goes out of scope.
    await using claim = await ablo.tasks.claim({
      id: taskId,
      description: 'editing',
      ttl: '2m',
    });

    // Because you hold the claim, this update is rejected if the row changed
    // underneath you, instead of silently overwriting it.
    const updated = await ablo.tasks.update({
      id: claim.data.id,
      data: {
        status: status ?? claim.data.status,
        summary: summary ?? claim.data.summary,
      },
      wait: 'confirmed',
    });

    return { ok: true, task: updated };
  },
});

export async function POST(req: Request) {
  // useChat sends UIMessage[]; convert before handing to the model.
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    // The model is a SERVER-bound provider instance — never sent from the client.
    model: anthropic('claude-sonnet-5'),
    messages: await convertToModelMessages(messages),
    tools: { updateTask },
    stopWhen: stepCountIs(5),
    maxOutputTokens: 2048,
  });

  return result.toUIMessageStreamResponse();
}
```

The model provider is interchangeable — swap `anthropic(...)` for any
server-bound provider instance. What matters is that the route binds the model on
the server (never trusting one sent in the request body), converts the incoming
`UIMessage[]` with `convertToModelMessages`, and that the tool:

- reads the latest row with `retrieve` (a server read),
- claims it for exclusive, ordered access — if someone else holds it, the claim
  waits for them, then re-reads,
- writes through the model resource, which is rejected if the row changed
  underneath you,
- waits for confirmation with `wait: 'confirmed'`,
- and auto-releases the claim when the tool returns.
