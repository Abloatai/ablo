/**
 * Engine-side database validation for `ablo connect` — used when the
 * developer's machine can't dial `DATABASE_URL` at all.
 *
 * Replication runs from Ablo's infrastructure, not from the developer's
 * machine, so the local network is not the authority on reachability: an
 * IPv6-only host (Supabase direct hosts), an IP-allowlisted database, or one
 * behind a VPN can be perfectly replicable while every local dial fails. When
 * the local probe fails to CONNECT (as opposed to connecting and finding
 * readiness problems), `--check` asks the engine to dial from its own network
 * via `POST /v1/datasources/validate`, and `--register` proceeds and lets
 * the registration preflight decide — both render the same checklist.
 *
 * The request itself goes through the control-plane boundary; this module
 * owns what is left once the transport is shared: classifying LOCAL dial
 * failures, and turning the engine's readiness items into plain language.
 */

import {
  datasourceValidationResponseSchema,
  isReadinessItem,
  type ReadinessFailure,
  type ReadinessItem,
} from '@abloatai/transaction/wire';
import { tryControlPlane, type ControlPlaneFetch } from './controlPlane';

/**
 * Error codes that mean "this machine could not reach the host" — DNS misses,
 * refused/unrouteable connections, and dial timeouts (`CONNECT_TIMEOUT` is the
 * postgres driver's own bounded-dial timeout). Anything else — an
 * authentication failure, a TLS rejection, a Postgres error — means the host
 * WAS reached, so the engine would see the same thing and a remote retry has
 * nothing to add.
 */
const DIAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CONNECT_TIMEOUT',
]);

/** The `code` property Node and the postgres driver stamp on network errors. */
interface CodedError {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
}

/**
 * When `err` is a network dial failure, return a human-readable reason
 * (`getaddrinfo ENOTFOUND db.x.supabase.co`); return null for every other
 * error so callers keep treating those as local, fatal problems. Looks
 * through `AggregateError` members because a dual-stack connect attempt
 * reports one error per address family.
 */
export function dialFailureReason(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null;
  const coded = err as CodedError;
  const code = typeof coded.code === 'string' ? coded.code : null;
  if (code && DIAL_FAILURE_CODES.has(code)) {
    return typeof coded.message === 'string' && coded.message.length > 0 ? coded.message : code;
  }
  if (Array.isArray(coded.errors)) {
    for (const member of coded.errors) {
      const reason = dialFailureReason(member);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * One failing readiness invariant, as the engine reports it over the wire —
 * the wire contract's own type, never restated here.
 */
export type RemoteReadinessFailure = ReadinessFailure;

/** The engine's answer, or the typed failure that prevented one. */
export type RemoteValidation =
  | {
      readonly ok: true;
      readonly reachable: boolean;
      readonly ready: boolean;
      readonly initialSnapshot?: {
        readonly status: 'loading' | 'retrying' | 'complete';
        readonly detail?: string;
      };
      /** The driver's words when the engine couldn't reach the host either. */
      readonly reason?: string;
      readonly failures: readonly RemoteReadinessFailure[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code?: string;
      readonly message: string;
    };

/** The observed value, parenthesized — only for items where it names the
 *  user's own objects (their tables, their Postgres version), never for a
 *  raw internal value like `wal_level = replica`. */
const withActual = (label: string, actual: string | undefined): string =>
  actual ? `${label} (${actual})` : label;

/**
 * Plain-language labels, one per vocabulary item: name the problem by what it
 * means for the user, not by the Postgres internal (wal_level, publication,
 * REPLICATION attribute…). The `fix` string carries the exact how; the label
 * just says what's not ready yet.
 *
 * Typed against {@link ReadinessItem} so it is total by construction: adding
 * an item to the wire vocabulary stops this compiling until the new item can
 * be explained in plain words. The alternative — a switch with a fallback —
 * is what let `server_version` reach readers as its raw internal name.
 */
const READINESS_LABELS: Readonly<Record<ReadinessItem, (f: RemoteReadinessFailure) => string>> = {
  server_version: (f) =>
    withActual(`your database's Postgres version is too old to share changes with Ablo`, f.actual),
  wal_level: () => `your database isn't set up to share changes as they happen yet`,
  publication: () => `none of your tables are shared with Ablo yet`,
  replication_role: () => `the login Ablo reads with can't follow your changes yet`,
  replica_identity: (f) =>
    withActual(
      `some shared tables don't record enough for Ablo to track edits and deletes`,
      f.actual
    ),
  table_select: (f) =>
    withActual(`the login Ablo reads with can't read some shared tables`, f.actual),
  write_role: () => `the login Ablo writes with isn't set up yet`,
  row_security: () => `the writer login isn't set to honor your row-level security`,
  database_privileges: () => `the writer login can still create things in your database`,
  schema_privileges: () => `the writer login has broader access than it should`,
  table_ownership: (f) =>
    withActual(`the writer login owns tables it should only write to`, f.actual),
  idempotency_ledger: () => `Ablo's write-safety record is missing or misconfigured`,
  table_privileges: (f) => withActual(`the writer login can't write to your tables yet`, f.actual),
  logical_marker: () =>
    `the writer login can't send the signal Ablo uses to confirm a write landed`,
  // The tables you pushed but didn't share. A write to one of these would
  // land in your database and never confirm — the failure this names.
  publication_drift: (f) =>
    withActual(`some tables in your schema aren't shared with Ablo`, f.actual),
};

/**
 * Render a wire failure as a checklist line — the ONE rendering of the
 * readiness checklist, used by `connect check`, registration refusals, and
 * every other surface that shows these items, so the same failure never reads
 * two ways. An item newer than this build passes through by name rather than
 * failing: the vocabulary is closed for producers, open for readers.
 */
export function describeRemoteFailure(failure: RemoteReadinessFailure): {
  readonly label: string;
  readonly fix: string;
} {
  const label = isReadinessItem(failure.item)
    ? READINESS_LABELS[failure.item](failure)
    : failure.item;
  return { label, fix: failure.fix };
}

/**
 * Ask the engine to report replication readiness from its own network — the
 * network replication actually runs from. With no `connectionString`, the engine
 * validates the source it already holds for the caller's plane, so the check
 * needs only the API key; with one, it dials that specific string (the
 * pre-registration probe). Never throws: network and HTTP failures come back as
 * `{ ok: false }` with the typed error's code and message, so the caller
 * renders one consistent message and can still branch on the code.
 */
export async function requestRemoteValidation(input: {
  readonly apiUrl: string;
  readonly apiKey: string;
  /** Omit to validate the registered source; supply to dial a specific string. */
  readonly connectionString?: string;
  /** Separate scoped DML credential; when present the engine validates both legs. */
  readonly writeConnectionString?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: ControlPlaneFetch;
}): Promise<RemoteValidation> {
  const result = await tryControlPlane({
    path: '/v1/datasources/validate',
    method: 'POST',
    baseUrl: input.apiUrl,
    apiKey: input.apiKey,
    body: {
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
      ...(input.writeConnectionString
        ? { writeConnectionString: input.writeConnectionString }
        : {}),
    },
    responseSchema: datasourceValidationResponseSchema,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.error.httpStatus ?? 0,
      message: result.error.message,
      ...(result.error.code !== undefined ? { code: result.error.code } : {}),
    };
  }
  const verdict = result.value;
  return {
    ok: true,
    reachable: verdict.reachable,
    ready: verdict.ready,
    ...(verdict.initial_snapshot !== undefined
      ? { initialSnapshot: verdict.initial_snapshot }
      : {}),
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    failures: verdict.failures,
  };
}
