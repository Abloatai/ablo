# Agent Scoped to One Deck

An agent that edits **one deck** and receives realtime updates for **only that
deck** — not the whole org. Shows the sync-group model end to end: a scope root,
a containment (`parent`) edge, identity roles, and the model-form `scope`.

See [Identity & Sync Groups](../identity.md) for the full reference.

## 1. Schema — declare the scope, once

```ts
import { defineSchema, identityRole, model, relation, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    // A scope root: deck rows form the group `deck:<id>`.
    decks: model(
      { title: z.string() },
      {},
      { orgScoped: true, scope: 'deck' },
    ),
    // A child: no group of its own. It inherits its deck's group via the
    // `parent` edge, so a slide write reaches everyone viewing the deck —
    // even a slide edit that doesn't touch `deckId` (routing is keyed on the
    // row's id, not the changed columns).
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

The agent inherits the triggering user's identity (its ceiling) and is narrowed
to one deck (the floor). You pass the **model and id** — never a `deck:<id>`
string; the engine builds the group from the model's `scope`.

```ts
const ablo = Ablo({
  schema,
  url: process.env.ABLO_URL,
  kind: 'agent',
  agentId: 'agent:slide-writer',
  userId: triggeringUser.id,     // ceiling: can't exceed this user's reach
  organizationId: triggeringUser.organizationId,
  scope: { decks: deckId },      // floor: just this deck → deck:<deckId>
});
await ablo.ready();
```

## 3. Write — it fans out to everyone on that deck

```ts
// Other participants subscribed to deck:<deckId> — the human in the editor,
// a reviewer agent — receive this delta in realtime. Participants on other
// decks never see it.
await ablo.slides.update(slideId, { body: 'Q4 revenue up 12% YoY' });
```

The slide's delta is stamped `deck:<deckId>` (derived server-side from the
slide → deck `parent` edge), so it reaches the deck's audience authoritatively —
regardless of which groups the agent happened to subscribe to. And `scope` only
ever *narrows*: the agent can't reach a deck its triggering user couldn't.

## See also

- [Identity & Sync Groups](../identity.md) — the full scope / parent / grants model.
- [Agent + Human](./agent-human.md) — yielding when a human edits the same row.
