/**
 * The proof that `createAbloReact(schema)` binds the schema generic once and
 * for all: the returned hook needs no type arguments, its no-arg form is the
 * typed client, and a selector's parameter is the typed reactive-read view.
 * There is no runtime here — `TypeProbe` exists to give the hooks a legal
 * call position, and the gate is that `tsc` accepts this file.
 */

import { createAbloReact } from '../../src/react/createAbloReact.js';
import { defineSchema, model, z } from '@abloatai/transaction/schema';
import type { Ablo } from '../../src/Ablo.js';
import type { Identical } from '../../src/local/testing/typeEquality.js';

const schema = defineSchema({
  items: model({ title: z.string(), status: z.string() }),
});

const { AbloProvider, useAblo } = createAbloReact(schema);
export { AbloProvider };

type Models = (typeof schema)['models'];

export function TypeProbe(): null {
  const ablo = useAblo();

  // The no-arg form is the fully typed client — no generics at the call site.
  const noArgIsTyped: Identical<typeof ablo, Ablo<Models> | null> = true;
  void noArgIsTyped;

  if (ablo) {
    // The schema's model keys resolve on the bound client, and the claim
    // options read the model's fields.
    void ablo.items.claim({ id: 't_1', field: 'title', queue: false });
    void ablo.items.claim({
      id: 't_1',
      contention: {
        mode: 'skip',
        onStatus(event) {
          if (event.type === 'queued') {
            event.ahead satisfies number;
          } else if (event.type === 'granted') {
            event.waited satisfies boolean;
          } else {
            event.error.code satisfies string;
          }
        },
      },
    });
  }

  // A selector's parameter is the typed reactive-read view: the model key
  // resolves and the row read is the snapshot shape.
  const title = useAblo((a) => a.items.local.get('t_1')?.title);
  const selectorIsTyped: Identical<typeof title, string | undefined> = true;
  void selectorIsTyped;

  return null;
}
