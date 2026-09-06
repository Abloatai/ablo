/** Consumer proof against the built public entry point, with no Register augmentation. */
import {
  Ablo, AbloProvider, createAbloReact, useAblo, useMutators, useUndoScope,
} from '@abloatai/ablo/react';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({ items: model({ title: z.string() }) });
const differentSchema = defineSchema({ users: model({ name: z.string() }) });
const binding = createAbloReact(schema);
type Models = (typeof schema)['models'];
type Row = Ablo.Schema.InferRow<typeof schema, 'items'>;

export function TypeProbe() {
  const client = binding.useAblo();
  client satisfies Ablo<Models> | null;
  // @ts-expect-error A bound client must not invent another model.
  client?.users.local.get('user-1');

  const title = binding.useAblo(ablo => ablo.items.local.get('item-1')?.title);
  title satisfies string | undefined;
  // @ts-expect-error Preserve the selected field's type.
  title satisfies number;
  // @ts-expect-error A selector must reject an unknown field.
  binding.useAblo(ablo => ablo.items.local.get('item-1')?.unknownField);

  const status = binding.useAblo(ablo => ablo.status);
  status satisfies Ablo.Status | undefined;
  useAblo(ablo => ablo.status) satisfies Ablo.Status | undefined;
  useAblo(ablo => ablo.presence.others) satisfies readonly Ablo.PresenceSession[] | undefined;

  const result = binding.useAblo(ablo => ablo.items, 'item-1');
  result satisfies useAblo.Result<Row>;
  // @ts-expect-error A row without an initial value may be missing.
  result.data.title satisfies string;
  const initial = { id: 'item-1', title: 'Server title' } satisfies Row;
  const options = { initial } satisfies useAblo.Options<Row>;
  const hydrated = binding.useAblo(ablo => ablo.items, 'item-1', options);
  hydrated.data?.title satisfies string | undefined;
  // @ts-expect-error A local deletion can remove even an initially seeded row.
  hydrated.data.title satisfies string;

  binding.usePresence(ablo => ablo.items, 'item-1') satisfies readonly Ablo.PresenceSession[];
  return null;
}

export function Wrapper(props: AbloProvider.Props<Models>) {
  return <AbloProvider {...props} />;
}

export function WrongProvider({ client }: { client: Ablo<(typeof differentSchema)['models']> }) {
  // @ts-expect-error The typed provider must reject a different schema's client.
  return <binding.AbloProvider client={client}><TypeProbe /></binding.AbloProvider>;
}

export function Annotations(
  options: Ablo.Options<Models>,
  reads: Ablo.Reads<Models>,
  undo: useUndoScope.Result<typeof schema>,
  mutations: useMutators.Result<{ items: { rename: (input: { args: string }) => Promise<number> } }>,
) {
  const mutationOptions = { undoScope: undo.scope } satisfies useMutators.Options<typeof schema>;
  mutations.items.rename('title') satisfies Promise<number>;
  // @ts-expect-error Mutation arguments must retain their inferred type.
  mutations.items.rename(123);
  return { options, reads, mutationOptions };
}
