import Ablo from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { context } from '../src/context/index.js';
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
    data: { record: http.records.read({ id: 'record-1' }) },
  });
  await http.records.update({
    id: 'record-2',
    data: { status: httpContext.data.record?.status ?? 'missing' },
    reads: httpContext.reads,
  });
  const httpClaim = await http.records.claim({
    id: 'record-2',
    description: 'guard an atomic update',
  });
  if (httpClaim) {
    await http.commits.create({
      operations: [{
        action: 'update',
        model: 'records',
        id: 'record-2',
        data: { status: 'reviewed' },
      }],
      reads: httpContext.reads,
      claim: httpClaim,
    });
    await httpClaim.release();
  }

  const reactiveContext = await context({
    ablo: reactive,
    data: { record: reactive.records.read({ id: 'record-1' }) },
  });
  await reactive.records.update({
    id: 'record-2',
    data: { status: reactiveContext.data.record?.status ?? 'missing' },
    reads: reactiveContext.reads,
  });
  const reactiveClaim = await reactive.records.claim({
    id: 'record-2',
    description: 'guard an atomic update',
  });
  if (reactiveClaim) {
    await reactive.commits.create({
      operations: [{
        action: 'update',
        model: 'records',
        id: 'record-2',
        data: { status: 'reviewed' },
      }],
      reads: reactiveContext.reads,
      claim: reactiveClaim,
    });
    await reactiveClaim.release();
  }
}

void contextReadsFitBothClients;
