/**
 * A reference to one field of one model — the field as a value rather than as
 * a quoted name.
 *
 * A model is declared as Zod schemas keyed by name, so a field's name lives on
 * the object key and never on the value: `model({ status: z.enum([...]) })`
 * gives you nothing to point at, and every surface that needs to name a field
 * has had to quote it. `fields: ['titel']` then compiles, is granted, excludes
 * nobody, and leaves the write of `title` unguarded — the conflict rule
 * compares names as opaque strings, so an invented one matches no other claim
 * and nothing reports it.
 *
 * {@link Schema.fields} carries one of these per field, stamped from the key
 * `defineSchema` is already holding. Referencing a field that does not exist
 * stops compiling, and renaming one is a compile error at every use rather than
 * a claim that quietly stops matching.
 *
 * An object rather than a branded string, for the reason `ClaimPart` is one: a
 * brand makes a concrete schema's claim params mutually unassignable with the
 * erased `SchemaRecord` view, and the react context boundary erases and
 * restores exactly that way. Objects stay pairwise comparable across it, which
 * a union of literal keys does not — function parameters are contravariant, so
 * a claim accepting `'title' | 'status'` is not assignable to one accepting
 * `string`.
 *
 * `model` rides along so a reference carries where it came from. Claiming
 * `users.email` through `ablo.tasks` is a mistake nothing can currently see.
 */
export interface FieldRef<
  Model extends string = string,
  Field extends string = string,
> {
  /** The schema key of the model this field belongs to. */
  readonly model: Model;
  /** The field's own name — the key it was declared under. */
  readonly field: Field;
}

/** Whether a value is a {@link FieldRef}. */
export function isFieldRef(value: unknown): value is FieldRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FieldRef).field === 'string' &&
    typeof (value as FieldRef).model === 'string'
  );
}

/** Build the reference for one declared field. */
export function fieldRef<
  const Model extends string,
  const Field extends string,
>(model: Model, field: Field): FieldRef<Model, Field> {
  return { model, field };
}

/** The fields of one model as selectable values. */
export type FieldSelection<T> = {
  readonly [K in Extract<keyof T, string>]: FieldRef<string, K>;
};

/**
 * A model-bound field selector. The callback receives only the fields inferred
 * from that model's Zod shape, so selection is property access rather than a
 * quoted name.
 */
export type FieldSelector<T> = (
  fields: FieldSelection<T>,
) =>
  | FieldRef<string, Extract<keyof T, string>>
  | readonly [
      FieldRef<string, Extract<keyof T, string>>,
      ...FieldRef<string, Extract<keyof T, string>>[],
    ];

/**
 * Build the lazy selector object used by model operations. A Proxy avoids
 * materializing another field registry in each client; runtime authority still
 * validates the selected names against the active Zod-derived model map.
 */
export function fieldSelection<T>(model: string): FieldSelection<T> {
  return new Proxy(Object.create(null) as FieldSelection<T>, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      return fieldRef(model, property);
    },
  });
}
