/**
 * Package-internal lifecycle for one granted claim handle.
 *
 * A handle is bound to one server grant. Wrappers may add row data or model
 * typing, but they all share this object so a loss observed at the transport
 * boundary removes the same handle from every client-side index. The public
 * cancellation surface is deliberately not defined here yet; this file first
 * establishes one truthful terminal transition for the existing API.
 */

export interface ClaimLifetime {
  /** Whether this exact grant has ended. */
  readonly ended: boolean;
  /** Why it ended, when the transport supplied a typed error. */
  readonly reason: Error | undefined;
  /** End the grant once. Later calls are no-ops. */
  end(reason?: Error): void;
  /** Run when the grant ends. An already-ended grant invokes immediately. */
  onEnd(listener: (reason: Error | undefined) => void): () => void;
}

const lifetimeByHandle = new WeakMap<object, ClaimLifetime>();

/** Create the single lifecycle shared by every wrapper around one grant. */
export function createClaimLifetime(): ClaimLifetime {
  let ended = false;
  let reason: Error | undefined;
  const listeners = new Set<(reason: Error | undefined) => void>();

  return {
    get ended() {
      return ended;
    },
    get reason() {
      return reason;
    },
    end(nextReason?: Error) {
      if (ended) return;
      ended = true;
      reason = nextReason;
      for (const listener of listeners) {
        try {
          listener(reason);
        } catch {
          // A cleanup observer cannot keep sibling cleanup from running.
        }
      }
      listeners.clear();
    },
    onEnd(listener) {
      if (ended) {
        listener(reason);
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Associate a wrapper with the lifecycle of the grant it represents. */
export function bindClaimLifetime<T extends object>(
  handle: T,
  lifetime: ClaimLifetime,
): T {
  lifetimeByHandle.set(handle, lifetime);
  return handle;
}

/** Read a handle's package-internal lifecycle, if it was minted by this SDK. */
export function claimLifetimeOf(handle: unknown): ClaimLifetime | undefined {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    return undefined;
  }
  return lifetimeByHandle.get(handle);
}
