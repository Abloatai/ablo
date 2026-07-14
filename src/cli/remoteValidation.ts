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
 * via `POST /api/v1/datasources/validate`, and `--register` proceeds and lets
 * the registration preflight decide — both render the same checklist.
 */

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
 * The validate-only endpoint for a given API base URL — mounted under `/api`
 * exactly like registration (see {@link registerEndpoint} in connect.ts).
 */
export function validateEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/datasources/validate`;
}

/** One failing readiness invariant, as the engine reports it over the wire. */
export interface RemoteReadinessFailure {
  readonly item: string;
  readonly actual?: string;
  readonly fix: string;
}

/** The engine's answer, or the HTTP failure that prevented one. */
export type RemoteValidation =
  | {
      readonly ok: true;
      readonly reachable: boolean;
      readonly ready: boolean;
      /** The driver's words when the engine couldn't reach the host either. */
      readonly reason?: string;
      readonly failures: readonly RemoteReadinessFailure[];
    }
  | { readonly ok: false; readonly status: number; readonly code?: string; readonly message: string };

/**
 * Render a wire failure as a checklist line — the same labels the local
 * `--check` prints, so the two paths read identically.
 */
export function describeRemoteFailure(failure: RemoteReadinessFailure): {
  readonly label: string;
  readonly fix: string;
} {
  switch (failure.item) {
    case 'wal_level':
      return {
        label: failure.actual
          ? `wal_level is ${failure.actual} (need logical)`
          : `wal_level must be logical`,
        fix: failure.fix,
      };
    case 'publication':
      return { label: 'the Ablo publication does not exist', fix: failure.fix };
    case 'replication_role':
      return { label: 'the DATABASE_URL role lacks the REPLICATION attribute', fix: failure.fix };
    case 'replica_identity':
      return {
        label: `published tables cannot replicate UPDATE/DELETE${failure.actual ? ` (${failure.actual})` : ''}`,
        fix: failure.fix,
      };
    default:
      return { label: failure.item, fix: failure.fix };
  }
}

/** The wire shapes, parsed defensively — a lying server never crashes the CLI. */
interface ValidationWireBody {
  object?: unknown;
  reachable?: unknown;
  ready?: unknown;
  reason?: unknown;
  failures?: unknown;
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseWireFailures(value: unknown): readonly RemoteReadinessFailure[] {
  if (!Array.isArray(value)) return [];
  const failures: RemoteReadinessFailure[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const { item, actual, fix } = entry as { item?: unknown; actual?: unknown; fix?: unknown };
    if (typeof item !== 'string' || typeof fix !== 'string') continue;
    failures.push({ item, fix, ...(typeof actual === 'string' ? { actual } : {}) });
  }
  return failures;
}

/** The slice of a fetch response the validation client reads. */
export interface ValidationHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * The slice of `fetch` the validation client needs — global fetch satisfies it
 * structurally, and tests inject a plain-object fake without needing the
 * runtime's `Response`/`Headers` globals.
 */
export type ValidationFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<ValidationHttpResponse>;

/**
 * Ask the engine to dial `connectionString` from its own network and report
 * replication readiness. Never throws: network and HTTP failures come back as
 * `{ ok: false }` so the caller renders one consistent message.
 */
export async function requestRemoteValidation(input: {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly connectionString: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: ValidationFetch;
}): Promise<RemoteValidation> {
  const doFetch: ValidationFetch = input.fetchImpl ?? fetch;
  let res: ValidationHttpResponse;
  try {
    res = await doFetch(validateEndpoint(input.apiUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ connectionString: input.connectionString }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `couldn't reach ${input.apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as ValidationWireBody;
  if (!res.ok) {
    const code = typeof body.code === 'string' ? body.code : body.error?.code;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error?.message === 'string'
          ? body.error.message
          : `HTTP ${res.status}`;
    return {
      ok: false,
      status: res.status,
      message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }

  const reachable = body.reachable === true;
  return {
    ok: true,
    reachable,
    ready: body.ready === true,
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    failures: parseWireFailures(body.failures),
  };
}
