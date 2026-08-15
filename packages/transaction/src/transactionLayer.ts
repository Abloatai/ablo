/**
 * The transaction layer's seam — the surface the sync engine (and any other
 * caller) sits on. ADR 0013's thesis as an interface: the layer defines,
 * orders, settles, and authorizes changes; it holds no materialised state.
 *
 * `observe()` is the whole seam in one method. The sync engine is `observe()`
 * piped into a local store — deltas → local store → IndexedDB → reactive
 * re-render — plus local optimistic mutations reconciled against `commit()` /
 * `settled()`. Everything reactive is downstream of that method; the
 * transaction layer never calls up into it.
 *
 * `participant` stays the WHO (user | agent | system), never the name of this.
 * The taught verbs map onto the seam directly: `create`/`update`/`delete` are
 * operations inside a `commit()` payload; `claim` is `claim()`; `track` rides
 * the commit payload's `track` field (a durable premise is a zero-operation
 * commit). Presence (`join`) is deliberately absent: it is live observation
 * over a socket, and it joins the seam when its core carrier type exists —
 * see docs/plans/transaction-core-language.md, Tier 3.
 *
 * This is the contract, not a runtime. The headless HTTP client implements it
 * as a proxy to the hosted authority; other compositions gain the same
 * compile-time conformance pin against this interface.
 */

import type { CommitMessage } from './wire/frames.js';
import type { ClientCommitReceipt } from './wire/commit.js';
import type { Delta, HeldClaim, ClaimTarget, ClaimLeaseOptions } from './types/streams.js';
import type { ModelData } from './types/modelData.js';
import type { ModelScope } from './types/index.js';

/**
 * A commit's durable acceptance — `{ status: 'queued' }` with the correlation
 * the confirmation feed later confirms. The wire layer owns the receipt fields;
 * the seam adds the client idempotency identity needed for a safe wait/retry.
 */
export type CommitReceipt = ClientCommitReceipt & {
  /** The idempotency identity used to await/retry this commit. */
  readonly clientTxId: string;
};

/**
 * The seam's read grammar for {@link TransactionLayer.list} — filter, order,
 * and page through settled rows. Mirrors the taught list options
 * (`where` / `orderBy` / `limit` / `offset` / `state`) without binding the
 * seam to the client's local-read machinery.
 */
export interface ListQuery {
  /** Equality filter on field values. */
  where?: ModelData;
  /** Sort order, field → direction. */
  orderBy?: Record<string, 'asc' | 'desc'>;
  limit?: number;
  offset?: number;
  /** Lifecycle filter; defaults to `'live'`. */
  state?: `${ModelScope}`;
}

export interface ObserveCursorStore {
  load(key: string): Promise<string | null>;
  save(key: string, cursor: string): Promise<void>;
}

export interface ObserveOptions {
  /** Resume from a cursor previously returned by this feed. */
  after?: string;
  /** Restrict delivery to these model names. Credential scope still applies first. */
  models?: string | readonly string[];
  /** Stable name used with `cursorStore`; defaults to `default`. */
  cursorKey?: string;
  /** Optional durable cursor storage. Saving remains consumer-controlled. */
  cursorStore?: ObserveCursorStore;
  /** Delay after an empty page. */
  pollIntervalMs?: number;
  /** Stop polling and reject pending work. */
  signal?: AbortSignal;
}

export type ObservedDelta = Delta & {
  /** Resume position immediately after this delta. */
  readonly cursor: string;
  /** Persist this delta's cursor through the configured store. */
  checkpoint(): Promise<void>;
};

/**
 * The transaction layer. Reads return settled state, point-in-time — never a
 * reactive subscription. A write is an intent submitted through `commit()`;
 * durable acceptance is the receipt (`queued`), and `settled()` resolves when
 * the sync log has appended it (`confirmed`).
 */
export interface TransactionLayer {
  /** Authentication: mint or renew the short-lived credential (`ek_`). */
  ready(): Promise<void>;

  /** Read one settled row by id, or `null` when absent. */
  get(model: string, id: string): Promise<ModelData | null>;

  /** Read settled rows matching a {@link ListQuery}. */
  list(model: string, query?: ListQuery): Promise<ModelData[]>;

  /**
   * Submit a batch of operations — with its idempotent `clientTxId`, its
   * `reads` premise, and any durable `track` registrations — and receive
   * durable acceptance.
   */
  commit(payload: CommitMessage['payload']): Promise<CommitReceipt>;

  /** Resolve when the receipt's operations have appended to the sync log. */
  settled(receipt: CommitReceipt): Promise<void>;

  /**
   * Take a FIFO lease with a fence token on a target; release through the
   * handle (`await using` disposes it).
   */
  claim(target: ClaimTarget, options?: ClaimLeaseOptions): Promise<HeldClaim>;

  /**
   * The authoritative change feed, scoped to one or more sync groups —
   * omitted, everything the credential can see.
   */
  observe(options?: ObserveOptions | string | readonly string[]): AsyncIterable<ObservedDelta>;
}
