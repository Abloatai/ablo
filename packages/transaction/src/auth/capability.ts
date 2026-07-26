/**
 * Capability — the one definition of what a credential may do.
 *
 * A grant is declared once, in the vocabulary a developer writes:
 *
 *     can: { documents: ['read', 'update'] }
 *
 * Everything downstream derives from that declaration: the wire spelling
 * (`documents.update`) stored on the key row, the typed `can` a schema narrows
 * to its own models, the request body the mint route parses, the pattern the
 * published contract advertises, and the scope block echoed back on the minted
 * session.
 *
 * Before this module the same grant was spelled five times — a literal union in
 * the resource types, a `z.array(z.string())` on the wire, a hand-rolled
 * field-by-field parser in the mint route, an object literal in the response
 * type, and a hand-written `model.verb` array at each caller that mints without
 * the SDK. Nothing failed when they drifted; the drift surfaced as
 * `capability_scope_denied` on a grant the caller believed it held.
 *
 * Two axes decide blast radius. VERBS come from `can`; ROWS come from
 * `syncGroups`. They belong to one grant, which is why they are declared
 * together here rather than meeting for the first time on the wire.
 */

import { z } from 'zod';
import { participantKindSchema } from '../coordination/schema.js';
import { syncGroupInputSchema } from '../schema/roles.js';
import { authTokenSchema } from './token.js';

/**
 * The verbs a grant can name — the whole vocabulary, in one place. Every other
 * spelling of an operation in the system derives from this enum: the SDK's
 * `can` values, the wire's `model.verb` pattern, and the JSON Schema the
 * published contract advertises.
 */
export const capabilityOperationSchema = z.enum(['read', 'create', 'update', 'delete']);
export type CapabilityOperation = z.infer<typeof capabilityOperationSchema>;

/**
 * One granted operation in its wire spelling: `<model>.<verb>`, lowercased.
 *
 * The template literal derives both halves — the verb set from
 * {@link capabilityOperationSchema}, the pattern in the published contract from
 * the template — so tightening the verb vocabulary can never leave a stale
 * regex or a stale doc behind. The model half is the name the server matches
 * against a model's registered aliases (type name, schema key, or table name),
 * so it stays permissive here and is resolved at the gate.
 */
export const grantedOperationSchema = z.templateLiteral([
  z.string().regex(/^[^.\s]+$/),
  '.',
  capabilityOperationSchema,
]);
export type GrantedOperation = z.infer<typeof grantedOperationSchema>;

/**
 * The declared grant, per model — the runtime shape of `can`. Model keys are
 * free-form at runtime because the server resolves them against the schema it
 * has; {@link CapabilityCan} narrows them to a known schema's models at the
 * type level.
 */
export const capabilityCanSchema = z.record(
  z.string().min(1),
  z.array(capabilityOperationSchema).min(1).readonly(),
).refine((can) => Object.keys(can).length > 0, {
  message: 'can must grant at least one operation',
});

export type NonEmptyCapabilityOperations = readonly [
  CapabilityOperation,
  ...CapabilityOperation[],
];

/**
 * `can`, narrowed to one schema's model names. A projection of
 * {@link capabilityCanSchema} — the value type is the operation enum, the key
 * domain is the schema's models, so `can: { tasks: ['update'] }` fails to
 * compile against a schema with no `tasks` model.
 */
export type CapabilityCan<S> = {
  [K in keyof S & string]: Readonly<Record<K, NonEmptyCapabilityOperations>> &
    Partial<
      Record<
        Exclude<keyof S & string, K>,
        NonEmptyCapabilityOperations
      >
    >;
}[keyof S & string];

/**
 * Public authoring type for a reusable grant. It accepts the `Schema` itself,
 * so callers can use TypeScript's `satisfies` operator without reaching into
 * `schema.models`.
 */
export type CapabilityGrant<
  S extends { readonly models: Readonly<Record<string, unknown>> },
> = CapabilityCan<S['models']>;

/**
 * Bind the canonical `can` Zod contract to one schema's model keys.
 *
 * The wire parser cannot know a tenant's models until a schema is selected.
 * This projection keeps the same operation/value contract and rejects keys
 * outside that selected schema.
 */
export function capabilityCanSchemaFor<
  const S extends Readonly<Record<string, unknown>>,
>(models: S) {
  const modelNames = new Set(Object.keys(models));
  return capabilityCanSchema.superRefine((can, ctx) => {
    for (const model of Object.keys(can)) {
      if (!modelNames.has(model)) {
        ctx.addIssue({
          code: 'custom',
          path: [model],
          message: `Model "${model}" is not declared by this schema.`,
        });
      }
    }
  });
}

/**
 * Read-your-writes expansion: append `<model>.read` for every model the grant
 * can write.
 *
 * A scoped agent that may update a row must be able to read it, or the read
 * gate (query / bootstrap / entity self-heal / delta fan-out) starves the very
 * writes the grant allows. The write verbs stay the source of truth; reads are
 * derived and deduped, and models the grant cannot write stay unreadable —
 * that is the read-side blast-radius reduction.
 *
 * It lives beside the declaration, so it applies wherever a grant is built,
 * rather than only at whichever mint the callers happen to share. The server
 * applies it again at the mint chokepoint for callers that post raw JSON; the
 * function is idempotent, so the second application is a no-op.
 */
export function expandReadYourWrites(
  operations: readonly GrantedOperation[],
): GrantedOperation[] {
  const out = new Set<GrantedOperation>(operations);
  for (const op of operations) {
    const [model] = op.split('.');
    if (model) out.add(`${model}.read`);
  }
  return [...out];
}

/**
 * The parts of a model definition a grant can name. Structural, so both the
 * SDK (which holds a `Schema`) and the mint route (which holds the tenant's
 * pushed artifact) derive names from the same rule.
 */
export interface CapabilityModelShape {
  readonly typename?: string;
  readonly tableName?: string;
}

/**
 * Schema key → the wire name a grant must be minted with.
 *
 * THE derivation. A model whose type name is overridden — schema key
 * `documents`, type name `Document` — has to mint `document.update`, not
 * `documents.update`, and a caller who works that out by hand gets it wrong
 * once and learns at `capability_scope_denied`. Callers pass their schema's
 * models, never a map they assembled themselves.
 */
export function modelWireNames(
  models: Readonly<Record<string, CapabilityModelShape>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(models).map(([key, def]) => [key, def.typename ?? key]),
  );
}

/**
 * Every name the enforcement gates accept for a model, lowercased. Three
 * vocabularies name one logical model — the wire type name (`lineitem`), the
 * schema key (`lineItems`), and the table name (`line_items`) — so a grant
 * minted in any of them is honored, and the mint can tell a real model from a
 * typo without guessing which vocabulary the caller used.
 */
export function capabilityModelAliases(
  models: Readonly<Record<string, CapabilityModelShape>>,
): Set<string> {
  const aliases = new Set<string>();
  for (const [key, def] of Object.entries(models)) {
    aliases.add(key.toLowerCase());
    if (def.typename) aliases.add(def.typename.toLowerCase());
    if (def.tableName) aliases.add(def.tableName.toLowerCase());
  }
  return aliases;
}

/**
 * The granted operations whose model half names nothing in the schema.
 *
 * A grant is checked against the schema at MINT, the way a write to an unpushed
 * model already fails with `server_execute_unknown_model` — so a typo in
 * `lineitem.update` is a rejected mint rather than a credential that looks
 * healthy and is denied on its first write. Without this the `model` half is a
 * hole: an opaque string nothing validates until enforcement time.
 */
export function unresolvableOperations(
  operations: readonly GrantedOperation[],
  aliases: ReadonlySet<string>,
): GrantedOperation[] {
  // The model half holds no dot (see `grantedOperationSchema`), so the first
  // separator is the only one.
  return operations.filter((op) => !aliases.has(op.slice(0, op.indexOf('.'))));
}

/**
 * Serializes a declared `can` into the wire allowlist — the ONE translation
 * from what a developer writes to what the server stores and enforces.
 *
 * `wireNames` comes from {@link modelWireNames} over the client's own schema.
 * It is required rather than optional: an omitted map silently mints the schema
 * key verbatim, which is right for most models and wrong for every model with
 * a type-name override — the kind of default that is correct until it isn't.
 */
export function grantedOperations(
  can: Readonly<Record<string, readonly CapabilityOperation[] | undefined>>,
  wireNames: Readonly<Record<string, string>>,
): GrantedOperation[] {
  const declared = Object.entries(can).flatMap(([model, ops]) => {
    const wireName = (wireNames[model] ?? model).toLowerCase();
    return (ops ?? []).map((op): GrantedOperation => `${wireName}.${op}`);
  });
  return expandReadYourWrites(declared);
}

/**
 * The grant at rest: what the credential ended up with, on both axes, plus the
 * participant it acts as. The mint echoes this block, the key row stores it,
 * and the gates read it — so a session's reported scope and its enforced scope
 * are the same shape by construction.
 */
export const capabilityScopeSchema = z.object({
  organizationId: z.string().min(1),
  /** Credential target. Branch id is authoritative; null supports self-hosted identities. */
  projectId: z.string().min(1).nullable().default(null),
  branchId: z.string().min(1).nullable().default(null),
  branchRoot: z.boolean().default(false),
  /**
   * The ROW axis — which sync groups this credential may act within. Read back
   * as plain strings rather than the branded form the request enforces: this is
   * what the key row already holds, including rows minted before that gate.
   */
  syncGroups: z.array(z.string()),
  /** The VERB axis — the allowlist as minted, after read-your-writes. */
  operations: z.array(grantedOperationSchema),
  participantKind: participantKindSchema,
  participantId: z.string().min(1),
});
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

/**
 * What `POST /v1/capabilities` answers with — **201**, the credential is minted.
 *
 * This is the first call any non-TypeScript client makes, and until it had a
 * schema the published contract described it as `{ type: 'object' }`: a caller
 * working from the reference could see that a capability could be minted and
 * not where the token was in the reply.
 *
 * `scope` echoes what was MINTED, not what was asked. A `wideScope` mint stores
 * the org-wide default and read-your-writes widens the verb axis, so a client
 * that assumed its request came back verbatim would report a scope narrower
 * than the one being enforced.
 *
 * `userMeta` is the caller's own blob, echoed. Ablo has no view into their user
 * directory — the API key is what is trusted — so this is deliberately open.
 */
export const capabilityMintResponseSchema = z.object({
  capabilityId: z.string().min(1),
  token: authTokenSchema,
  expiresAt: z.iso.datetime(),
  organizationId: z.string().min(1),
  scope: capabilityScopeSchema,
  userMeta: z.record(z.string(), z.unknown()),
});
export type CapabilityMintResponse = z.infer<typeof capabilityMintResponseSchema>;

/**
 * `POST /v1/capabilities` — mint a capability for a participant.
 *
 * Where an ephemeral key is a session for a person, a capability is a scoped,
 * revocable grant for an agent or a system. Narrow by default: an agent or
 * system capability must name its `operations` unless the caller explicitly
 * asks for `wideScope`, which is itself privileged.
 *
 * This is the parsed body — the mint route validates against it rather than
 * reading fields one at a time, so the shape and the validation rules cannot
 * drift from each other or from the published contract.
 */
export const capabilityRequestSchema = z.object({
  participantKind: participantKindSchema,
  participantId: z.string().min(1).optional(),
  /**
   * Mint into another organization. Reserved for a platform secret carrying
   * `ephemeral:mint-any-org`; ordinary tenant keys may omit only.
   */
  organizationId: z.string().min(1).optional(),
  /**
   * The ROW axis. Validated as the engine's branded sync-group form
   * (`default` or `<namespace>:<id>`): a malformed group stored on the key row
   * would subscribe the connection to NOTHING and fail silently at fan-out
   * time, so it is rejected loudly at the boundary.
   */
  syncGroups: z.array(syncGroupInputSchema).readonly().optional(),
  /** The VERB axis, as `model.verb` — e.g. `tasks.update`. */
  operations: z.array(grantedOperationSchema).readonly().optional(),
  ttlSeconds: z.number().int().positive(),
  label: z.string().min(1).optional(),
  /**
   * Opt out of narrow-by-default scoping. Without it, agent and system
   * capabilities require non-empty `operations`; with it, the caller must
   * additionally hold an admin/owner role or present a secret key.
   */
  wideScope: z.boolean().optional(),
  /**
   * Caller-attested identity for the end user this capability acts for — the
   * on-behalf-of pattern. Ablo does not validate it and has no view into the
   * caller's user directory; the API key is what is trusted, and this blob is
   * echoed back to the client.
   */
  userMeta: z.record(z.string(), z.unknown()).optional(),
});
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
