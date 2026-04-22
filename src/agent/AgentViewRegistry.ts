/**
 * AgentViewRegistry — tracks active AgentQueryView instances per model name,
 * fans out delta notifications to matching views.
 *
 * Mirrors the ViewRegistry pattern from core/ but without MobX.
 */

import type { AgentQueryView } from './AgentQueryView';

export class AgentViewRegistry {
  private readonly views = new Map<
    string,
    Set<AgentQueryView<Record<string, unknown>>>
  >();

  /** Register a view for a model type. */
  register(
    modelName: string,
    view: AgentQueryView<Record<string, unknown>>,
  ): void {
    if (!this.views.has(modelName)) {
      this.views.set(modelName, new Set());
    }
    this.views.get(modelName)!.add(view);
  }

  /** Unregister a view. */
  unregister(
    modelName: string,
    view: AgentQueryView<Record<string, unknown>>,
  ): void {
    const set = this.views.get(modelName);
    if (set) {
      set.delete(view);
      if (set.size === 0) this.views.delete(modelName);
    }
  }

  /** Notify all views for a model type that an entity was added. */
  notifyAdded(modelName: string, entity: Record<string, unknown>): void {
    const set = this.views.get(modelName);
    if (!set) return;
    for (const view of set) {
      view.handleAdded(entity);
    }
  }

  /** Notify all views for a model type that an entity was updated. */
  notifyUpdated(modelName: string, entity: Record<string, unknown>): void {
    const set = this.views.get(modelName);
    if (!set) return;
    for (const view of set) {
      view.handleUpdated(entity);
    }
  }

  /** Notify all views for a model type that an entity was removed. */
  notifyRemoved(modelName: string, modelId: string): void {
    const set = this.views.get(modelName);
    if (!set) return;
    for (const view of set) {
      view.handleRemoved(modelId);
    }
  }
}
