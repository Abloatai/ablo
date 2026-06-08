# Agent Scoped to One Deck

You want an agent that edits **one deck** and pushes realtime updates to the
people on **that deck only** — not a broadcast to the whole org. The catch most
people hit: which write reaches whom is decided by how the rows *relate*, not by
which columns the write touched. So a slide edit that never sets `deckId` still
reaches everyone viewing the deck, because the slide already belongs to it. You
get this by declaring the relationship once, then narrowing the agent to the deck
id — you never assemble a `deck:<id>` audience string by hand.

The three steps below show how to declare it, scope the agent, and write.

See [Identity & Sync Groups](../identity.md) for the full reference.

## 1. Schema — declare the relationship, once

```ts
import { defineSchema, identityRole, model, relation, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    // A deck's rows form the group `deck:<id>` (the kind comes from `scope`).
    decks: model(
      { title: z.string() },
      {},
      { orgScoped: true, scope: 'deck' },
    ),
    // A slide has no group of its own. It inherits its deck's group via the
    // `parent` edge, so a slide write reaches everyone viewing the deck.
    slides: model(
      { deckId: z.string(), body: z.string() },
      { deck: relation.belongsTo('decks', 'deckId', { parent: true }) },
      { orgScoped: true },
    ),
  },
  {
    // Humans get their full org scope automatically from these.
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
    ],
  },
);
```

## 2. Dispatch — narrow the agent to the deck it's working on

An agent can never reach more than the user who triggered it — that's the upper
limit. From there you narrow it to a single deck with `scope`. You pass the
**model and id** — `{ decks: deckId }`, never a `deck:<id>` string; the engine
builds the group from the `decks` model's `scope`.

```tsx
import { AbloProvider } from '@abloatai/ablo/react';

// The agent run is mounted on behalf of its triggering user.
<AbloProvider
  schema={schema}
  userId={triggeringUser.id}   // ceiling: can't exceed this user's reach
  scope={{ decks: deckId }}    // floor: narrowed to just this deck → deck:<deckId>
>
  {children}
</AbloProvider>
```

`scope` requests, it never grants: at connect the server intersects the groups
you ask for with the groups the identity is actually allowed, so the agent can
never reach a deck its triggering user couldn't.

## 3. Write — it fans out to everyone on that deck

Inside any component under the provider, grab the scoped client with `useAblo()`
and write. The connection is already narrowed to `deck:<deckId>` from Step 2.

```ts
const ablo = useAblo<(typeof schema)['models']>();

// Other participants subscribed to deck:<deckId> — the human in the editor,
// a reviewer agent — receive this delta in realtime. Participants on other
// decks never see it.
await ablo.slides.update({ id: slideId, data: { body: 'Q4 revenue up 12% YoY' } });
```

The slide's delta is stamped `deck:<deckId>`, derived server-side from the
slide → deck `parent` edge — not from `deckId` appearing in this particular
write, and not from whatever the agent happened to subscribe to. The routing is
decided by the data: a slide belongs to its deck, so its writes go to the deck's
group, full stop.

## See also

- [Identity & Sync Groups](../identity.md) — the full scope / parent / grants model.
- [Agent + Human](./agent-human.md) — yielding when a human edits the same row.
