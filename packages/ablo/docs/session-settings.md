# Session Settings

> Point your row-level-security policies at Ablo's writes, by naming the Postgres session settings they already read.

Ablo writes your rows through a scoped role with `row_security` on and
`NOBYPASSRLS` set, so your policies govern its writes the same way they govern
your own application's. They only govern well if they can see who the write is
for. Before each write, Ablo sets its own identity context on the transaction —
and if your policies read settings under names you chose, `sessionSettings` maps
one to the other:

```ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    invoices: model({
      total: z.number(),
      reference: z.string(),
    }),
  },
  {
    sessionSettings: { 'app.current_org': 'orgId' },
  },
);
```

A policy written against `current_setting('app.current_org')` now applies to
Ablo's write, unchanged:

```sql
CREATE POLICY tenant_isolation ON invoices
  USING (organization_id = current_setting('app.current_org', true));
```

The key is the setting name **your** policies read. The value names which piece
of Ablo's authenticated identity fills it.

## What Ablo sets on its own

Every direct write runs inside a transaction that begins by setting this
context, whether or not you map anything:

| Setting | Carries |
| --- | --- |
| `app.current_org_id` | The organization the credential acts for |
| `app.current_project_id` | The project |
| `app.current_environment` | The key's test/live trust class (`sandbox`/`production` on this compatibility surface) |
| `app.current_sandbox_id` | Legacy compatibility coordinate for older test planes; not a branch selector |
| `app.current_participant_id` | The participant making the write |
| `app.current_participant_kind` | Whether that participant is a person, an agent, or the system |
| `app.current_user_id` | The person on whose behalf the write is made |

If your policies read these names directly, you need no mapping at all — this
page is for the case where they read different ones.

`app.current_user_id` is worth reading twice, because it has three states rather
than two. It carries a person's id when a person is behind the write. It carries
`*` when a backend credential is acting as the organization itself, which is the
authority a server-side key holds. And it carries the empty string when no
identity could be established — written explicitly rather than left alone, so a
policy on a pooled connection reads absence as absence and denies, instead of
inheriting whatever the previous transaction left behind.

## What a mapping may name

The value side is a closed set, and every member is resolved by Ablo from the
authenticated key and the plane:

`orgId` · `projectId` · `environment` · `sandboxId` · `participantId` ·
`participantKind`

`environment` and `sandboxId` retain their published names for compatibility
with existing RLS policies. Current development isolation comes from the
credential's immutable branch binding; callers do not choose a sandbox or
branch through session settings.

Because none of them come from the caller, a mapping can forward the tenant
identity Ablo already trusts, but cannot widen what a writer sees. A setting name
takes exactly one source — the name is the key — so naming the same setting twice
is unrepresentable rather than something to resolve later.

## What a mapping may not name

The settings in the table above, along with `row_security`, `search_path`,
`statement_timeout`, and `lock_timeout`, are reserved. `defineSchema` rejects a
mapping onto any of them, and the engine refuses one at write time too.

The reason is worth stating plainly: those settings are how Ablo bounds its own
write. A schema that could reassign them could relax the scoping under which
Ablo writes, which would put the boundary inside the thing being bounded. Point
your policies at a name you own — `app.current_org` rather than
`app.current_org_id` — and map that.

## Reads served from the log

One arrangement cannot honour a policy that names a person. When a plane is
served from its retained log rather than from its tables, every row carries the
organization and the project, but not the owner — so a rule about who owns a row
has nothing to act on.

Rather than fold those rows and return a plausible answer, such a read is
declined whole with `user_scope_not_enforced`: a member reading a colleague's
private records would otherwise be indistinguishable from a member reading their
own. Reads made by a credential acting for the organization are unaffected, as is
every plane served from its tables.

## Related

- [Data Sources](./data-sources.md) — the writer role's privileges, and what it
  can and cannot do to your database.
- [Operating on Your Database](./operating-on-your-database.md) — which actions
  are read-only, which are reversible, and which belong to a human.
