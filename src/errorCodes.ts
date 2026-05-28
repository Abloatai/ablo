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

/**
 * Version of the error contract — the envelope shape + the set of codes and
 * their semantics. Date-based, like Stripe's API versions. Bump it (and only
 * it) when the contract changes in a way consumers can observe: a new/removed
 * code, a changed HTTP status, an envelope field. Emitted in `errors.json`
 * and on the `Ablo-Version` response header so a consumer can detect drift.
 */
export const ERROR_CONTRACT_VERSION = '2026-05-28';

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
  | 'intent'
  | 'bootstrap'
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'client';

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
}

const wire = (
  category: ErrorCategory,
  httpStatus: number,
  retryable: boolean,
  message: string,
): ErrorCodeSpec => ({ category, surface: 'wire', httpStatus, retryable, message });

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
  apikey_expired: wire('auth', 401, false, 'API key has expired.'),
  apikey_missing: wire('auth', 401, false, 'No API key was supplied on the request.'),
  api_key_required: wire('auth', 401, false, 'This operation requires an API key.'),
  capability_id_missing: wire('auth', 401, false, 'A capability id was expected but not provided.'),
  exchange_failed: wire('auth', 401, false, 'The API-key credential exchange was rejected.'),
  identity_resolve_failed: wire('auth', 401, false, 'Identity resolution was rejected.'),
  session_expired: wire('auth', 401, false, 'The session is invalid or expired; re-authenticate.'),
  file_upload_auth_required: wire('auth', 401, false, 'File upload requires an authenticated session.'),
  browser_apikey_blocked: client('auth', 'Raw API keys must not be used from a browser context.'),

  // ── permission / capability (403) ──────────────────────────────────
  capability_scope_denied: wire('capability', 403, false, "The connection's resolved scope does not cover the attempted action."),
  capability_invalid: wire('capability', 403, false, 'The capability is unknown, revoked, or expired.'),
  byo_role_cannot_enforce_rls: wire('permission', 403, false, 'The bring-your-own DB role cannot enforce row-level security.'),
  byo_role_unreadable: wire('permission', 403, false, 'The bring-your-own DB role could not be introspected.'),
  byo_tenant_tables_unforced_rls: wire('permission', 403, false, 'Tenant tables do not have RLS forced under the BYO role.'),

  // ── claim / intent conflict (409) ──────────────────────────────────
  claim_conflict: wire('claim', 409, true, 'The target entity is claimed by another participant.'),
  claim_lost: wire('claim', 409, true, 'A previously held claim was lost before the write applied.'),
  entity_claimed: wire('claim', 409, true, 'The target entity is currently claimed; write was blocked.'),
  intent_conflict: wire('claim', 409, true, 'An intent on the target conflicts with an active intent (server-internal alias of claim_conflict).'),
  malformed_claim: wire('claim', 400, false, 'The claim payload was malformed.'),
  model_claimed: wire('claim', 409, true, 'The model instance is claimed by another participant.'),
  model_claimed_timeout: wire('claim', 409, true, 'Timed out waiting for a model claim to clear.'),
  model_claim_not_configured: client('claim', 'Claiming was requested on a model that has no claim configuration.'),

  // ── stale context / idempotency (409) ──────────────────────────────
  stale_context: wire('conflict', 409, true, 'The write carried a readAt watermark that is now stale; re-read and retry.'),
  idempotency_conflict: wire('conflict', 409, false, 'The same Idempotency-Key was reused with a different request body.'),
  idempotency_key_too_long: wire('validation', 400, false, 'The supplied Idempotency-Key exceeds the maximum length.'),

  // ── validation (400 / 422) ─────────────────────────────────────────
  turn_validation_failed: wire('validation', 422, false, 'The agent turn failed server-side validation.'),
  commit_operation_required: wire('validation', 400, false, 'A commit must carry `operation` or `operations`.'),
  commit_operation_model_required: wire('validation', 400, false, 'A commit operation is missing its `model`.'),
  commit_operations_ambiguous: wire('validation', 400, false, 'A commit supplied both `operation` and `operations`.'),
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

  // ── tenant / unknown model (400) ───────────────────────────────────
  server_execute_unknown_model: wire('tenant', 400, false, 'The server-execute request named a model not in the tenant schema.'),
  mutate_create_unknown_model: wire('tenant', 400, false, 'A create targeted a model not in the tenant schema.'),
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

  // ── intent / lease (409 / transport) ───────────────────────────────
  intent_lease_unavailable: wire('intent', 503, true, 'The intent-lease coordination subsystem is unavailable; retry.'),
  intent_not_wired: client('intent', 'Intent support was used but is not wired in this runtime.'),
  intent_queued: wire('intent', 409, true, 'The intent was queued behind an active lease holder.'),
  intent_wait_aborted: wire('intent', 409, true, 'Waiting for the intent lease was aborted.'),
  intent_wait_poll_interval_required: client('intent', 'A poll interval is required when waiting on an intent.'),
  grant_timeout: wire('intent', 504, true, 'Timed out waiting for a capability grant.'),
  slide_intent_missing_deck_id: wire('intent', 400, false, 'A slide intent was missing its deck id.'),
  slide_intent_unknown_sibling: wire('intent', 400, false, 'A slide intent referenced an unknown sibling slide.'),

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
  fetch_unavailable: client('transport', 'No fetch implementation is available in this environment.'),
  base_url_missing: client('transport', 'No base URL was configured for the client.'),
  sync_not_ready: client('transport', 'A sync operation was attempted before the client was ready.'),
  ws_not_ready: client('transport', 'A frame was sent before the WebSocket was connected.'),

  // ── quota / rate limit (429) ──────────────────────────────────────
  quota_exceeded: wire('rate_limit', 429, true, 'The organization exceeded its configured usage quota.'),

  // ── server (5xx) ───────────────────────────────────────────────────
  internal_error: wire('server', 500, true, 'An unexpected server error occurred.'),
  quota_lookup_failed: wire('server', 503, true, 'The quota decision could not be loaded.'),
  turn_open_failed: wire('server', 500, true, 'The agent turn failed to open.'),
  turn_close_failed: wire('server', 500, true, 'The agent turn failed to close cleanly.'),

  // ── client-only invariants (never serialized) ──────────────────────
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
  mock_mutation_failed: client('client', 'A mock mutation adapter was configured to fail.'),
  mock_unsupported_operation: client('client', 'A mock adapter received an unsupported operation.'),

  // ── HTTP route edge codes (egress through app.onError) ─────────────
  invalid_body: wire('validation', 400, false, 'The request body was missing, unparseable, or the wrong shape.'),
  invalid_json: wire('validation', 400, false, 'The request body was not valid JSON.'),
  capability_id_required: wire('validation', 400, false, 'A capability id is required for this request.'),
  organization_mismatch: wire('permission', 403, false, 'The request targeted an organization the caller is not scoped to.'),
  forbidden: wire('permission', 403, false, 'The caller lacks permission for this operation.'),
  source_api_key_unresolved: wire('auth', 401, false, 'The source API key could not be resolved.'),
  capability_auth_disabled: wire('server', 503, false, 'Capability authentication is disabled on this server.'),
  provisioner_unavailable: wire('server', 503, false, 'No database provisioner is configured.'),
  invalid_model: wire('validation', 400, false, 'The request named an invalid model.'),
  invalid_id: wire('validation', 400, false, 'The request carried an invalid id.'),
  unknown_model: wire('tenant', 400, false, 'The request named a model not in the tenant schema.'),
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
  intent_id_required: wire('validation', 400, false, 'An intent id is required for this request.'),
  commit_operation_action_required: wire('validation', 400, false, 'A commit operation is missing its `action`.'),
  commit_operation_unsupported: wire('validation', 400, false, 'A commit operation used an unsupported `action`.'),
  usage_invalid: wire('validation', 400, false, 'The usage request was invalid.'),
  invalid_request: wire('validation', 400, false, 'The request parameters were invalid.'),
  capability_not_found: wire('not_found', 404, false, 'No capability exists with the given id.'),
  invalid_participant_kind: wire('validation', 400, false, 'The participant kind is invalid.'),
  narrow_scope_required: wire('validation', 400, false, 'A narrowed scope is required for this request.'),
  wide_scope_forbidden: wire('permission', 403, false, 'A wide scope is not permitted for this caller.'),
  capability_required: wire('auth', 401, false, 'This operation requires a capability.'),
  parent_turn_not_found: wire('not_found', 404, false, 'The referenced parent turn does not exist.'),
  parent_turn_foreign_agent: wire('permission', 403, false, 'The parent turn belongs to a different agent.'),
  turn_not_found: wire('not_found', 404, false, 'The referenced turn does not exist.'),
  turn_foreign_agent: wire('permission', 403, false, 'The turn belongs to a different agent.'),
  invalid_intent: wire('validation', 400, false, 'The intent request was invalid.'),
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
