/**
 * The identity of a participant — a person's session, an AI agent, or a system
 * actor — in the coordination protocol.
 *
 * {@link ParticipantRef} is the single identity shape shared by the streams
 * types and the conflict-policy types. It has no imports of its own, so both
 * can depend on it without creating an import cycle. The runtime validator for
 * the same participant kinds lives alongside the other coordination schemas.
 */

/** The kind of actor a participant is: a human session, an AI agent, or a system actor. */
export type ParticipantKind = 'user' | 'agent' | 'system';

/**
 * A reference to one participant: its {@link ParticipantKind} and its id. Used
 * both for the actor performing an action and for the participant it acts on
 * behalf of.
 */
export interface ParticipantRef {
  kind: ParticipantKind;
  id: string;
}
