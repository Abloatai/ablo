import { humans } from '../dist/index.js';
import { createLocalMutationPort } from '../dist/local/transactions/localMutation.js';
import { createReconnectDrain } from '../dist/local/transactions/reconnectDrain.js';

const localEvents = [];
const localMutation = createLocalMutationPort((event) => localEvents.push(event));
const localModel = { id: 'task_local', getModelName: () => 'Task' };
const localTransaction = {
  id: 'tx_local',
  type: 'update',
  modelName: 'Task',
  modelId: localModel.id,
  status: 'pending',
  createdAt: Date.now(),
  attempts: 0,
  priority: 'normal',
  priorityScore: 0,
  data: { title: 'after' },
  previousData: { title: 'before' },
  context: { userId: 'user_local', organizationId: 'org_local' },
};
localMutation.applyUpdate(localModel, localTransaction);
await localMutation.rollback(localTransaction, 'integration-check');
if (
  localEvents.join(',') !== 'optimistic:update,optimistic:rollback' ||
  localMutation.updates.size !== 0
) {
  throw new Error('humans local mutation adapter did not apply and roll back cleanly');
}

const reconnectDrain = createReconnectDrain();
let drains = 0;
let releaseDrain;
const drainGate = new Promise((resolve) => {
  releaseDrain = resolve;
});
const drain = async () => {
  drains += 1;
  await drainGate;
};
const firstDrain = reconnectDrain.drain(drain);
const joinedDrain = reconnectDrain.drain(drain);
if (firstDrain !== joinedDrain || drains !== 1) {
  throw new Error('humans offline adapter did not coalesce concurrent reconnect drains');
}
releaseDrain();
await firstDrain;

const plugin = humans();
if (plugin.id !== 'humans' || plugin.materialises !== true) {
  throw new Error('@abloatai/humans did not expose its materializer capability');
}

console.log('humans package integration clean');
