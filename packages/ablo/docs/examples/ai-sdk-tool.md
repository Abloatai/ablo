# AI SDK Tools

> Give an AI SDK agent safe access to the same typed Ablo resources as your
> backend.

Use AI SDK for the agent loop and Ablo for the state boundary inside the tool.
When an agent updates a shared record from inside a tool call you have a
concurrency problem: another agent or a person may be editing the same row, and
a naive write can overwrite work the model never saw. Ablo's tool adapters put
the authoritative read, retry, claim, and confirmed-write behavior behind the
ordinary AI SDK tool contract.

```ts
// app/api/chat/route.ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z as schemaZ } from '@abloatai/ablo/schema';
import { anthropic } from '@ai-sdk/anthropic';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from 'ai';
import { updateTool } from '@abloatai/ablo/ai-sdk';
import { z } from 'zod';

export const runtime = 'nodejs';

const schema = defineSchema({
  records: model({
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

const updateTask = updateTool(ablo.records, {
  title: 'Update record',
  description: 'Update a record without overwriting concurrent work.',
  inputSchema: z.object({
    recordId: z.string(),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    summary: z.string().optional(),
  }),
  id: ({ recordId }) => recordId,
  apply: (current, { status, summary }) => ({
    status: status ?? current.status,
    summary: summary ?? current.summary,
  }),
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
the server (never trusting one sent in the request body) and converts the
incoming `UIMessage[]` with `convertToModelMessages`.

`updateTool` defaults to a functional update: Ablo re-reads and reapplies the
patch if another participant writes first. Use `strategy: 'claim'` when the
model should skip work already owned by someone else, or `strategy: 'queue'`
when it should wait in Ablo's server-owned FIFO claim queue. The same entrypoint
also exports `readTool`, `createTool`, and `deleteTool`; deletes require AI SDK
approval unless the application explicitly disables it.

When the model call needs several current reads rather than one model tool,
[Context](../context.md) assembles them and formats an optional user message
without taking ownership of the AI SDK loop.
