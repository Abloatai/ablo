/**
 * The registry of every stable error code Ablo can produce. Error handling has
 * two levels, and this file defines the finer one.
 *
 *   - The `type` is the coarse category, and each one corresponds to an
 *     {@link AbloError} subclass such as `AbloPermissionError` or
 *     `AbloValidationError`. Catching by `instanceof` is equivalent to switching
 *     on `error.type`.
 *   - The `code` is the fine-grained, machine-readable identifier defined here,
 *     written in `snake_case` (for example `entity_claimed` or `queue_too_deep`).
 *     This is what you switch on to handle a specific situation, and what the
 *     documentation link for an error is built from.
 *
 * The client, the server, and the tool-calling boundary all speak this same
 * vocabulary, which makes the registry part of the API contract. Two things
 * follow from that:
 *
 *   1. {@link ErrorCode} is a closed set — plus the dynamic `policy:${string}`
 *      family — so producing a code that is not registered here is a
 *      compile-time error. The {@link AbloError} constructor accepts only a
 *      registered code. The one place an arbitrary string is accepted as a code
 *      is where an incoming response is parsed, which lets an older client
 *      tolerate a code from a newer server it does not yet recognize.
 *   2. The codes marked `surface: 'wire'` are the ones that cross the network
 *      and are mapped at the HTTP and tool-calling boundaries; the public error
 *      documentation is generated from them. Codes marked `surface: 'client'`
 *      describe local mistakes — accessing the database before opening it, or
 *      writing to a model that was never registered — and are never sent over
 *      the network, so they carry no HTTP status.
 */

import { z } from 'zod';

/**
 * The version of the error contract: the envelope shape together with the set of
 * codes and their meanings. It is date-based, and changes only when the contract
 * changes in a way a consumer can observe — a code added or removed, an HTTP
 * status changed, or an envelope field changed. It is emitted in the generated
 * error documentation and returned on the `Ablo-Version` response header, so a
 * consumer can detect when its expected contract has drifted from the server's.
 */
export const ERROR_CONTRACT_VERSION = '2026-08-15';

/** A coarse grouping of error codes, used to organize metrics and documentation. */
export type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'capability'
  | 'claim'
  | 'conflict'
  | 'validation'
  | 'not_found'
  | 'tenant'
  | 'schema'
  | 'bootstrap'
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'client';

/**
 * A closed classification of how a failure can be recovered from — a level above
 * the raw {@link ErrorCode}. Where a code says what went wrong, a recovery class
 * says what a client should do about it, which is exactly the distinction the
 * connection layer needs to decide between retrying, re-minting a credential, and
 * signing the user out. Every code maps to one of these, and the set is
 * validated at runtime.
 *
 *   - `access_credential_expiry` — the short-lived access credential the client
 *     presents (its ephemeral `ek_` or `rk_` key) has expired, while the
 *     underlying login is still valid. The remedy is to mint a fresh key from the
 *     session and retry the same request. This does not sign the user out; a
 *     short-lived key expiring — for example after a laptop resumes from sleep —
 *     is routine.
 *   - `session_expiry` — the long-lived login itself is gone. This is terminal:
 *     sign out and route to re-authentication.
 *   - `auth_blocked` — the server was reachable but rejected the kind or
 *     configuration of the credential (wrong key type, untrusted issuer, no
 *     organization). Re-authenticating would present the same rejected credential
 *     and loop, so the client should stop rather than reconnect or sign out.
 *   - `permission` — an authorization denial (403) based on scope, role, or
 *     membership.
 *   - `transient` — a temporary failure, such as a server error or lease
 *     contention, that may succeed if the same request is retried unchanged.
 *   - `none` — not a recoverable authentication condition: validation errors,
 *     not-found, local invariants, and any code an older client does not
 *     recognize.
 */
export const RECOVERY_CLASSES = [
  'access_credential_expiry',
  'session_expiry',
  'auth_blocked',
  'permission',
  'transient',
  'none',
] as const;

/** A Zod enum over {@link RECOVERY_CLASSES}, for validating a recovery class at
 *  runtime. */
export const recoveryClassSchema = z.enum(RECOVERY_CLASSES);

/** The recovery classification of a failure. See {@link RECOVERY_CLASSES}. */
export type RecoveryClass = z.infer<typeof recoveryClassSchema>;

/** One entry in the registry: everything known about a single error code.
 *  `httpStatus` is present only for codes that cross the network, since an HTTP
 *  status is a property of the wire boundary rather than of a purely local
 *  error. */
export interface ErrorCodeSpec {
  readonly category: ErrorCategory;
  /** `'wire'` for a code that crosses the network and is part of the API
   *  contract; `'client'` for a local error that is never serialized. */
  readonly surface: 'wire' | 'client';
  /** Canonical HTTP status for the wire boundary. Omitted for client codes. */
  readonly httpStatus?: number;
  /** Whether the same request can succeed on a later retry without the caller
   *  changing anything. `false` for permission, validation, and not-found;
   *  `true` for transient transport failures and lease contention. */
  readonly retryable: boolean;
  /** A one-line, human-readable description of the error — also the source text
   *  for its documentation page. */
  readonly message: string;
  /**
   * An explicit {@link RecoveryClass}, set only where it differs from what the
   * category, HTTP status, and `retryable` flag already imply — mainly the few
   * authentication codes whose remedy the status alone cannot reveal, such as
   * telling a session expiry apart from an access-credential expiry. For every
   * other code the recovery class is derived by {@link classifyRecovery}, so
   * this field can be left unset.
   */
  readonly recovery?: RecoveryClass;
  /** Exhaustive sink and alert policy for this code. */
  readonly observability: ErrorObservabilityPolicy;
}

export interface ErrorObservabilityPolicy {
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly sentry: 'log' | 'issue';
  readonly pagingEligible: boolean;
  readonly expectedVolume: 'low' | 'normal' | 'high';
  readonly owner: 'platform' | 'product';
}

function observabilityPolicy(
  category: ErrorCategory,
  httpStatus: number | undefined,
  operational = false,
): ErrorObservabilityPolicy {
  if ((httpStatus ?? 0) >= 500) {
    return { severity: 'error', sentry: 'issue', pagingEligible: true, expectedVolume: 'low', owner: 'platform' };
  }
  if (operational) {
    return { severity: 'warning', sentry: 'issue', pagingEligible: false, expectedVolume: 'low', owner: 'platform' };
  }
  return {
    severity: category === 'auth' ? 'info' : 'warning',
    sentry: 'log',
    pagingEligible: false,
    expectedVolume: category === 'auth' ? 'high' : 'normal',
    owner: 'product',
  };
}

const wire = (
  category: ErrorCategory,
  httpStatus: number,
  retryable: boolean,
  message: string,
  recovery?: RecoveryClass,
  operational = false,
): ErrorCodeSpec => ({
  category,
  surface: 'wire',
  httpStatus,
  retryable,
  message,
  recovery,
  observability: observabilityPolicy(category, httpStatus, operational),
});

const client = (
  category: ErrorCategory,
  message: string,
  recovery?: RecoveryClass
): ErrorCodeSpec => ({
  category,
  surface: 'client',
  retryable: false,
  observability: observabilityPolicy(category, undefined),
  message,
  ...(recovery !== undefined ? { recovery } : {}),
});

/**
 * The complete set of stable error codes, keyed by code. A code must be added
 * here before it can be thrown, since the {@link AbloError} constructor accepts
 * only codes from this set.
 */
export const ERROR_CODES = {
  // ── auth (401) ─────────────────────────────────────────────────────
  apikey_invalid: wire(
    'auth',
    401,
    false,
    "This API key isn't one Ablo recognizes — it may be mistyped, truncated, or belong to a different environment. Check the key and try again."
  ),
  apikey_revoked: wire(
    'auth',
    401,
    false,
    'This API key has been revoked and can no longer be used. Mint a new key from the dashboard.'
  ),
  // The short-lived access credential — the ephemeral key (`ek_` for users,
  // `rk_` for agents) minted from the login and presented as a bearer token.
  // Its expiry is routine and re-mintable: get a fresh key from the still-valid
  // session and retry, rather than signing out. An agent's expired `rk_` must
  // not sign a human out either. This is the one code on the silent re-mint
  // path; see the `access_credential_expiry` recovery class.
  apikey_expired: wire(
    'auth',
    401,
    false,
    'This ephemeral API key has expired. Mint a fresh key from your still-valid session and retry the request.',
    'access_credential_expiry'
  ),
  apikey_missing: wire(
    'auth',
    401,
    false,
    'The request arrived without an API key. Send one as `Authorization: Bearer <key>`.'
  ),
  api_key_required: wire(
    'auth',
    401,
    false,
    'This operation requires an API key, and none was presented. Send one as `Authorization: Bearer <key>`.'
  ),
  capability_id_missing: wire(
    'auth',
    401,
    false,
    'This request must name a capability id, but none was provided.'
  ),
  exchange_failed: wire(
    'auth',
    401,
    false,
    'The API key could not be exchanged for a working credential — the exchange was rejected. Check that the key is still valid.'
  ),
  identity_resolve_failed: wire(
    'auth',
    401,
    false,
    'The server could not resolve an identity for this credential — the identity lookup was rejected. Check that the credential is still valid.'
  ),
  auth_no_credentials: wire(
    'auth',
    401,
    false,
    'No recognized authentication credential was presented — no API key and no bearer JWT. Send `Authorization: Bearer <token>`.'
  ),
  identity_missing_organization: wire(
    'auth',
    401,
    false,
    'Authentication succeeded, but the credential resolves to no organization, so requests cannot be scoped. Check that the key or token carries an organization.'
  ),
  // The long-lived login is gone; this is terminal and drives sign-out and
  // re-authentication.
  session_expired: wire(
    'auth',
    401,
    false,
    'Your session has expired or is no longer valid. Sign in again to continue.',
    'session_expiry'
  ),
  better_auth_request_failed: wire(
    'auth',
    400,
    false,
    'The authentication request was rejected. Check the submitted credentials or request and try again.'
  ),
  better_auth_upstream_failed: wire(
    'server',
    500,
    true,
    'The authentication service could not complete the request. Retry the request; if it continues to fail, contact support.'
  ),
  // `jwt_invalid` is the general fallback; the codes below it split out specific
  // failure modes, so an integrator can tell a wrong JWKS registration from a
  // token with no organization claim from a wrong audience, instead of getting
  // one opaque code for all of them.
  jwt_invalid: wire(
    'auth',
    401,
    false,
    "The bearer JWT failed validation for a reason the server could not classify further. Check the token's issuer, signature, audience, and expiry."
  ),
  jwt_malformed: wire(
    'auth',
    401,
    false,
    'The bearer token is not a well-formed JWT and could not be decoded. Check that the full, unmodified token was sent.'
  ),
  jwt_missing_issuer: wire(
    'auth',
    401,
    false,
    'The bearer JWT has no `iss` (issuer) claim, so it cannot be routed to a trusted issuer.'
  ),
  jwt_issuer_untrusted: wire(
    'auth',
    401,
    false,
    "The bearer JWT's `iss` is not a registered trusted issuer. Check the token's issuer claim, or register the issuer with your deployment before retrying."
  ),
  jwt_signature_invalid: wire(
    'auth',
    401,
    false,
    "The bearer JWT's signature could not be verified against the issuer's JWKS (wrong key, rotated key, or forged token)."
  ),
  jwt_audience_mismatch: wire(
    'auth',
    401,
    false,
    "The bearer JWT's `aud` (audience) claim does not match the audience this issuer is registered with."
  ),
  jwt_missing_subject: wire(
    'auth',
    401,
    false,
    'The bearer JWT has no `sub` (subject) claim to identify the user.'
  ),
  jwt_missing_organization: wire(
    'auth',
    401,
    false,
    'The bearer JWT carries no organization context — neither a fixed org for the issuer nor the configured organization claim.'
  ),
  // Applies only to the trusted-issuer path, where a customer authenticates with
  // a JWT from their own identity provider. When such a token expires, the
  // remedy is to re-authenticate against that provider, so it classifies as a
  // session expiry.
  jwt_expired: wire(
    'auth',
    401,
    false,
    'The bearer JWT has expired. Obtain a fresh token from your identity provider and retry.',
    'session_expiry'
  ),
  jwt_org_membership_denied: wire(
    'auth',
    403,
    false,
    "The bearer JWT's subject is not an active member of the organization in its `org_id` claim (removed, suspended, or the claim does not match a membership)."
  ),
  file_upload_auth_required: wire(
    'auth',
    401,
    false,
    'File uploads require an authenticated session. Sign in and retry.'
  ),
  browser_apikey_blocked: client(
    'auth',
    'A raw API key was used from a browser, where anyone can read it. Keep secret keys server-side and hand the browser a short-lived ephemeral key instead.'
  ),
  datasource_connection_unsupported: wire(
    'validation',
    400,
    false,
    'This deployment does not accept direct connection-string data sources. Register a signed Data Source endpoint instead.'
  ),
  source_connector_localhost_required: wire(
    'validation',
    400,
    false,
    'A connector-only development Data Source must use a localhost descriptor. Use `ablo dev --local`; use the ordinary signed HTTPS endpoint registration for a deployed handler.'
  ),
  source_connector_unauthenticated: wire(
    'auth',
    401,
    false,
    'The localhost Data Source connector could not authenticate. Rerun `ablo dev --local` so it mints and uses a fresh branch-bound secret key.'
  ),

  // ── permission / capability (403) ──────────────────────────────────
  capability_scope_denied: wire(
    'capability',
    403,
    false,
    'This action falls outside the scope granted to the connection, so it was denied.'
  ),
  issuer_register_forbidden: wire(
    'permission',
    403,
    false,
    'Registering a trusted issuer requires a secret (`sk_`) API key. The key presented is not a secret key.'
  ),
  capability_invalid: wire(
    'capability',
    403,
    false,
    'This capability cannot be used — it is unknown, revoked, or expired. Request a fresh grant.'
  ),
  tenant_routing_failed: wire(
    'server',
    500,
    true,
    "The org's registered database could not be resolved or dialed. Ablo never falls back to shared storage for a dedicated tenant — retry, and check the datasource status if it persists."
  ),
  database_role_cannot_enforce_rls: wire(
    'permission',
    403,
    false,
    'The database role Ablo connects with is a superuser or has `BYPASSRLS`, so Postgres will not enforce row-level security for it. Connect with a role that is subject to RLS.',
    undefined,
    true,
  ),
  database_role_unreadable: wire(
    'permission',
    403,
    false,
    'Ablo could not introspect the database role it connects with, so it cannot verify that row-level security is enforced.',
    undefined,
    true,
  ),
  database_tables_unforced_rls: wire(
    'permission',
    403,
    false,
    'Some synced tables do not have `FORCE ROW LEVEL SECURITY` applied, so the table owner can bypass row isolation. Run `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on each synced table.',
    undefined,
    true,
  ),
  database_host_not_allowed: wire(
    'permission',
    403,
    false,
    "The database host did not resolve exclusively to an allowed address for this route. Use a publicly resolvable direct endpoint, or configure the matching PrivateLink, peering, or VPN route. Localhost has its own `database_loopback_requires_connector` workflow."
  ),
  database_loopback_requires_connector: wire(
    'validation',
    400,
    false,
    'Ablo Cloud cannot open a direct PostgreSQL connection to localhost on your machine. For localhost-first development, run `ablo migrate` once and keep `ablo dev --local` running; use a network-reachable direct route only when Ablo must observe arbitrary SQL writes through WAL.'
  ),
  connected_database_unreachable: wire(
    'tenant',
    503,
    false,
    'Ablo could not reach the database connected to this environment: it refused the credentials on file, or did not answer at all. A database often changes after it is connected — a password is rotated, an instance is replaced — while the connection goes on pointing at what used to be there. The error names the host it tried. If the password changed, `ablo connect rotate` re-keys the roles and re-registers them; if the database itself was replaced, `ablo connect apply` sets up the new one and `ablo connect register` hands it over. Run either with a key for this environment.'
  ),
  // Older spellings of the `database_*` codes above, still sent by some servers
  // and kept so they classify identically. Prefer the `database_*` codes.
  byo_role_cannot_enforce_rls: wire(
    'permission',
    403,
    false,
    'The direct Postgres connector role cannot enforce row-level security.'
  ),
  byo_role_unreadable: wire(
    'permission',
    403,
    false,
    'The direct Postgres connector role could not be introspected.'
  ),
  byo_tenant_tables_unforced_rls: wire(
    'permission',
    403,
    false,
    'Tenant tables do not have RLS forced under the direct Postgres connector role.'
  ),
  byo_host_not_allowed: wire(
    'permission',
    403,
    false,
    'The direct Postgres connector host resolves to a private, loopback, or link-local address and cannot be used.'
  ),

  // ── claim / claim conflict (409) ──────────────────────────────────
  // A rejection because another participant holds a claim is not retryable.
  // Re-sending the same write cannot succeed while the claim is held, and a
  // claim can outlive any reasonable retry budget, so an automatic retry would
  // only loop. Recovery belongs to the caller: take a claim, which queues fairly
  // behind the holder (`ablo.<model>.claim`), or re-read and rebase.
  claim_conflict: wire(
    'claim',
    409,
    false,
    'Another participant holds a claim on this row, so the write was rejected. Take a claim with `ablo.<model>.claim` to queue fairly behind the holder, or re-read and rebase.'
  ),
  claim_lost: wire(
    'claim',
    409,
    false,
    'The claim held on this row was lost before the write could apply. Re-acquire with `ablo.<model>.claim` and retry from its fresh snapshot.'
  ),
  fence_token_stale: wire(
    'claim',
    409,
    false,
    'This claim is no longer current because another participant completed newer work on the row. Re-claim the row and retry from the fresh state.'
  ),
  entity_claimed: wire(
    'claim',
    409,
    false,
    'This row is currently claimed by another participant, so the write was blocked. Queue behind the holder with `ablo.<model>.claim`, or wait for the claim to clear.'
  ),
  // A claim payload that cannot be parsed is a malformed request, not
  // contention — it is filed with `malformed_subscription` below rather than
  // with the 409s above, so the claim category stays purely about a target
  // being held. This is the code for a claim that fails to name its target,
  // over either transport — and for the participant claim behind `join`, which
  // names scopes rather than a row but fails the same way and to the same
  // caller. The copy covers both because the caller sees one word, `claim`, and
  // needs to be told which shape was expected without being handed a lecture on
  // the two frames.
  malformed_claim: wire(
    'validation',
    400,
    false,
    'The claim payload could not be parsed. A claim on a row must name the model and the entity it targets; a claim on a scope, which is what `join` opens, must name sync groups spelled `kind:id` or `default`. Check the payload shape and resend.'
  ),
  malformed_subscription: wire(
    'validation',
    400,
    false,
    'The `update_subscription` payload was malformed; expected `{ syncGroups: string[] }`.'
  ),
  // The counterpart to the two above, pointing the other way: those are a
  // client sending the server something it cannot read, this is the server
  // sending the client something it cannot read. One code covers both
  // transports — a mis-shaped socket frame and a mis-shaped HTTP body are the
  // same failure, and the message says which arrived. Not retryable: it means
  // the two sides are running different versions of the protocol, and waiting
  // does not change that.
  malformed_response: wire(
    'transport',
    502,
    false,
    'The server sent a message this client could not read, so it was declined whole rather than applied in part. Nothing was changed locally. This normally means the client and the server are running different versions; upgrading the client resolves it.'
  ),
  model_claimed: wire(
    'claim',
    409,
    false,
    'Another participant holds a claim on this row. Read `claim.state` to see who holds it, or queue behind them with a claim of your own.'
  ),
  model_claimed_timeout: wire(
    'claim',
    409,
    false,
    'Another participant held a claim on this row and did not release it in time. Retry, or read `claim.state` to see who holds it.'
  ),
  model_claim_not_configured: client(
    'claim',
    'Claiming is unavailable on this model client. Construct it through the standard Ablo({ schema, apiKey }) client and retry.'
  ),
  model_join_not_configured: client(
    'claim',
    'join() opens a presence/claim subscription and needs a live WebSocket, so it is unavailable on the HTTP transport and on model proxies built without a socket. Use the standard Ablo({ schema, apiKey }) client (default WebSocket transport).'
  ),

  // ── stale context / idempotency (409) ──────────────────────────────
  // Not retryable at the transport: the rejected request carries its frozen
  // `readAt`, so resending the identical payload can never succeed. Recovery
  // is a caller-level re-read that produces a NEW request with a fresh
  // watermark — the same shape as `claim_conflict`.
  stale_context: wire(
    'conflict',
    409,
    false,
    "The row changed after you read it — the write's `readAt` watermark is older than the current row version. Pass a function to `update(id, current => next)` and the SDK re-reads and retries for you; or re-read and retry by hand."
  ),
  // Raised by the functional `update(id, current => next)` form once its
  // internal reconcile budget is exhausted, because the row stayed continuously
  // contended. The SDK has already retried; the caller decides whether to back
  // off, raise `retries`, or move the row to the WebSocket transport.
  contention_exhausted: client(
    'conflict',
    'A functional update kept losing to concurrent writes and exhausted its reconcile budget. Back off and retry, raise `retries`, or move the row to the WebSocket transport.'
  ),
  update_aborted: client(
    'conflict',
    'The functional update was aborted via its `AbortSignal` before the write landed; nothing was written.'
  ),
  idempotency_conflict: wire(
    'conflict',
    409,
    false,
    'This `Idempotency-Key` was already used with a different request body. Reuse a key only to retry an identical request; otherwise generate a new one.'
  ),
  idempotency_key_expired: wire(
    'conflict',
    409,
    false,
    'This idempotency key belongs to an expired retained source intent and cannot be executed again safely. Use a new key only for a genuinely new write.'
  ),
  source_transport_pinned: wire(
    'conflict',
    409,
    false,
    'An earlier attempt under this idempotency key was pinned to a different source transport. Restore that route and retry the same key; Ablo will not switch a possibly committed write.'
  ),
  precondition_failed: wire(
    'conflict',
    409,
    false,
    'A conditional operation did not match the current database row. The complete atomic commit was rejected and no operation in the batch was applied.'
  ),
  idempotency_key_too_long: wire(
    'validation',
    400,
    false,
    'The supplied `Idempotency-Key` exceeds the maximum length. Use a shorter key — a UUID works well.'
  ),

  // ── validation (400 / 422) ─────────────────────────────────────────
  write_options_invalid: client(
    'validation',
    'The write options (`idempotencyKey` / `label` / `wait` / `readAt` / `claim`) failed validation against the write-options schema.'
  ),
  write_payload_invalid: client(
    'validation',
    'A write payload contained a value that cannot be represented safely as JSON. Use plain objects, arrays, finite numbers, strings, booleans, null, or valid dates.'
  ),
  source_operation_id_required: client(
    'validation',
    'A data-source operation arrived without the entity `id` it targets.'
  ),
  source_adapter_misconfigured: client(
    'validation',
    'The data-source ORM adapter could not map a schema model onto the backing client — the client exposes no matching delegate or model. Check that the adapter and schema agree on model names.'
  ),
  // The server validates every incoming data-source event before appending it
  // to the log and rejects the whole batch with this code; `param` names the
  // offending index and field path, such as `events[3].entityId`. It is also
  // raised on the client when an outbound source event cannot be built.
  source_event_invalid: wire(
    'validation',
    400,
    false,
    'A data-source event was malformed — missing or invalid id, model, entityId, type, or field value. The whole event batch was rejected and nothing was ingested; fix the offending outbox row and re-send.'
  ),
  duration_invalid: client(
    'validation',
    'A duration value was not a number of seconds or a "500ms" | "30s" | "3m" | "24h" string.'
  ),
  schema_definition_invalid: client(
    'validation',
    'A schema definition value was invalid (bad column identifier, non-finite backfill, or unsupported schema-JSON version).'
  ),
  cli_invalid_arguments: client(
    'validation',
    'The CLI was invoked with an unknown flag or a malformed flag value.'
  ),
  // recovery `none`: no credential EXISTS yet, so the auth-category default
  // ('auth_blocked' — "the credential was rejected") would tell the reader to
  // inspect a key they don't have. The message carries the actual next step.
  cli_api_key_missing: client(
    'auth',
    'The command needs an API key and none was found on this machine. Run `ablo login` (or set ABLO_API_KEY), then re-run the command.',
    'none'
  ),
  cli_database_url_missing: client(
    'validation',
    'The command needs a database connection string and none was found — no DATABASE_URL in the process environment, .env.local, or .env, and no --url flag.'
  ),
  cli_database_unreachable: client(
    'transport',
    'The database named by the connection string could not be reached from this machine. The host, port, network, or credential refused the dial before any statement ran.'
  ),
  commit_operation_required: wire(
    'validation',
    400,
    false,
    'A commit must carry `operation` or `operations`.'
  ),
  // Both commit transports — the WebSocket `commit` frame and the HTTP
  // `/v1/commits` endpoint — validate every operation and reject the whole batch
  // with this code. `param` names the offending index and field path, such as
  // `operations[3].readAt`.
  commit_operation_invalid: wire(
    'validation',
    400,
    false,
    'A commit operation failed validation against the wire commit-operation schema — wrong field type (e.g. a string `readAt`), unknown `type`, or missing `model`. The whole batch was rejected; the error names the offending operation index and field path.'
  ),
  commit_operation_model_required: wire(
    'validation',
    400,
    false,
    'A commit operation is missing its `model`.'
  ),
  commit_operations_ambiguous: wire(
    'validation',
    400,
    false,
    'A commit supplied both `operation` and `operations`. Send one or the other, not both.'
  ),
  commit_too_many_operations: wire(
    'validation',
    400,
    false,
    'A commit exceeded the per-commit operation limit; split it into smaller batches.'
  ),
  model_required_field_missing: wire(
    'validation',
    400,
    false,
    'The write is missing a field the model marks as required. Include the field and retry.'
  ),
  model_identifier_missing: wire(
    'validation',
    400,
    false,
    "The payload is missing the model's identifier, so the target row cannot be determined. Include the `id` field."
  ),
  snapshot_reserved_key: wire(
    'validation',
    400,
    false,
    'The snapshot uses a key name that is reserved by the runtime. Rename the key and retry.'
  ),
  mesh_message_invalid_input: wire(
    'validation',
    400,
    false,
    'The mesh message payload failed input validation and was not delivered.'
  ),
  mesh_message_from_id_spoof: wire(
    'validation',
    403,
    false,
    "The mesh message's `from` id does not match the authenticated sender, so it was rejected — participants may only send as themselves."
  ),
  mesh_message_from_kind_mismatch: wire(
    'validation',
    403,
    false,
    "The mesh message's `from` kind does not match the kind of the authenticated sender, so it was rejected."
  ),
  agent_perception_missing_context: wire(
    'validation',
    422,
    false,
    'The agent perception request is missing context it needs to run. Include the required context fields and retry.'
  ),
  // Mutator sidecar failures use the same public envelope as HTTP and
  // WebSocket transactions. Keeping them here prevents a second status table
  // from drifting away from the canonical error contract.
  invalid_input: wire(
    'validation',
    400,
    false,
    'The mutator input could not be parsed or failed input validation.'
  ),
  validation_failed: wire(
    'validation',
    400,
    false,
    'The mutator rejected the input because it violates a business rule.'
  ),
  invalid_mutator: wire(
    'not_found',
    404,
    false,
    'The requested mutator is not registered on this server.'
  ),
  permission_denied: wire(
    'permission',
    403,
    false,
    'The participant is not allowed to execute this mutator.'
  ),
  source_connector_requires_secret_key: wire(
    'permission',
    403,
    false,
    'A Data Source reverse channel must authenticate with the branch-bound secret (`sk_`) key created by `ablo dev`; browser, ephemeral, restricted, and management keys cannot serve a database.'
  ),
  source_connector_production_not_enabled: wire(
    'permission',
    403,
    false,
    'This production Data Source has not opted into reverse-channel transport. `ablo dev --local` is for child branches; use a direct production endpoint or explicitly enable the supported production reverse-channel route.'
  ),

  // ── not found (404) ────────────────────────────────────────────────
  entity_not_found: wire(
    'not_found',
    404,
    false,
    'No row exists with the requested id. It may have been deleted, or the id may belong to a different environment.'
  ),
  model_not_found: wire(
    'not_found',
    404,
    false,
    'No row of this model exists with the requested id. It may have been deleted, or the id may belong to a different environment.'
  ),
  mutate_update_entity_not_found: wire(
    'not_found',
    404,
    false,
    'The row targeted by this update does not exist — it may have been deleted since you read it. Re-read before retrying.'
  ),
  no_data_source_registered: wire(
    'not_found',
    404,
    false,
    'This branch is not connected to your database yet. Run `ablo connect` for a cloud-reachable direct Postgres endpoint, or `ablo dev --local` to register and serve a localhost Data Source, then retry.',
    undefined,
    true,
  ),
  source_connector_no_source_registered: wire(
    'not_found',
    404,
    false,
    'The branch has no endpoint Data Source for this connector to serve. Run `ablo dev --local` with the current CLI, which registers the connector-only source before opening the socket.'
  ),
  item_id_missing: wire(
    'server',
    502,
    true,
    'The item-create response arrived without an item id, so the result cannot be used. Retry the request.'
  ),

  // ── data integrity / database constraints ──────────────────────────
  // Emitted when a database integrity constraint rejects a write. None are
  // retryable: the same payload re-sent unchanged fails identically, so the
  // client must roll back rather than retry. The server maps the underlying SQL
  // constraint to one of these codes and places the raw constraint, column, and
  // table detail in `details` instead of exposing the driver's message text.
  not_null_violation: wire(
    'validation',
    400,
    false,
    'The database rejected the write because a required column was left empty — a not-null constraint. The error details name the column; supply a value and retry.'
  ),
  foreign_key_violation: wire(
    'conflict',
    409,
    false,
    'The database rejected the write on a foreign-key constraint: a referenced row does not exist, or the row being deleted is still referenced by others. The error details name the constraint.'
  ),
  entity_already_exists: wire(
    'conflict',
    409,
    false,
    'A row already exists with this id. CREATE is strict; use UPDATE for an existing row.'
  ),
  unique_violation: wire(
    'conflict',
    409,
    false,
    'The write duplicates a value that must be unique — another row already holds it. Choose a different value, or update the existing row.'
  ),
  check_violation: wire(
    'validation',
    400,
    false,
    'The database rejected a value that fails one of its check constraints. The error details name the constraint; adjust the value and retry.'
  ),
  constraint_violation: wire(
    'validation',
    400,
    false,
    'The database rejected the write on an integrity constraint. The error details identify the specific constraint.'
  ),
  column_type_mismatch: wire(
    'validation',
    400,
    false,
    'A structured (JSON) value was written to a column whose database type cannot hold it. Ablo adapts a json field to either a jsonb column (native) or a text column (serialized) — but a scalar column (integer, boolean, uuid, timestamp, …) cannot store a JSON object or array. Use a jsonb or text column for this field. Ablo adapts to your column; it does not alter your schema.'
  ),
  column_value_out_of_range: wire(
    'validation',
    400,
    false,
    'A stored value is outside the range the field was declared to hold. A number field reads back as a JavaScript number, which represents integers exactly only up to 9,007,199,254,740,991; a bigint column holding more than that would come back rounded. Declare the field as text to read those values digit for digit.'
  ),

  // ── tenant / unknown model (400) ───────────────────────────────────
  server_execute_unknown_model: wire(
    'tenant',
    400,
    false,
    'Wrote to a model the server does not know. The server keeps its own copy of the schema — run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` before writing to new or changed models.'
  ),
  mutate_create_unknown_model: wire(
    'tenant',
    400,
    false,
    'Created a model the server does not know. Run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` first — the server keeps its own copy of the schema.'
  ),
  tenant_model_columns_unknown: wire(
    'tenant',
    400,
    false,
    'The columns for this model could not be resolved in the tenant database, so the operation cannot be mapped onto its table.'
  ),
  tenant_model_missing_organization_id: wire(
    'tenant',
    400,
    false,
    "This model's table has no `organization_id` column, which Ablo requires to isolate rows by organization. Add the column before syncing this model."
  ),

  // ── schema migration / declaration (validation) ────────────────────
  schema_mutable_missing_meta: wire(
    'schema',
    400,
    false,
    'The schema is declared mutable but is missing its required `meta` block.'
  ),
  schema_scope_kind_invalid: wire(
    'schema',
    400,
    false,
    'A scope declaration in the schema uses a kind the engine does not recognize.'
  ),
  schema_field_not_camelcase: wire(
    'schema',
    400,
    false,
    'A schema field name is not camelCase. Rename the field (for example `dueDate`) — Ablo derives column names from camelCase field names.'
  ),
  schema_field_consecutive_caps: wire(
    'schema',
    400,
    false,
    'A schema field name contains consecutive capital letters, which cannot be mapped to a column name unambiguously. Write acronyms in lower case (`apiKey`, not `APIKey`).'
  ),
  schema_reserved_field: client(
    'schema',
    'A model declared `id`, the one universal field Ablo supplies. Remove it from the declared application fields.'
  ),
  schema_grants_shape_invalid: wire(
    'schema',
    400,
    false,
    'A `grants` declaration in the schema has an invalid shape and could not be parsed.'
  ),
  schema_grants_identifier_unsafe: wire(
    'schema',
    400,
    false,
    'A `grants` declaration references an identifier that is not safe to use in SQL. Use plain column and relation names.'
  ),
  schema_grants_relation_kind: wire(
    'schema',
    400,
    false,
    'A `grants` declaration references a relation of a kind it cannot traverse.'
  ),
  schema_grants_relation_missing: wire(
    'schema',
    400,
    false,
    'A `grants` declaration references a relation the model does not define. Check the relation name against the model.'
  ),
  schema_grants_target_not_scope_root: wire(
    'schema',
    400,
    false,
    'A `grants` declaration targets a model that is not a scope root, so access cannot be derived from it.'
  ),
  drop_field: client(
    'schema',
    'This migration would drop an existing field, destroying the data stored in it.'
  ),
  drop_model: client(
    'schema',
    'This migration would drop an entire model and its table, destroying the rows stored in it.'
  ),
  lossy_recreate: client(
    'schema',
    'This migration can only apply by recreating the table, which would not preserve its existing rows.'
  ),
  made_required: client(
    'schema',
    'This migration makes an existing optional field required, which rows without a value for it would violate.'
  ),
  required_field_added: client(
    'schema',
    'This migration adds a new required field that existing rows have no value for.'
  ),
  enum_value_removed: client(
    'schema',
    'This migration removes an enum value that existing rows may still hold.'
  ),
  risky_cast: client(
    'schema',
    'This migration changes a column to a type its current values may not convert to cleanly.'
  ),

  // ── claim / lease (409 / transport) ───────────────────────────────
  claim_lease_unavailable: wire(
    'claim',
    503,
    true,
    'The claim-lease coordination subsystem is temporarily unavailable, so the claim could not be processed. Retry shortly.'
  ),
  claim_not_wired: client(
    'claim',
    'Claims were used, but this runtime has no claim support wired in. The standard `Ablo({ schema, apiKey })` client wires it up automatically.'
  ),
  claim_queued: wire(
    'claim',
    409,
    true,
    'The claim was queued behind the current lease holder and will be granted in turn. Poll `claims.retrieve({ claimId })` for the grant — the id rides on the error — or read `claim.queue` to see the line.'
  ),
  claim_wait_aborted: wire(
    'claim',
    409,
    true,
    'The wait for this claim lease was aborted before the lease was granted.'
  ),
  grant_timeout: wire(
    'claim',
    504,
    true,
    'The wait for the claim grant timed out before your turn arrived (`waitTimeoutMs`). Claim again to rejoin the line, raise the cap, or re-read and proceed without the claim.'
  ),

  // ── bootstrap (transport) ──────────────────────────────────────────
  bootstrap_fetch_timeout: wire(
    'bootstrap',
    504,
    true,
    'The initial bootstrap fetch timed out before the server responded. Retry shortly.'
  ),
  // Deliberate cancellation, never a failure of the network. It is what the
  // client hands to `abort()` so the layer above can tell "we stopped this on
  // purpose" apart from "the transfer died" — the two are indistinguishable
  // from a bare abort, and retrying the first re-issues requests that were just
  // killed. Non-retryable by construction: whoever cancelled it either has a
  // newer request in flight or has already given up.
  bootstrap_cancelled: client(
    'bootstrap',
    'This bootstrap request was cancelled before it finished, because a newer one replaced it or the bootstrap it belonged to had already failed. It is not retried on its own.'
  ),
  bootstrap_offline: wire(
    'bootstrap',
    503,
    true,
    'Bootstrap could not run because the client is offline. It can proceed once the network returns.'
  ),
  bootstrap_offline_no_cache: wire(
    'bootstrap',
    503,
    false,
    'The client is offline and no cached snapshot is available to start from, so there is no data to load until the network returns.'
  ),
  bootstrap_response_invalid: wire(
    'bootstrap',
    502,
    true,
    'The bootstrap response could not be parsed. Retrying may succeed.'
  ),
  bootstrap_response_schema_invalid: wire(
    'bootstrap',
    502,
    true,
    'The bootstrap response parsed but failed schema validation, so it was not applied. Retrying may succeed.'
  ),

  // ── transport / connection ─────────────────────────────────────────
  exchange_malformed_response: wire(
    'transport',
    502,
    true,
    'The credential exchange returned a response that could not be parsed. Retrying may succeed.'
  ),
  exchange_network_error: wire(
    'transport',
    503,
    true,
    'A network error interrupted the credential exchange. Check connectivity and retry.'
  ),
  source_network_error: wire(
    'transport',
    503,
    true,
    'A network error occurred while talking to the data source. For localhost mode, keep `ablo dev --local` running and check its connector output; for a direct source, check database connectivity and retry.'
  ),
  source_request_failed: wire(
    'transport',
    502,
    true,
    'The signed Data Source returned a failure without a more specific code. Inspect the `ablo dev --local` process or deployed endpoint logs, then retry with the same idempotency key.'
  ),
  source_id_missing: wire(
    'auth',
    401,
    false,
    'The signed Data Source request did not include its webhook id. Check that the request reaches the handler without an intermediary removing Standard Webhooks headers.'
  ),
  source_api_key_missing: wire(
    'auth',
    401,
    false,
    'The Data Source handler has no signing key configured. Configure it with the signing key from the current Data Source registration.'
  ),
  source_timestamp_missing: wire(
    'auth',
    401,
    false,
    'The signed Data Source request did not include its webhook timestamp. Check that the request reaches the handler without an intermediary removing Standard Webhooks headers.'
  ),
  source_timestamp_invalid: wire(
    'auth',
    401,
    false,
    'The signed Data Source request carried an invalid webhook timestamp.'
  ),
  source_timestamp_expired: wire(
    'auth',
    401,
    false,
    'The signed Data Source request fell outside the allowed clock-skew window. Synchronize the endpoint host clock, then retry.'
  ),
  source_signature_missing: wire(
    'auth',
    401,
    false,
    'The signed Data Source request did not include its webhook signature. Check that the request reaches the handler without an intermediary removing Standard Webhooks headers.'
  ),
  source_signature_invalid: wire(
    'auth',
    401,
    false,
    'The Data Source rejected Ablo\'s signature. Configure the endpoint or localhost connector with the signing key from the current Data Source registration.'
  ),
  source_forbidden: wire(
    'permission',
    403,
    false,
    'The Data Source key is not allowed to perform this operation.'
  ),
  source_connector_not_attached: wire(
    'transport',
    503,
    true,
    'This branch uses localhost connector-only storage, but no connector is attached. Start or restart `ablo dev --local` and keep that process running.'
  ),
  source_connector_timeout: wire(
    'transport',
    504,
    true,
    'The local Data Source handler did not answer before the connector deadline. Check the local Postgres connection and handler logs; the same idempotent request may be retried.'
  ),
  source_connector_send_failed: wire(
    'transport',
    502,
    true,
    'The connector socket closed while Ablo was forwarding a signed Data Source request. Keep `ablo dev --local` running; Ablo retries after the connector reconnects.'
  ),
  source_connector_disconnected: wire(
    'transport',
    503,
    true,
    'The localhost Data Source connector disconnected with a request in flight. The connector reconnects automatically; retry after it reports ready.'
  ),
  source_connector_superseded: wire(
    'transport',
    503,
    true,
    'A newer localhost Data Source connector replaced this one. Stop duplicate `ablo dev --local` processes and use the newest process; in-flight requests are safe to retry.'
  ),
  source_connector_shutdown: wire(
    'transport',
    503,
    true,
    'The Ablo service shut down the connector while a request was in flight. The connector reconnects automatically after the service returns.'
  ),
  source_connector_protocol_error: wire(
    'transport',
    400,
    false,
    'The CLI and Ablo service disagreed on the Data Source connector frame protocol, or a malformed frame arrived. Upgrade the Ablo CLI and SDK together, then restart `ablo dev --local`.'
  ),
  source_unreachable: wire(
    'transport',
    503,
    true,
    'Ablo could not safely reach the registered direct data source before completing the write. The write remains pinned to direct; retry the same idempotency key after connectivity recovers.'
  ),
  data_source_blocked: wire(
    'transport',
    503,
    false,
    "This branch's database connection is not ready. Check its credentials and configuration; Ablo will not send reads or writes anywhere else."
  ),
  source_connector_handler_error: wire(
    'server',
    500,
    true,
    'The local signed Data Source handler threw while processing a request. Read the `ablo dev --local` error immediately above it, fix the database or adapter failure, and retry.'
  ),
  source_connector_internal_error: wire(
    'server',
    500,
    true,
    'Ablo could not establish the Data Source reverse channel because of an internal service failure. Retry; if it persists, report the request id.'
  ),
  identity_network_error: wire(
    'transport',
    503,
    true,
    'A network error occurred while resolving your identity. Check connectivity and retry.'
  ),
  commit_no_result: wire(
    'transport',
    504,
    true,
    'The commit was sent, but no result frame arrived, so its outcome is unknown. It is safe to retry.'
  ),
  commit_failed: wire(
    'transport',
    500,
    true,
    'The commit reached the server but failed to apply. Retrying may succeed.'
  ),
  replication_lag_timeout: wire(
    'transport',
    504,
    true,
    'The data source accepted the write, but its correlated authoritative source delta did not arrive before the confirmation deadline. The write may still materialize; retry with the same idempotency key or wait for source ingestion to recover.'
  ),
  commit_offline_grace_expired: wire(
    'transport',
    503,
    false,
    'The offline grace window expired before this commit could be sent, so it was not applied. Re-apply the change once the connection returns.'
  ),
  queue_too_deep: wire(
    'transport',
    503,
    true,
    'The line is already past its depth limit. For a claim, more participants were waiting than your `maxQueueDepth` allows — claim again without the cap to wait anyway, or work elsewhere and retry later. For a write, the transaction queue is draining — retry shortly.'
  ),
  flush_timeout: wire(
    'transport',
    504,
    true,
    'Flushing the transaction queue timed out before every pending write was sent. Retry once connectivity stabilizes.'
  ),
  wait_for_timeout: wire(
    'transport',
    504,
    true,
    'A wait-for condition timed out before it was satisfied. Retry, or extend the timeout.'
  ),
  instance_at_capacity: wire(
    'transport',
    503,
    true,
    'The server is at connection capacity. Retry shortly — transient and not specific to your credentials.'
  ),
  delivery_partition_mismatch: wire(
    'transport',
    503,
    true,
    'The connection reached a gateway that does not own its delivery partition. Retry through the cell router.'
  ),
  fetch_unavailable: client(
    'transport',
    'This environment provides no `fetch` implementation, so HTTP requests cannot be made. Run on a platform with `fetch` (Node 18+, modern browsers) or supply a polyfill.'
  ),
  api_unreachable: client(
    'transport',
    'The Ablo API could not be reached from this machine — the dial failed before any request arrived. Check the network, any proxy, and an ABLO_API_URL override, then retry.'
  ),
  response_unrecognized: client(
    'transport',
    'The server answered successfully, but with a body this client does not recognize. The client may be older than the server — update it and retry.'
  ),
  base_url_missing: client(
    'transport',
    'The client has no base URL configured, so it cannot address the server. Set the base URL when constructing the client.'
  ),
  sync_not_ready: client(
    'transport',
    'A sync operation ran before the client finished initializing. Wait for the client to be ready before syncing.'
  ),
  ws_not_ready: client(
    'transport',
    'A frame was sent before the WebSocket connection was established. Wait for the connection to open before sending.'
  ),

  // ── quota / rate limit (429) ──────────────────────────────────────
  quota_exceeded: wire(
    'rate_limit',
    429,
    true,
    'Your organization has used up its configured usage quota. Requests will succeed again once the quota resets or the limit is raised.'
  ),
  connection_limit_exceeded: wire(
    'rate_limit',
    429,
    true,
    'Too many concurrent WebSocket connections for this principal or organization. Close idle connections, or retry once others drain.'
  ),
  // A per-key request-rate limit — the fast, requests-per-second axis, as
  // opposed to `quota_exceeded`, which is the slower organization-wide usage
  // limit. It is keyed per API key, so one noisy key backs off without affecting
  // the rest of the organization. The `Retry-After` header carries the delay
  // before the next request is allowed.
  rate_limit_exceeded: wire(
    'rate_limit',
    429,
    true,
    'This API key is sending requests faster than its rate limit allows. Slow down and retry after the delay in the `Retry-After` header.'
  ),

  // ── server (5xx) ───────────────────────────────────────────────────
  session_check_failed: wire(
    'server',
    503,
    true,
    'Ablo could not verify the current login session. Retry shortly.'
  ),
  mint_failed: wire(
    'server',
    502,
    true,
    'Ablo could not mint the requested runtime credential. Retry shortly.'
  ),
  server_side_only: wire(
    'permission', 403, false, 'This endpoint is available only to trusted server-side callers.'
  ),
  unknown_auth_host: wire(
    'auth', 400, false, 'The authentication host is not recognized.'
  ),
  no_active_organization: wire(
    'tenant', 400, false, 'Select an active organization before continuing.'
  ),
  data_session_unsupported: wire(
    'validation', 400, false, 'This sign-in host cannot create the requested data session.'
  ),
  internal_error: wire(
    'server',
    500,
    true,
    "Something went wrong on Ablo's side — an unexpected server error. It is safe to retry."
  ),
  quota_lookup_failed: wire(
    'server',
    503,
    true,
    "The server could not load this organization's quota state, so the request was rejected rather than admitted unchecked. Retry shortly."
  ),
  // The rate-limiter backend was unreachable and this endpoint is configured to
  // fail closed, so the request was rejected rather than admitted unchecked. It
  // is retryable: the next attempt re-probes the backend.
  rate_limiter_unavailable: wire(
    'server',
    503,
    true,
    'The rate-limiter backend is unavailable and this endpoint is configured to fail closed; retry shortly.'
  ),

  // ── client-only invariants (never serialized) ──────────────────────
  invalid_options: client(
    'client',
    'The Ablo client was constructed with invalid or incomplete options.'
  ),
  no_ablo_provider: client('client', 'An Ablo hook was used outside of an Ablo provider.'),
  no_sync_group_provider: client('client', 'A sync-group hook was used outside of its provider.'),
  sync_context_missing_provider: client('client', 'Sync context was read outside of its provider.'),
  db_not_opened: client('client', 'The local database was accessed before it was opened.'),
  db_secure_hash_unavailable: client(
    'client',
    'Secure local persistence requires Web Crypto SHA-256 support.'
  ),
  db_identity_mismatch: client(
    'client',
    'The local database is connected to a different organization, project, or branch.'
  ),
  db_cleanup_failed: client(
    'client',
    'Authenticated local data could not be completely removed from this device.'
  ),
  db_store_not_found: client('client', 'The requested IndexedDB object store does not exist.'),
  db_unknown_action_type: client('client', 'An unknown database action type was dispatched.'),
  idb_unavailable: client('client', 'IndexedDB is unavailable in this environment.'),
  meta_db_not_initialized: client(
    'client',
    'The meta database was accessed before initialization.'
  ),
  sync_client_db_missing: client('client', 'The sync client has no database handle.'),
  lazy_ref_db_missing: client('client', 'A lazy reference was resolved without a database handle.'),
  lazy_ref_pool_missing: client('client', 'A lazy reference was resolved without a model pool.'),
  model_class_not_registered: client('client', 'The model class is not registered with the store.'),
  model_not_registered: client('client', 'The model is not registered with the store.'),
  model_not_in_schema: client(
    'client',
    'A model was accessed on a client whose schema projection leaves it out.'
  ),
  model_disposed: client('client', 'The model instance has been disposed.'),
  pool_model_class_not_registered: client(
    'client',
    'The model class is not registered with the pool.'
  ),
  pool_registry_missing: client('client', 'The model pool registry is not initialized.'),
  pool_subscribe_unregistered: client(
    'client',
    'Subscribed to a model that is not registered with the pool.'
  ),
  registry_invalid_constructor: client(
    'client',
    'A model was registered with an invalid constructor.'
  ),
  registry_not_initialized: client('client', 'The registry was used before initialization.'),
  registry_property_conflict: client(
    'client',
    'Two registered models declared a conflicting property.'
  ),
  registry_reference_unknown_target: client(
    'client',
    'A relation referenced an unknown target model.'
  ),
  registry_reference_unresolved: client('client', 'A relation reference could not be resolved.'),
  registry_unknown_model: client('client', 'The registry has no entry for the requested model.'),
  query_returns_unknown_model: client(
    'client',
    'A query returned a model the registry does not know.'
  ),
  store_create_schema_missing: client('client', 'Store.create was called without a schema.'),
  store_manager_unknown_model: client(
    'client',
    'The store manager has no entry for the requested model.'
  ),
  store_query_schema_missing: client('client', 'Store.query was called without a schema.'),
  store_query_unknown_model: client('client', 'Store.query named a model the store does not know.'),
  transaction_mutate_unknown_model: client(
    'client',
    'A transaction mutated a model the registry does not know.'
  ),
  transaction_read_unknown_model: client(
    'client',
    'A transaction read a model the registry does not know.'
  ),
  mutator_registry_duplicate: client(
    'client',
    'Two mutator definitions registered under the same name.'
  ),
  mutator_registry_unnamed_def: client(
    'client',
    'A mutator definition was registered without a name.'
  ),
  mutators_schema_missing: client('client', 'Mutators were registered without a schema.'),
  undo_scope_schema_missing: client('client', 'An undo scope was opened without a schema.'),
  undo_entry_invalid: client('client', 'An undo entry failed inverse-op schema validation.'),
  mock_mutation_failed: client('client', 'A mock mutation adapter was configured to fail.'),
  mock_unsupported_operation: client('client', 'A mock adapter received an unsupported operation.'),

  // ── HTTP route edge codes ──────────────────────────────────────────
  invalid_body: wire(
    'validation',
    400,
    false,
    'The request body was missing, unparseable, or the wrong shape.'
  ),
  invalid_json: wire('validation', 400, false, 'The request body was not valid JSON.'),
  capability_id_required: wire(
    'validation',
    400,
    false,
    'A capability id is required for this request.'
  ),
  organization_mismatch: wire(
    'permission',
    403,
    false,
    'The request targeted an organization the caller is not scoped to.'
  ),
  project_scope_denied: wire(
    'permission',
    403,
    false,
    "The request targeted a project the caller's key is not scoped to."
  ),
  branch_scope_denied: wire(
    'permission',
    403,
    false,
    "The request targeted a branch the caller's key is not scoped to."
  ),
  project_slug_taken: wire(
    'validation',
    409,
    false,
    'A project with this slug already exists in the organization. Choose a different slug.'
  ),
  forbidden: wire('permission', 403, false, 'The caller lacks permission for this operation.'),
  source_api_key_unresolved: wire(
    'auth',
    401,
    false,
    'The API key presented for this data source could not be resolved to a known key. Check the key and its environment.'
  ),
  capability_auth_disabled: wire(
    'server',
    503,
    false,
    'Capability authentication is disabled on this server.'
  ),
  capability_rotation_unavailable: wire(
    'server',
    500,
    false,
    'This capability could not be rotated, because the environment it belongs to could not be read from it. It is unchanged and still works. Create a replacement capability and retire this one.'
  ),
  provisioner_unavailable: wire(
    'server',
    503,
    false,
    'This deployment has no database provisioner configured, so tables cannot be created here.'
  ),
  invalid_model: wire(
    'validation',
    400,
    false,
    'The model name in the request is not a valid model identifier.'
  ),
  invalid_id: wire('validation', 400, false, 'The id in the request is not a valid identifier.'),
  unknown_model: wire(
    'tenant',
    400,
    false,
    'Named a model the server does not know. Run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` — the server keeps its own copy of the schema.'
  ),
  model_not_tenant_scoped: wire(
    'tenant',
    400,
    false,
    'This model is not tenant-scoped, so it cannot be queried through the tenant-scoped read path.'
  ),
  source_tenancy_not_enforced: wire(
    'tenant',
    400,
    false,
    "This model gets its tenant identity from the connected Data Source, but that connection is not ready for scoped reads yet. Ablo refused the read to prevent data from crossing tenant boundaries. Connect the branch and retry; for internally logged models, use `by: 'column'` or `by: 'parent'`."
  ),
  user_scope_not_enforced: wire(
    'tenant',
    400,
    false,
    "Rows in this model belong to one person rather than the whole organization, but the current read source does not carry the owner identity needed to enforce that boundary. Ablo returned nothing to prevent one member from seeing another member's private records. Use a read source that preserves owner identity, or a credential that acts for the organization."
  ),
  model_not_provisioned: wire(
    'tenant',
    409,
    false,
    "This model is in the branch's registered schema, but its table does not exist in the connected database yet. `ablo push` records the model but does not change a customer's database. Apply the table migration in your database, then retry the read."
  ),
  schema_table_invalid: wire('schema', 500, false, "The model's table identifier is invalid."),
  schema_scope_invalid: wire(
    'schema',
    500,
    false,
    "The model's scope predicate could not be built."
  ),
  entity_fetch_failed: wire(
    'server',
    500,
    true,
    'The server failed to fetch the requested entity. It is safe to retry.'
  ),
  events_required: wire(
    'validation',
    400,
    false,
    'The request must include a non-empty `events` array.'
  ),
  ingest_failed: wire(
    'validation',
    400,
    false,
    'The source-event batch was rejected during ingest and nothing was appended. Check the events against the expected shape and re-send.'
  ),
  migration_failed: wire(
    'server',
    500,
    false,
    'The schema migration failed while applying and did not complete.'
  ),
  schema_provisioning_forbidden: wire(
    'permission',
    403,
    false,
    'Schema registration could not create tables in the target database: the engine is not permitted to run DDL there.',
    undefined,
    true,
  ),
  model_query_failed: wire(
    'validation',
    400,
    false,
    'The model query failed to execute. Check the query filters and operators.'
  ),
  queries_required: wire(
    'validation',
    400,
    false,
    'The request must include a non-empty `queries` array.'
  ),
  query_unsupported_operator: wire(
    'validation',
    400,
    false,
    'The query used an unsupported operator.'
  ),
  query_invalid_like_pattern: wire(
    'validation',
    400,
    false,
    'The `LIKE` pattern must not end with an escape character.'
  ),
  query_invalid_boolean: wire(
    'validation',
    400,
    false,
    'The query compared a boolean column against an invalid boolean literal.'
  ),
  protocol_version_unsupported: wire(
    'transport',
    426,
    false,
    'The client sync-protocol version is outside the range this server supports — upgrade the SDK (or the server was rolled back mid-fleet).'
  ),
  database_unreachable: wire(
    'validation',
    400,
    false,
    "Ablo could not reach this database to check that it can stream replication. The connection string may be wrong, the host may not be reachable from Ablo's servers, or the credentials may not be accepted."
  ),
  database_not_replication_ready: wire(
    'validation',
    400,
    false,
    'This database is not set up for logical replication yet. Every failing item — wal_level, the publication, the replication grant, a replica identity — is listed in the error details with its exact fix. `ablo connect` prints the one-time setup; `ablo connect check` verifies it.'
  ),
  database_already_connected: wire(
    'conflict',
    409,
    false,
    'This database is already connected to another environment in your organization. Ablo streams a database from one environment at a time, so connecting it to a second one would leave the two reading the same change stream, and the newer connection would take the stream over from the older. Give this environment a database of its own — on a branching provider a branch of the same database is the usual answer, and it is what sandbox is for. If you meant to move the connection rather than add one, disconnect it from the environment that holds it with `ablo connect deregister` first.'
  ),
  replication_publication_drift: wire(
    'validation',
    400,
    false,
    'Your schema maps to tables that are not members of the replication publication, so their changes silently never stream and the source looks frozen. The missing tables and the exact `ALTER PUBLICATION … ADD TABLE …` to add them are in the error details — Ablo never alters your database for you.'
  ),
  query_unknown_relation: wire(
    'validation',
    400,
    false,
    'The query references a relation the model does not define. Check the relation name against the schema.'
  ),
  query_relation_target_unknown: wire(
    'schema',
    500,
    false,
    'A relation in the query targets a model the schema does not define.'
  ),
  query_invalid_identifier: wire(
    'validation',
    400,
    false,
    'The query contained an invalid identifier.'
  ),
  query_relation_expansion_too_large: wire(
    'validation',
    400,
    false,
    'A requested relation expansion exceeds the bounded nested-row budget. Query the related model as its own paginated collection instead.'
  ),
  organization_disabled: wire(
    'permission',
    403,
    false,
    'This organization has been disabled by an operator. Contact support before retrying.'
  ),
  org_id_required: wire(
    'validation',
    400,
    false,
    'An organization id is required for this request.'
  ),
  presence_identity_required: wire(
    'validation',
    400,
    false,
    'Presence requests must carry both `userId` and `organizationId`.'
  ),
  upload_fields_required: wire(
    'validation',
    400,
    false,
    'The upload request is missing a required field.'
  ),
  upload_items_required: wire(
    'validation',
    400,
    false,
    'The request must include a non-empty `items` array.'
  ),
  presigned_url_failed: wire(
    'server',
    500,
    true,
    'The server could not generate a presigned upload URL. It is safe to retry.'
  ),
  upload_not_configured: wire(
    'server',
    503,
    false,
    'Uploads are not configured on this deployment: the upload storage bucket and CDN domain are unset.'
  ),
  item_id_required: wire('validation', 400, false, 'An item id is required for this request.'),
  claim_id_required: wire('validation', 400, false, 'A claim id is required for this request.'),
  commit_operation_action_required: wire(
    'validation',
    400,
    false,
    'A commit operation is missing its `action`.'
  ),
  commit_operation_unsupported: wire(
    'validation',
    400,
    false,
    'A commit operation used an unsupported `action`.'
  ),
  usage_invalid: wire('validation', 400, false, 'The usage request was invalid.'),
  invalid_request: wire('validation', 400, false, 'The request parameters were invalid.'),
  capability_not_found: wire('not_found', 404, false, 'No capability exists with the given id.'),
  claim_not_found: wire(
    'not_found',
    404,
    false,
    'No claim of yours exists with the given id. It was released, expired, or belongs to a different branch.'
  ),
  invalid_participant_kind: wire(
    'validation',
    400,
    false,
    'The participant kind is not one the server recognizes.'
  ),
  invalid_sync_group: wire(
    'validation',
    400,
    false,
    'Sync groups must be `default` or `<namespace>:<id>`.'
  ),
  narrow_scope_required: wire(
    'validation',
    400,
    false,
    'This request requires a scope narrowed to specific resources; the presented scope is too broad.'
  ),
  wide_scope_forbidden: wire(
    'permission',
    403,
    false,
    'This caller may not use a wide scope. Request a scope narrowed to the resources you need.'
  ),
  capability_required: wire(
    'auth',
    401,
    false,
    'This operation requires a capability, and none was presented.'
  ),
  // A row in an ordered collection can be created at a position stated relative
  // to its neighbours ("before this one"), so the position has to be resolved
  // against the parent before the row lands. These are the two ways that request
  // can fail to describe a real place: no parent to resolve against, and a
  // neighbour that is not in it.
  position_missing_parent: wire(
    'validation',
    400,
    false,
    'This row gives a position but not the parent it belongs to, so the position cannot be resolved. Send the parent id alongside the position.'
  ),
  position_unknown_sibling: wire(
    'validation',
    400,
    false,
    'This row is positioned relative to another row that is not in the same parent. Check that the neighbouring row id is correct and still present.'
  ),
  schema_too_large: wire(
    'validation',
    413,
    false,
    'The submitted schema exceeds the maximum size.'
  ),
  request_too_large: wire('validation', 413, false, 'The request body exceeds the maximum size.'),
  invalid_schema: wire('validation', 400, false, 'The submitted schema could not be parsed.'),
  operational_warning: client(
    'server',
    'Ablo handled an operational degradation that remains searchable for diagnosis.'
  ),
  incompatible_change: wire(
    'conflict',
    409,
    false,
    'The schema change is incompatible with the schema currently deployed and cannot be applied as-is.'
  ),
  replication_reset_required: wire(
    'conflict',
    409,
    false,
    'This branch has live replicated rows for a mapped model that disappeared. Declare a rename or an explicit drop/reset before advancing the schema.'
  ),
} as const satisfies Record<string, ErrorCodeSpec>;

/**
 * The type of a valid error code: any key registered in {@link ERROR_CODES}.
 * The {@link AbloError} constructor accepts only this
 * type, so a typo or an unregistered code is a compile-time error. Only the
 * boundary that parses an incoming response casts an arbitrary string to this
 * type, which preserves forward compatibility with a newer server.
 */
export type ErrorCode = keyof typeof ERROR_CODES;

/** The subset of {@link ErrorCode} values that cross the network — the codes
 *  that make up the API contract, from which the HTTP and tool-calling
 *  boundaries map and the public documentation is generated. */
export type WireErrorCode = {
  [K in keyof typeof ERROR_CODES]: (typeof ERROR_CODES)[K]['surface'] extends 'wire' ? K : never;
}[keyof typeof ERROR_CODES];

/** Looks up the {@link ErrorCodeSpec} for a code. Returns `undefined` for a
 * newer code this client does not yet recognize. */
export function errorCodeSpec(code: string): ErrorCodeSpec | undefined {
  return (ERROR_CODES as Record<string, ErrorCodeSpec>)[code];
}

/** Reports whether a code is marked retryable. Unknown codes
 *  default to non-retryable, so an unrecognized failure is never retried
 *  automatically. */
export function isRetryableCode(code: string): boolean {
  return errorCodeSpec(code)?.retryable ?? false;
}

/**
 * Classifies a code into its {@link RecoveryClass} — the single value the
 * connection layer and the network probe branch on to decide how to recover.
 *
 * The registry is the source of truth. An explicit `recovery` on the code's spec
 * wins; it is set only on the few authentication codes whose remedy the HTTP
 * status cannot reveal. Every other code is derived from its spec:
 *   - retryable                 → `transient`
 *   - HTTP 403                  → `permission`
 *   - remaining `auth` category → `auth_blocked` (the credential-type 401s)
 *   - anything else, or unknown → `none`
 *
 * An unknown code or a code this client predates
 * (no spec) defaults to `none`, the same safe default as {@link isRetryableCode}:
 * an unrecognized code is never treated as a credential expiry or a sign-out.
 */
export function classifyRecovery(code: string): RecoveryClass {
  const spec = errorCodeSpec(code);
  if (!spec) return 'none';
  if (spec.recovery) return spec.recovery;
  if (spec.retryable) return 'transient';
  if (spec.httpStatus === 403) return 'permission';
  if (spec.category === 'auth') return 'auth_blocked';
  return 'none';
}

/**
 * A compile-time exhaustiveness guard: it forces every {@link RecoveryClass} to
 * be listed here, so adding a class to {@link RECOVERY_CLASSES} without deciding
 * its meaning is a type error rather than a silent gap.
 */
const _RECOVERY_CLASS_EXHAUSTIVE = {
  access_credential_expiry: true,
  session_expiry: true,
  auth_blocked: true,
  permission: true,
  transient: true,
  none: true,
} as const satisfies Record<RecoveryClass, true>;
void _RECOVERY_CLASS_EXHAUSTIVE;
