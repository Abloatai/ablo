/**
 * ViewRegistry — tracks active QueryViews per typename.
 *
 * When the ObjectPool mutates a model, it calls notifyAdded / notifyUpdated /
 * notifyRemoved on the registry, which fans the event out to every active
 * QueryView subscribed to that typename.
 */

import { type Model, modelAsRow } from '../Model.js';
import type { IncrementalView } from './query-utils.js';

export class ViewRegistry {
  private views = new Map<string, Set<IncrementalView>>();

  register(typename: string, view: IncrementalView): void {
    let set = this.views.get(typename);
    if (!set) {
      set = new Set();
      this.views.set(typename, set);
    }
    set.add(view);
  }

  unregister(typename: string, view: IncrementalView): void {
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
      view.handleAdded(modelAsRow<Record<string, unknown>>(model));
    }
  }

  /** Called by ObjectPool after a model is updated in the pool. */
  notifyUpdated(typename: string, model: Model): void {
    const set = this.views.get(typename);
    if (!set) return;
    for (const view of set) {
      view.handleUpdated(modelAsRow<Record<string, unknown>>(model));
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
