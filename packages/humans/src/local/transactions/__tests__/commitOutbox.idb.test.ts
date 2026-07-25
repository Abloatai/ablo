import { Database } from '../../Database.js';
import {
  createDurableCommitEnvelope,
  durableCommitEnvelopeSchema,
} from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import {
  createDurableHttpCommitEnvelope,
  durableHttpCommitEnvelopeSchema,
} from '@abloatai/transaction/transactions/settlement/httpCommitEnvelope';

const DB_NAME = 'commit-outbox-test';

function openOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('__transactions', { keyPath: 'id' });
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request error')); };
  });
}

function deleteOutboxDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => { resolve(); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request error')); };
    request.onblocked = () => { reject(new Error('database deletion blocked')); };
  });
}

function put(db: IDBDatabase, record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('__transactions', 'readwrite');
    transaction.objectStore('__transactions').put(record);
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB transaction error')); };
  });
}

function get(db: IDBDatabase, id: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('__transactions', 'readonly');
    const request = transaction.objectStore('__transactions').get(id);
    request.onsuccess = () => { resolve(request.result as Record<string, unknown> | undefined); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request error')); };
  });
}

function databaseUsing(db: IDBDatabase): Database {
  const database = Object.create(Database.prototype) as Database;
  Object.assign(database, {
    inMemory: false,
    workspaceDb: db,
    isClosing: false,
  });
  return database;
}

function envelope(idempotencyKey: string, title: string) {
  const now = Date.now();
  return createDurableCommitEnvelope({
    idempotencyKey,
    origin: 'model_batch',
    operations: [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title },
        transactionId: 'operation-1',
      },
    ],
    sourceMutationIds: ['mutation-1', 'mutation-2'],
    commitOptions: {},
    createdAt: now,
    sealedAt: now,
  });
}

describe('Database commit outbox handoff', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    await deleteOutboxDatabase().catch(() => undefined);
    db = await openOutboxDatabase();
  });

  afterEach(async () => {
    db.close();
    await deleteOutboxDatabase();
  });

  it('atomically replaces staged mutation rows with one sealed envelope', async () => {
    await put(db, { id: 'pending-mutation:mutation-1', type: 'pending_mutation' });
    await put(db, { id: 'pending-mutation:mutation-2', type: 'pending_mutation' });
    const durable = envelope('commit-atomic', 'after');

    await databaseUsing(db).sealTransactionRecord(durable, [
      'pending-mutation:mutation-1',
      'pending-mutation:mutation-2',
    ]);

    expect(await get(db, durable.id)).toEqual(durable);
    expect(await get(db, 'pending-mutation:mutation-1')).toBeUndefined();
    expect(await get(db, 'pending-mutation:mutation-2')).toBeUndefined();
  });

  it('aborts a key/body collision without consuming the new staged rows', async () => {
    const first = envelope('commit-collision', 'first');
    await put(db, first);
    await put(db, { id: 'pending-mutation:new-source', type: 'pending_mutation' });
    const conflicting = createDurableCommitEnvelope({
      ...envelope('commit-collision', 'different'),
      sourceMutationIds: ['new-source'],
    });

    await expect(
      databaseUsing(db).sealTransactionRecord(conflicting, [
        'pending-mutation:new-source',
      ]),
    ).rejects.toThrow('different request');

    expect(await get(db, first.id)).toEqual(first);
    expect(await get(db, 'pending-mutation:new-source')).toBeDefined();
  });

  it('atomically upgrades an identical HTTP envelope with source acceptance', async () => {
    const durable = createDurableHttpCommitEnvelope({
      idempotencyKey: 'http-source-accepted',
      request: {
        method: 'POST',
        path: '/v1/commits',
        body: {
          operations: [
            { action: 'delete', model: 'tasks', id: 'task-1' },
          ],
        },
      },
      scopeNamespace: 'org:agent:test',
    });
    await databaseUsing(db).sealTransactionRecord(durable, []);
    const accepted = durableHttpCommitEnvelopeSchema.parse({
      ...durable,
      acceptedAt: durable.sealedAt + 1,
      correlationId: 'corr-source-accepted',
    });

    await databaseUsing(db).sealTransactionRecord(accepted, []);

    expect(await get(db, durable.id)).toEqual(accepted);
  });

  it('atomically upgrades an identical model envelope with source acceptance', async () => {
    const durable = envelope('model-source-accepted', 'accepted');
    await databaseUsing(db).sealTransactionRecord(durable, []);
    const accepted = durableCommitEnvelopeSchema.parse({
      ...durable,
      acceptedAt: durable.sealedAt + 1,
      correlationId: 'corr-model-source-accepted',
    });

    await databaseUsing(db).sealTransactionRecord(accepted, []);

    expect(await get(db, durable.id)).toEqual(accepted);
  });

  it('rejects a second-tab promotion after another envelope claimed its source', async () => {
    const losingEnvelope = envelope('commit-second-tab', 'duplicate');

    await expect(
      databaseUsing(db).sealTransactionRecord(losingEnvelope, [
        'pending-mutation:mutation-1',
        'pending-mutation:mutation-2',
      ]),
    ).rejects.toThrow('already claimed');

    expect(await get(db, losingEnvelope.id)).toBeUndefined();
  });
});
