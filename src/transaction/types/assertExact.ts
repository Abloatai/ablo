/**
 * A compile-time proof that two types are the same type, in both directions.
 *
 * This is how a derived shape is pinned to the shape it derives from. A plain
 * `extends` check only proves one side is assignable to the other, which a
 * schema that has grown a field still satisfies; both directions catch the
 * addition. Instantiating it at a value binding turns the mismatch into a
 * compile error at the definition site rather than at some distant caller.
 *
 * ```ts
 * const _contract: AssertExact<z.infer<typeof participantRefSchema>, ParticipantRef> = true;
 * ```
 *
 * The tuple wrappers stop a union operand from distributing, so a union is
 * compared whole rather than member by member.
 */
export type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
