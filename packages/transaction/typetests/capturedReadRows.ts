import { Ablo } from '../src/ablo.js';
import { defineSchema, model, z } from '../src/schema/index.js';

const schema = defineSchema({
  items: model({ status: z.string() }),
});

const client = Ablo({
  schema,
  apiKey: 'sk_type_only',
  baseURL: 'https://api.example.test',
});

async function capturedRowsGuideReads(): Promise<void> {
  const captured = await client.items.get({ id: 'item-1' });
  if (!captured) return;

  await client.items.update({
    id: 'item-2',
    data: { status: 'done' },
    reads: [captured],
  });

  await client.items.update(
    'item-2',
    (current) => ({ status: current.status === 'todo' ? 'doing' : 'done' }),
    { reads: [captured] },
  );

  const [listed] = await client.items.list({ where: { status: 'todo' } });
  if (listed) {
    await client.items.update({
      id: 'item-2',
      data: { status: 'done' },
      reads: [listed],
    });
    await client.items.update(
      'item-2',
      (current) => ({ status: current.status }),
      {
        reads: [listed],
      },
    );
  }

  await client.items.update({
    id: 'item-2',
    data: { status: 'done' },
    // @ts-expect-error — arbitrary objects are not captured-row handles.
    reads: [{ status: 'todo' }],
  });
}

void capturedRowsGuideReads;
