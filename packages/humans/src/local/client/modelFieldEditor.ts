import type { QueuedMutation } from '../transactions/mutations/commitPayload.js';

/** A field editor is a view of the model, not another pending-state or undo owner. */
export interface ModelFieldEditor<Value, Operation> {
  readonly value: Value;
  readonly error: unknown;
  readonly disposed: boolean;
  edit(operation: Operation): Promise<void>;
  /** A successful explicit refresh acknowledges a previous write rejection. */
  refresh(): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
}
export interface ModelCounterEditor extends ModelFieldEditor<number, number> {
  increment(amount: number): Promise<void>;
}

export function createModelFieldEditor<Value, Operation>(port: {
  value(): Value;
  error(): unknown;
  stage(operation: Operation): Promise<QueuedMutation>;
  refresh(): Promise<void>;
  flush(): Promise<void>;
  dispose?(): void;
}): ModelFieldEditor<Value, Operation> {
  let closed = false;
  let failure: unknown = null;
  let rejectedWrite: unknown = null;
  const assertOpen = () => { if (closed) throw new Error('The field editor is disposed. Reopen it to continue.'); };
  return {
    get value() { return port.value(); },
    get error() { return failure ?? port.error(); },
    get disposed() { return closed; },
    async edit(operation) {
      assertOpen();
      const transaction = await port.stage(operation);
      void transaction.confirmation?.catch((error: unknown) => { failure = rejectedWrite = error; });
    },
    async refresh() { assertOpen(); await port.refresh(); failure = rejectedWrite = null; },
    async flush() {
      assertOpen();
      try {
        await port.flush();
        if (rejectedWrite !== null) throw rejectedWrite;
        await port.refresh();
        failure = null;
      }
      catch (error) { failure = error; throw error; }
    },
    dispose() { if (!closed) { closed = true; port.dispose?.(); } },
  };
}
