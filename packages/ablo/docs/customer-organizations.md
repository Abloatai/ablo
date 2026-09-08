# Serving Many Customers

> One application connection, customer subject rules, and sessions minted from verified membership.

For a multi-account application, keep one Ablo organization, one project for the
application, and one branch per environment. Your customers remain rows in your
own database. Their existing account IDs can identify the subjects authorized by
Ablo; they do not need corresponding Ablo account registrations.

## What each layer owns

| Layer | Meaning | Boundary |
| --- | --- | --- |
| Ablo organization | Your team's Ablo account | Outer organization authority |
| Project | Your application and its schema | Application data plane |
| Branch | An environment of that application | Connection, retained log and branch-bound credentials |
| Customer subject | An account in your application | A model rule checks the row against verified session groups |
| Session | One human or agent's granted access | Subject membership, model operations and expiry |

`organizationId` on a session names the outer Ablo organization. It does not
select an account inside your application. A model's `subject` declares that
inner boundary; session `groups` supplies the authenticated membership needed
to pass it. Routing groups alone are not row authorization.

## Declare the customer boundary

Use an explicit required account field on every customer-protected model:

```ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  conversationSummaries: model({
    accountId: z.string().min(1),
    title: z.string(),
  }, { subject: { field: 'accountId', group: 'account' }, load: 'instant' }),
});
```

The subject rule requires the session to hold `account:<row.accountId>`. Keep
account IDs from Better Auth, or another membership system, in this field.
The outer tenancy column `organization_id` retains the owning Ablo organization;
it is not a second name for the customer account field.

Push the schema to the application branch and apply subject policies through
[supported connection setup](./data-sources.md). Updating TypeScript alone does
not update the server schema, existing rows or database policies. For an existing
projection, migrate its writer and backfill as well as its model declaration.

## Mint after verifying membership

Your backend authenticates the person and verifies membership in the requested
account on every mint. Use the verified account ID, never an unchecked request
parameter:

```ts
import Sessions from '@abloatai/ablo/sessions';
import { syncGroup } from '@abloatai/ablo/schema';
import { schema } from './schema';

const sessions = Sessions({ schema, apiKey: process.env.ABLO_API_KEY! });
const session = await sessions.create({
  user: { id: verifiedMember.userId },
  groups: [syncGroup('account', verifiedMember.accountId)],
  can: { conversationSummaries: ['read'] },
  ttlSeconds: 300,
});
```

This session inherits the issuer's organization, project and branch. No
`organizationId` override or `organization:act-as` grant is needed. The model's
subject rule authorizes rows; `can` authorizes operations. A list filter merely
selects a view.

The [account multiplayer walkthrough](./examples/account-multiplayer.md) contains
the complete server membership handler, browser lifecycle and scoped server
writes. A secret-key singleton must not substitute for a subject-scoped session
when performing customer operations.

## Share one database connection

Customers with subject-protected rows in the same application branch use that
branch's connected database and schema. There is no per-customer connection
registration. Ablo serves connected-plane reads from its retained log, populated
from the database; readiness and snapshot coverage still need verification.

A Data Source is selected by organization, project and branch. Neither a subject
ID nor a routing group selects a different connection.

## Where isolation is enforced

For models with subject rules, the server checks subject membership beneath the
UI across bootstrap, known-ID and list HTTP reads, live delivery and catch-up.
Write authorization checks the row's subject too. Routing membership in another
group does not bypass the subject rule. Models without subject rules do not gain
customer isolation merely because a session names an account group.

Before enabling browser reads, test two real accounts against the deployed SDK,
server and connection configuration:

- Bootstrap exposes only the authorized account's rows.
- Reading another account's known row ID over HTTP is denied.
- Live updates and reconnect catch-up do not expose foreign rows.
- Switching accounts disposes the previous client and does not display its
  IndexedDB data in the newly authorized account.

The maintained example and authorization journeys provide runnable checks;
local tests are not evidence that a deployed fleet has the same behavior.
[Groups and shared context](./groups.md) describes cache clearing and membership
changes. An external membership change does not automatically revoke every
already-issued session, and offline cached copies cannot be remotely retracted.

## When to use separate Ablo organizations

Choose separate organizations when customers own separate Ablo accounts or need
separate outer data planes. The engine can use an unregistered organization
scope ID; this does not register an Ablo billing account or connect a database.

Cross-organization minting requires a secret key explicitly granted
`organization:act-as`. That authority can target any organization; there is no
application-customer allowlist on the grant. Normal dashboard key creation does
not grant it. It is operator-provisioned platform authority, not a prerequisite
for serving customers through the shared-application pattern above.

A cross-organization session uses the target organization's default project and
root branch. It does **not** inherit the issuer's staging branch. Its schema may
come from the issuer's project, but its data connection does not: every target
plane needs its own supported data-source setup. Sharing a schema artifact alone
does not establish shared Aurora reads.

See [Sessions](./sessions.md) for schema binding and [API keys](./api-keys.md) for
the authority and lifecycle of a platform mint key.

## Troubleshooting

**The mint is refused.** For customers inside one application, omit
`organizationId`, declare subject rules and grant verified account groups. Do
not remove the override without migrating a model that currently uses the
customer ID as its outer tenancy column.

**A session reads nothing.** Check the branch, pushed subject rule, stored account
field, granted groups and connection readiness. A schema shared across
organizations does not share the source connection.

**A session reads another customer's row.** Check the actual pushed model's
subject declaration and the session's verified groups. A parent edge, routing
group or client filter alone is not an authorization rule.
