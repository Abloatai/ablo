/**
 * Public human-facing local-state capability.
 *
 * The plugin and its local-state runtime belong to @abloatai/humans. The
 * shared confirmation package supplies only the handoff identity and wire
 * contracts.
 */
import type { AbloPlugin, PluginContext, AppliedChange } from './plugin.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { createPresence, type AttachablePresence } from './presence/index.js';
import {
  buildStoreCluster,
  kStoreCluster,
  type InternalAbloOptions,
  type StoreCluster,
} from './local/client/storeCluster.js';

export interface HumansSurface {
  readonly presence: AttachablePresence;
  readonly [kStoreCluster]?: StoreCluster;
}

export function humans() {
  let applyChanges: ((changes: readonly AppliedChange[]) => void) | null = null;

  return {
    id: 'humans',
    requires: { duplex: true },
    materialises: true,
    stages: {
      apply: ({ changes }: { readonly changes: readonly AppliedChange[] }) => {
        applyChanges?.(changes);
      },
    },
    init: (context: PluginContext<InternalAbloOptions>): HumansSurface => {
      const cluster = buildStoreCluster(context);
      if (cluster) {
        if (applyChanges) {
          throw new AbloValidationError(
            'This humans() instance is already installed on a client. ' +
              'Construct a fresh humans() for each Ablo({ ... }) call.',
            { code: 'invalid_options', param: 'plugins' },
          );
        }
        applyChanges = (changes) => { cluster.store.applyChangesToPool(changes); };
      }
      return {
        presence: createPresence(context.transport ?? null),
        ...(cluster ? { [kStoreCluster]: cluster } : {}),
      };
    },
  } as const satisfies AbloPlugin<HumansSurface>;
}
export type { AbloClient, AbloReads } from './client.js';
