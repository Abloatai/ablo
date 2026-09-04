import {
  createPresenceProjection,
  type PresenceProjection,
  type PresenceProjectionEvents,
  type PresenceView,
} from '@abloatai/transaction/presence';

/** Reactive-client presence backed by the client's existing live connection. */
export interface ReactivePresence extends PresenceView {
  forModel(model: string, recordId?: string): ReturnType<PresenceProjection['forModel']>;
  onChange(listener: () => void): () => void;
}

/** Lifecycle hooks kept inside the humans composition boundary. */
export interface AttachablePresence extends ReactivePresence {
  attach(transport: PresenceProjectionEvents): void;
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
  transport: PresenceProjectionEvents | null = null,
): AttachablePresence {
  let projection: PresenceProjection | null = null;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const attach = (events: PresenceProjectionEvents): void => {
    if (projection !== null) return;
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
    forModel(model, recordId) {
      return projection?.forModel(model, recordId) ?? [];
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      projection?.dispose();
      projection = null;
      listeners.clear();
    },
  };
}
