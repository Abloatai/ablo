import { Model } from '../../Model.js';
import { projectModelRow } from '../operations/rowProjection.js';
import type { QueuedMutation } from '../mutations/commitPayload.js';

class Item extends Model {
  title = 'base';
  order = 0;
  override getModelName() { return 'Item'; }
}
const queued = (title: string, id: string): QueuedMutation => ({
  id, type: 'update', modelName: 'Item', modelId: 'row', data: { title },
  context: { userId: 'user', organizationId: 'org' }, status: 'pending',
  createdAt: 1, attempts: 0, priority: 'normal',
});

test('newer unstaged edits win over older queued patches while peer fields still apply', () => {
  const item = new Item({ id: 'row' });
  item.markAsPersisted();
  item.applyChanges({ title: 'newest' });
  projectModelRow(item, { title: 'server', order: 7 }, [queued('queued', 'first')]);
  expect(item.title).toBe('newest');
  expect(item.order).toBe(7);
  expect(item.getChanges()).toEqual({ title: 'newest' });
});

test('queued edits retain invocation order when there is no unstaged edit', () => {
  const item = new Item({ id: 'row' });
  item.markAsPersisted();
  projectModelRow(item, { title: 'server', order: 7 }, [queued('first', 'first'), queued('last', 'last')]);
  expect(item.title).toBe('last');
  expect(item.order).toBe(7);
});
