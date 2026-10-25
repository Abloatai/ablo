import { retryOperationContention } from './contention.js';
import { AbloStaleContextError } from '../../errors.js';
import type { OperationDomain, OperationHistory, OperationEdit, OperationState } from './contract.js';
import { foldOperationHistory } from './history.js';
import { OperationSession } from './session.js';

export interface OperationTarget {
  readonly model: string;
  readonly id: string;
  readonly field: string;
}

export interface OperationOpenOptions<Value, Operation> {
  readonly state?: OperationState<Value, Operation>;
  /** Save pending edits before dispatch, and the resulting state after acknowledgement. */
  readonly persist?: (state: OperationState<Value, Operation>) => Promise<void>;
}

export interface OperationTransport<Value, Operation> {
  read(target: OperationTarget): Promise<OperationHistory<Value, Operation>>;
  commit(target: OperationTarget, edit: OperationEdit<Operation>): Promise<unknown>;
  subscribe?(target: OperationTarget, invalidate: () => void): () => void;
}

/** One optimistic field buffer, using the client's existing durable commit transport. */
export class OperationField<Value, Operation> {
  private readonly session: OperationSession<Value, Operation>;
  private unsubscribe?: () => void;
  private failure: unknown = null;
  private closed = false;
  private persistence: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private invalidated = false;

  constructor(
    private readonly domain: OperationDomain<Value, Operation>,
    private readonly target: OperationTarget,
    private readonly transport: OperationTransport<Value, Operation>,
    history: OperationHistory<Value, Operation>,
    private readonly options: OperationOpenOptions<Value, Operation>,
  ) {
    this.session = new OperationSession(domain, options.state ?? { snapshot: foldOperationHistory(domain, history) });
    this.receive(history);
    this.unsubscribe = transport.subscribe?.(target, () => {
      if (this.closed) return;
      void this.refresh().catch((error: unknown) => { this.failure = error; });
    });
  }

  get value(): Value { return this.session.value; }
  get error(): unknown { return this.failure; }
  get disposed(): boolean { return this.closed; }
  dispose(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined; }
  exportState(): OperationState<Value, Operation> { return this.session.exportState(); }

  async edit(operation: Operation): Promise<void> {
    this.assertOpen();
    this.session.edit(crypto.randomUUID(), operation);
    await this.save();
  }

  async undo(): Promise<boolean> {
    this.assertOpen();
    const applied = this.session.undo(crypto.randomUUID());
    if (applied) await this.save();
    return applied;
  }

  async redo(): Promise<boolean> {
    this.assertOpen();
    const applied = this.session.redo(crypto.randomUUID());
    if (applied) await this.save();
    return applied;
  }

  /** Call on row invalidation to rebase local edits against accepted operations. */
  refresh(): Promise<void> {
    this.assertOpen();
    this.invalidated = true;
    this.refreshing ??= this.readInvalidations().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async readInvalidations(): Promise<void> {
    while (this.invalidated) {
      this.invalidated = false;
      const history = await retryOperationContention(() => this.transport.read(this.target));
      if (this.closed) return;
      this.receive(history);
      await this.save();
    }
  }

  flush(): Promise<void> {
    this.assertOpen();
    this.flushing ??= this.drain().then(() => { this.failure = null; }).catch((error: unknown) => { this.failure = error; throw error; }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    await this.refresh();
    for (;;) {
      const edit = this.session.nextEdit();
      if (!edit) return;
      await this.save();
      this.assertOpen();
      await retryOperationContention(() => this.transport.commit(this.target, edit));
      await this.refresh();
      if (this.session.exportState().inFlight?.id === edit.id) {
        throw new AbloStaleContextError('The accepted operation is not visible in history yet. Retry flush.', { code: 'stale_context' });
      }
    }
  }

  private receive(input: OperationHistory<Value, Operation>): void {
    const history = this.domain.schemas.history.parse(input);
    const snapshot = this.session.exportState().snapshot;
    if (snapshot.epoch !== history.base.epoch || snapshot.version < history.base.version) {
      throw new AbloStaleContextError('Operation history expired or its base changed. Keep pending edits for explicit recovery.', { code: 'stale_context' });
    }
    for (const edit of history.edits) this.session.receive(edit);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The field buffer is disposed. Reopen it to continue.');
  }

  private save(): Promise<void> {
    const state = this.session.exportState();
    const save = () => this.options.persist?.(state);
    this.persistence = this.persistence.then(save, save);
    return this.persistence;
  }
}
