# Agent Scoped to One Workspace

> Narrow an agent to a single record's audience, so its writes reach that group and no one else.

You want an agent that edits **one workspace** and pushes realtime updates to the
participants on **that workspace only** — not a broadcast to the whole org. The
catch most people hit: which write reaches whom is decided by how the rows
*relate*, not by which columns the write touched. So a task edit that never sets
`workspaceId` still reaches everyone watching the workspace, because the task already
belongs to it. You get this by declaring the relationship once, then narrowing the
agent to the workspace id — you never assemble a `workspace:<id>` audience string by
hand.

The three steps below show how to declare it, scope the agent, and write.

See [Identity & Sync Groups](../identity.md) for the full reference.

## 1. Schema — declare the relationship, once

```ts
import { defineSchema, identityRole, model, relation, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    // A workspace's rows form the group `workspace:<id>` (the kind comes from `groups.root`).
    workspaces: model(
      { title: z.string() },
      { groups: { root: 'workspace' } },
    ),
    // A task has no group of its own. It inherits its workspace's group via the
    // `parent` edge, so a task write reaches everyone watching the workspace.
    tasks: model(
      { workspaceId: z.string(), title: z.string() },
      { relations: { workspace: relation.belongsTo('workspaces', 'workspaceId', { parent: true }) } },
    ),
  },
  {
    // People get their full org scope automatically from these.
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
    ],
  },
);
```

## 2. Dispatch — narrow the agent to the workspace it's working on

An agent can never reach more than the user who triggered it — that's the upper
limit. From there you narrow it to a single workspace by minting the agent's session
against **just that workspace's sync group**. You build the group from the **model
kind and id** with the typed `syncGroup` helper — `syncGroup('workspace', workspaceId)`,
never a hand-assembled `workspace:<id>` string — where `'workspace'` is the kind
declared by the `workspaces` model's `groups.root`.

Mint the scoped session on your backend (it holds the `sk_` key; the browser
never does), then hand the short-lived token to the browser client:

```ts
// server — mints a scoped agent session for one workspace
import Ablo from '@abloatai/ablo';
import { syncGroup } from '@abloatai/ablo/schema';
import { schema } from './schema';

const server = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

export async function mintProjectAgentSession(workspaceId: string, agentId: string) {
  const { token } = await server.sessions.create({
    agent: { id: agentId },
    can: { tasks: ['read', 'update'] }, // operation allowlist for this run
    syncGroups: [syncGroup('workspace', workspaceId)], // narrowed to just this workspace
  });
  return token;
}
```

```tsx
// client — the browser client carries only the scoped token.
import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from './schema';

const ablo = Ablo({
  schema,
  apiKey: async () => mintProjectAgentSession(workspaceId, agentId),
});

// The agent run is mounted on behalf of its triggering user.
<AbloProvider client={ablo} userId={triggeringUser.id}>
  {children}
</AbloProvider>
```

`syncGroups` requests, it never grants: at connect the server intersects the
groups the session asks for with the groups the identity is actually allowed, so
the agent can never reach a workspace its triggering user couldn't.

## 3. Write — it fans out to everyone on that workspace

Inside any component under the provider, grab the scoped client with `useAblo()`
and write. The connection is already narrowed to `workspace:<workspaceId>` from Step 2.

```ts
const ablo = useAblo();

// Other participants subscribed to workspace:<workspaceId> — a reviewer agent, a
// person watching in the UI — receive this delta in realtime. Participants on
// other workspaces never see it.
await ablo.tasks.update({ id: taskId, data: { title: 'Ship the Q4 report' } });
```

The task's delta is stamped `workspace:<workspaceId>`, derived server-side from the
task → workspace `parent` edge — not from `workspaceId` appearing in this particular
write, and not from whatever the agent happened to subscribe to. The routing is
decided by the data: a task belongs to its workspace, so its writes go to the
workspace's group, full stop.

## See also

- [Identity & Sync Groups](../identity.md) — the full scope / parent / grants model.
- [Agent + Human](./agent-human.md) — yielding when someone else edits the same row.
