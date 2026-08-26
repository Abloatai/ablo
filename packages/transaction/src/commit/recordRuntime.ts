import type { ReadDependency } from '../coordination/schema.js';
import {
  publishCommitRecord,
  type ReadSetContext,
} from './readSetContext.js';
import {
  commitRecordSchema,
  type CommitOperationBody,
  type CommitReceiptWire,
} from './contract.js';

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
    readonly fenceToken?: number | null;
  }[];
  readonly reads?: readonly ReadDependency[] | null;
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
  const retainedReads: ReadDependency[] = [...reads];
  for (const operation of operations) {
    if (typeof operation.readAt !== 'number' || !operation.id) continue;
    retainedReads.push({
      model: operation.model,
      id: operation.id,
      readAt: operation.readAt,
    });
  }

  const record = commitRecordSchema.parse({
    id: observation.receipt.clientTxId,
    createdAt: observation.receipt.createdAt,
    status: observation.receipt.status,
    statusAt: observation.receipt.statusAt,
    lastSyncId: observation.receipt.lastSyncId,
    ...(observation.receipt.correlationId
      ? { correlationId: observation.receipt.correlationId }
      : {}),
    reads: retainedReads,
    operations: retainedOperations(operations),
    ...commitEvidence(observation.receipt, operations, 'http'),
    authority: observation.receipt.authority,
    receipt: {
      clientTxId: observation.receipt.clientTxId,
      serverTxId: observation.receipt.serverTxId,
      ops: observation.receipt.ops,
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
    ...(typeof operation.fenceToken === 'number'
      ? { fenceToken: operation.fenceToken }
      : {}),
  }));
  const retainedReads: ReadDependency[] = [...(observation.reads ?? [])];
  for (const operation of operations) {
    if (typeof operation.readAt !== 'number' || !operation.id) continue;
    retainedReads.push({
      model: operation.model,
      id: operation.id,
      readAt: operation.readAt,
    });
  }
  const record = commitRecordSchema.parse({
    id: observation.receipt.clientTxId,
    createdAt: observation.receipt.createdAt,
    status: observation.receipt.status,
    statusAt: observation.receipt.statusAt,
    lastSyncId: observation.receipt.lastSyncId,
    ...(observation.receipt.correlationId
      ? { correlationId: observation.receipt.correlationId }
      : {}),
    reads: retainedReads,
    operations: retainedOperations(operations),
    ...commitEvidence(observation.receipt, operations, 'websocket'),
    authority: observation.receipt.authority,
    receipt: {
      clientTxId: observation.receipt.clientTxId,
      serverTxId: observation.receipt.serverTxId,
      ops: observation.receipt.ops,
      ...(observation.receipt.missingIds
        ? { missingIds: observation.receipt.missingIds }
        : {}),
    },
  });
  publishCommitRecord(context, record);
}
