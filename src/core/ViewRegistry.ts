/**
 * ViewRegistry — tracks active QueryViews per typename.
 *
 * When the ObjectPool mutates a model, it calls notifyAdded / notifyUpdated /
 * notifyRemoved on the registry, which fans the event out to every active
 * QueryView subscribed to that typename.
 */

import type { Model } from '../Model';
import type { QueryView } from './QueryView';

export class ViewRegistry {
  private views = new Map<string, Set<QueryView<Record<string, unknown>>>>();

  register(typename: string, view: QueryView<Record<string, unknown>>): void {
    let set = this.views.get(typename);
    if (!set) {
      set = new Set();
      this.views.set(typename, set);
    }
    set.add(view);
  }

  unregister(typename: string, view: QueryView<Record<string, unknown>>): void {
    const set = this.views.get(typename);
    if (!set) return;
    set.delete(view);
    if (set.size === 0) {
      this.views.delete(typename);
    }
  }

  /** Called by ObjectPool after a model is added to the pool. */
  notifyAdded(typename: string, model: Model): void {
    const set = this.views.get(typename);
    if (!set) return;
    for (const view of set) {
      view.handleAdded(model as unknown as Record<string, unknown>);
    }
  }

  /** Called by ObjectPool after a model is updated in the pool. */
  notifyUpdated(typename: string, model: Model): void {
    const set = this.views.get(typename);
    if (!set) return;
    for (const view of set) {
      view.handleUpdated(model as unknown as Record<string, unknown>);
    }
  }

  /** Called by ObjectPool after a model is removed from the pool. */
  notifyRemoved(typename: string, modelId: string): void {
    const set = this.views.get(typename);
    if (!set) return;
    for (const view of set) {
      view.handleRemoved(modelId);
    }
  }
}
