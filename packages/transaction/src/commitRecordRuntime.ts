import {
  DEFAULT_TRACK_ON_STALE,
  type CommitReadSetEntry,
  type ReadDependency,
  type ReadSetEntry,
  type TrackDependency,
} from './coordination/schema.js';
import {
  commitRecordIdentity,
  publishCommitRecord,
  type ReadSetContext,
} from './readSetContext.js';
import {
  commitRecordSchema,
  type CommitOperationBody,
  type CommitReceiptWire,
} from './wire/commit.js';

interface HttpCommitObservation {
  readonly receipt: CommitReceiptWire;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface WebSocketCommitObservation {
  readonly receipt: CommitReceiptWire;
  readonly operations: readonly {
    readonly type: string;
    readonly model: string;
    readonly id: string;
    readonly input?: Record<string, unknown>;
    readonly claimId?: string | null;
    readonly readAt?: number | null;
    readonly onStale?: CommitOperationBody['onStale'] | null;
    readonly fenceToken?: number | null;
  }[];
  readonly reads?: readonly ReadDependency[] | null;
  readonly track?: readonly TrackDependency[] | null;
}

function commitEntry(dependency: ReadDependency): CommitReadSetEntry {
  return {
    target: 'group' in dependency
      ? { scope: 'group', group: dependency.group }
      : {
          scope: 'row',
          model: dependency.model,
          id: dependency.id,
          ...(dependency.fields ? { fields: dependency.fields } : {}),
        },
    watermark: dependency.readAt,
    lifetime: 'commit',
    onStale: dependency.onStale ?? 'reject',
  };
}

function persistedEntry(
  dependency: TrackDependency,
  defaultWatermark: number,
): ReadSetEntry {
  return {
    target: 'group' in dependency
      ? { scope: 'group', group: dependency.group }
      : { scope: 'row', model: dependency.model, id: dependency.id },
    watermark: dependency.readAt ?? defaultWatermark,
    lifetime: 'persisted',
    onStale: dependency.onStale ?? DEFAULT_TRACK_ON_STALE,
  };
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
}

function retainedOperations(operations: readonly CommitOperationBody[]) {
  return operations.map(({ data: _data, ...operation }) => ({
    ...operation,
    data: { retention: 'redacted' as const },
  }));
}

function commitEvidence(
  receipt: CommitReceiptWire,
  operations: readonly CommitOperationBody[],
  transport: 'http' | 'websocket',
) {
  return {
    attempts: [{
      id: receipt.clientTxId,
      observedAt: receipt.createdAt,
      transport,
      kind: 'execution' as const,
    }],
    actor: {
      kind: receipt.authority.participantKind,
      id: receipt.authority.participantId,
    },
    // A receipt does not prove which live claim grant the server matched.
    // Durable server records populate this from the claim gate instead.
    claims: [],
  };
}

function operationFromModelRequest(
  observation: HttpCommitObservation,
  body: Record<string, unknown>,
): CommitOperationBody[] {
  const segments = observation.path.split('/').filter(Boolean);
  const modelIndex = segments.indexOf('models');
  if (modelIndex < 0) return [];
  const model = decodeURIComponent(segments[modelIndex + 1] ?? '');
  const pathId = segments[modelIndex + 2];
  const action = observation.method === 'POST'
    ? 'create'
    : observation.method === 'DELETE'
      ? 'delete'
      : 'update';
  return [{
    action,
    model,
    ...(pathId ? { id: decodeURIComponent(pathId) } : typeof body.id === 'string' ? { id: body.id } : {}),
    ...(body.data && typeof body.data === 'object'
      ? { data: body.data as Record<string, unknown> }
      : {}),
    ...(typeof body.readAt === 'number' ? { readAt: body.readAt } : {}),
    ...(typeof body.onStale === 'string'
      ? { onStale: body.onStale as CommitOperationBody['onStale'] }
      : {}),
    ...(typeof body.fenceToken === 'number' ? { fenceToken: body.fenceToken } : {}),
    ...(typeof body.claim === 'string' ? { claimId: body.claim } : {}),
  }];
}

/** @internal Joins exact HTTP request and receipt projections. */
export function recordHttpCommitReceipt(
  context: ReadSetContext | undefined,
  observation: HttpCommitObservation,
): void {
  if (!context?.getStore()) return;
  const body = bodyRecord(observation.body);
  const operations = Array.isArray(body.operations)
    ? body.operations as CommitOperationBody[]
    : operationFromModelRequest(observation, body);
  const reads = Array.isArray(body.reads) ? body.reads as ReadDependency[] : [];
  const track = Array.isArray(body.track) ? body.track as TrackDependency[] : [];
  const readSet: ReadSetEntry[] = reads.map(commitEntry);
  for (const operation of operations) {
    if (typeof operation.readAt !== 'number' || !operation.id) continue;
    readSet.push(commitEntry({
      model: operation.model,
      id: operation.id,
      readAt: operation.readAt,
      onStale: operation.onStale ?? 'reject',
    }));
  }
  readSet.push(...track.map((entry) => persistedEntry(entry, observation.receipt.lastSyncId)));

  const record = commitRecordSchema.parse({
    id: commitRecordIdentity(context, observation.receipt.clientTxId).id,
    createdAt: observation.receipt.createdAt,
    status: observation.receipt.status,
    statusAt: observation.receipt.statusAt,
    lastSyncId: observation.receipt.lastSyncId,
    ...(observation.receipt.correlationId
      ? { correlationId: observation.receipt.correlationId }
      : {}),
    readSet,
    operations: retainedOperations(operations),
    ...commitEvidence(observation.receipt, operations, 'http'),
    authority: observation.receipt.authority,
    receipt: {
      clientTxId: observation.receipt.clientTxId,
      serverTxId: observation.receipt.serverTxId,
      ops: observation.receipt.ops,
      ...(observation.receipt.notifications
        ? { notifications: observation.receipt.notifications }
        : {}),
      ...(observation.receipt.missingIds
        ? { missingIds: observation.receipt.missingIds }
        : {}),
    },
  });
  publishCommitRecord(context, record);
}

/** @internal Joins an exact commit frame and its authoritative WS receipt. */
export function recordWebSocketCommitReceipt(
  context: ReadSetContext | undefined,
  observation: WebSocketCommitObservation,
): void {
  if (!context?.getStore()) return;
  const operations: CommitOperationBody[] = observation.operations.map((operation) => ({
    action: operation.type.toLowerCase() as CommitOperationBody['action'],
    model: operation.model,
    id: operation.id,
    ...(operation.input ? { data: operation.input } : {}),
    ...(operation.claimId ? { claimId: operation.claimId } : {}),
    ...(typeof operation.readAt === 'number' ? { readAt: operation.readAt } : {}),
    ...(operation.onStale ? { onStale: operation.onStale } : {}),
    ...(typeof operation.fenceToken === 'number'
      ? { fenceToken: operation.fenceToken }
      : {}),
  }));
  const readSet: ReadSetEntry[] = (observation.reads ?? []).map(commitEntry);
  for (const operation of operations) {
    if (typeof operation.readAt !== 'number' || !operation.id) continue;
    readSet.push(commitEntry({
      model: operation.model,
      id: operation.id,
      readAt: operation.readAt,
      onStale: operation.onStale ?? 'reject',
    }));
  }
  readSet.push(...(observation.track ?? []).map((entry) =>
    persistedEntry(entry, observation.receipt.lastSyncId)));
  const record = commitRecordSchema.parse({
    id: commitRecordIdentity(context, observation.receipt.clientTxId).id,
    createdAt: observation.receipt.createdAt,
    status: observation.receipt.status,
    statusAt: observation.receipt.statusAt,
    lastSyncId: observation.receipt.lastSyncId,
    ...(observation.receipt.correlationId
      ? { correlationId: observation.receipt.correlationId }
      : {}),
    readSet,
    operations: retainedOperations(operations),
    ...commitEvidence(observation.receipt, operations, 'websocket'),
    authority: observation.receipt.authority,
    receipt: {
      clientTxId: observation.receipt.clientTxId,
      serverTxId: observation.receipt.serverTxId,
      ops: observation.receipt.ops,
      ...(observation.receipt.notifications
        ? { notifications: observation.receipt.notifications }
        : {}),
      ...(observation.receipt.missingIds
        ? { missingIds: observation.receipt.missingIds }
        : {}),
    },
  });
  publishCommitRecord(context, record);
}
