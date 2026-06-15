/**
 * The canonical Ablo error-code registry — the **`code` tier** of the
 * Stripe-style two-tier error model.
 *
 * ### The two tiers (mirrors Stripe)
 *
 *   - **`type`** — coarse category, 1:1 with an {@link AbloError} subclass
 *     (`AbloPermissionError`, `AbloValidationError`, …). "Catch by
 *     `instanceof`" ≡ "switch on `e.type`". This tier lives in `errors.ts`.
 *   - **`code`** — the fine-grained, machine-readable identifier in this
 *     file. `snake_case`, ordered noun→state (`entity_claimed`) or
 *     condition→constraint (`queue_too_deep`). This is what callers
 *     `switch` on for specific handling, and what `doc_url` is derived from.
 *
 * Because sync-engine ↔ sync-server ↔ MCP all speak this code vocabulary,
 * the registry **is** the wire contract. Two consequences:
 *
 *   1. `ErrorCode` is a *closed* union (plus the `policy:${string}`
 *      dynamic family). Producing an unregistered code is a compile error
 *      — that's the whole point. {@link AbloError}'s constructor param is
 *      narrowed to `ErrorCode`; only the wire-parse boundary
 *      (`translateHttpError`, frame deserialization) casts an incoming
 *      string to `ErrorCode`, so an *older* SDK still tolerates a *newer*
 *      server's code (forward compat) while internal producers stay checked.
 *   2. The `surface: 'wire'` subset is what an HTTP/MCP boundary maps from
 *      and what the public error docs are generated from. `surface:
 *      'client'` codes are local SDK invariants (you forgot to open the DB,
 *      a model isn't registered) — never sent over the network, so they
 *      carry no `httpStatus`, exactly as Stripe omits client-side
 *      programmer errors from its published code list.
 */

import { z } from 'zod';

/**
 * Version of the error contract — the envelope shape + the set of codes and
 * their semantics. Date-based, like Stripe's API versions. Bump it (and only
 * it) when the contract changes in a way consumers can observe: a new/removed
 * code, a changed HTTP status, an envelope field. Emitted in `errors.json`
 * and on the `Ablo-Version` response header so a consumer can detect drift.
 */
export const ERROR_CONTRACT_VERSION = '2026-06-13';

/** Coarse grouping for metrics dashboards and docs sectioning. */
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
  | 'claim'
  | 'bootstrap'
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'client';

/**
 * The closed taxonomy of *how a failure recovers* — one rung above the raw
 * `code`. Where `code` says **what** went wrong, `RecoveryClass` says **what
 * the client should do about it**, which is exactly the discriminant the sync
 * FSM and the network probe need. It collapses what used to be three scattered
 * booleans (`retryable`, `authBlocked`, `sessionValid`) into one exhaustive,
 * Zod-validated enum so the connection layer branches on a single value with
 * compile-time completeness instead of ad-hoc `if (!isRetryableCode(...))`
 * chains.
 *
 *   - `access_credential_expiry` — the Stripe-style ephemeral key (`ek_`/`rk_`)
 *     the sync-engine presents as its Bearer has expired. The long-lived login
 *     is fine; the remedy is to silently RE-MINT a fresh key from the session
 *     and retry the same request. This MUST NOT sign the user out (the whole
 *     point of the wake-from-sleep fix: a 15-min `ek_` dying after a laptop nap
 *     is routine, not a logout).
 *   - `session_expiry` — the LONG-LIVED login itself is gone. Terminal:
 *     sign out and route to re-authentication.
 *   - `auth_blocked` — reachable, but the credential TYPE/config was rejected
 *     (wrong key kind, untrusted issuer, no org). Re-auth re-mints the same
 *     rejected credential and loops, so STOP — don't reconnect, don't sign out.
 *   - `permission` — a 403 authorization denial (scope/role/membership).
 *   - `transient` — retry the same request unchanged (5xx, lease contention…).
 *   - `none` — not a recoverable-auth condition (validation, not-found, local
 *     invariants, and any forward-compat code an older SDK doesn't know).
 */
export const RECOVERY_CLASSES = [
  'access_credential_expiry',
  'session_expiry',
  'auth_blocked',
  'permission',
  'transient',
  'none',
] as const;

/** Zod enum derived from {@link RECOVERY_CLASSES} — the runtime-validatable
 *  form of the recovery taxonomy. */
export const recoveryClassSchema = z.enum(RECOVERY_CLASSES);

/** How a failure recovers. See {@link RECOVERY_CLASSES}. */
export type RecoveryClass = z.infer<typeof recoveryClassSchema>;

/** One registry entry. `httpStatus` is present only for `surface: 'wire'`
 *  codes — status is a property of the wire boundary, never of a
 *  purely-local client invariant. */
export interface ErrorCodeSpec {
  readonly category: ErrorCategory;
  /** `'wire'` = crosses the network and is part of the API/MCP contract;
   *  `'client'` = local SDK invariant, never serialized. */
  readonly surface: 'wire' | 'client';
  /** Canonical HTTP status for the wire boundary. Omitted for client codes. */
  readonly httpStatus?: number;
  /** Whether the same request can succeed on a later retry without the
   *  caller changing anything. `false` for permission / validation /
   *  not-found; `true` for transient transport / lease contention. */
  readonly retryable: boolean;
  /** One-line human description — the source text for the `doc_url` page. */
  readonly message: string;
  /**
   * Explicit recovery class. Set ONLY where it diverges from what `category` /
   * `httpStatus` / `retryable` already imply — i.e. the handful of auth codes
   * whose remedy (`session_expiry` vs `access_credential_expiry`) the bare
   * status can't distinguish. Everything else is derived by
   * {@link classifyRecovery}, so adding a normal code needs no `recovery`.
   */
  readonly recovery?: RecoveryClass;
}

const wire = (
  category: ErrorCategory,
  httpStatus: number,
  retryable: boolean,
  message: string,
  recovery?: RecoveryClass,
): ErrorCodeSpec => ({ category, surface: 'wire', httpStatus, retryable, message, recovery });

const client = (
  category: ErrorCategory,
  message: string,
): ErrorCodeSpec => ({ category, surface: 'client', retryable: false, message });

/**
 * The closed set of stable error codes. Add a code here BEFORE throwing it
 * — the narrowed {@link AbloError} constructor param enforces this.
 */
export const ERROR_CODES = {
  // ── auth (401) ─────────────────────────────────────────────────────
  apikey_invalid: wire('auth', 401, false, 'API key is unknown or malformed.'),
  apikey_revoked: wire('auth', 401, false, 'API key has been revoked.'),
  // THE sync-engine access credential — the Stripe-style ephemeral key
  // (`ek_` for users, `rk_` for agents) minted server-side from the login and
  // presented as a Bearer. Its expiry is routine and re-mintable: get a fresh
  // key from the still-valid session and retry — NEVER a sign-out. (An agent's
  // expired `rk_` must not log a human out either.) This is the ONLY code on
  // the silent re-mint path; see RecoveryClass `access_credential_expiry`.
  apikey_expired: wire('auth', 401, false, 'API key has expired.', 'access_credential_expiry'),
  apikey_missing: wire('auth', 401, false, 'No API key was supplied on the request.'),
  api_key_required: wire('auth', 401, false, 'This operation requires an API key.'),
  capability_id_missing: wire('auth', 401, false, 'A capability id was expected but not provided.'),
  exchange_failed: wire('auth', 401, false, 'The API-key credential exchange was rejected.'),
  identity_resolve_failed: wire('auth', 401, false, 'Identity resolution was rejected.'),
  auth_no_credentials: wire('auth', 401, false, 'No recognized authentication credential was presented — no API key and no bearer JWT. Send `Authorization: Bearer <token>`.'),
  identity_missing_organization: wire('auth', 401, false, 'Authentication succeeded but resolved to no organization context.'),
  // The long-lived login is gone — terminal, drives sign-out + re-auth.
  session_expired: wire('auth', 401, false, 'The session is invalid or expired; re-authenticate.', 'session_expiry'),
  // `jwt_invalid` is the residual fallback; the codes below split out the
  // specific failure modes so an integrating customer can tell "I registered
  // the wrong JWKS" from "my token has no org claim" from "wrong audience"
  // rather than getting one opaque code for all of them.
  jwt_invalid: wire('auth', 401, false, 'The bearer JWT could not be validated (unclassified).'),
  jwt_malformed: wire('auth', 401, false, 'The bearer JWT is not a well-formed JWT and could not be decoded.'),
  jwt_missing_issuer: wire('auth', 401, false, 'The bearer JWT has no `iss` (issuer) claim, so it cannot be routed to a trusted issuer.'),
  jwt_issuer_untrusted: wire('auth', 401, false, "The bearer JWT's `iss` is not a registered trusted issuer. Register it via POST /v1/trusted-issuers, or check the token's issuer claim."),
  jwt_signature_invalid: wire('auth', 401, false, "The bearer JWT's signature could not be verified against the issuer's JWKS (wrong key, rotated key, or forged token)."),
  jwt_audience_mismatch: wire('auth', 401, false, "The bearer JWT's `aud` (audience) claim does not match the audience this issuer is registered with."),
  jwt_missing_subject: wire('auth', 401, false, 'The bearer JWT has no `sub` (subject) claim to identify the user.'),
  jwt_missing_organization: wire('auth', 401, false, 'The bearer JWT carries no organization context — neither a fixed org for the issuer nor the configured organization claim.'),
  // Trusted-issuer / BYO-IdP path only — Ablo's own sync-engine no longer
  // authenticates with JWTs (it uses the Stripe-style ephemeral key, below).
  // When a customer DOES present an external-IdP JWT, its expiry means
  // re-authenticate against that IdP, so it classifies as a session expiry
  // (which also keeps `isSessionErrorResponse` behaviour unchanged).
  jwt_expired: wire('auth', 401, false, 'The bearer JWT has expired; obtain a fresh token.', 'session_expiry'),
  jwt_org_membership_denied: wire('auth', 403, false, "The bearer JWT's subject is not an active member of the organization in its `org_id` claim (removed, suspended, or the claim does not match a membership)."),
  file_upload_auth_required: wire('auth', 401, false, 'File upload requires an authenticated session.'),
  browser_apikey_blocked: client('auth', 'Raw API keys must not be used from a browser context.'),
  browser_database_url_blocked: client('auth', 'A database connection string must not be used from a browser context — it carries DB credentials.'),
  datasource_registration_failed: client('auth', 'Failed to register the provided databaseUrl as a datasource.'),
  datasource_connection_unsupported: wire('validation', 400, false, 'This deployment cannot register a direct (connection string) datasource — use the signed endpoint kind.'),

  // ── permission / capability (403) ──────────────────────────────────
  capability_scope_denied: wire('capability', 403, false, "The connection's resolved scope does not cover the attempted action."),
  issuer_register_forbidden: wire('permission', 403, false, 'Registering a trusted issuer requires a secret (sk_) API key.'),
  capability_invalid: wire('capability', 403, false, 'The capability is unknown, revoked, or expired.'),
  test_database_not_registered: wire('permission', 403, false, 'Test mode requires a registered dev database for this org — run `npx ablo init`, or construct the client with `databaseUrl` using your test key.'),
  tenant_routing_failed: wire('server', 500, true, "The org's registered database could not be resolved or dialed. Ablo never falls back to shared storage for a dedicated tenant — retry, and check the datasource status if it persists."),
  database_role_cannot_enforce_rls: wire('permission', 403, false, 'The connected database role cannot enforce row-level security (superuser or BYPASSRLS).'),
  database_role_unreadable: wire('permission', 403, false, 'The connected database role could not be introspected.'),
  database_tables_unforced_rls: wire('permission', 403, false, 'Synced tables in the connected database do not have FORCE ROW LEVEL SECURITY applied.'),
  database_host_not_allowed: wire('permission', 403, false, 'The connected database host resolves to a private, loopback, or link-local address and cannot be used.'),
  // Deprecated spellings of the `database_*` codes above — still emitted by
  // older servers; kept so they classify identically. Do not use in new code.
  byo_role_cannot_enforce_rls: wire('permission', 403, false, 'The direct Postgres connector role cannot enforce row-level security.'),
  byo_role_unreadable: wire('permission', 403, false, 'The direct Postgres connector role could not be introspected.'),
  byo_tenant_tables_unforced_rls: wire('permission', 403, false, 'Tenant tables do not have RLS forced under the direct Postgres connector role.'),
  byo_host_not_allowed: wire('permission', 403, false, 'The direct Postgres connector host resolves to a private, loopback, or link-local address and cannot be used.'),

  // ── claim / claim conflict (409) ──────────────────────────────────
  // Held-claim rejections are NOT queue-retryable (gRPC FAILED_PRECONDITION /
  // ABORTED semantics; Replicache/Zero SETTLE a rejected mutation — reject the
  // caller, roll back the optimistic effect — instead of resending it).
  // Blindly re-sending the same payload cannot succeed while the lease is
  // held, and a lease can outlive any sane retry budget. The correct recovery
  // lives at the CALLER: take a claim (`ablo.<model>.claim` queues fairly
  // behind the holder) or re-read and rebase. `retryable: true` here turned
  // every cross-client claim conflict into an infinite client resend loop
  // (~150ms storm — found by the claims journey, 2026-06-10).
  claim_conflict: wire('claim', 409, false, 'The target entity is claimed by another participant.'),
  claim_lost: wire('claim', 409, false, 'A previously held claim was lost before the write applied.'),
  entity_claimed: wire('claim', 409, false, 'The target entity is currently claimed; write was blocked.'),
  malformed_claim: wire('claim', 400, false, 'The claim payload was malformed.'),
  malformed_subscription: wire('validation', 400, false, 'The update_subscription payload was malformed; expected { syncGroups: string[] }.'),
  model_claimed: wire('claim', 409, false, 'The model instance is claimed by another participant.'),
  model_claimed_timeout: wire('claim', 409, false, 'Timed out waiting for a model claim to clear.'),
  model_claim_not_configured: client('claim', 'Claiming was requested on a model that has no claim configuration.'),

  // ── stale context / idempotency (409) ──────────────────────────────
  stale_context: wire('conflict', 409, true, 'The write carried a readAt watermark that is now stale; re-read and retry.'),
  idempotency_conflict: wire('conflict', 409, false, 'The same Idempotency-Key was reused with a different request body.'),
  idempotency_key_too_long: wire('validation', 400, false, 'The supplied Idempotency-Key exceeds the maximum length.'),

  // ── validation (400 / 422) ─────────────────────────────────────────
  write_options_invalid: client('validation', 'The write options (`idempotencyKey` / `label` / `wait` / `readAt` / `onStale` / `claim`) failed validation against the write-options schema.'),
  source_operation_id_required: client('validation', 'A data-source operation arrived without the entity `id` it targets.'),
  source_adapter_misconfigured: client('validation', 'The data-source ORM adapter could not map a schema model onto the backing client (missing delegate or model).'),
  source_event_invalid: client('validation', 'A data-source outbox event could not be built — the operation carries no entity id and none was supplied.'),
  duration_invalid: client('validation', 'A duration value was not a number of seconds or a "500ms" | "30s" | "3m" | "24h" string.'),
  schema_definition_invalid: client('validation', 'A schema definition value was invalid (bad column identifier, non-finite backfill, or unsupported schema-JSON version).'),
  cli_invalid_arguments: client('validation', 'The CLI was invoked with an unknown flag or a malformed flag value.'),
  turn_validation_failed: wire('validation', 422, false, 'The agent turn failed server-side validation.'),
  commit_operation_required: wire('validation', 400, false, 'A commit must carry `operation` or `operations`.'),
  commit_operation_model_required: wire('validation', 400, false, 'A commit operation is missing its `model`.'),
  commit_operations_ambiguous: wire('validation', 400, false, 'A commit supplied both `operation` and `operations`.'),
  commit_too_many_operations: wire('validation', 400, false, 'A commit exceeded the per-commit operation limit; split it into smaller batches.'),
  model_required_field_missing: wire('validation', 400, false, 'A required field was absent from the model payload.'),
  model_identifier_missing: wire('validation', 400, false, 'The model payload is missing its identifier.'),
  snapshot_reserved_key: wire('validation', 400, false, 'A snapshot used a reserved key name.'),
  mesh_message_invalid_input: wire('validation', 400, false, 'The mesh message failed input validation.'),
  mesh_message_from_id_spoof: wire('validation', 403, false, 'The mesh message `from` id does not match the authenticated sender.'),
  mesh_message_from_kind_mismatch: wire('validation', 403, false, 'The mesh message `from` kind does not match the sender.'),
  agent_perception_missing_context: wire('validation', 422, false, 'The agent perception request lacked required context.'),

  // ── not found (404) ────────────────────────────────────────────────
  entity_not_found: wire('not_found', 404, false, 'The referenced entity does not exist.'),
  model_not_found: wire('not_found', 404, false, 'The referenced model row does not exist.'),
  mutate_update_entity_not_found: wire('not_found', 404, false, 'The entity targeted by an update does not exist.'),
  task_id_missing: wire('server', 502, true, 'The task-create response did not include an id.'),

  // ── data integrity / DB constraints ────────────────────────────────
  // Emitted when a write is rejected by a database integrity constraint
  // (Postgres class-23). All NON-retryable: the same payload re-sent
  // unchanged will fail identically, so the client must roll back, not
  // retry. The server normalizer maps SQLSTATE → these codes and tucks the
  // raw constraint/column/table detail into `details` rather than leaking
  // the driver's message text onto the wire.
  not_null_violation: wire('validation', 400, false, 'A required field was missing (database not-null constraint).'),
  foreign_key_violation: wire('conflict', 409, false, 'A referenced entity does not exist, or is still referenced (database foreign-key constraint).'),
  unique_violation: wire('conflict', 409, false, 'A value violates a uniqueness constraint.'),
  check_violation: wire('validation', 400, false, 'A value violates a database check constraint.'),
  constraint_violation: wire('validation', 400, false, 'A database integrity constraint was violated.'),

  // ── tenant / unknown model (400) ───────────────────────────────────
  server_execute_unknown_model: wire('tenant', 400, false, 'Wrote to a model the server does not know. The server keeps its own copy of the schema — run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` before writing to new or changed models.'),
  mutate_create_unknown_model: wire('tenant', 400, false, 'Created a model the server does not know. Run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` first — the server keeps its own copy of the schema.'),
  tenant_model_columns_unknown: wire('tenant', 400, false, "The tenant model's columns could not be resolved."),
  tenant_model_missing_organization_id: wire('tenant', 400, false, 'The tenant model is missing the organization_id column required for isolation.'),

  // ── schema migration / declaration (validation) ────────────────────
  schema_mutable_missing_meta: wire('schema', 400, false, 'A mutable schema is missing its required meta block.'),
  schema_scope_kind_invalid: wire('schema', 400, false, 'A scope kind in the schema is invalid.'),
  schema_field_not_camelcase: wire('schema', 400, false, 'A schema field name is not camelCase.'),
  schema_field_consecutive_caps: wire('schema', 400, false, 'A schema field name has consecutive capital letters.'),
  schema_grants_shape_invalid: wire('schema', 400, false, 'A grants declaration has an invalid shape.'),
  schema_grants_identifier_unsafe: wire('schema', 400, false, 'A grants declaration referenced an unsafe identifier.'),
  schema_grants_relation_kind: wire('schema', 400, false, 'A grants relation referenced an invalid kind.'),
  schema_grants_relation_missing: wire('schema', 400, false, 'A grants declaration referenced a missing relation.'),
  schema_grants_target_not_scope_root: wire('schema', 400, false, 'A grants target is not a scope root.'),
  drop_field: client('schema', 'Migration would drop a field (destructive classification).'),
  drop_model: client('schema', 'Migration would drop a model (destructive classification).'),
  lossy_recreate: client('schema', 'Migration would require a lossy table recreate.'),
  made_required: client('schema', 'Migration would make an existing field required.'),
  required_field_added: client('schema', 'Migration adds a new required field.'),
  enum_value_removed: client('schema', 'Migration removes an enum value (destructive classification).'),
  risky_cast: client('schema', 'Migration would perform a risky column type cast.'),

  // ── claim / lease (409 / transport) ───────────────────────────────
  claim_lease_unavailable: wire('claim', 503, true, 'The claim-lease coordination subsystem is unavailable; retry.'),
  claim_not_wired: client('claim', 'Claim support was used but is not wired in this runtime.'),
  claim_queued: wire('claim', 409, true, 'The claim was queued behind an active lease holder.'),
  claim_wait_aborted: wire('claim', 409, true, 'Waiting for the claim lease was aborted.'),
  claim_wait_poll_interval_required: client('claim', 'A poll interval is required when waiting on an claim.'),
  grant_timeout: wire('claim', 504, true, 'Timed out waiting for a capability grant.'),
  slide_intent_missing_deck_id: wire('claim', 400, false, 'A slide claim was missing its deck id.'),
  slide_intent_unknown_sibling: wire('claim', 400, false, 'A slide claim referenced an unknown sibling slide.'),

  // ── bootstrap (transport) ──────────────────────────────────────────
  bootstrap_fetch_timeout: wire('bootstrap', 504, true, 'The bootstrap fetch timed out.'),
  bootstrap_offline: wire('bootstrap', 503, true, 'Bootstrap could not run because the client is offline.'),
  bootstrap_offline_no_cache: wire('bootstrap', 503, false, 'Bootstrap is offline and no cached snapshot is available.'),
  bootstrap_response_invalid: wire('bootstrap', 502, true, 'The bootstrap response was malformed.'),
  bootstrap_response_schema_invalid: wire('bootstrap', 502, true, 'The bootstrap response failed schema validation.'),

  // ── transport / connection ─────────────────────────────────────────
  exchange_malformed_response: wire('transport', 502, true, 'The credential exchange returned a malformed response.'),
  exchange_network_error: wire('transport', 503, true, 'A network error occurred during credential exchange.'),
  source_network_error: wire('transport', 503, true, 'A network error occurred talking to the source.'),
  identity_network_error: wire('transport', 503, true, 'A network error occurred resolving identity.'),
  commit_no_result: wire('transport', 504, true, 'The commit was sent but no result frame arrived.'),
  commit_failed: wire('transport', 500, true, 'The commit failed to apply.'),
  commit_offline_grace_expired: wire('transport', 503, false, "The offline grace window expired before the commit could be sent."),
  queue_too_deep: wire('transport', 503, true, 'The transaction queue exceeded its depth limit.'),
  flush_timeout: wire('transport', 504, true, 'Timed out flushing the transaction queue.'),
  wait_for_timeout: wire('transport', 504, true, 'A wait-for condition timed out.'),
  instance_at_capacity: wire('transport', 503, true, 'The server is at connection capacity. Retry shortly — transient and not specific to your credentials.'),
  fetch_unavailable: client('transport', 'No fetch implementation is available in this environment.'),
  base_url_missing: client('transport', 'No base URL was configured for the client.'),
  sync_not_ready: client('transport', 'A sync operation was attempted before the client was ready.'),
  ws_not_ready: client('transport', 'A frame was sent before the WebSocket was connected.'),

  // ── quota / rate limit (429) ──────────────────────────────────────
  quota_exceeded: wire('rate_limit', 429, true, 'The organization exceeded its configured usage quota.'),
  connection_limit_exceeded: wire('rate_limit', 429, true, 'Too many concurrent WebSocket connections for this principal or organization. Close idle connections, or retry once others drain.'),

  // ── server (5xx) ───────────────────────────────────────────────────
  internal_error: wire('server', 500, true, 'An unexpected server error occurred.'),
  quota_lookup_failed: wire('server', 503, true, 'The quota decision could not be loaded.'),
  turn_open_failed: wire('server', 500, true, 'The agent turn failed to open.'),
  turn_close_failed: wire('server', 500, true, 'The agent turn failed to close cleanly.'),

  // ── client-only invariants (never serialized) ──────────────────────
  invalid_options: client('client', 'The Ablo client was constructed with invalid or incomplete options.'),
  no_ablo_provider: client('client', 'An Ablo hook was used outside of an Ablo provider.'),
  no_sync_group_provider: client('client', 'A sync-group hook was used outside of its provider.'),
  sync_context_missing_provider: client('client', 'Sync context was read outside of its provider.'),
  db_not_opened: client('client', 'The local database was accessed before it was opened.'),
  db_store_not_found: client('client', 'The requested IndexedDB object store does not exist.'),
  db_unknown_action_type: client('client', 'An unknown database action type was dispatched.'),
  idb_unavailable: client('client', 'IndexedDB is unavailable in this environment.'),
  meta_db_not_initialized: client('client', 'The meta database was accessed before initialization.'),
  sync_client_db_missing: client('client', 'The sync client has no database handle.'),
  lazy_ref_db_missing: client('client', 'A lazy reference was resolved without a database handle.'),
  lazy_ref_pool_missing: client('client', 'A lazy reference was resolved without a model pool.'),
  model_class_not_registered: client('client', 'The model class is not registered with the store.'),
  model_not_registered: client('client', 'The model is not registered with the store.'),
  model_disposed: client('client', 'The model instance has been disposed.'),
  pool_model_class_not_registered: client('client', 'The model class is not registered with the pool.'),
  pool_registry_missing: client('client', 'The model pool registry is not initialized.'),
  pool_subscribe_unregistered: client('client', 'Subscribed to a model that is not registered with the pool.'),
  registry_invalid_constructor: client('client', 'A model was registered with an invalid constructor.'),
  registry_not_initialized: client('client', 'The registry was used before initialization.'),
  registry_property_conflict: client('client', 'Two registered models declared a conflicting property.'),
  registry_reference_unknown_target: client('client', 'A relation referenced an unknown target model.'),
  registry_reference_unresolved: client('client', 'A relation reference could not be resolved.'),
  registry_unknown_model: client('client', 'The registry has no entry for the requested model.'),
  query_returns_unknown_model: client('client', 'A query returned a model the registry does not know.'),
  store_create_schema_missing: client('client', 'Store.create was called without a schema.'),
  store_manager_unknown_model: client('client', 'The store manager has no entry for the requested model.'),
  store_query_schema_missing: client('client', 'Store.query was called without a schema.'),
  store_query_unknown_model: client('client', 'Store.query named a model the store does not know.'),
  transaction_mutate_unknown_model: client('client', 'A transaction mutated a model the registry does not know.'),
  transaction_read_unknown_model: client('client', 'A transaction read a model the registry does not know.'),
  mutator_registry_duplicate: client('client', 'Two mutator definitions registered under the same name.'),
  mutator_registry_unnamed_def: client('client', 'A mutator definition was registered without a name.'),
  mutators_schema_missing: client('client', 'Mutators were registered without a schema.'),
  undo_scope_schema_missing: client('client', 'An undo scope was opened without a schema.'),
  undo_entry_invalid: client('client', 'An undo entry failed inverse-op schema validation.'),
  mock_mutation_failed: client('client', 'A mock mutation adapter was configured to fail.'),
  mock_unsupported_operation: client('client', 'A mock adapter received an unsupported operation.'),

  // ── HTTP route edge codes (egress through app.onError) ─────────────
  invalid_body: wire('validation', 400, false, 'The request body was missing, unparseable, or the wrong shape.'),
  invalid_json: wire('validation', 400, false, 'The request body was not valid JSON.'),
  capability_id_required: wire('validation', 400, false, 'A capability id is required for this request.'),
  organization_mismatch: wire('permission', 403, false, 'The request targeted an organization the caller is not scoped to.'),
  project_scope_denied: wire('permission', 403, false, "The request targeted a project the caller's key is not scoped to."),
  project_slug_taken: wire('validation', 409, false, 'A project with this slug already exists in the organization.'),
  forbidden: wire('permission', 403, false, 'The caller lacks permission for this operation.'),
  source_api_key_unresolved: wire('auth', 401, false, 'The source API key could not be resolved.'),
  capability_auth_disabled: wire('server', 503, false, 'Capability authentication is disabled on this server.'),
  provisioner_unavailable: wire('server', 503, false, 'No database provisioner is configured.'),
  invalid_model: wire('validation', 400, false, 'The request named an invalid model.'),
  invalid_id: wire('validation', 400, false, 'The request carried an invalid id.'),
  unknown_model: wire('tenant', 400, false, 'Named a model the server does not know. Run `ablo push` (or keep `ablo dev` running) to upload `ablo/schema.ts` — the server keeps its own copy of the schema.'),
  model_not_tenant_scoped: wire('tenant', 400, false, 'The model is not tenant-scoped and cannot be queried this way.'),
  schema_table_invalid: wire('schema', 500, false, "The model's table identifier is invalid."),
  schema_scope_invalid: wire('schema', 500, false, "The model's scope predicate could not be built."),
  entity_fetch_failed: wire('server', 500, true, 'The entity fetch failed.'),
  events_required: wire('validation', 400, false, 'The request must include a non-empty events array.'),
  ingest_failed: wire('validation', 400, false, 'The source-event ingest failed.'),
  migration_failed: wire('server', 500, false, 'The schema migration failed to apply.'),
  model_query_failed: wire('validation', 400, false, 'The model query failed.'),
  queries_required: wire('validation', 400, false, 'The request must include a non-empty queries array.'),
  query_unsupported_operator: wire('validation', 400, false, 'The query used an unsupported operator.'),
  query_unknown_relation: wire('validation', 400, false, 'The query referenced an unknown relation.'),
  query_relation_target_unknown: wire('schema', 500, false, 'A relation targets a model the schema does not define.'),
  query_invalid_identifier: wire('validation', 400, false, 'The query contained an invalid identifier.'),
  org_id_required: wire('validation', 400, false, 'An organization id is required for this request.'),
  presence_identity_required: wire('validation', 400, false, 'Both userId and organizationId are required.'),
  upload_fields_required: wire('validation', 400, false, 'A required upload field was missing.'),
  upload_items_required: wire('validation', 400, false, 'The request must include a non-empty items array.'),
  presigned_url_failed: wire('server', 500, true, 'Failed to generate a presigned upload URL.'),
  task_id_required: wire('validation', 400, false, 'A task id is required for this request.'),
  claim_id_required: wire('validation', 400, false, 'An claim id is required for this request.'),
  commit_operation_action_required: wire('validation', 400, false, 'A commit operation is missing its `action`.'),
  commit_operation_unsupported: wire('validation', 400, false, 'A commit operation used an unsupported `action`.'),
  usage_invalid: wire('validation', 400, false, 'The usage request was invalid.'),
  invalid_request: wire('validation', 400, false, 'The request parameters were invalid.'),
  capability_not_found: wire('not_found', 404, false, 'No capability exists with the given id.'),
  invalid_participant_kind: wire('validation', 400, false, 'The participant kind is invalid.'),
  invalid_sync_group: wire('validation', 400, false, 'Sync groups must be "default" or "<namespace>:<id>".'),
  narrow_scope_required: wire('validation', 400, false, 'A narrowed scope is required for this request.'),
  wide_scope_forbidden: wire('permission', 403, false, 'A wide scope is not permitted for this caller.'),
  capability_required: wire('auth', 401, false, 'This operation requires a capability.'),
  parent_turn_not_found: wire('not_found', 404, false, 'The referenced parent turn does not exist.'),
  parent_turn_foreign_agent: wire('permission', 403, false, 'The parent turn belongs to a different agent.'),
  turn_not_found: wire('not_found', 404, false, 'The referenced turn does not exist.'),
  turn_foreign_agent: wire('permission', 403, false, 'The turn belongs to a different agent.'),
  invalid_intent: wire('validation', 400, false, 'The claim request was invalid.'),
  schema_too_large: wire('validation', 413, false, 'The submitted schema exceeds the maximum size.'),
  invalid_schema: wire('validation', 400, false, 'The submitted schema could not be parsed.'),
  incompatible_change: wire('conflict', 409, false, 'The schema change is incompatible with the current schema.'),
} as const satisfies Record<string, ErrorCodeSpec>;

/**
 * The closed set of registered codes, plus the `policy:${reason}` dynamic
 * family (conflict-policy rejections name their reason inline, the same way
 * Stripe carries a `decline_code` sub-detail). The constructor of
 * {@link AbloError} narrows its `code` option to this type, so a typo or an
 * unregistered code is a compile error. The wire-parse boundary casts
 * incoming strings to this type to preserve forward compatibility.
 */
export type ErrorCode = keyof typeof ERROR_CODES | `policy:${string}`;

/** The subset of codes that cross the network — the actual API/MCP wire
 *  contract. HTTP/MCP boundaries map from this set; docs are generated
 *  from it. */
export type WireErrorCode = {
  [K in keyof typeof ERROR_CODES]: (typeof ERROR_CODES)[K]['surface'] extends 'wire'
    ? K
    : never;
}[keyof typeof ERROR_CODES];

/** Look up an error code's spec. Returns `undefined` for the dynamic
 *  `policy:*` family and for any forward-compat code an older SDK doesn't
 *  yet know. */
export function errorCodeSpec(code: string): ErrorCodeSpec | undefined {
  return (ERROR_CODES as Record<string, ErrorCodeSpec>)[code];
}

/** Whether a code's spec marks it retryable. Unknown / dynamic codes
 *  default to non-retryable (safe default — don't auto-retry the unknown). */
export function isRetryableCode(code: string): boolean {
  return errorCodeSpec(code)?.retryable ?? false;
}

/**
 * Classify a `code` into its {@link RecoveryClass} — the single discriminant
 * the connection FSM and the network probe branch on.
 *
 * The registry stays the source of truth: an explicit `spec.recovery` wins
 * (set only on the few auth codes whose remedy the status can't reveal), and
 * everything else is DERIVED from the spec so the registry stays terse:
 *   - retryable                → `transient`
 *   - 403                      → `permission`
 *   - residual `auth`-category → `auth_blocked` (the 401 credential-type codes)
 *   - otherwise / unknown      → `none`
 *
 * Unknown / dynamic `policy:*` / forward-compat codes (`spec === undefined`)
 * default to `none`, mirroring {@link isRetryableCode}'s safe default — never
 * silently treat an unrecognised code as a credential expiry or a logout.
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
 * Compile-time exhaustiveness guard: forces every {@link RecoveryClass} to be
 * acknowledged here, so adding a class to {@link RECOVERY_CLASSES} without
 * deciding its meaning is a type error rather than a silent gap. (Mirrors the
 * closed-union discipline `ERROR_CODES` itself uses via `satisfies`.)
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
