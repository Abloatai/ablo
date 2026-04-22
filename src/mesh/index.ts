/**
 * @ablo/sync-engine/mesh — declarative SDK for agent-multiplayer.
 *
 * Run multiple agents on one live entity without stomping each other.
 * `mesh.join(agent, opts)` turns any agent-like object into a live
 * participant on the sync mesh — scoped by capability token, wired
 * into presence + intent + context-watermark streams, unchanged
 * otherwise. Tools, skills, prompts, models, agent orchestration stay
 * in the customer's code.
 *
 * ```ts
 * import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';
 * import { createMesh } from '@ablo/sync-engine/mesh';
 *
 * const schema = defineSchema({
 *   matters:   mutable.lazy({ name: z.string() }, { syncGroupFormat: 'matter:{id}' }),
 *   documents: mutable.lazy({ title: z.string() }, { parent: schema.models.matters }),
 * });
 *
 * // Zero-config: reads ABLO_API_KEY (+ optional ABLO_BASE_URL) from env.
 * // Org is derived from the key server-side; session-auth callers
 * // (browsers) skip the env entirely and use cookies.
 * const mesh = createMesh({ schema });
 *
 * // `id` is auto-generated (agent_<uuid>). Label is the human-readable
 * // name peers see; pass an explicit `id` only if you need to correlate
 * // the same agent across process restarts.
 * const researcher = { label: 'Q3 due diligence' };
 *
 * // Auto-connects — `participant` is live when the promise resolves.
 * const participant = await mesh.join(researcher, {
 *   scope: { matters: 'techco-acquisition' },
 * });
 * ```
 *
 * See `./api.ts` for the full `AbloClient` surface: `mesh.roles`,
 * `mesh.members`, `mesh.audit`, `mesh.capabilities`, plus the
 * participant-level `presence`, `intents`, and `context` streams.
 */

export { createMesh } from './createMesh';
export { Ablo } from './Ablo';

// ── Principal constructors — remove guesswork at the call site ────────
//
// Instead of hand-building `{ kind: 'session', id, userId, organizationId }`
// every time, callers use `session({ id, userId, organizationId })`.
// The helper is pure (no I/O) — just returns the typed ref. Keeps
// `SessionRef` / `AgentRef` shapes as an implementation detail the
// caller doesn't have to memorize.
export { session, agent } from './principal';

// ── React bindings (re-exported from `./react` for discoverability) ──
//
// The actual React implementation lives in `@ablo/sync-engine/react`.
// We re-point consumers to that entry so the mesh-only build doesn't
// pull in React. Importing from the React entry is the recommended
// pattern for React apps:
//
//   import { AbloProvider, useAblo, useParticipant }
//     from '@ablo/sync-engine/react';
//
// The mesh root doesn't re-export the React surface — keeping the two
// separate avoids accidentally pulling `react` into Node-only builds.

// ── Canonical public surface ──────────────────────────────────────────
export type {
  AbloClient,
  AbloClientBase,
  CreateMeshOptions,
  Resource,
  Page,
  Deleted,
  Principal,
  SessionRef,
  AgentRef,
  ScopedJoiner,
  ScopedJoiners,
  ScopedJoinOptions,
  ScopeRef,
  Snapshot,
  AgentLike,
  JoinOptions,
  JoinDescription,
  MeshParticipant,
  Role,
  RoleCreateParams,
  RolesResource,
  Member,
  MemberCreateParams,
  MemberListFilters,
  MembersResource,
  AuditEntry,
  AuditListFilters,
  AuditResource,
  Capability,
  CapabilityCreateParams,
  CapabilitiesResource,
  PresenceStream,
  PresenceEntry,
  PresenceTarget,
  Activity,
  EntityRef,
  IntentStream,
  IntentDeclaration,
  IntentHandle,
  IntentOptions,
  IntentRejection,
  ActiveIntent,
  Duration,
} from './api';

// ── Deprecated aliases (kept for back-compat; remove in next major) ──
export type { MeshClient, MeshClientBase } from './api';
