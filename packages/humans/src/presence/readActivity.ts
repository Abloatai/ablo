import type {
  PresenceCommand,
  PresenceTarget,
} from '@abloatai/transaction/presence';
import { LEASE_TTL_MS } from '@abloatai/transaction/wire';

/** The connection slice needed to keep one session-owned read alive. */
export interface ReadActivityTransport {
  isConnected(): boolean;
  sendPresenceCommand(command: PresenceCommand): void;
  subscribe(event: 'connected', listener: () => void): () => void;
}

export interface ReadActivityLifetime {
  /** End the read and remove it from the server, reconnecting briefly if needed. */
  stop(): void;
  /** Tear down local resources when the owning client itself is disposed. */
  dispose(): void;
}

const READ_TTL_MS = LEASE_TTL_MS;
const READ_REFRESH_MS = READ_TTL_MS / 3;
let fallbackActivitySequence = 0;
const noop = (): void => undefined;

function readActivityId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `read:${crypto.randomUUID()}`;
  }
  fallbackActivitySequence += 1;
  return `read:${Date.now().toString(36)}:${fallbackActivitySequence.toString(36)}`;
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  const candidate: unknown = timer;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'unref' in candidate &&
    typeof candidate.unref === 'function'
  ) {
    (candidate as { unref(): void }).unref();
  }
}

/**
 * Own the lease mechanics for one declared read. React only starts and stops
 * this lifetime; command ids, refreshes, reconnect recovery, and offline
 * cleanup remain inside the presence subsystem.
 */
export function startReadActivity(
  transport: ReadActivityTransport,
  target: PresenceTarget,
  onFinished: () => void = noop,
): ReadActivityLifetime {
  const activityId = readActivityId();
  let active = true;
  let disposed = false;
  let removeOnConnect: (() => void) | null = null;
  let removalExpiry: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    onFinished();
  };

  const send = (command: PresenceCommand): boolean => {
    if (!transport.isConnected()) return false;
    try {
      transport.sendPresenceCommand(command);
      return true;
    } catch (error) {
      // The socket can close between the state check and the synchronous send.
      // Reconnect handling retries; a failure while still connected is real.
      if (transport.isConnected()) throw error;
      return false;
    }
  };

  const upsert = (): void => {
    if (!active || disposed) return;
    send({ type: 'read.upsert', activityId, target, ttlMs: READ_TTL_MS });
  };

  const unsubscribeConnected = transport.subscribe('connected', upsert);
  upsert();

  const refreshTimer = setInterval(() => {
    if (!active || disposed) return;
    send({ type: 'read.refresh', activityId, ttlMs: READ_TTL_MS });
  }, READ_REFRESH_MS);
  unref(refreshTimer);

  const clearResources = (): void => {
    unsubscribeConnected();
    clearInterval(refreshTimer);
    removeOnConnect?.();
    removeOnConnect = null;
    if (removalExpiry !== null) clearTimeout(removalExpiry);
    removalExpiry = null;
  };

  const stop = (): void => {
    if (!active || disposed) return;
    active = false;
    unsubscribeConnected();
    clearInterval(refreshTimer);

    const remove = (): void => {
      if (disposed) return;
      if (!send({ type: 'read.remove', activityId })) return;
      removeOnConnect?.();
      removeOnConnect = null;
      if (removalExpiry !== null) clearTimeout(removalExpiry);
      removalExpiry = null;
      finish();
    };

    if (transport.isConnected()) {
      remove();
      return;
    }

    // If the component leaves offline, remove on the next reconnect so the
    // resumed logical session cannot briefly show a departed viewer. Once the
    // lease expires server-side, there is nothing left to remove.
    removeOnConnect = transport.subscribe('connected', remove);
    removalExpiry = setTimeout(() => {
      removeOnConnect?.();
      removeOnConnect = null;
      removalExpiry = null;
      finish();
    }, READ_TTL_MS);
    unref(removalExpiry);
  };

  return {
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      clearResources();
      finish();
    },
  };
}
