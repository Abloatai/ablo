import {
  counterDomain, counterEditValueSchema, counterHistorySchema, counterValueSchema,
  textDomain, textEditValueSchema, textHistorySchema,
  invertAcceptedFieldEdit, appendContextOperation, prepareContextOperation, retryOperationContention, foldOperationHistory,
  type OperationTarget, type TextOperation,
} from '@abloatai/transaction/commit';
import { AbloStaleContextError, AbloValidationError } from '@abloatai/transaction/errors';
import type { ModelMetadata } from '@abloatai/transaction/types';
import type { QueuedMutation } from '../mutations/commitPayload.js';
import { fieldIntentSchema, queuedTextContext, queuedCounterContext, type FieldIntent, type FieldMutation } from './intent.js';
import { historyForAcceptedRow } from './acceptedHistory.js';
import type { AppliedChange } from '../../../plugin.js';
export { fieldIntentSchema, type FieldIntent } from './intent.js';
export { projectModelRow } from './rowProjection.js';
export { validateModelWrite } from './validation.js';
export { createModelChangePublisher } from './observation.js';
export { fieldOperationUndo, reverseFieldOperation, replaceOperationReversals } from './undo.js';

export type FieldOperationKind = 'text' | 'counter';

/** Schema declarations, rather than marker-shaped ordinary JSON, select a domain. */
export function operationFields(metadata: ModelMetadata | undefined, patch: Record<string, unknown>) {
  return Object.entries(patch).flatMap<{ field: string; kind: FieldOperationKind }>(([field, value]) => {
    const kind = metadata?.fields?.[field]?.merge;
    if (kind === 'text') {
      textEditValueSchema.parse(value);
      return [{ field, kind }];
    }
    if (kind === 'counter' && typeof value === 'object' && value !== null && '$increment' in value) {
      counterEditValueSchema.parse(value);
      return [{ field, kind }];
    }
    return [];
  });
}

/** Domain projection reads the primary queue; it never owns another pending ledger. */
export class ModelOperationRuntime {
  private readonly revisions = new Map<string, number>();
  private readonly staging = new Map<string, Promise<void>>();
  private readonly histories = new Map<string, unknown>();
  private readonly acceptedAncestors = new Map<string, ReadonlySet<string>>();
  private readonly retained = new Map<string, number>();
  private readonly reconciliations = new Map<string, { dirty: boolean; promise: Promise<Record<string, unknown> | null> }>();
  private generation = 0;
  private acceptedBatch?: { keys: Set<string>; done: Promise<void>; failed: boolean; release(): void; reject(error: unknown): void };

  constructor(private readonly port: {
    metadata(model: string): ModelMetadata | undefined;
    pending(): readonly QueuedMutation[];
    read(kind: FieldOperationKind, target: OperationTarget): Promise<unknown>;
    publish?(model: string, id: string, patch: Record<string, unknown>): void;
  }) {}

  clear(): void { this.generation++; this.acceptedBatch?.release(); this.acceptedBatch = undefined; this.revisions.clear(); this.staging.clear(); this.histories.clear(); this.acceptedAncestors.clear(); this.reconciliations.clear(); this.retained.clear(); }

  /** Prepare a whole received frame without publishing any member early. */
  async withAcceptedBatch(changes: readonly AppliedChange[], apply: (patches: ReadonlyMap<string, Record<string, unknown>>) => void): Promise<boolean> {
    const rows = new Map<string, AppliedChange>();
    const references = new Map<string, Map<string, NonNullable<AppliedChange['operation']>>>();
    for (const change of changes) {
      if (change.action === 'verify') continue;
      const key = JSON.stringify([change.modelName, change.modelId]);
      const prior = rows.get(key);
      const fields = references.get(key) ?? new Map();
      for (const field of Object.keys(this.port.metadata(change.modelName)?.fields ?? {})) {
        if (prior?.data && change.data && Object.hasOwn(change.data, field) && prior.data[field] !== change.data[field]) fields.delete(field);
      }
      if (change.operation) fields.set(change.operation.field, change.operation);
      references.set(key, fields);
      rows.set(key, change);
    }
    const semantic = [...rows.values()].filter((row) => row.action !== 'verify' && row.action !== 'remove' && row.action !== 'archive' && row.data &&
      Object.values(this.port.metadata(row.modelName)?.fields ?? {}).some((field) => field.merge));
    if (!semantic.length && !this.acceptedBatch) return false;
    const generation = this.generation;
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const batch = { keys: new Set([...(this.acceptedBatch?.keys ?? []), ...rows.keys()]), failed: false,
      done: new Promise<void>((resolve, failure) => { release = resolve; reject = failure; }),
      release: () => { release(); }, reject: (error: unknown) => { reject(error); } };
    void batch.done.catch(() => undefined);
    this.acceptedBatch = batch;
    try {
      const histories = new Map<string, { target: OperationTarget; kind: FieldOperationKind; history: unknown; acceptedAncestors: Set<string> }[]>();
      await Promise.all(semantic.map(async (row) => {
        const key = JSON.stringify([row.modelName, row.modelId]);
        const fields: { target: OperationTarget; kind: FieldOperationKind; history: unknown; acceptedAncestors: Set<string> }[] = [];
        for (const [field, metadata] of Object.entries(this.port.metadata(row.modelName)?.fields ?? {})) {
          const kind = metadata.merge;
          if (!kind || !row.data || !Object.hasOwn(row.data, field)) continue;
          const target = { model: row.modelName, id: row.modelId, field };
          const cacheKey = JSON.stringify(target);
          if (!this.retained.has(cacheKey) && !this.histories.has(cacheKey) && !this.pending(target).length) continue;
          const reference = references.get(key)?.get(field);
          if (reference && reference.kind !== kind) throw new AbloStaleContextError('The received operation kind disagrees with its field declaration.', { code: 'stale_context' });
          const cached = this.histories.get(cacheKey);
          const currentValue = row.data[field];
          const unchanged = !reference && cached && !this.pending(target).length && (kind === 'text'
            ? foldOperationHistory(textDomain, textHistorySchema.parse(cached)).value
            : foldOperationHistory(counterDomain, counterHistorySchema.parse(cached)).value) === currentValue;
          const history = unchanged ? cached : await this.refresh(kind, target);
          const anchored = kind === 'text' ? historyForAcceptedRow(textDomain, history, currentValue, reference)
            : historyForAcceptedRow(counterDomain, history, currentValue, reference);
          // The full authorized history proves any own ancestor accepted after this frame.
          if (kind === 'text') queuedTextContext(history, this.pending(target), field);
          else if (!this.pending(target).some((tx) => typeof tx.data?.[field] === 'number')) queuedCounterContext(history, this.pending(target), field);
          const ancestors = new Set(this.pending(target).flatMap((tx) => tx.fieldIntent?.field === field && tx.fieldIntent.kind === kind
            ? tx.fieldIntent.context.pending.map((edit) => edit.id) : []));
          fields.push({ target, kind, history: anchored, acceptedAncestors: new Set((
            kind === 'text' ? textHistorySchema.parse(history).edits : counterHistorySchema.parse(history).edits).filter((edit) => ancestors.has(edit.id)).map((edit) => edit.id)) });
        }
        histories.set(key, fields);
      }));
      if (generation !== this.generation) return true;
      const patches = new Map<string, Record<string, unknown>>();
      for (const [key, fields] of histories) {
        const patch: Record<string, unknown> = {};
        for (const { target, kind, history, acceptedAncestors } of fields) patch[target.field] = this.project(kind, target, history, undefined, acceptedAncestors);
        patches.set(key, patch);
      }
      for (const fields of histories.values()) for (const { target, history, acceptedAncestors } of fields) {
        const key = JSON.stringify(target);
        if (this.retained.has(key) || this.pending(target).length) { this.histories.set(key, history); this.acceptedAncestors.set(key, acceptedAncestors); }
        else { this.histories.delete(key); this.acceptedAncestors.delete(key); }
      }
      apply(patches);
      return true;
    } catch (error) {
      if (generation !== this.generation) return true;
      batch.failed = true;
      batch.reject(error);
      throw error;
    } finally {
      if (!batch.failed || generation !== this.generation) {
        if (this.acceptedBatch === batch) this.acceptedBatch = undefined;
        batch.release();
      }
    }
  }

  retain(target: OperationTarget): () => void {
    const key = JSON.stringify(target);
    const generation = this.generation;
    this.retained.set(key, (this.retained.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released || generation !== this.generation) return;
      released = true;
      const count = (this.retained.get(key) ?? 1) - 1;
      if (count > 0) this.retained.set(key, count);
      else {
        this.retained.delete(key);
        if (!this.pending(target).length) { this.histories.delete(key); this.acceptedAncestors.delete(key); }
      }
    };
  }

  hasOperations(model: string, patch: Record<string, unknown>): boolean {
    return operationFields(this.port.metadata(model), patch).length > 0;
  }

  invalidate(model: string, id: string): number {
    const key = JSON.stringify([model, id]);
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  stage(model: string, id: string, patch: Record<string, unknown>, apply: (materialized: Record<string, unknown>) => Promise<void> | undefined): Promise<void> {
    const generation = this.generation;
    const key = JSON.stringify([model, id]);
    const previous = this.staging.get(key);
    if (!previous && !this.hasOperations(model, patch)) {
      this.invalidate(model, id);
      return Promise.resolve(apply(patch));
    }
    let confirmation: Promise<void> | undefined;
    const staged = (previous ?? Promise.resolve()).then(async () => {
      if (generation !== this.generation) throw new Error('The model operation session changed before staging.');
      const materialized = await this.materialize(model, id, patch);
      if (generation !== this.generation) throw new Error('The model operation session changed before staging.');
      this.invalidate(model, id);
      confirmation = apply(materialized);
      // Confirmation is observed by the caller after staging releases the next write.
      void confirmation?.catch(() => undefined);
    });
    const tail = staged.catch(() => undefined);
    this.staging.set(key, tail);
    void tail.then(() => { if (this.staging.get(key) === tail) this.staging.delete(key); });
    return staged.then(() => confirmation);
  }

  async materialize(model: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fields = operationFields(this.port.metadata(model), patch);
    if (fields.length > 1) throw new AbloValidationError('Commit one field operation per row.', { code: 'commit_operation_invalid' });
    const result = { ...patch };
    for (const { field, kind } of fields) {
      const target = { model, id, field };
      const history = await this.refresh(kind, target);
      result[field] = this.project(kind, target, history, patch[field]);
    }
    return result;
  }

  /** Editors enqueue through the same journal and row materializer as model.update. */
  stageLocal(kind: FieldOperationKind, target: OperationTarget, operation: TextOperation | number, authoredValue: unknown,
    apply: (value: string | number, input: Record<string, unknown>, intent: FieldIntent) => Promise<QueuedMutation>,
  ): Promise<QueuedMutation> {
    const generation = this.generation;
    const key = JSON.stringify([target.model, target.id]);
    const previous = this.staging.get(key);
    const applyHistory = (history: unknown) => {
      if (generation !== this.generation) throw new Error('The model operation session changed before staging.');
      const declared = this.port.metadata(target.model)?.fields?.[target.field]?.merge;
      if (declared !== kind) throw new AbloValidationError('The model field does not declare this operation kind.', { code: 'commit_operation_invalid' });
      const pending = this.pending(target);
      const editId = crypto.randomUUID();
      let intent: FieldIntent;
      let value: string | number;
      if (kind === 'text') {
        const basis = queuedTextContext(history, pending, target.field, this.acceptedAncestors.get(JSON.stringify(target)));
        if (basis.pending.reduce((value, edit) => textDomain.apply(value, edit.operation), basis.snapshot.value) !== authoredValue) throw new AbloStaleContextError('The displayed text changed before its edit could be staged. Refresh before retrying.', { code: 'stale_context' });
        const context = appendContextOperation(textDomain, basis, editId, textDomain.schemas.edit.shape.operation.parse(operation));
        intent = { kind, field: target.field, editId, context };
        value = context.pending.reduce((value, edit) => textDomain.apply(value, edit.operation), context.snapshot.value);
      } else {
        const basis = queuedCounterContext(history, pending, target.field, this.acceptedAncestors.get(JSON.stringify(target)));
        if (basis.pending.reduce((value, edit) => counterDomain.apply(value, edit.operation), basis.snapshot.value) !== authoredValue) throw new AbloStaleContextError('The displayed counter changed before its edit could be staged. Refresh before retrying.', { code: 'stale_context' });
        const context = appendContextOperation(counterDomain, basis, editId, counterValueSchema.parse(operation));
        intent = { kind, field: target.field, editId, context };
        value = context.pending.reduce((value, edit) => counterDomain.apply(value, edit.operation), context.snapshot.value);
      }
      const last = intent.context.pending.at(-1);
      if (!last) throw new Error('The queued field intent is empty.');
      const input = { [target.field]: { [kind === 'text' ? '$text' : '$increment']: {
        id: editId, epoch: intent.context.snapshot.epoch, baseVersion: intent.context.snapshot.version, operation: last.operation,
      } } };
      if (generation !== this.generation) throw new Error('The model operation session changed before staging.');
      this.invalidate(target.model, target.id);
      this.histories.set(JSON.stringify(target), history);
      return apply(value, input, fieldIntentSchema.parse(intent));
    };
    const cached = this.histories.get(JSON.stringify(target));
    if (!previous && cached) return applyHistory(cached);
    const queued = (previous ?? Promise.resolve()).then(async () => applyHistory(this.histories.get(JSON.stringify(target)) ?? await this.refresh(kind, target)));
    const tail = queued.then(() => undefined, () => undefined);
    this.staging.set(key, tail);
    void tail.then(() => { if (this.staging.get(key) === tail) this.staging.delete(key); });
    return queued;
  }

  async prepare(transaction: QueuedMutation): Promise<Record<string, unknown>> {
    const intent = fieldIntentSchema.parse(transaction.fieldIntent);
    const target = { model: transaction.modelName, id: transaction.modelId, field: intent.field };
    if (this.port.metadata(target.model)?.fields?.[target.field]?.merge !== intent.kind) {
      throw new AbloStaleContextError('The queued operation declaration changed. Preserve its mutation for recovery.', { code: 'stale_context' });
    }
    const history = await this.refresh(intent.kind, target);
    const submitted = intent.kind === 'text' ? textEditValueSchema.parse(transaction.data?.[intent.field]).$text : counterEditValueSchema.parse(transaction.data?.[intent.field]).$increment;
    if (submitted.id !== intent.editId) throw new AbloStaleContextError('The queued operation identity disagrees with its authoring context.', { code: 'stale_context' });
    const edit = intent.kind === 'text'
      ? prepareContextOperation(textDomain, intent.context, textHistorySchema.parse(history), intent.editId)
      : prepareContextOperation(counterDomain, intent.context, counterHistorySchema.parse(history), intent.editId);
    return { ...transaction.data, [intent.field]: { [intent.kind === 'text' ? '$text' : '$increment']: edit } };
  }

  reconcile(model: string, id: string): Promise<Record<string, unknown> | null> {
    const key = JSON.stringify([model, id]);
    const existing = this.reconciliations.get(key);
    if (existing) { existing.dirty = true; return existing.promise; }
    const generation = this.generation;
    const work = { dirty: true, promise: Promise.resolve<Record<string, unknown> | null>(null) };
    const read = async () => {
      let result: Record<string, unknown> = {};
      let failure: unknown;
      let histories = new Map<string, { target: OperationTarget; history: unknown }>();
      while (work.dirty) {
        work.dirty = false;
        if (this.acceptedBatch?.keys.has(key)) {
          await this.acceptedBatch.done;
          if (generation !== this.generation) return null;
        }
        const revision = this.invalidate(model, id);
        result = {};
        failure = undefined;
        histories = new Map();
        for (const [field, meta] of Object.entries(this.port.metadata(model)?.fields ?? {})) {
          if (!meta.merge) continue;
          const target = { model, id, field };
          const history = await this.refresh(meta.merge, target);
          histories.set(JSON.stringify(target), { target, history });
          try { result[field] = this.project(meta.merge, target, history); }
          catch (error) {
            failure = error;
            result[field] = meta.merge === 'text'
              ? foldOperationHistory(textDomain, textHistorySchema.parse(history)).value
              : foldOperationHistory(counterDomain, counterHistorySchema.parse(history)).value;
          }
        }
        if (generation !== this.generation) return null;
        if (this.acceptedBatch?.keys.has(key)) { await this.acceptedBatch.done; work.dirty = true; }
        if (revision !== this.revisions.get(key)) work.dirty = true;
      }
      for (const [key, { target, history }] of histories) {
        this.acceptedAncestors.delete(key);
        if (this.retained.has(key) || this.pending(target).length) this.histories.set(key, history);
        else this.histories.delete(key);
      }
      this.port.publish?.(model, id, result);
      if (failure !== undefined) throw failure;
      return result;
    };
    this.reconciliations.set(key, work);
    work.promise = read().finally(() => { if (this.reconciliations.get(key) === work) this.reconciliations.delete(key); });
    return work.promise;
  }

  retainedFields(model: string, id: string): string[] {
    return Object.keys(this.port.metadata(model)?.fields ?? {}).filter((field) => this.histories.has(JSON.stringify({ model, id, field })));
  }

  async inverse(kind: FieldOperationKind, target: OperationTarget, editId: string) {
    const history = await this.refresh(kind, target);
    const id = crypto.randomUUID();
    return kind === 'text'
      ? { $text: invertAcceptedFieldEdit(textDomain, textHistorySchema.parse(history), editId, id) }
      : { $increment: invertAcceptedFieldEdit(counterDomain, counterHistorySchema.parse(history), editId, id) };
  }

  private async refresh(kind: FieldOperationKind, target: OperationTarget): Promise<unknown> {
    const generation = this.generation;
    const history = await retryOperationContention(() => this.port.read(kind, target));
    if (generation !== this.generation) throw new Error('The model operation session changed. Reopen the client before editing.');
    return history;
  }

  private pending(target: OperationTarget): readonly QueuedMutation[] {
    return this.port.pending().filter((tx) => tx.type === 'update' && tx.modelName === target.model && tx.modelId === target.id && tx.data && Object.hasOwn(tx.data, target.field));
  }

  private project(kind: FieldOperationKind, target: OperationTarget, history: unknown, proposed?: unknown, acceptedAncestors?: ReadonlySet<string>): string | number {
    const pending: FieldMutation[] = [...this.pending(target)];
    if (proposed !== undefined) pending.push({ data: { [target.field]: proposed } });
    const values = pending.map((tx) => tx.data?.[target.field]);
    // A replacement is a governed epoch change; it cannot be interpreted as an increment.
    const replacement = values.map((value) => typeof value === 'number').lastIndexOf(true);
    if (replacement >= 0) {
      if (replacement !== values.length - 1) throw new AbloStaleContextError('A pending replacement must be confirmed before editing its new operation epoch.', { code: 'stale_context' });
      return counterValueSchema.parse(values[replacement]);
    }
    if (kind === 'text') {
      const context = queuedTextContext(history, pending, target.field, acceptedAncestors);
      return context.pending.reduce((value, edit) => textDomain.apply(value, edit.operation), context.snapshot.value);
    }
    const context = queuedCounterContext(history, pending, target.field, acceptedAncestors);
    return context.pending.reduce((value, edit) => counterDomain.apply(value, edit.operation), context.snapshot.value);
  }
}
