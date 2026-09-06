import {
  createPresenceProjection,
  type PresenceProjection,
  type PresenceProjectionEvents,
  type PresenceView,
} from '@abloatai/transaction/presence';
import type { PresenceTarget } from '@abloatai/transaction/presence';
import {
  startReadActivity,
  type ReadActivityLifetime,
  type ReadActivityTransport,
} from './readActivity.js';

type PresenceTransport = PresenceProjectionEvents & ReadActivityTransport;

/** Reactive-client presence backed by the client's existing live connection. */
export interface ReactivePresence extends PresenceView {
  forModel(model: string, recordId?: string): ReturnType<PresenceProjection['forModel']>;
  onChange(listener: () => void): () => void;
}

/** Lifecycle hooks kept inside the humans composition boundary. */
export interface AttachablePresence extends ReactivePresence {
  attach(transport: PresenceTransport): void;
  startRead(target: PresenceTarget): () => void;
  dispose(): void;
}

const clientPresence = new WeakMap<object, ReactivePresence>();

/** Framework bridge that does not consume a string key on the model namespace. */
export function attachPresenceToClient(client: object, presence: ReactivePresence): void {
  clientPresence.set(client, presence);
}

export function presenceOfClient(client: object): ReactivePresence {
  const presence = clientPresence.get(client);
  if (presence === undefined) throw new Error('presence is not attached to this client');
  return presence;
}

export function createPresence(
  transport: PresenceTransport | null = null,
): AttachablePresence {
  let projection: PresenceProjection | null = null;
  let attachedTransport: PresenceTransport | null = null;
  const listeners = new Set<() => void>();
  const reads = new Set<ReadActivityLifetime>();
  let unsubscribe: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const attach = (events: PresenceTransport): void => {
    if (projection !== null) return;
    attachedTransport = events;
    projection = createPresenceProjection(events);
    unsubscribe = projection.subscribe(notify);
    notify();
  };

  if (transport !== null) attach(transport);

  return {
    get active() { return projection?.active ?? []; },
    get others() { return projection?.others ?? []; },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    attach,
    startRead(target) {
      if (attachedTransport === null) {
        throw new Error('presence is not attached to a duplex transport');
      }
      const lifetime = startReadActivity(
        attachedTransport,
        target,
        () => { reads.delete(lifetime); },
      );
      reads.add(lifetime);
      return () => {
        lifetime.stop();
      };
    },
    forModel(model, recordId) {
      return projection?.forModel(model, recordId) ?? [];
    },
    dispose() {
      for (const read of reads) read.dispose();
      reads.clear();
      unsubscribe?.();
      unsubscribe = null;
      projection?.dispose();
      projection = null;
      attachedTransport = null;
      listeners.clear();
    },
  };
}
