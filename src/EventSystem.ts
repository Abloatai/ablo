/**
 * Linear Sync Engine - Event System
 *
 * Simple event system using native EventTarget for Linear-style observables
 */

/**
 * Custom event types for the sync engine
 */
export interface SyncEventMap {
  'initial-models-loaded': CustomEvent<void>;
  'database-version-change': CustomEvent<{ oldVersion: number; newVersion: number }>;
  bootstrap: CustomEvent<{ type: string }>;
  'bootstrap:started': CustomEvent<void>;
  'bootstrap:complete': CustomEvent<any>;
  'bootstrap:error': CustomEvent<Error>;
  'bootstrap:progress': CustomEvent<{ loaded: number }>;
  'connection:established': CustomEvent<void>;
  'connection:failed': CustomEvent<Error>;
  'connection:disconnected': CustomEvent<void>;
  'sync:start': CustomEvent<void>;
  'sync:success': CustomEvent<any>;
  'sync:error': CustomEvent<Error>;
  'delta:applied': CustomEvent<any>;
  'delta:error': CustomEvent<Error>;
  'model:added': CustomEvent<{ model: any }>;
  'model:updated': CustomEvent<{ model: any }>;
  'model:deleted': CustomEvent<{ model: any }>;
  'model:archived': CustomEvent<{ model: any }>;
  archive: CustomEvent<{ model: any }>;
  'archive-update': CustomEvent<{ model: any }>;
  unarchive: CustomEvent<{ model: any }>;
  'sync-groups-changed': CustomEvent<{ added: string[]; removed: string[] }>;
  'invalidate-rejected-hydrations': CustomEvent<void>;
  'database-unavailable': CustomEvent<{ error: Error }>;
  'saving-store-count-change': CustomEvent<{ count: number }>;
  'transaction-count-change': CustomEvent<{ count: number }>;
  'transaction-queued': CustomEvent<{ transaction: any }>;
}

/**
 * Simple event emitter using native EventTarget
 * Much cleaner than custom event system
 */
export class SyncEventEmitter extends EventTarget {
  /**
   * Add event listener (Linear compatibility)
   */
  addListener<K extends keyof SyncEventMap>(
    type: K,
    listener: (event: SyncEventMap[K]['detail']) => void
  ): void {
    this.addEventListener(type, (event: Event) => {
      listener((event as CustomEvent).detail);
    });
  }

  /**
   * Remove event listener (Linear compatibility)
   */
  removeListener<K extends keyof SyncEventMap>(
    type: K,
    listener: (event: SyncEventMap[K]['detail']) => void
  ): void {
    this.removeEventListener(type, listener);
  }

  /**
   * Emit an event with typed data
   */
  emit<K extends keyof SyncEventMap>(type: K, detail?: SyncEventMap[K]['detail']): void {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
  }

  /**
   * Subscribe to an event with typed callback
   */
  on<K extends keyof SyncEventMap>(
    type: K,
    callback: (event: SyncEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): () => void {
    const listener = callback as EventListener;
    this.addEventListener(type, listener, options);

    // Return unsubscribe function
    return () => this.removeEventListener(type, listener);
  }

  /**
   * Subscribe to an event once
   */
  once<K extends keyof SyncEventMap>(
    type: K,
    callback: (event: SyncEventMap[K]) => void
  ): () => void {
    return this.on(type, callback, { once: true });
  }

  /**
   * Remove all listeners for a specific event type
   */
  off<K extends keyof SyncEventMap>(type: K): void {
    // Note: There's no built-in way to remove all listeners for a type
    // We'd need to track them manually, but for simplicity we'll just
    // document that users should keep the unsubscribe functions
  }

  /**
   * Remove all event listeners (compatibility with EventEmitter)
   */
  removeAllListeners(): void {
    // EventTarget doesn't provide a direct way to remove all listeners
    // In practice, we would need to track listeners manually
    // For now, we'll provide a no-op for compatibility
    getContext().logger.warn(
      'removeAllListeners() called - EventTarget does not support removing all listeners'
    );
  }
}

/**
 * Create event getters that return objects with subscribe/unsubscribe methods
 * This mimics Linear's pattern where events are accessed as properties
 */
export function createEventGetter<K extends keyof SyncEventMap>(
  emitter: SyncEventEmitter,
  eventType: K
) {
  return {
    subscribe(callback: (event: SyncEventMap[K]) => void, options?: AddEventListenerOptions) {
      return emitter.on(eventType, callback, options);
    },

    subscribeOnce(callback: (event: SyncEventMap[K]) => void) {
      return emitter.once(eventType, callback);
    },

    fire(detail?: SyncEventMap[K]['detail']) {
      emitter.emit(eventType, detail);
    },
  };
}

/**
 * Simple utility to create a scoped event emitter for a component
 */
export function createScopedEmitter(): SyncEventEmitter {
  return new SyncEventEmitter();
}
import { getContext } from './context';
