/**
 * `humans()` — the reactive materialiser, declared as a capability (ADR 0016).
 *
 * The bare client is the coordination layer: commit, read, observe, claim.
 * Add `humans()` when people are watching — it declares the local, watchable
 * copy: the offline store, live queries, presence, and the framework
 * bindings. There is no `agents()` counterpart, and the absence is the
 * message: agents are the default caller, not a special one.
 *
 * Transitional shape: the contract fields do real configuration work
 * (`requires.duplex` rejects it on a request-response client at construction
 * time; `materialises` is the five-second membership test as a checkable
 * property), and `init` constructs what the widened context carries enough
 * to build — the presence stream, attached to the connection the context
 * carries, and the store cluster (this client's runtime, the component
 * graph, the registered models, and the `BaseSyncedStore`), now that the
 * context carries the resolved url and the credential source. What still
 * lives in the composition root — the credential lifecycle, `ready()`, the
 * model proxies, the resources, the framework bindings — migrates here as
 * the context grows to carry what it needs.
 */

import type { AbloPlugin, PluginContext, AppliedChange } from '../transaction/plugin.js';
import { AbloValidationError } from '../transaction/errors.js';
import type { SchemaRecord } from '../transaction/schema/schema.js';
import {
  createPresenceStream,
  type AttachablePresenceStream,
} from '../sync/createPresenceStream.js';
import {
  buildStoreCluster,
  kStoreCluster,
  type StoreCluster,
} from './storeCluster.js';
import type { InternalAbloOptions } from './options.js';

/**
 * What `humans()` contributes to the client — exactly the members that merge
 * onto it, nothing else. Whether a plugin materialises is declared on the
 * plugin itself, never restated on its surface.
 *
 * The one exception is deliberate and invisible to merging:
 * {@link kStoreCluster} is symbol-keyed, and surface members merge onto the
 * client by string key alone — so the cluster reaches the host without ever
 * becoming client API.
 */
export interface HumansSurface {
  /**
   * Who is here and what they are doing. Attached to the connection at
   * construction; calls before the socket opens mutate local state and skip
   * the wire send, and the stream re-announces on every connect.
   */
  readonly presence: AttachablePresenceStream;

  /**
   * The constructed store cluster, when the context carried enough to build
   * it (the connection, the resolved url, the credential source, and a
   * schema). Absent on a thinner context — the presence stream's own
   * tolerance, applied to the store.
   */
  readonly [kStoreCluster]?: StoreCluster;
}

/**
 * The reactive materialiser. Installed by default when `Ablo({ ... })` is
 * constructed over the socket with no `plugins` list; listed explicitly, it
 * reads as what it is — this client renders for people.
 */
export function humans() {
  // The apply handler's target. `init` binds it to the store it constructs;
  // until then the handler is a no-op, and nothing dispatches before then —
  // the store itself is the pipeline that dispatches.
  let applyChanges: ((changes: readonly AppliedChange[]) => void) | null = null;

  return {
    id: 'humans',
    // Live queries, presence, and claim push are server-initiated frames, so
    // a request-response client rejects this plugin while it is being
    // configured — a typed error, not a subscription that never delivers.
    requires: { duplex: true },
    // The point of the plugin: it keeps a local copy of rows. A stateless
    // caller can assert its own list is uniformly false.
    materialises: true,
    stages: {
      // Deltas land in the materialised in-memory graph at `apply` — the
      // declaration and the handler are one field, so this cannot name a
      // stage and forget the work.
      apply: ({ changes }) => { applyChanges?.(changes); },
    },
    init: (context: PluginContext<InternalAbloOptions<SchemaRecord>>): HumansSurface => {
      const cluster = buildStoreCluster(context);
      if (cluster) {
        // One client per humans() instance: the apply handler routes into
        // the store this init built, so a shared instance would silently
        // apply one client's deltas into another client's store.
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
        presence: createPresenceStream(
          {
            participantId: context.participant?.id ?? '',
            syncGroups: [...(context.syncGroups ?? [])],
            // Peers' kinds are server-stamped; only the local `self` entry is ours.
            isAgent: context.participant?.kind === 'agent',
          },
          // The host built the connection before resolving the plugin list, so
          // the stream attaches now and starts the moment the feed opens.
          context.transport ?? null,
        ),
        ...(cluster ? { [kStoreCluster]: cluster } : {}),
      };
    },
    // `satisfies` rather than a return annotation, so `id` keeps its literal
    // type and a plugin list's surface can be keyed by id at the type level.
  } as const satisfies AbloPlugin<HumansSurface>;
}
