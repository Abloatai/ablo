/*
 * OfflineTransactionStore
 * - IndexedDB-backed queue for GraphQL mutations and REST ops
 * - AES-GCM encryption at rest (per-browser key)
 * - Priority-aware ordering with simple topological sort
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { openIDBWithTimeout } from '../core/openIDBWithTimeout';
import { AbloConnectionError } from '../errors';

export enum Priority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

export type OfflineTransaction = {
  id: string;
  opName: string; // e.g., CreateTask, UpdateProject
  priority: Priority;
  createdAt: number;
  // Explicit dependencies by tx id (optional)
  dependsOn?: string[];
  // Request payload (GraphQL or REST)
  request: {
    // GraphQL persisted op id or full document
    gqlId?: string;
    document?: string;
    variables?: Record<string, any>;
    headers?: Record<string, string>;
    // Optional REST fallback
    method?: string;
    url?: string;
    body?: any;
  };
};

type EncryptedRecord = {
  id: string;
  priority: number;
  createdAt: number;
  dependsOn?: string[];
  // Encryption metadata
  iv: string; // base64
  ciphertext: string; // base64
};

// Minimal IndexedDB helpers. Delegates to openIDBWithTimeout so the open
// request can't silently hang when another tab holds an older version
// (`onblocked`) or when storage is in a bad state (no event fires at all).
function openDB(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return openIDBWithTimeout(name, version, {
    onUpgrade: (request) => upgrade(request.result),
  });
}

function txStore<T = any>(db: IDBDatabase, mode: IDBTransactionMode) {
  const tx = db.transaction('transactions', mode);
  const store = tx.objectStore('transactions');
  return { tx, store } as const;
}

function b64(bytes: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes as any).toString('base64');
  let binary = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.byteLength; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

function b64dec(text: string): ArrayBuffer {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(text, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getOrCreateKey(): Promise<CryptoKey | null> {
  try {
    const storageKey = 'ablo:offline:key';
    let raw = localStorage.getItem(storageKey);
    if (!raw) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      raw = b64(seed.buffer);
      localStorage.setItem(storageKey, raw);
    }
    const keyData = b64dec(raw);
    return await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    return null; // no crypto in environment
  }
}

async function encryptJSON(
  key: CryptoKey | null,
  data: any
): Promise<{ iv: string; ciphertext: string }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  if (!key || !crypto?.subtle) {
    return { iv: '', ciphertext: b64(plaintext.buffer) };
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: b64(iv.buffer), ciphertext: b64(ct) };
}

async function decryptJSON<T = any>(key: CryptoKey | null, record: EncryptedRecord): Promise<T> {
  if (!key || !record.iv) {
    const buf = b64dec(record.ciphertext);
    const text = new TextDecoder().decode(buf);
    return JSON.parse(text) as T;
  }
  const iv = new Uint8Array(b64dec(record.iv));
  const ct = b64dec(record.ciphertext);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export class OfflineTransactionStore {
  private db: IDBDatabase | null = null;
  private key: CryptoKey | null = null;

  async init(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    this.key = await getOrCreateKey();
    this.db = await openDB('ablo-sync', 1, (db) => {
      if (!db.objectStoreNames.contains('transactions')) {
        const store = db.createObjectStore('transactions', { keyPath: 'id' });
        store.createIndex('priority_createdAt', ['priority', 'createdAt']);
        store.createIndex('createdAt', 'createdAt');
      }
    });
  }

  async enqueue(tx: Omit<OfflineTransaction, 'createdAt'>): Promise<string> {
    if (!this.db) await this.init();
    if (!this.db)
      throw new AbloConnectionError('IndexedDB unavailable', {
        code: 'idb_unavailable',
      });
    const full: OfflineTransaction = { ...tx, createdAt: Date.now() } as any;
    const { iv, ciphertext } = await encryptJSON(this.key, full);
    const rec: EncryptedRecord = {
      id: full.id,
      priority: full.priority,
      createdAt: full.createdAt,
      dependsOn: full.dependsOn,
      iv,
      ciphertext,
    };
    const { tx: itx, store } = txStore(this.db, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(rec);
      req.onsuccess = () => {
        resolve(full.id);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  }

  async listAll(): Promise<OfflineTransaction[]> {
    if (!this.db) await this.init();
    if (!this.db) return [];
    const out: OfflineTransaction[] = [];
    const { store } = txStore(this.db, 'readonly');
    const req = store.getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = async () => {
        try {
          for (const rec of req.result as EncryptedRecord[]) {
            out.push(await decryptJSON<OfflineTransaction>(this.key, rec));
          }
          resolve(out);
        } catch (e) {
          reject(e);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getOptimizedSyncOrder(): Promise<OfflineTransaction[]> {
    // Collect all, sort by priority asc, then topologically by dependsOn
    const items = await this.listAll();
    items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt - b.createdAt;
    });

    // Topological sort
    const byId = new Map<string, OfflineTransaction>();
    const indeg = new Map<string, number>();
    const graph = new Map<string, string[]>();
    for (const it of items) {
      byId.set(it.id, it);
      indeg.set(it.id, 0);
      graph.set(it.id, []);
    }
    for (const it of items) {
      for (const dep of it.dependsOn || []) {
        if (!byId.has(dep)) continue; // ignore external
        indeg.set(it.id, (indeg.get(it.id) || 0) + 1);
        graph.get(dep)!.push(it.id);
      }
    }
    const queue: string[] = [];
    for (const [id, deg] of indeg) if (deg === 0) queue.push(id);
    // Sort queue by priority so nodes at the same dependency level
    // come out in priority order (lower number = higher priority)
    const sortQueue = () =>
      queue.sort((a, b) => {
        const pa = byId.get(a)?.priority ?? 0;
        const pb = byId.get(b)?.priority ?? 0;
        if (pa !== pb) return pa - pb;
        return (byId.get(a)?.createdAt ?? 0) - (byId.get(b)?.createdAt ?? 0);
      });
    sortQueue();
    const order: OfflineTransaction[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      const node = byId.get(id);
      if (node) order.push(node);
      for (const nxt of graph.get(id) || []) {
        const d = (indeg.get(nxt) || 0) - 1;
        indeg.set(nxt, d);
        if (d === 0) queue.push(nxt);
      }
      if (queue.length > 1) sortQueue();
    }
    // Fallback: if cycles exist, append remaining by createdAt
    if (order.length < items.length) {
      const seen = new Set(order.map((x) => x.id));
      for (const it of items) if (!seen.has(it.id)) order.push(it);
    }
    return order;
  }

  async remove(id: string): Promise<void> {
    if (!this.db) await this.init();
    if (!this.db) return;
    const { store } = txStore(this.db, 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) await this.init();
    if (!this.db) return;
    const { store } = txStore(this.db, 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Flush with caller-provided network function
  async flush(
    processor: (tx: OfflineTransaction) => Promise<void>
  ): Promise<{ processed: number; failed: number }> {
    const ordered = await this.getOptimizedSyncOrder();
    let processed = 0;
    let failed = 0;
    for (const tx of ordered) {
      try {
        await processor(tx);
        await this.remove(tx.id);
        processed++;
      } catch (_err) {
        // Stop on first failure to preserve order
        failed++;
        break;
      }
    }
    return { processed, failed };
  }
}

export const offlineTxStore = new OfflineTransactionStore();
