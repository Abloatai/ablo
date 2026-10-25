/** Publish local row invalidation once per microtask across ordinary and semantic edits. */
export function createModelChangePublisher(publish: (models: Set<string>) => void): (model: string) => void {
  let pending: Set<string> | null = null;
  return (model) => {
    if (!pending) {
      pending = new Set();
      queueMicrotask(() => {
        const models = pending;
        pending = null;
        if (models?.size) publish(models);
      });
    }
    pending.add(model);
  };
}
