import { z } from 'zod';
import { logPositionSchema, type LogPosition } from '../syncLog/contract.js';
import {
  syncGroupInputSchema,
  syncGroupRefSchema,
  syncGroupSchema,
} from '../schema/roles.js';
export { syncGroupInputSchema } from '../schema/roles.js';
import { isFieldRef, type FieldRef } from '../schema/fieldRef.js';
import type { ParticipantKind } from '../types/participant.js';
import type { AssertExact } from '../types/assertExact.js';

/**
 * The wire schemas for coordination — the shapes that keep agents and people
 * from overwriting each other on a shared row. Coordination works in three
 * layers, from outermost to innermost:
 *
 *   1. Presence (observation): who is working where. It reports, never blocks.
 *   2. Claims (pessimistic leases): `claim_begin` / `claim_abandon` grant one
 *      participant exclusive intent on a target while others wait.
 *   3. Stale-context (optimistic): a `readAt` watermark that rejects a lost
 *      update when the row moved after you read it.
 *
 * These Zod schemas are the single definition of each shape. Both the client
 * SDK and the server derive their TypeScript types from them with `z.infer`
 * rather than re-declaring the shapes, and the server validates inbound frames
 * against them at runtime.
 */

// ─────────────────────────────────────────────────────────────────────────
//  Shared primitives
// ─────────────────────────────────────────────────────────────────────────

/**
 * An app-defined claimable part name — a cell (`'B2'`), a section id, a
 * block — made explicit with {@link part}. The schema's own field names need
 * no marker; a name that is NOT a field does, so looseness is a visible
 * decision at the call site rather than a silent absorber of typos.
 *
 * A small object rather than a branded string on purpose: a brand makes a
 * concrete schema's claim params mutually unassignable with the erased
 * `SchemaRecord` view, and the react context boundary erases and restores
 * exactly that way. The object member stays pairwise comparable, so no
 * boundary needs a cast through `unknown`.
 */
export interface ClaimPart {
  readonly part: string;
}

/**
 * Name an app-defined part of a row for a claim target: `part('B2')` for a
 * cell, `part('sec_intro')` for a section. The conflict rule compares part
 * names as opaque case-insensitive strings, so any name is legal on the
 * wire — this marker exists purely so the type surface stays definite about
 * the model's own fields.
 */
export function part(name: string): ClaimPart {
  return { part: name };
}

/**
 * The wire spelling of a part name, from whichever spelling the caller used.
 *
 * Three, because they are three different promises. A {@link FieldRef} —
 * `schema.fields.items.status` — is a field the schema declares, so a name that
 * does not exist never compiles. `part('B2')` is a name the schema does not
 * know and says so. A bare string is neither, and survives only because the
 * erased `SchemaRecord` view and untyped callers still need it.
 *
 * All three become the same string here: the wire has always carried names, and
 * what differs is how much was known before the crossing.
 */
export function partName(value: string | ClaimPart | FieldRef): string {
  if (typeof value === 'string') return value;
  return isFieldRef(value) ? value.field : value.part;
}

/**
 * One claimable part name.
 *
 * Names compare as opaque strings, so any name is legal — except one that is
 * plainly several. A caller who needed to claim two parts and had only `field`
 * to say it in packed them into one delimited string, and because
 * `blocks:b_1,b_2` and `blocks:b_1` are different names, both writers were
 * granted a lease on `b_1` and one of their updates was lost with nothing
 * raised. `fields` exists to say that, and refusing the packed spelling is what
 * makes the mistake visible at the moment it is made rather than as a missing
 * update later.
 *
 * Deliberately narrow: only the comma, because that is what a caller reaches
 * for to join a list. A part name is otherwise free.
 */
const partNameSchema = z.string().refine((name) => !name.includes(','), {
  message:
    'A part name cannot contain a comma. Claim several parts with `fields: [a, b]` — two names in one `field` compare as a single unrelated name, so both writers would be granted the same part.',
});

export const participantKindSchema = z.enum(['user', 'agent', 'system']);
// The actor union is declared once, in types/participant.ts — the participant
// IS the actor (user | agent | system), so that file owns the name. The pin
// below fails to compile if this schema and the canonical union ever drift.
export type { ParticipantKind } from '../types/participant.js';
const _participantKindContract: AssertExact<
  z.infer<typeof participantKindSchema>,
  ParticipantKind
> = true;
void _participantKindContract;

/**
 * Parses a participant kind from an inbound frame, tolerating an older wire
 * dialect. Some presence and claim frames label a non-agent participant
 * `'human'`, while the rest of the surface uses `'user'` for the same
 * participant. This normalizes `'human'` to `'user'` on read so every consumer
 * switches on one vocabulary. Producers emit the canonical
 * {@link participantKindSchema} values, and the output union is never widened.
 */
export const wireParticipantKindSchema = z.preprocess(
  (value) => (value === 'human' ? 'user' : value),
  participantKindSchema,
);

/**
 * Resolves a peer's kind from an inbound presence or claim frame. It prefers
 * the server-stamped `participantKind` (normalized through
 * {@link wireParticipantKindSchema}). A frame from an older server that omits
 * that field falls back to the `isAgent` boolean, which can tell 'agent' from
 * 'user' but can never report 'system'.
 */
export function participantKindFromWire(
  wireKind: unknown,
  isAgent: boolean | undefined,
): ParticipantKind {
  const parsed = wireParticipantKindSchema.safeParse(wireKind);
  if (parsed.success) return parsed.data;
  return isAgent ? 'agent' : 'user';
}

/**
 * Reads the peer-visible description a claim or presence frame carries in its
 * opaque `meta.description`. This is the single place that unpacks that field.
 * A caller that has an explicit `description` should prefer it
 * (`explicit ?? fromMeta`).
 *
 * The parameter is `unknown` because that is the honest requirement: this reads
 * one optional string off a value it does not own. Demanding the wire's open
 * record instead forced every caller holding a claim's *declared* `meta` — the
 * shape registered on `Register`'s `ClaimMeta` slot — through a conversion to
 * ask a question that never needed one.
 */
export function descriptionFromMeta(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  if (!('description' in meta)) return undefined;
  const { description } = meta;
  return typeof description === 'string' ? description : undefined;
}

/** The default a claim carries when its holder describes no work. */
export const DEFAULT_CLAIM_DESCRIPTION = 'editing';

/**
 * Resolves the peer-visible description of a claim from the places a caller may
 * have put it, falling back to a plain default.
 *
 * `reason` was this field's name before it was renamed, and the rename shipped
 * without leaving anything behind — so the wire kept accepting both spellings
 * while the SDK type quietly offered only one, and two branches "fixed" the
 * gap in opposite directions without either being contradicted by a compiler.
 * The precedence is declared once, here, and both the client and the server
 * read it from this function rather than each spelling out the same `??` chain.
 *
 * A caller whose default differs — a claim taken around a `create` describes
 * itself as `'creating'` — passes that word as `fallback`; the precedence above
 * it stays this function's.
 */
export function claimDescription(
  source: {
    description?: string | null;
    reason?: string | null;
    /** Wire-shaped or declared — see {@link descriptionFromMeta}. */
    meta?: unknown;
  },
  fallback: string = DEFAULT_CLAIM_DESCRIPTION,
): string {
  return (
    source.description ??
    descriptionFromMeta(source.meta) ??
    source.reason ??
    fallback
  );
}

/**
 * What a coordination event points at — the locator shared by all three
 * layers. It names an entity, optionally narrowed to a field or set of fields,
 * and carries opaque application metadata.
 */
export const targetRefSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  field: partNameSchema.optional(),
  /**
   * Several named parts of one row, claimed together — three sections of a
   * document, two cells of a table.
   *
   * This exists because there was no way to say it. A caller who needed it
   * packed the set into `field` as one delimited string, and the conflict rule
   * compares `field` for equality: `blocks:b_1` and `blocks:b_1,b_2` read as
   * unrelated targets, so both writers were granted a lease on `b_1` and one
   * of their updates was lost with nothing raised. A set compares as a set —
   * overlapping sets conflict, disjoint sets do not.
   *
   * `field` remains for the single-field case and is read as a set of one, so
   * a claim naming `field` and a claim naming `fields` still compare correctly
   * against each other.
   */
  fields: z.array(partNameSchema).readonly().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type TargetRef = z.infer<typeof targetRefSchema>;

/**
 * What a {@link ModelClaim} points at — the target locator as SDK callers see
 * it, keyed by `model` and `id` rather than the wire schema's `entityType` and
 * `entityId`. This is the public `ModelTarget` shape.
 *
 * Declared beside {@link targetRefSchema} because the two are the same shape in
 * two spellings, and a member added to one belongs in the other. Both are read
 * by the claim family below, so this has to
 * precede them.
 */
export const modelTargetSchema = z
  .object({
    model: z.string(),
    id: z.string(),
    field: z.string().optional(),
    /** Several named parts at once — see {@link targetRefSchema}. */
    fields: z.array(z.string()).readonly().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .readonly();
export type ModelTarget = z.infer<typeof modelTargetSchema>;

/**
 * The same locator in the spelling the wait line and the claim handle use —
 * `{ type, id }` for the entity, the sub-entity half unchanged. It is a
 * projection of {@link targetRefSchema} rather than a second declaration, so a
 * member added to the locator reaches the wait line without anyone editing it;
 * a hand-written copy here is how `fields` came to be missing from queue frames.
 */
const streamTargetSchema = targetRefSchema
  .omit({ entityType: true, entityId: true })
  .extend({ type: z.string(), id: z.string() });

// ─────────────────────────────────────────────────────────────────────────
//  Layer 3 — optimistic stale-context (the write guard)
// ─────────────────────────────────────────────────────────────────────────

/** Maximum decision-input entries one logical commit may ask the server to scan. */
export const MAX_READ_SET_ENTRIES = 500;

/**
 * The optimistic guard carried on a commit operation. `readAt` is the
 * snapshot watermark captured by `read` (null/absent ⇒ unguarded write).
 */
export const writeGuardSchema = z.object({
  readAt: logPositionSchema.nullish(),
});
export type WriteGuard = z.infer<typeof writeGuardSchema>;

/**
 * A log position, as the server reports one.
 *
 * Server-PRODUCED watermarks are constrained here; the caller-supplied
 * {@link writeGuardSchema} `readAt` deliberately is not. The asymmetry is the
 * trust direction, not an oversight: the server controls what it stamps, so
 * stating the domain costs nothing, while tightening an inbound field would
 * reject payloads the wire accepts today.
 */
const syncIdSchema = z.number().int().nonnegative();

/**
 * How a change reached the premise that fired — the three ways a record joins a
 * sync group, which is the vocabulary `RecordGroupSpec` already routes by
 * (`selfKind` / `parents` / `transitive`) rather than a fourth name for it.
 *
 * Without this a group notification can only say "something in the group you
 * read moved", and the cheapest correct response to that is to re-read the
 * whole group. `via` plus the notification's `target` narrows it to the row
 * that actually moved and how it got there, which is usually a one-row re-read.
 *
 *   • `self`       — the row that moved IS the group's scope root.
 *   • `parent`     — it sits one declared containment edge below the root.
 *   • `transitive` — the root is ≥2 hops up (`comment → item → project`).
 */
/** One compact row read carried into a later commit. */
const readRowDependencySchema = z.object({
  model: z.string(),
  id: z.string(),
  fields: z.array(z.string()).readonly().optional(),
  readAt: logPositionSchema,
});

/** One compact group read carried into a later commit. */
const readGroupDependencySchema = z.object({
  group: syncGroupRefSchema,
  readAt: logPositionSchema,
});

export const readDependencySchema = z.union([
  readRowDependencySchema,
  readGroupDependencySchema,
]);
export type ReadDependency = z.infer<typeof readDependencySchema>;

/** Bounded wire projection of one commit's reads. */
export const readDependencyListSchema = z
  .array(readDependencySchema)
  .max(MAX_READ_SET_ENTRIES);

// ─────────────────────────────────────────────────────────────────────────
//  Layer 2 — pessimistic claims and leases
// ─────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle of a claim. When absent on the wire it means `'active'` (an
 * additive back-compat default). The server stamps `'active'` on `claim_begin`
 * and emits one terminal frame — `committed`, `canceled`, or `expired` — as the
 * claim ends, so contenders learn how it resolved, not merely that it vanished.
 */
export const wireClaimStatusSchema = z.enum([
  'active',
  'committed',
  'expired',
  'canceled',
]);
export type WireClaimStatus = z.infer<typeof wireClaimStatusSchema>;

/**
 * Every lifecycle state of a claim, as a caller sees it.
 *
 * `active` is the current holder — the lock itself. `queued` is waiting in line
 * behind the holder and carries an advisory `position`. The rest are terminal
 * and drop the claim from the synced set.
 *
 * Distinct from {@link wireClaimStatusSchema}, which never carries `queued`
 * because the wire frame for a waiter is a different message. This is the one a
 * published contract describes, so it is a schema rather than a bare TS union —
 * a union cannot be derived into the API reference.
 */
export const publicClaimStatusSchema = z.enum([
  'active',
  'queued',
  'committed',
  'expired',
  'canceled',
]);
export type PublicClaimStatus = z.infer<typeof publicClaimStatusSchema>;

/**
 * @deprecated Renamed to {@link wireClaimStatusSchema} — this is the wire enum,
 * which never carries `'queued'`; the five-state public status lives in
 * types/streams. Removed in 0.36.0.
 */
export const claimStatusSchema = wireClaimStatusSchema;
/** @deprecated Renamed to {@link WireClaimStatus}. Removed in 0.36.0. */
export type ClaimStatus = WireClaimStatus;

/**
 * Server-owned grant stamps — minted once when a claim is first granted and
 * preserved verbatim across a re-announce of the same `claimId`, so neither a
 * reconnect nor a client-supplied value can move them (unlike `declaredAt`,
 * which the client sends afresh each announce). Both optional: a frame without
 * them stays valid, and the feature each backs simply does not engage.
 */
const grantStampFields = {
  /**
   * The monotonic fencing token minted for this grant (Option B). Strictly
   * increasing per entity across successive grants, so a write that carries it
   * is rejected at commit if a later holder already advanced the entity's
   * high-water. A token-less write is simply not fence-checked.
   */
  fenceToken: z.number().optional(),
  /**
   * Lease origin (epoch ms): when THIS holding was acquired. The cumulative-
   * hold ceiling measures a holder's fair share from here — and because it
   * survives a re-announce, a reconnect cannot rewind the clock.
   */
  acquiredAt: z.number().optional(),
} as const;



/**
 * A holder as the participant blocked behind them sees it: who has the row,
 * what they said they are doing, and until when.
 *
 * This is the smaller half of a claim, so it is declared first and the full
 * claim extends it — the waiter's view cannot omit a member the holder's view
 * has, because there is nowhere for it to be omitted. Listing what to keep was
 * the bug: this named `field` and not `path`, `range`, or `fields`, so a waiter
 * could see that a row was held but never which part of it, and every locator
 * member added later would have been missing here too.
 */
export const wireClaimSummarySchema = targetRefSchema.extend({
  claimId: z.string(),
  /**
   * Peer-visible description of the work being done (`'rewriting the risk
   * section to match Q3'`). The server stamps a default when a frame carries
   * none.
   */
  description: z.string().optional(),
  /** Server-stamped declaration time (epoch ms). */
  declaredAt: z.number(),
  /** Server-computed TTL deadline (epoch ms). Readers treat as advisory. */
  expiresAt: z.number(),
  /**
   * On whose authority the holder acts, and under which grant — stamped by the
   * server off the connection's credential, never accepted from the frame. The
   * same three fields the delta this claim produces will record, so "who is
   * doing this" and "who did this" answer in one vocabulary.
   *
   * On the summary rather than the full claim because this is precisely what a
   * blocked waiter needs: yielding to a colleague and queuing behind another
   * customer's agent are different decisions.
   *
   * All three optional and additive — an older server omits them, which is a
   * different fact from a holder that has no delegator.
   */
  onBehalfOfId: z.string().nullish(),
  onBehalfOfKind: wireParticipantKindSchema.nullish(),
  capabilityId: z.string().nullish(),
});
export type WireClaimSummary = z.infer<typeof wireClaimSummarySchema>;

/**
 * The full claim as its holder's own frames carry it — the waiter's view plus
 * the lifecycle and grant stamps that belong to the holding itself.
 */
const wireClaimBaseSchema = wireClaimSummarySchema.extend({
  status: wireClaimStatusSchema.optional(),
  ...grantStampFields,
});

/** Why a claim ended in a non-success terminal state. */
export const claimErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  /** Participant already holding the target (conflict rejections). */
  heldBy: z.string().optional(),
  heldByClaimId: z.string().optional(),
  heldByExpiresAt: z.number().optional(),
  /** Rich holder context for conflict rejections. Additive: older frames omit it. */
  heldByClaim: wireClaimSummarySchema.optional(),
});
export type ClaimError = z.infer<typeof claimErrorSchema>;

/**
 * Why a claim ended without its holder releasing it, or was refused.
 *
 * A closed set, because the two refusals are different guarantees and a reader
 * has to be able to tell them apart: `conflict` means someone holds the row
 * right now and you may queue behind them, while `coordination_unavailable`
 * means the coordinator could not answer, so nothing is known about the row.
 * `expired` and `preempted` are the two ways a lease you held ends.
 *
 * The rejection frame's `reason` stays a plain string on the wire — it is
 * frozen, and an older server may send a word not listed here. This is the
 * reader's side of it: a value that parses becomes the typed reason, and one
 * that does not is simply absent rather than smuggled through as prose.
 * {@link claimLostSchema} already spells its reasons as an enum; this brings
 * the refusals into line.
 */
export const claimEventReasonSchema = z.enum([
  'conflict',
  'coordination_unavailable',
  'capability_denied',
  'invalid_target',
  'expired',
  'preempted',
]);
export type ClaimEventReason = z.infer<typeof claimEventReasonSchema>;

/**
 * A declared, pending-mutation claim — the unit broadcast inside a presence
 * frame's `activeClaims`. The client supplies the descriptive `targetRef`
 * fields, a `description` of the work, and a chosen `claimId`; the server stamps
 * `declaredAt` and `expiresAt` and may set `status` and `error`. Those last
 * two are optional, so one shape serves both the server, which sets them, and
 * the leaner SDK view, which reads a claim without them.
 */
export const wireClaimSchema = wireClaimBaseSchema.extend({
  error: claimErrorSchema.optional(),
});
export type WireClaim = z.infer<typeof wireClaimSchema>;

export const claimRejectionSchema = z.object({
  claimId: z.string(),
  /**
   * Why the claim was refused, as one of {@link claimEventReasonSchema}'s
   * words — so a caller can branch on it. `conflict` means someone holds the
   * row right now and you may queue behind them; `coordination_unavailable`
   * means the coordinator could not answer, so nothing is known about it.
   * Those are different decisions, and a free string made them one.
   *
   * The wire spelling is frozen and an older server may send a word not listed
   * there, so this reads the way {@link wireParticipantKindSchema} reads its
   * dialect: a value that parses becomes the typed reason, and one that does
   * not is absent rather than smuggled through as prose. Prose has its own
   * field — `message` below — which is why nothing is lost by refusing to
   * carry it here.
   *
   * The registry code a caller finally sees on `AbloClaimedError`
   * (`claim_conflict`) stays a separate vocabulary, mapped at the throw. Two
   * small vocabularies with one mapping point beat one vocabulary and a
   * projection of it that has to be maintained as the registry grows.
   */
  reason: z.preprocess(
    (value) => (claimEventReasonSchema.safeParse(value).success ? value : undefined),
    claimEventReasonSchema.optional(),
  ),
  target: targetRefSchema.optional(),
  heldBy: z.string().optional(),
  /**
   * Whether the holder blocking this claim is a person, an agent, or the
   * system. The server already derives this from the holder's id when it
   * builds the conflict; carrying it means a caller can decide how to respond
   * — yield to a person, queue behind an agent — without parsing an opaque id
   * for a prefix and guessing. Additive: an older server omits it.
   */
  heldByKind: wireParticipantKindSchema.optional(),
  heldByClaimId: z.string().optional(),
  heldByExpiresAt: z.number().optional(),
  heldByClaim: wireClaimSummarySchema.optional(),
  message: z.string().optional(),
});
export type ClaimRejection = z.infer<typeof claimRejectionSchema>;

/**
 * The point-to-point notification sent to a holder whose lease ended without
 * a successful commit. This remains a wire-shaped target because it arrives
 * directly from the WebSocket; the schema is the single validation boundary
 * before the event reaches public `claims.onLost` listeners.
 */
export const claimLostSchema = z.object({
  claimId: z.string(),
  reason: z.enum(['expired', 'preempted']),
  target: targetRefSchema,
});
export type ClaimLost = z.infer<typeof claimLostSchema>;

/**
 * The lease is ours without waiting — the target was free when the claim
 * arrived. `fenceToken` is present whenever the coordinator minted one, and a
 * write carries it back so a lapsed lease cannot apply late.
 */
export const claimAcquiredSchema = z.object({
  claimId: z.string(),
  fenceToken: z.number().optional(),
  readAt: z.number().int().nonnegative().optional(),
  target: targetRefSchema,
});
export type ClaimAcquired = z.infer<typeof claimAcquiredSchema>;

/**
 * A queued claim reached the head of the line and the lease is now ours. The
 * shape matches {@link claimAcquiredSchema} exactly — the two frames differ
 * only in whether the caller waited — but they stay separate declarations
 * because they are separate wire contracts, and collapsing them would let a
 * change to one silently redefine the other.
 */
export const claimGrantedSchema = z.object({
  claimId: z.string(),
  fenceToken: z.number().optional(),
  readAt: z.number().int().nonnegative().optional(),
  target: targetRefSchema,
});
export type ClaimGranted = z.infer<typeof claimGrantedSchema>;

/**
 * Our claim is waiting in line behind a live holder — the same conflict
 * {@link claimRejectionSchema} reports, delivered as a wait rather than a
 * refusal, plus the caller's `position`.
 *
 * `reason` is the one member that does not carry over as required. A refusal
 * states why it refused; a wait has only ever named the conflict through
 * `heldBy`/`heldByClaim`, and no server has ever stamped `reason` on this
 * frame. Requiring it here — inherited silently by extending the rejection
 * schema — made the parse boundary reject every genuine `claim_queued` as
 * malformed the moment frame validation went in. Optional is what the wire
 * actually is, and it stays derived from the rejection field so the two cannot
 * describe the value differently.
 *
 * `position` is advisory: a privileged reorder can move it up, so a caller
 * that asserts monotonic position will fail in production. Only the arrival of
 * a grant is authoritative.
 */
export const claimQueuedSchema = claimRejectionSchema.extend({
  position: z.number(),
  reason: claimRejectionSchema.shape.reason.optional(),
});
export type ClaimQueued = z.infer<typeof claimQueuedSchema>;

/**
 * One entry in a wait-line snapshot.
 *
 * NOTE — this is the third spelling of a target locator on the wire: here it is
 * `{ type, id }`, the HTTP claim DTO uses `{ model, id }`
 * ({@link modelTargetSchema}), and the claim frames use
 * `{ entityType, entityId }` ({@link targetRefSchema}). The schema describes
 * what the server sends today rather than what it should send; unifying the
 * three is a coordinated protocol change scheduled behind the protocol version.
 * Until it happens, the translation between the spellings lives in one place —
 * `wireTarget`, `modelTarget` and `streamTarget` in ./locator.ts — so no hop
 * gets to invent a fourth.
 */
export const claimQueueEntrySchema = z.object({
  object: z.literal('claim'),
  id: z.string(),
  status: z.literal('queued'),
  target: streamTargetSchema,
  /**
   * Peer-visible description of the work. A claim may be declared without one,
   * and the public `Claim` promises the field is always there — so the default
   * lives here, applied as the frame is decoded, rather than being restated by
   * each reader.
   */
  description: z.string().default('editing'),
  heldBy: z.string().optional(),
  participantKind: wireParticipantKindSchema.optional(),
  position: z.number(),
  expiresAt: z.number(),
});
export type ClaimQueueEntry = z.infer<typeof claimQueueEntrySchema>;

/**
 * The whole wait line for one row, rebroadcast to that row's peers on every
 * queue mutation. This is what backs the reactive
 * `ablo.<model>.claim.queue({ id })` read, which is why it carries the full
 * line rather than a delta against it.
 */
export const claimQueueSchema = z.object({
  target: streamTargetSchema.pick({ type: true, id: true }),
  queue: z.array(claimQueueEntrySchema),
});
export type ClaimQueue = z.infer<typeof claimQueueSchema>;

/**
 * The two states a claim can be observed in while it still exists.
 *
 * Derived from {@link publicClaimStatusSchema} rather than spelled again: the
 * other three are terminal and drop the claim from the observable set, so a
 * listing or a peer's view can only ever see these. Extracting them by name
 * means a state added to the public vocabulary is a deliberate decision about
 * whether it is observable, not a silent omission.
 */
export const heldClaimStatusSchema = publicClaimStatusSchema.extract([
  'active',
  'queued',
]);
export type HeldClaimStatus = z.infer<typeof heldClaimStatusSchema>;

/**
 * ONE CLAIM — everything true about a lease at a moment: what it points at, who
 * holds it, what they said they are doing, where it stands, and until when.
 *
 * Every caller-facing surface that answers a question about a claim is a
 * PROJECTION of this record, never a second object: {@link modelClaimSchema} is
 * what a peer may see, and `claimStateSchema` (`claims/contract.ts`) is what a
 * caller polls about a claim of its own. Each is pinned to this record, so a
 * field added here either reaches the people it was declared for or fails to
 * compile.
 *
 * Before this, the peer-visible shape was a standalone `z.object` deriving from
 * nothing, and the polling shape was a third. That is why it took reading four
 * files to answer whether a heartbeat's progress reaches an asker — the
 * declaring surface and the observing surface were kept in step by hand, and
 * three of their shared fields had already drifted on how strictly they parse.
 *
 * What this record deliberately does NOT unify is the socket family
 * ({@link wireClaimSchema} and its base). Those carry the same claim under the
 * `entityType`/`entityId` locator rather than `model`/`id`, and they already
 * derive from one another; collapsing the two locator spellings is a wire
 * rename, not a projection.
 */
export const claimRecordSchema = z.object({
  /** The claim's identity. Spelled `claimId` where a message names a claim it
   *  is not itself, and `id` where the claim is the resource. */
  id: z.string(),
  /** Who holds it. */
  actor: z.string(),
  /** Parsed through {@link wireParticipantKindSchema}, so a legacy `'human'`
   *  frame normalizes to `'user'`. */
  participantKind: wireParticipantKindSchema,
  /**
   * On whose authority the holder acts — the same three fields, with the same
   * meanings, that `deltaAttributionSchema` records on every delta the claim
   * goes on to produce, and sourced the same way: off the credential the
   * connection authenticated with, never from the caller.
   *
   * A claim that carries only `actor` can say who is doing something and not
   * who asked for it. "What is agent a7f3 doing" is a debugging question;
   * "what is running on behalf of this customer right now" is an operations
   * question, and until these are here it is answerable only in hindsight,
   * against the audit log, after the fact.
   *
   * Null rather than absent when there is genuinely no delegator or no grant —
   * a person acting directly is their own principal, and a session holds no
   * capability.
   */
  onBehalfOfId: z.string().nullable(),
  onBehalfOfKind: wireParticipantKindSchema.nullable(),
  capabilityId: z.string().nullable(),
  /**
   * What the holder said they are doing (`'rewriting the risk section'`).
   *
   * A caller may declare it as `description`, as the older `reason`, or inside
   * `meta`; {@link claimDescription} resolves those to this one field with a
   * declared precedence, so only one of them is ever a shape.
   */
  description: z.string(),
  /** Holding the row, or waiting in line for it. */
  status: heldClaimStatusSchema,
  /**
   * Place in the wait line. Advisory: a privileged caller can reorder the
   * queue, so a position can go UP between reads — only `status` is
   * authoritative.
   */
  position: z.number().int().nonnegative(),
  /**
   * When the lease lapses without a heartbeat, in epoch milliseconds — the same
   * encoding as the WebSocket {@link WireClaim}, so one timestamp
   * representation spans the wire, the SDK, HTTP, and errors. There is no ISO
   * string anywhere.
   */
  expiresAt: z.number().int(),
  /** The grant's fencing token, minted at acquisition. Present on a claim that
   *  is held, never on one that is queued. */
  fenceToken: z.number().int(),
  /** The row, and which part of it. */
  target: modelTargetSchema,
  /**
   * The claim's metadata as an OPEN record — including what the coordinator
   * writes there rather than the holder. A heartbeat's `details` lands here as
   * `progress` (last beat wins), so an asker reads
   * `claim.state({ id })?.meta.progress`. It is presence, not a checkpoint: it
   * dies with the lease.
   *
   * This is the same bag the wire carries; what is new is that it has a home at
   * the CLAIM level. Both projections used to file it under `target` alone, and
   * `target.meta` is typed as the shape the program registered for its own claim
   * metadata — so a server-written key was unreadable there by construction:
   * `target.meta.progress` does not typecheck for any program that declared a
   * shape, and the value was arriving in a slot whose type forbids it.
   *
   * Two views of one field, each typed for its reader: `target.meta` stays the
   * holder's declared shape, and this stays open, because a peer reading someone
   * else's claim has no grounds to assume the writer's declaration.
   */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ClaimRecord = z.infer<typeof claimRecordSchema>;

/**
 * A claim as SDK callers and the HTTP claim routes see it
 * (`ablo.<model>.claim.state`, `GET /v1/claims`) — the resolved, peer-readable
 * view of one active or queued claim. The client's `ModelClaim` type derives
 * from this shape.
 *
 * Everything but the deprecated `field` is projected from
 * {@link claimRecordSchema}. Four members are optional here and required on the
 * record, and the split is the same in each case: the record says what a claim
 * IS, while a peer's view of one may legitimately have been built without them
 * — a queued claim has no `fenceToken`, a held one has no `position`, an older
 * producer sends no `status`, and a claim may be declared with no description.
 */
export const modelClaimSchema = claimRecordSchema
  .partial({
    description: true,
    status: true,
    position: true,
    fenceToken: true,
    // Additive: a server that predates the delegation trio omits all three,
    // which is a different fact from a claim that has no delegator (null).
    onBehalfOfId: true,
    onBehalfOfKind: true,
    capabilityId: true,
  })
  .extend({
    /**
     * @deprecated Read `target.field` instead, and `target.fields` for a claim
     * on several parts of the row. Removed in 0.36.0.
     *
     * This says the same thing as `target.field` and nothing keeps the two
     * agreeing, so a producer that sets one and not the other publishes a
     * claim that contradicts itself. It also cannot express a field set at
     * all, which is the reason `target.fields` exists.
     */
    field: z.string().optional(),
  })
  .readonly();
export type ModelClaim = z.infer<typeof modelClaimSchema>;

/**
 * The peer-visible view covers the record. A field added to a claim is either
 * projected to the people it was declared for, or deliberately dropped by an
 * `.omit` here — never missing because nobody remembered the second object.
 */
const _modelClaimCoversRecord: AssertExact<
  Exclude<keyof ModelClaim, 'field'>,
  keyof ClaimRecord
> = true;
void _modelClaimCoversRecord;

/**
 * The `claim_begin` payload a client sends. It carries the descriptive target
 * and a `description` of the work, an optional duration hint, and the opt-in
 * fair-queue flag. The server stamps the lifecycle and timestamp fields, so they
 * are not part of this inbound shape — this is exactly what the server validates
 * on ingest.
 */
export const claimBeginPayloadSchema = targetRefSchema.extend({
  claimId: z.string(),
  /** Peer-visible description of the work. The server stamps `'editing'` when a
   *  frame carries none. */
  description: z.string().optional(),
  /** Hint for `expiresAt`; the server caps it. */
  estimatedMs: z.number().optional(),
  /**
   * Opt into the fair wait queue. When the target is already held, the server
   * enqueues this claim in FIFO order and replies `claim_queued`, then
   * `claim_granted` later, instead of `claim_rejected`. A client that sets this
   * must be ready to handle the grant.
   */
  queue: z.boolean().optional(),
});
export type ClaimBeginPayload = z.infer<typeof claimBeginPayloadSchema>;

/**
 * The `claim_abandon` payload a client sends. `entityType` and `entityId` let
 * the server dequeue a claim that is still waiting (not yet held) from the FIFO
 * line; abandoning a claim that is already held needs only `claimId`.
 */
export const claimAbandonPayloadSchema = z.object({
  claimId: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
export type ClaimAbandonPayload = z.infer<typeof claimAbandonPayloadSchema>;

/**
 * The `claim_reorder` payload a client sends. A privileged participant, such as
 * a supervisor over its sub-agents, re-ranks the FIFO wait queue for an entity:
 * `order` lists waiters by `heldBy` and `claimId` in the desired priority, and
 * any waiter not listed keeps its relative order behind those that are. The
 * server gates who may call this and drops an unauthorized sender. Where
 * `claim_abandon` acts on the caller's own entry, a reorder acts on other
 * participants' queue positions — which is why it is gated.
 */
export const claimReorderPayloadSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  order: z.array(z.object({ heldBy: z.string(), claimId: z.string() })),
});
export type ClaimReorderPayload = z.infer<typeof claimReorderPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────
//  Heartbeat — the async / long-running-work surface of a claim.
//
//  A claim's TTL is crash cleanup, not a work-duration estimate. Work that
//  outlives it — an agent run, a background worker's job — keeps its lease by
//  BEATING: request `claim_heartbeat`, reply `claim_heartbeat_ack`. One field
//  set serves every shape; the single and batched payloads are both derived
//  from it, and the WebSocket frame and HTTP routes are two encodings of the
//  same messages. Everything long-running-work-related on the wire lives in
//  this block.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The one field set behind every heartbeat message. The single-claim payload
 * refines it; the batched payload picks from it — there is deliberately no
 * second shape to keep in sync.
 */
const claimHeartbeatFieldsSchema = z.object({
  claimId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  /** Requested extension from now; the server clamps it, and an extension
   *  never shortens a lease. */
  ttlMs: z.number().positive().optional(),
  /**
   * Lightweight progress the beat carries along ("42/100 pages") — stored
   * as the claim's `meta.progress` (last beat wins) and peer-visible via
   * `claim.state` while the lease is held. This is presence, not a
   * checkpoint: it dies with the lease. Crash-recoverable progress belongs
   * in the data itself — write a row, and every subscriber already sees it.
   */
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The `claim_heartbeat` payload a client sends to extend a lease it holds (or
 * refresh its slot in the wait queue) past the liveness window — the
 * work-duration signal for long-running holders, distinct from the connection
 * keepalive.
 *
 * The claim is identified either way: by `claimId`, or — since a claim is
 * singular per (actor, entity) — by the full `entityType`/`entityId` target
 * ("my claim on this row"). At least one of the two must be present. The
 * target also lets the server resolve without a scan and is required to
 * refresh a *queued* claim (a waiter is not in the holder set the server
 * would otherwise search).
 */
export const claimHeartbeatPayloadSchema = claimHeartbeatFieldsSchema.refine(
  (payload) =>
    payload.claimId !== undefined ||
    (payload.entityType !== undefined && payload.entityId !== undefined),
  {
    message:
      'a heartbeat must identify its claim — pass claimId, or entityType and entityId together',
  },
);
export type ClaimHeartbeatPayload = z.infer<typeof claimHeartbeatPayloadSchema>;

/**
 * The server's reply to a `claim_heartbeat`. For a socketless worker the
 * heartbeat reply is the only inbound signal path, so it carries the lease's
 * fate rather than a bare ok: `held` (extended to `expiresAt`), `queued`
 * (slot refreshed; `position` is the current place in line), or `lost` (the
 * lease expired and the queue moved on — the worker should abandon or
 * re-queue, and any write it still attempts is caught by its `readAt` guard).
 */
export const claimHeartbeatAckPayloadSchema = z.object({
  claimId: z.string(),
  status: z.enum(['held', 'queued', 'lost']),
  expiresAt: z.number().optional(),
  position: z.number().optional(),
  /**
   * How many participants are waiting in line behind a held lease — the
   * cooperative-yield pressure signal (present on `held`). A worker that can
   * checkpoint may choose to release early when others wait. Hard
   * cancellation needs no extra field: a preempted, expired, or revoked
   * lease answers the next beat with `lost`.
   */
  queueDepth: z.number().optional(),
});
export type ClaimHeartbeatAckPayload = z.infer<typeof claimHeartbeatAckPayloadSchema>;

/**
 * The batched heartbeat — one request extends every lease the caller holds
 * on its plane (the socketless twin of the WebSocket keepalive, which renews
 * all held leases on every ping). For a worker holding many rows this is one
 * round trip per cadence instead of one per claim. Queued slots are not
 * batch-refreshed: a waiter knows its target and beats it directly.
 */
export const claimHeartbeatBatchPayloadSchema = claimHeartbeatFieldsSchema.pick(
  { ttlMs: true },
);
export type ClaimHeartbeatBatchPayload = z.infer<
  typeof claimHeartbeatBatchPayloadSchema
>;

/** Reply to a batched heartbeat: one ack entry per lease that was extended. */
export const claimHeartbeatBatchAckPayloadSchema = z.object({
  results: z.array(claimHeartbeatAckPayloadSchema),
});
export type ClaimHeartbeatBatchAckPayload = z.infer<
  typeof claimHeartbeatBatchAckPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────
//  Read interest — what a connection receives
//
//  `update_subscription` replaces the connection's whole read set. It is
//  bounded by the connection credential's grant and is not a row lease;
//  row leases use `claim_begin` in the pessimistic-claims block above.
// ─────────────────────────────────────────────────────────────────────────

/**
 * How many scopes one frame may name. A coarse abuse ceiling, not a business
 * limit: a connection legitimately watches a handful of entities, and a list
 * this long is an amplification attempt rather than a workload. Declared here,
 * beside the two frames it bounds, so neither can be given a different answer.
 */
export const MAX_FRAME_SYNC_GROUPS = 200;

/**
 * The sync groups a scope-subscription frame names. Each entry is a
 * {@link syncGroupInputSchema} (`'default'` or a branded `kind:id`), so a
 * malformed group is rejected on ingest rather than silently indexed — a group
 * that does not parse matches nothing, and subscribing to nothing quietly is
 * the failure this element type exists to prevent.
 *
 * Strict because this is untrusted client input.
 */
const frameSyncGroupsSchema = z
  .array(syncGroupInputSchema)
  .max(MAX_FRAME_SYNC_GROUPS);

/**
 * The `update_subscription` payload a client sends. It replaces the
 * connection's read interest with the complete set of sync groups.
 */
export const updateSubscriptionPayloadSchema = z.object({
  syncGroups: frameSyncGroupsSchema,
});
export type UpdateSubscriptionPayload = z.infer<
  typeof updateSubscriptionPayloadSchema
>;

/**
 * `subscription_ack` payload (server → client). Echoes the connection's
 * effective read set after the update (unchanged on rejection — the update is
 * atomic). `error` is present iff `success` is false (e.g. a scoped key
 * requesting a group outside its grant). `syncGroups` is lenient
 * (`z.string()`) here, not branded: it is the server's own echo for display,
 * not untrusted input, and includes base anchors like `org:<id>`.
 */
export const subscriptionAckPayloadSchema = z.object({
  success: z.boolean(),
  syncGroups: z.array(z.string()),
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    event_id: z.string().optional(),
  }).optional(),
});
export type SubscriptionAckPayload = z.infer<
  typeof subscriptionAckPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────
//  Commit operation — carries the optimistic write-guard (Layer 3)
// ─────────────────────────────────────────────────────────────────────────

export const commitOperationTypeSchema = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'UNARCHIVE',
]);
export type CommitOperationType = z.infer<typeof commitOperationTypeSchema>;

/**
 * A single mutation in a commit batch, as it arrives on the wire. Extends the
 * optimistic `writeGuard` (`readAt`) — the structural link
 * that makes "every write is stale-guarded" legible in the type, not just in
 * prose.
 */
export const commitOperationSchema = writeGuardSchema.extend({
  type: commitOperationTypeSchema,
  model: z.string(),
  id: z.string().nullish(),
  input: z.record(z.string(), z.unknown()).nullish(),
  /** Equality conditions evaluated atomically by the writing database. */
  where: z
    .record(z.string().min(1), z.unknown())
    .refine((value) => Object.keys(value).length > 0, 'where must name at least one field')
    .nullish(),
  /** Per-op client tx id, echoed on the broadcast delta. */
  transactionId: z.string().nullish(),
  /**
   * The server-issued claim identity this operation was performed under.
   * Distinct from `transactionId`: a claim attributes and fences coordinated
   * ownership, while a transaction id correlates the resulting source echo.
   */
  claimId: z.string().min(1).nullish(),
  /**
   * The fencing token from the held claim this write belongs to (Option B).
   * Present only on a write issued under a claim that was granted one; the
   * server checks it against the entity's persisted high-water and rejects a
   * stale token. Absent (nullish) on every unclaimed write — those are governed
   * by version-CAS and the Option A blind-write guard, unchanged.
   */
  fenceToken: z.number().nullish(),
});
export type CommitOperation = z.infer<typeof commitOperationSchema>;

/**
 * Any commit operation on the wire — the runtime-validated ingest contract.
 * Commit operations carry replace (last-write-wins) semantics, guarded by the
 * optimistic write guard. It is a distinct alias from {@link CommitOperation}
 * so the server's ingest boundary reads as "any op on the wire", even though
 * the two shapes are identical.
 */
export type AnyCommitOperation = CommitOperation;

// ─────────────────────────────────────────────────────────────────────────
//  Layer 1 — presence (observation only; it never enforces)
// ─────────────────────────────────────────────────────────────────────────

export const presenceKindSchema = z.enum(['enter', 'update', 'leave']);
export type PresenceKind = z.infer<typeof presenceKindSchema>;

/**
 * What a participant is actively working on (agents fill this in).
 *
 * The two backpressure fields are part of the frame, not an extension of it:
 * an agent worker announces them on every step, and an orchestrator reading
 * peer activity routes work by them. They are declared here because a reader
 * that validates this frame would otherwise drop them on the floor — the
 * server passes both through without interpreting either.
 */
export const presenceActivitySchema = targetRefSchema.extend({
  action: z.string(),
  detail: z.string().optional(),
  /** Backpressure signal in `[0, 1]`: `0` idle, `1` at capacity. */
  loadFactor: z.number().optional(),
  /** Gate for new assignments; absent means yes. */
  acceptingNewWork: z.boolean().optional(),
});
export type PresenceActivity = z.infer<typeof presenceActivitySchema>;

/**
 * Full `presence_update` frame as the server broadcasts it. The activity +
 * `activeClaims` are the observation surface for the other two layers —
 * rendered, never acted on as enforcement.
 *
 * Open for the same reason {@link presenceUpdatePayloadSchema} is, and it has to
 * be the same in both directions: whatever vocabulary an application announces
 * through presence, it reads back off its peers' frames. A reader that parsed
 * this strictly would validate the frame and quietly discard the part the
 * application actually came for.
 */
export const presenceUpdateSchema = z.object({
  kind: presenceKindSchema,
  /**
   * Who the frame is about. Required, because every one of the five sites that
   * builds a presence frame stamps it from the connection's identity — an
   * anonymous presence frame has never been sent and would say nothing. It was
   * optional here for as long as nothing parsed the frame, and the hand-written
   * copy the transport used to carry declared it required; two descriptions of
   * one frame can disagree indefinitely while neither is ever checked.
   */
  userId: z.string(),
  syncGroups: z.array(z.string()).optional(),
  timestamp: z.number().optional(),
  status: z.string(),
  timezone: z.string().optional(),
  customStatus: z.string().optional(),
  activity: presenceActivitySchema.optional(),
  isAgent: z.boolean().optional(),
  /**
   * Server-stamped canonical kind. Additive — older servers omit it and
   * readers fall back to `isAgent` (see {@link participantKindFromWire}).
   */
  participantKind: wireParticipantKindSchema.optional(),
  activeClaims: z.array(wireClaimSchema).optional(),
  delegatedFrom: z.string().nullish(),
}).catchall(z.unknown());
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;

/**
 * @deprecated Renamed to {@link presenceUpdateSchema}. Removed in 0.36.0.
 *
 * `Frame` was the only such suffix in this vocabulary: every other frame the
 * server sends is named plainly — {@link claimLostSchema},
 * {@link claimAcquiredSchema}, {@link claimRejectionSchema} — and the client's
 * half carries `Payload`. One name did not follow the rule the other fifteen do.
 */
export const presenceUpdateFrameSchema = presenceUpdateSchema;
/** @deprecated Renamed to {@link PresenceUpdate}. Removed in 0.36.0. */
export type PresenceUpdateFrame = PresenceUpdate;

/**
 * The `presence_update` payload a client SENDS — deliberately much smaller
 * than the frame the server broadcasts back.
 *
 * Everything that identifies or situates the participant is stamped by the
 * server and cannot be declared here: `userId`, `participantKind`, `isAgent`,
 * `syncGroups`, `timestamp`, `kind`, and `delegatedFrom` all come from the
 * connection's own identity. A client that sends them is not believed — an
 * older SDK once hardcoded `isAgent: true` on every announce, and because the
 * payload was spread into the broadcast unfiltered, every human session
 * rendered to its peers as an agent. Parsing an inbound payload through this
 * schema and broadcasting the *result* is what makes that structurally
 * impossible rather than a rule the broadcast has to remember.
 *
 * `status` is a plain string, matching the outbound frame: the three canonical
 * values are conventions the presence UI understands, not a closed set the
 * protocol enforces.
 *
 * The payload is deliberately OPEN — `catchall` keeps keys this schema does not
 * name. Presence is the one frame an application extends: an agent mesh
 * announces its own coordination vocabulary through it and reads it back off
 * peer frames, without the protocol having to learn each app's words. So the
 * fields named here are validated and typed, and anything else rides along
 * untouched. Openness is not the same as trust: the server-stamped identity
 * fields are applied AFTER this payload is spread into the broadcast, so a
 * client that sends its own `userId` or `isAgent` is overwritten either way.
 */
export const presenceUpdatePayloadSchema = z
  .object({
    status: z.string().optional(),
    activity: presenceActivitySchema.optional(),
    /** The sender's own open claims, which replace what the server holds. */
    activeClaims: z.array(wireClaimSchema).optional(),
    timezone: z.string().optional(),
    customStatus: z.string().optional(),
  })
  .catchall(z.unknown());
export type PresenceUpdatePayload = z.infer<typeof presenceUpdatePayloadSchema>;
