import { z } from 'zod';

/**
 * Sync-group roles — the fan-out vocabulary, as typed data.
 *
 * A *sync group* is the unit the broadcast layer routes deltas on. On the wire
 * it's a `kind:id` string, but that serialization is owned entirely by this
 * module — callers never hand-write `'org:abc'`. Instead they declare a typed
 * {@link Role} (`kind` + which field supplies the id) and the engine mints the
 * branded {@link SyncGroup} string via {@link syncGroup}.
 *
 * Two reading directions, one shape:
 *
 *   • {@link IdentityRole} — "which groups may this *participant* subscribe to?"
 *     Reads fields off an identity context (`organizationId`, `teamIds`).
 *
 *   • {@link EntityRole} — "which groups does this *record* live in?" Reads
 *     fields off the record itself (`id`, `reportId`), so the server can fan a
 *     committed delta to the right entity streams regardless of what the
 *     committer was subscribed to.
 *
 * Roles are pure data (no closures) so a `Schema` round-trips through the
 * control plane and the reconstructed copy behaves identically.
 */

// ── Sync-group wire form (branded) ──────────────────────────────────────────

/**
 * The branded wire form of a sync group: `${kind}:${id}`. Branded so a raw
 * string can't masquerade as one — the only way to produce a `SyncGroup` is
 * {@link syncGroup}. Because the brand is an intersection it's still assignable
 * *to* `string`, so existing `string[]` plumbing keeps working unchanged.
 */
/**
 * The `kind:id` shape itself, unbranded — what a CALLER writes.
 *
 * Input and output want different strictness from one format, so the format is
 * declared once here and viewed two ways. This view rejects `'nonsense'` at
 * compile time (no colon ⇒ matches no group) while still accepting
 * `` `org:${orgId}` `` written inline, which is the whole point of
 * {@link SyncGroupInput}. Requiring the constructor on an input field buys no
 * safety this does not already give and costs every call site a helper import.
 */
export const syncGroupRefSchema = z.templateLiteral([
  z.string().regex(/^[a-z][a-z0-9_]*$/),
  ':',
  z.string().min(1),
]);

export type SyncGroupRef = z.infer<typeof syncGroupRefSchema>;

/**
 * The same format, branded — what the SERVER hands back.
 *
 * The brand earns its keep on the way out, where Ablo is the author: a consumer
 * that receives a `SyncGroup` knows it was minted, and a raw string cannot
 * masquerade as one.
 */
export const syncGroupSchema = syncGroupRefSchema.brand<'SyncGroup'>();

export type SyncGroup = z.infer<typeof syncGroupSchema>;

/**
 * Mint a sync-group string. The single place the `kind:id` convention lives —
 * if the wire format ever changes (structured columns, a different separator),
 * it changes here and nowhere else.
 */
export function syncGroup(kind: string, id: string): SyncGroup {
  return `${kind}:${id}` as SyncGroup;
}

/**
 * The caller-facing input form of a sync group. Accepts a {@link SyncGroup}
 * from the constructor, a template literal of the right shape
 * (`` `org:${orgId}` `` type-checks without importing the constructor), or the
 * reserved `'default'` anchor. A plain string with no colon is a compile error,
 * because it would match no group and silently subscribe to nothing.
 */
export type SyncGroupInput = SyncGroup | `${string}:${string}` | 'default';

/**
 * Runtime validation for {@link SyncGroupInput}, used wherever a group crosses a
 * trust boundary such as minting a capability or an ephemeral key. A malformed
 * group is rejected with `invalid_sync_group` rather than stored and left
 * silently subscribed to nothing.
 */
export const syncGroupInputSchema = z.union([z.literal('default'), syncGroupSchema]);

/** Runtime guard matching {@link SyncGroupInput}. */
export function isSyncGroupInput(value: unknown): value is SyncGroupInput {
  return syncGroupInputSchema.safeParse(value).success;
}

// ── Identity anchors (closed vocabulary) ────────────────────────────────────

/**
 * The sync-group kinds the authentication provider mints directly onto an
 * identity. This is a fixed vocabulary: add to this list rather than write a
 * new namespace string inline.
 *
 *   - `org:<organizationId>`  — every member of the organization
 *   - `user:<participantId>`  — the participant itself
 *   - `project:<projectId>`   — every credential scoped to the project; the
 *     organization's default project shares the organization's id
 *
 * Schema-declared roles ({@link identityRole} and {@link entityRole}) extend
 * this vocabulary per application; the kinds here are the ones the engine
 * reserves.
 */
export const IDENTITY_ANCHOR_KINDS = ['org', 'user', 'project'] as const;
export type IdentityAnchorKind = (typeof IDENTITY_ANCHOR_KINDS)[number];

/** Mint an engine-reserved identity anchor (typed wrapper over {@link syncGroup}). */
export function identityAnchor(kind: IdentityAnchorKind, id: string): SyncGroup {
  return syncGroup(kind, id);
}

// ── Role source ─────────────────────────────────────────────────────────────

/** Validates how a role pulls ids out of a context (identity or record). */
export const roleSourceSchema = z.object({
  /** The context field to read, e.g. `'organizationId'`, `'id'`, `'reportId'`. */
  field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'source must be a valid identifier'),
  /**
   * When `true`, `field` holds an array; every non-empty string element yields
   * one group. When `false` (default), `field` is a scalar; truthy → one group.
   */
  multi: z.boolean(),
});

export type RoleSource = z.infer<typeof roleSourceSchema>;
/** Back-compat alias — historical name for {@link RoleSource}. */
export type IdentityRoleSource = RoleSource;
/** Record-side name for {@link RoleSource}. */
export type EntityRoleSource = RoleSource;

/** Free-form context a role reads from. */
export type RoleContext = Record<string, unknown>;
/** The identity shape an {@link IdentityRole} reads from. */
export type IdentityContext = RoleContext;
/** The record shape an {@link EntityRole} reads from. */
export type EntityContext = RoleContext;

// ── Role (kind + source — no template string) ───────────────────────────────

/**
 * A sync-group role: a typed `kind` plus the field that supplies the id. The
 * wire string is `${kind}:${id}`, built by the engine — there is deliberately
 * no template/placeholder for the author to get wrong.
 */
export const roleSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]*$/, 'kind must be a lowercase identifier, e.g. "report"'),
  source: roleSourceSchema,
});

export type Role = z.infer<typeof roleSchema>;

/**
 * Identity-anchored role. Reads an identity field; `kind` names the group.
 *
 * ```ts
 * identityRole({ kind: 'org',  source: 'organizationId' })
 * identityRole({ kind: 'team', source: 'teamIds', multi: true })
 * ```
 */
export type IdentityRole = Role;

/**
 * Record-anchored role. Reads a record field; `kind` names the group. A record
 * can route to a group keyed by its own `id` *or* a foreign key like `reportId`.
 *
 * ```ts
 * entityRole({ kind: 'report', source: 'id' })        // a report → report:<id>
 * entityRole({ kind: 'report', source: 'reportId' })  // a block → its parent report
 * ```
 */
export type EntityRole = Role;

/** Validates an {@link IdentityRole}. */
export const identityRoleSchema: z.ZodType<IdentityRole> = roleSchema;
/** Validates an {@link EntityRole}. */
export const entityRoleSchema: z.ZodType<EntityRole> = roleSchema;

/**
 * Validates a model's `scope` declaration: `true` (kind = typename) or an
 * explicit lowercase kind string. The same vocabulary the roles use, so the
 * whole sync-group declaration surface is Zod-validated, not hand-checked.
 */
export const scopeSchema = z.union([
  z.boolean(),
  z.string().regex(/^[a-z][a-z0-9_]*$/, 'scope kind must be a lowercase identifier, e.g. "workspace"'),
]);

/**
 * Validates a model's `grants` membership edge. Both values are relation names
 * declared on the same model (`subject` → identity, `scope` → scope root); that
 * the relations actually exist + are `belongsTo` is a cross-field check done in
 * `defineSchema` where the relation map is in scope.
 */
export const grantsRefSchema = z.object({
  subject: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'grants.subject must name a relation'),
  scope: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'grants.scope must name a relation'),
});

/**
 * The authoring form of a model's sync-group routing — the `groups: { ... }`
 * option. One object collects the three independent routing controls. This is a
 * separate concern from `policy`, which governs tenant isolation: `policy`
 * decides who may read a row, while `groups` decides which change channels a row
 * fans into.
 *
 * - `root`   — marks this model a scope root, so its records form the group
 *   `<kind>:<id>` (the kind defaults to the typename).
 * - `grants` — a membership edge granting an identity access to a scope root.
 * - `roles`  — record-to-group roles keyed on a plain field rather than a
 *   relation, such as inbox fan-out. Accepts a single role or an array.
 */
export const groupsInputSchema = z.object({
  root: scopeSchema.optional(),
  grants: grantsRefSchema.optional(),
  roles: z.union([entityRoleSchema, z.array(entityRoleSchema)]).optional(),
});
export type GroupsInput = z.infer<typeof groupsInputSchema>;

// ── Factories ───────────────────────────────────────────────────────────────

function makeRole(spec: {
  readonly kind: string;
  readonly source: string;
  readonly multi?: boolean;
}): Role {
  return { kind: spec.kind, source: { field: spec.source, multi: spec.multi ?? false } };
}

/** Build an identity-anchored role. `multi` defaults to `false`. */
export function identityRole(spec: {
  readonly kind: string;
  /** Identity-context field to read. See {@link RoleSource.field}. */
  readonly source: string;
  /** Treat the field as an array of ids. See {@link RoleSource.multi}. */
  readonly multi?: boolean;
}): IdentityRole {
  return makeRole(spec);
}

/** Build a record-anchored role. `multi` defaults to `false`. */
export function entityRole(spec: {
  readonly kind: string;
  /** Record field to read. See {@link RoleSource.field}. */
  readonly source: string;
  /** Treat the field as an array of ids. See {@link RoleSource.multi}. */
  readonly multi?: boolean;
}): EntityRole {
  return makeRole(spec);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate a {@link RoleSource} against a context. Absent or falsy fields yield
 * `[]`, so a role whose field isn't present (a user with no `teamIds`, a record
 * with no `reportId`) is a silent no-op.
 */
export function extractRoleIds(context: RoleContext, source: RoleSource): readonly string[] {
  const raw = context[source.field];
  if (source.multi) {
    return Array.isArray(raw)
      ? raw.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [];
  }
  return raw ? [String(raw)] : [];
}

/** Identity-side name for {@link extractRoleIds}. */
export const extractIdentityIds = extractRoleIds;
/** Record-side name for {@link extractRoleIds}. */
export const extractEntityIds = extractRoleIds;

/**
 * Compose the sync groups an identity may subscribe to, from the schema's
 * registered {@link IdentityRole}s. Returns `[]` when no role produces an id;
 * the caller treats `[]` as "no scope", not "match everything".
 */
export function composeIdentitySyncGroups(
  identity: IdentityContext,
  schema: { readonly identityRoles: readonly IdentityRole[] },
): readonly SyncGroup[] {
  const out = new Set<SyncGroup>();
  for (const role of schema.identityRoles) {
    for (const id of extractRoleIds(identity, role.source)) {
      if (id) out.add(syncGroup(role.kind, id));
    }
  }
  return Array.from(out);
}

/**
 * Compose the sync groups a record belongs to, from the model's registered
 * {@link EntityRole}s. Mirror of {@link composeIdentitySyncGroups}, reading the
 * record instead of an identity. Returns `[]` when the model has no entity
 * roles (the delta then fans on its base `org:`/`user:` groups only).
 */
export function composeEntitySyncGroups(
  record: EntityContext,
  def: { readonly entityRoles?: readonly EntityRole[] },
): readonly SyncGroup[] {
  if (!def.entityRoles?.length) return [];
  const out = new Set<SyncGroup>();
  for (const role of def.entityRoles) {
    for (const id of extractRoleIds(record, role.source)) {
      if (id) out.add(syncGroup(role.kind, id));
    }
  }
  return Array.from(out);
}

/**
 * Narrow a client's requested sync-group set to the groups it is actually
 * allowed to subscribe to. This helper is fully generic — it never inspects the
 * group strings — so it lives beside the composition helpers above.
 *
 * Behaviour:
 *   - If the client requested no groups, return the full identity-derived set,
 *     which is this participant's default subscription scope.
 *   - If the client requested some groups, keep only those that appear in the
 *     identity-derived allowed set and drop the rest, reporting the dropped
 *     groups through the optional `logDropped` callback.
 *   - If nothing survives the filter, fall back to the full allowed set rather
 *     than return `[]`, which would otherwise collapse to the server-side
 *     `'default'` fallback and deliver no changes at all.
 */
export function intersectRequestedWithAllowed(args: {
  readonly requested: readonly string[];
  readonly allowed: readonly string[];
  readonly logDropped?: (dropped: readonly string[]) => void;
}): readonly string[] {
  const { requested, allowed, logDropped } = args;
  if (requested.length === 0) return allowed;
  const allowedSet = new Set(allowed);
  const accepted: string[] = [];
  const dropped: string[] = [];
  for (const g of requested) {
    if (allowedSet.has(g)) accepted.push(g);
    else dropped.push(g);
  }
  if (dropped.length > 0 && logDropped) logDropped(dropped);
  return accepted.length > 0 ? accepted : allowed;
}
