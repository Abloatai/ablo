import { Ablo } from '../src/index.js';
import { defineSchema, model, field } from '../src/schema/index.js';

const schema = defineSchema({ documents: model({ body: field.text(), title: field.string() }) });

export async function primaryModelOperationSurface(): Promise<void> {
  const schema = defineSchema({ documents: model({ body: field.text().from('body_text'), count: field.counter(), title: field.string() }) });
  const client = Ablo({ schema, apiKey: 'sk_test_typetest', transport: 'http' });
  const basis = { id: 'edit', epoch: 'epoch', baseVersion: 0 };
  await client.documents.create({ data: { body: 'initial', count: 0, title: 'title' } });
  await client.documents.update({ id: 'doc', data: { body: { $text: { ...basis, operation: ['new'] } }, title: 'changed' } });
  await client.documents.update({ id: 'doc', data: { count: { $increment: { ...basis, operation: 2 } } } });
  await client.documents.update({ id: 'doc', data: { count: 4 } });
  // @ts-expect-error Text updates declare versioned intent instead of replacing the field.
  await client.documents.update({ id: 'doc', data: { body: 'replacement' } });
  // @ts-expect-error Ordinary strings do not acquire text merge semantics.
  await client.documents.update({ id: 'doc', data: { title: { $text: { ...basis, operation: ['new'] } } } });
  // @ts-expect-error Creation takes values rather than versioned edits.
  await client.documents.create({ data: { body: { $text: { ...basis, operation: ['new'] } }, count: 0, title: 'title' } });
}

export async function textFieldSurface(): Promise<string> {
  const client = Ablo({ schema, apiKey: 'sk_test_typetest', transport: 'http' });
  const body = await client.documents.text({ id: 'doc-1', field: 'body' });
  await body.edit([1, { d: 1 }, 'x']);
  await body.undo();
  await body.redo();
  await body.flush();
  await body.refresh();
  await client.documents.text({ id: 'doc-1', field: 'body', state: body.exportState() });
  // @ts-expect-error A text buffer must name a declared model field.
  await client.documents.text({ id: 'doc-1', field: 'unknownField' });
  // @ts-expect-error Operation components have a closed vocabulary.
  await body.edit([{ replace: 'unversioned value' }]);
  return body.value;
}

export async function counterFieldSurface(): Promise<number> {
  const counters = defineSchema({ counts: model({ value: field.counter() }) });
  const client = Ablo({ schema: counters, apiKey: 'sk_test_typetest', transport: 'http' });
  const count = await client.counts.counter({ id: 'count-1', field: 'value' });
  await count.increment(2);
  // @ts-expect-error Increments accept numbers, not text operations.
  await count.increment('2');
  // @ts-expect-error Counter targets must be declared fields.
  await client.counts.counter({ id: 'count-1', field: 'missing' });
  return count.value;
}
