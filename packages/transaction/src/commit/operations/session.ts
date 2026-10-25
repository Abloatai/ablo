import { AbloStaleContextError, AbloValidationError } from '../../errors.js';
import type { OperationDomain, OperationState, OperationEdit, AcceptedOperation } from './contract.js';

/** One field's optimistic edits. Persist exportState before sending nextEdit. */
export class OperationSession<Value, Operation> {
  private state: OperationState<Value, Operation>;

  constructor(private readonly domain: OperationDomain<Value, Operation>, input: unknown) {
    this.state = domain.schemas.state.parse(input);
    const ids = this.state.pending.map((edit) => edit.id);
    if (new Set(ids).size !== ids.length) throw new Error('Pending operation edit ids must be unique.');
    const sent = this.state.inFlight;
    if (sent && (
      sent.id !== ids[0] || sent.epoch !== this.state.snapshot.epoch ||
      sent.baseVersion > this.state.snapshot.version
    )) throw new Error('In-flight operation edit does not match the pending queue.');
    this.value;
  }

  get value(): Value {
    return this.state.pending.reduce(
      (value, edit) => this.domain.apply(value, edit.operation),
      this.state.snapshot.value,
    );
  }

  exportState(): OperationState<Value, Operation> {
    return structuredClone(this.state);
  }

  /** Local edits remain individual operations, even while another edit is in flight. */
  edit(id: string, operation: Operation): void {
    const value = this.value;
    const inverse = this.domain.invert(value, operation);
    this.enqueue(id, operation);
    this.state.undo.push(inverse);
    this.state.redo = [];
  }

  /** At most one outstanding edit; retries return the exact original intent. */
  nextEdit(): OperationEdit<Operation> | null {
    if (!this.state.inFlight) {
      const pending = this.state.pending[0];
      if (!pending) return null;
      this.state.inFlight = {
        ...pending,
        epoch: this.state.snapshot.epoch,
        baseVersion: this.state.snapshot.version,
      };
    }
    return structuredClone(this.state.inFlight);
  }

  receive(input: AcceptedOperation<Operation>): void {
    const edit = this.domain.schemas.accepted.parse(input);
    const previous = this.state.snapshot;
    if (edit.epoch !== previous.epoch) {
      throw new AbloStaleContextError('Operation base changed. Keep pending edits for explicit recovery.', { code: 'stale_context' });
    }
    if (edit.version <= previous.version) return;
    if (edit.version !== previous.version + 1) {
      throw new AbloStaleContextError('Missing operation edits. Fetch history before continuing.', { code: 'stale_context' });
    }
    const snapshot = {
      epoch: edit.epoch, version: edit.version,
      value: this.domain.apply(previous.value, edit.operation),
    };
    const own = this.state.pending[0];
    if (edit.id === this.state.inFlight?.id && own) {
      if (this.domain.apply(previous.value, own.operation) !== snapshot.value) {
        throw new AbloStaleContextError('Accepted operation disagrees with the pending edit.', { code: 'stale_context' });
      }
      this.state.snapshot = snapshot;
      this.state.pending.shift();
      this.state.inFlight = null;
      return;
    }
    if (this.state.pending.some((pending) => pending.id === edit.id)) {
      throw new AbloValidationError('Unsent operation edit was acknowledged.', { code: 'invalid_input' });
    }
    let remote = edit.operation;
    const pending = this.state.pending.map((local) => {
      const operation = this.domain.transform(local.operation, remote, 'right');
      remote = this.domain.transform(remote, local.operation, 'left');
      return { ...local, operation };
    });
    const undo = this.state.undo.map((operation) => this.domain.transform(operation, remote, 'right'));
    const redo = this.state.redo.map((operation) => this.domain.transform(operation, remote, 'right'));
    // Verify before publishing any state; a rejected delivery must not consume a cursor.
    pending.reduce((value, local) => this.domain.apply(value, local.operation), snapshot.value);
    this.state = { ...this.state, snapshot, pending, undo, redo };
  }

  undo(id: string): boolean {
    return this.replay(id, 'undo', 'redo');
  }

  redo(id: string): boolean {
    return this.replay(id, 'redo', 'undo');
  }

  private replay(id: string, from: 'undo' | 'redo', to: 'undo' | 'redo'): boolean {
    const operation = this.state[from].at(-1);
    if (operation === undefined) return false;
    const inverse = this.domain.invert(this.value, operation);
    this.enqueue(id, operation);
    this.state[from].pop();
    this.state[to].push(inverse);
    return true;
  }

  private enqueue(id: string, operation: Operation): void {
    const edit = this.domain.schemas.edit.parse({
      id, operation, epoch: this.state.snapshot.epoch, baseVersion: this.state.snapshot.version,
    });
    if (this.state.pending.some((pending) => pending.id === id)) {
      throw new AbloValidationError('Pending operation edit ids must be unique.', { code: 'invalid_input' });
    }
    this.domain.apply(this.value, edit.operation);
    const undo = this.state.undo.map((saved) => this.domain.transform(saved, edit.operation, 'right'));
    const redo = this.state.redo.map((saved) => this.domain.transform(saved, edit.operation, 'right'));
    this.state = {
      ...this.state, undo, redo,
      pending: [...this.state.pending, { id: edit.id, operation: edit.operation }],
    };
  }
}
