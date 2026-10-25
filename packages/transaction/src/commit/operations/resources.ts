import { createTextResource } from '../text/resource.js';
import { textHistorySchema, type TextOperation } from '../text/contract.js';
import { createCounterResource, counterHistorySchema } from '../counter/index.js';
import type { OperationEdit } from './contract.js';
import type { OperationTarget } from './resource.js';

/** @internal SDK adapters share the domain routing; their existing commit lane owns dispatch. */
export function createModelFieldResources(port: {
  read(kind: 'text' | 'counter', target: OperationTarget): Promise<unknown>;
  commit(kind: 'text' | 'counter', target: OperationTarget, edit: OperationEdit<TextOperation> | OperationEdit<number>): Promise<unknown>;
  subscribe?(target: OperationTarget, invalidate: () => void): () => void;
}) {
  return {
    text: createTextResource({
      read: async (target) => textHistorySchema.parse(await port.read('text', target)),
      commit: (target, edit) => port.commit('text', target, edit),
      subscribe: port.subscribe,
    }),
    counter: createCounterResource({
      read: async (target) => counterHistorySchema.parse(await port.read('counter', target)),
      commit: (target, edit) => port.commit('counter', target, edit),
      subscribe: port.subscribe,
    }),
  };
}
