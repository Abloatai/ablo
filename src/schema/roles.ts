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
 *     fields off the record itself (`id`, `deckId`), so the server can fan a
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
export const syncGroupSchema = z
  .templateLiteral([z.string().regex(/^[a-z][a-z0-9_]*$/), ':', z.string().min(1)])
  .brand<'SyncGroup'>();

export type SyncGroup = z.infer<typeof syncGroupSchema>;

/**
 * Mint a sync-group string. The single place the `kind:id` convention lives —
 * if the wire format ever changes (structured columns, a different separator),
 * it changes here and nowhere else.
 */
export function syncGroup(kind: string, id: string): SyncGroup {
  return `${kind}:${id}` as SyncGroup;
}

// ── Role source ─────────────────────────────────────────────────────────────

/** Validates how a role pulls ids out of a context (identity or record). */
export const roleSourceSchema = z.object({
  /** The context field to read, e.g. `'organizationId'`, `'id'`, `'deckId'`. */
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
  kind: z.string().regex(/^[a-z][a-z0-9_]*$/, 'kind must be a lowercase identifier, e.g. "deck"'),
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
 * can route to a group keyed by its own `id` *or* a foreign key like `deckId`.
 *
 * ```ts
 * entityRole({ kind: 'deck', source: 'id' })      // a deck → deck:<id>
 * entityRole({ kind: 'deck', source: 'deckId' })  // a layer → its parent deck
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
  z.string().regex(/^[a-z][a-z0-9_]*$/, 'scope kind must be a lowercase identifier, e.g. "dataroom"'),
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
 * with no `deckId`) is a silent no-op.
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
