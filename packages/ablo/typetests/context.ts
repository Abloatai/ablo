import Ablo from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { context } from '../src/context.js';
import { defineSchema, model, z } from '../src/schema.js';

const schema = defineSchema({
  tasks: model({ status: z.string() }),
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
    data: { task: http.tasks.get({ id: 'task-1' }) },
  });
  await http.tasks.update({
    id: 'task-2',
    data: { status: httpContext.data.task?.status ?? 'missing' },
    reads: httpContext.reads,
  });

  const reactiveContext = await context({
    ablo: reactive,
    data: { task: reactive.tasks.get({ id: 'task-1' }) },
  });
  await reactive.tasks.update({
    id: 'task-2',
    data: { status: reactiveContext.data.task?.status ?? 'missing' },
    reads: reactiveContext.reads,
  });
}

void contextReadsFitBothClients;
