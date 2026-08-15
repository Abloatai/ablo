import Ablo from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { context } from '../src/context.js';
import { defineSchema, model, z } from '../src/schema.js';

const schema = defineSchema({
  records: model({ status: z.string() }),
});

const http = Ablo({
  schema,
  apiKey: 'sk_type_context',
  baseURL: 'https://api.example.test',
});

const reactive = ReactiveAblo({
  schema,
  baseURL: 'ws://localhost:1234',
  apiKey: 'sk_type_context',
});

async function contextReadsFitBothClients(): Promise<void> {
  const httpContext = await context({
    ablo: http,
    data: { record: http.records.get({ id: 'record-1' }) },
  });
  await http.records.update({
    id: 'record-2',
    data: { status: httpContext.data.record?.status ?? 'missing' },
    reads: httpContext.reads,
  });

  const reactiveContext = await context({
    ablo: reactive,
    data: { record: reactive.records.get({ id: 'record-1' }) },
  });
  await reactive.records.update({
    id: 'record-2',
    data: { status: reactiveContext.data.record?.status ?? 'missing' },
    reads: reactiveContext.reads,
  });
}

void contextReadsFitBothClients;
