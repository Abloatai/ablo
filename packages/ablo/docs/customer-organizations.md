# Serving Many Customers

> One account, one schema, and a session scoped to the customer whose data it may read.

Your customers live in your database, in a table you already have. Ablo reaches
one of them by the groups a session is minted with.

```ts
// 1. src/ablo/schema.ts — your customer table is a scope root.
import { defineSchema, identityRole, relation, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    // Its rows form the group `customer:<id>`; the kind comes from `groups.root`.
    customers: model(
      { name: z.string() },
      { groups: { root: 'customer' } },
    ),
    // A child inherits its customer's group through the `parent` edge.
    decks: model(
      { customerId: z.string(), title: z.string() },
      { relations: { customer: relation.belongsTo('customers', 'customerId', { parent: true }) } },
    ),
  },
  {
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
    ],
  },
);
```

```ts
// 2. app/api/ablo-session/route.ts — mint for one customer, on your backend.
import { syncGroup } from '@abloatai/ablo/schema';
import { credentialEndpointSuccessSchema } from '@abloatai/ablo/auth';
import { ablo } from '@/ablo/server';

export async function POST() {
  const member = await requireSignedInMember();

  const session = await ablo.sessions.create({
    user: { id: member.userId },
    can: { customers: ['read'], decks: ['read', 'create', 'update'] },
    syncGroups: [syncGroup('customer', member.customerId)],
  });

  return Response.json(
    credentialEndpointSuccessSchema.parse({
      token: session.token,
      expiresAt: session.expiresAt,
      credentialKind: 'ephemeral',
    }),
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
```

That is the whole integration. The rest of this page is why each line is where
it is.

## What each layer is

Four things carry a name in this arrangement, and mixing two of them up is the
one mistake worth spending a page to prevent.

| Layer | What it is | Where it lives |
|---|---|---|
| Your account | The organization you signed up with. Colleagues join it with their own logins and share one bill. | Ablo |
| Your application | A project. One per app you run, bound to one schema in your database. | Ablo |
| Your customer | A row in your own table, with your own id on it. | Your database |
| One person's session | An `ek_` your backend mints, cut to one customer's group. | Minted per sign-in |

Your customers sit in the third row. They are not accounts, because an account
is something you invite colleagues into. They are not projects, because a
project binds to a Postgres schema and you run one application, not one per
customer.

Your `sk_` already carries your account, so a session never names it. What the
session adds is which customer the person in front of it may read.

## Where the boundary is enforced

Two mechanisms do different jobs, and it is worth knowing which is which before
you rely on either.

**Your account is the tenant boundary.** Every row Ablo stores carries your
organization and project, and row-level security compares both against the
credential on every read and every write. A client cannot reach past it by
asking, because the values come from the key rather than the request.

**Sync groups are the cut inside your account.** They decide which of your own
rows a session is delivered and which it may read back over HTTP. This is the
boundary between one of your customers and the next, and it is the one your
schema declares.

Reads go through it. `list` and `get` are cut to the session's groups, live
delivery is cut to the same set, and the initial load is the intersection of
what the session asked for with what it was minted with.

Coordination reads are cut more coarsely today. Listing claims and reading
presence are scoped to your account and plane rather than to the session's
groups, so one customer's session can see that a row is claimed and who is
present, though never the row's contents. Treat row ids and participant ids on
those two surfaces as visible across your customers until this page says
otherwise.

## Naming a group

Build a group with the `syncGroup(kind, id)` helper rather than a string. The
kind is the one you declared in `groups.root`, and the id is your own
identifier for the customer.

```ts
syncGroups: [syncGroup('customer', member.customerId)]
```

Resolve `member.customerId` from the membership you just authenticated on the
server. A signed-in person can put any value in a request body, and the session
you mint is what decides what they can read.

## When a customer really is an account

There is one shape where each of your customers should be its own Ablo
organization: when each is a separate paying business that signs in to Ablo
itself, holds its own subscription, and invites its own developers. That is what
an identity provider looks like, and it is what the `organization:act-as` scope
on a secret key exists for.

It is rare, and it is not what a platform serving customers from one product
looks like. If your customers never see Ablo, they belong in your schema.

## Onboarding a customer

Insert the row. There is nothing to register with Ablo, because the group is
derived from the row's id, and the first session minted against it is delivered
its data.

Add a project only when you add an application. `npx ablo projects create` takes
a management credential from `ablo login`, and one project holds one schema.

## Troubleshooting

### A session reads nothing

Check the groups the session was minted with against the kind in `groups.root`.
A group whose kind is not declared matches nothing, which reads as an empty
database rather than an error.

### A session reads another customer's rows

Check that the model declares a `parent` edge up to the scope root. A model with
no group of its own and no parent belongs to no group, so a group cut does not
narrow it.

### The mint is refused

Naming `organizationId` reaches into a different account and takes
`organization:act-as`. A platform serving its own customers names groups
instead, and its key needs no scope at all.

## See it yourself

```
npx ablo whoami --json
```

The `syncGroups` it reports are the cut the engine will apply. If a customer's
group is missing there, no read will show its rows.

## Related guides

- [Identity & Sync Groups](/identity) — how groups are declared and resolved.
- [Sessions](/sessions) — session lifetime, refresh, and revocation.
- [API Keys](/api-keys) — credential classes and scopes.
- [Projects](/projects) — one project per application.
