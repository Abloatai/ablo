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
 * property), and `init` constructs what the widened context already carries
 * enough to build — the presence stream, attached to the connection the
 * context carries (the host built it before resolving the plugin list). The
 * rest of the materialiser (store, bootstrap, delta pipeline, framework
 * bindings) still lives in the composition root and migrates here as the
 * context grows to carry what it needs.
 */

import type { AbloPlugin, PluginContext } from '../transaction/plugin.js';
import {
  createPresenceStream,
  type AttachablePresenceStream,
} from '../sync/createPresenceStream.js';

/**
 * What `humans()` contributes to the client — exactly the members that merge
 * onto it, nothing else. Whether a plugin materialises is declared on the
 * plugin itself, never restated on its surface.
 */
export interface HumansSurface {
  /**
   * Who is here and what they are doing. Attached to the connection at
   * construction; calls before the socket opens mutate local state and skip
   * the wire send, and the stream re-announces on every connect.
   */
  readonly presence: AttachablePresenceStream;
}

/**
 * The reactive materialiser. Installed by default when `Ablo({ ... })` is
 * constructed over the socket with no `plugins` list; listed explicitly, it
 * reads as what it is — this client renders for people.
 */
export function humans() {
  return {
    id: 'humans',
    // Live queries, presence, and claim push are server-initiated frames, so
    // a request-response client rejects this plugin while it is being
    // configured — a typed error, not a subscription that never delivers.
    requires: { duplex: true },
    // The point of the plugin: it keeps a local copy of rows. A stateless
    // caller can assert its own list is uniformly false.
    materialises: true,
    // Deltas land in the materialised in-memory graph at `apply`.
    stage: 'apply',
    init: (context: PluginContext): HumansSurface => ({
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
    }),
    // `satisfies` rather than a return annotation, so `id` keeps its literal
    // type and a plugin list's surface can be keyed by id at the type level.
  } as const satisfies AbloPlugin<HumansSurface>;
}
