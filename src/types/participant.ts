/**
 * Participant identity — a zero-import leaf of the type graph.
 *
 * `ParticipantRef` (and the participant-kind literals it carries) is the one
 * identity shape shared by the streams surface (`types/streams.ts`) and the
 * conflict-policy layer (`policy/types.ts`). It lives in its own leaf module —
 * importing nothing — so both layers can depend on it without forming the
 * foundation triangle `types/streams → schema/model → policy/types →
 * types/streams`. The runtime validator for the same literals stays in
 * `coordination/schema.ts` (`participantKindSchema`).
 */

/** The participant-kind vocabulary: human session, AI agent, or system actor. */
export type ParticipantKind = 'user' | 'agent' | 'system';

/**
 * Identity reference for an actor / on-behalf-of slot. Generic
 * protocol vocabulary; works for sessions, agents, and system roles.
 */
export interface ParticipantRef {
  kind: ParticipantKind;
  id: string;
}
