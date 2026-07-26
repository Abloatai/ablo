# Branch-first development

> Understand exactly what `ablo dev` prepares, what it watches, and how each Git branch gets an isolated Ablo schema and credential.

`ablo dev` is Ablo's schema-development loop. It prepares an isolated Ablo
branch for the Git branch you are working on, gives your local application a
short-lived credential for that branch, pushes the schema, and keeps the schema
registered as you edit it.

It does **not** start your application or run database migrations.

The everyday setup is two terminals:

```bash
# Terminal 1: your application
npm run dev

# Terminal 2: Ablo's schema loop
npx ablo dev
```

## The mental model

```text
Git branch
    │
    │  npx ablo dev
    ▼
Ablo branch
    ├── active schema artifact
    ├── isolated transaction plane
    ├── immutable branch id
    └── expiring sk_test_ credential
              │
              ▼
        gitignored .env.local
              │
              ▼
       your local application
```

A branch name is a human handle. The credential carries the immutable Ablo
branch id, so application requests cannot switch branches by changing a slug or
request parameter.

Production is the root branch. Development branches are children; they do not
inherit production write authority.

## Before the first run

Initialize the project and sign in:

```bash
npx ablo init
npx ablo login
```

Login stores one project-scoped `mk_` management credential. It has no
production/test mode and no application-data authority. It can manage projects
and branches and exchange for an expiring credential bound to one branch.

If you switch projects, log in for the selected project before running `dev`:

```bash
npx ablo projects use orders
npx ablo login --project orders
```

## What happens when you run it

Given:

```bash
git switch -c feature/order-approval
npx ablo dev
```

Ablo performs these steps.

### 1. Discover the branch

The first available source wins:

1. `--branch <name>`
2. `ABLO_BRANCH`
3. GitHub's `GITHUB_HEAD_REF` or `GITHUB_REF_NAME`
4. Vercel's `VERCEL_GIT_COMMIT_REF`
5. GitLab's `CI_COMMIT_REF_NAME`
6. the current local Git branch

The reference is normalized into a lowercase plane-safe slug:

```text
feature/order-approval  →  feature-order-approval
Feature: Billing V2     →  feature-billing-v2
```

Long names are shortened with a stable hash, so the same Git branch resolves to
the same Ablo branch on every machine.

### 2. Ensure the Ablo branch

The CLI lists branches for the active project and reuses one with the same slug.
If none exists, it creates a child of the project's production root.

Creation is idempotent: two CI jobs racing to ensure the same branch converge on
the same server record.

At creation, the child receives its own copy of the parent's active schema.
Later production schema pushes do not silently change an in-flight feature
branch.

### 3. Exchange for a temporary credential

The stored `mk_` credential authorizes the branch-management call. The server then
returns a new `sk_test_` credential bound only to the child branch.

The default lifetime is eight hours:

```bash
npx ablo dev --branch-ttl-hours 12
```

Allowed values are 1–168 hours. Rerunning `ablo dev` mints a fresh credential.
This lifetime belongs to the credential, not the branch. The branch persists
until `ablo branch delete` or preview automation removes it.

Temporary branch credentials can read, write, and push schema on their own
branch. They cannot create or delete siblings, mint sibling credentials, or
obtain production authority.

### 4. Wire the local application

The temporary credential is written to:

```dotenv
# .env.local
ABLO_API_KEY=sk_test_...
```

The CLI creates `.env.local` with owner-only permissions when possible and adds
it to `.gitignore` if it is not already ignored. The key is not added to Ablo's
long-lived credential store.

Most application frameworks load `.env.local` automatically. Plain Node can
load it explicitly:

```bash
node --env-file=.env.local app.ts
```

An `ABLO_API_KEY` exported in your shell overrides `.env.local` for child
processes. `ablo dev` warns when it detects that mismatch. Unset the exported
value before starting the application:

```bash
unset ABLO_API_KEY
npm run dev
```

### 5. Load and push the schema

By default, the CLI imports:

```text
ablo/schema.ts
```

and reads its `schema` export. Override either:

```bash
npx ablo dev \
  --schema src/ablo-schema.ts \
  --export appSchema
```

The schema is serialized and uploaded to the selected branch. The server
compares it with that branch's active artifact and returns either:

- unchanged, with the current version;
- activated, with a new version and hash; or
- rejected, with the incompatible changes and the required next action.

`push` registers a contract. It does not execute DDL.

### 6. Watch for edits

After the first successful push, `ablo dev` watches the schema module. Editor
write/rename bursts are debounced into one reload and one push.

Stop it with `Ctrl-C`.

For a single branch preparation and push:

```bash
npx ablo dev --no-watch
```

## Command reference

```bash
# Discover from Git and watch
npx ablo dev

# Choose the branch explicitly
npx ablo dev --branch preview-pr-482

# Push once
npx ablo dev --no-watch

# Change the temporary-key lifetime
npx ablo dev --branch-ttl-hours 24

# Use another schema module/export
npx ablo dev --schema db/ablo.ts --export schema

```

Lower-level branch operations are also available:

```bash
npx ablo branch list
npx ablo branch status feature-orders
npx ablo branch check feature-orders
npx ablo branch create feature-orders
npx ablo branch ensure preview-pr-482 --credential --ttl-hours 168 --json
npx ablo branch credential br_... --ttl-hours 8
npx ablo branch delete br_...
```

Automation should retain immutable ids returned by the API. Slugs are for
people and discovery.

`branch status` and `branch check` are aliases. They show lifecycle state, the
active schema and hash, compatibility with the parent schema, the bound
database's safe coordinates, and an exact readiness fix.

## CI and preview deployments

For a one-shot CI schema check:

```bash
# Store the project management credential as the masked secret.
ABLO_MANAGEMENT_KEY="mk_..." \
ABLO_BRANCH="preview-pr-${PR_NUMBER}" \
  npx ablo dev --no-watch
```

For infrastructure that needs the credential response directly:

```bash
npx ablo branch ensure "preview-pr-${PR_NUMBER}" \
  --kind preview \
  --credential \
  --ttl-hours 168 \
  --json
```

`--credential` explicitly requests plaintext secret material. Treat the JSON
result as a secret, mask it in logs, and pass it through the deployment
provider's secret-variable mechanism.

Closing a preview should call `branch delete`. Deletion immediately makes
branch-bound credentials fail authentication even if their expiry is later.

## Managing branches in Sync Web

The persistent dashboard header selects a project and then one branch inside it. The
selection scopes API keys, Schema, Audit log, and Server log. Production is the
protected root; every other item is a named development branch.

Use the **Branches** page to create, select, inspect, or delete a branch.
Deleting a child revokes all of its credentials first, removes its datasource
connection material, and then removes it from discovery. It never deletes a
sibling, the production root, customer tables, or retained schema history.

See [Ablo branch lifecycle](../../../docs/explainers/branch-lifecycle.md) for
the complete project/branch mental model and dashboard journey.

## Your database and migrations

There are two independent contracts:

```text
Your ORM/migration tool     owns tables, columns, relations, and DDL
Ablo schema                 owns the coordination contract for synced models
```

`ablo dev` currently isolates the Ablo branch and schema. It does not:

- run Prisma, Drizzle, or SQL migrations;
- create a Neon/Supabase/RDS database branch;
- copy production data;
- automatically register whichever `DATABASE_URL` happens to be present.

The last point is a safety boundary. A generic `DATABASE_URL` does not prove
that the database is an isolated feature branch; automatically registering it
could bind a development credential to production.

Until provider-verified database-branch binding lands, use Ablo's hosted branch
plane for the inner loop or explicitly prepare and review an isolated database
through [Connect Your Database](./data-sources.md). Never point a child branch at
production merely because its migrations are compatible.

## Production rollout

There is intentionally no `branch merge` that promotes child rows or logs.

Production rollout remains:

1. Merge code and migration files through Git.
2. Run the reviewed migration against the production database.
3. Push the production/root Ablo schema through the deployment workflow.
4. Deploy the application.

The feature branch proves the change. It does not become production.

## Troubleshooting

### “Creating a development branch needs the active project CLI key”

Run:

```bash
npx ablo login
```

For a non-default project:

```bash
npx ablo login --project <project>
```

If `ABLO_API_KEY` is exported, it overrides the stored login key. Unset it when
you want the CLI to use the active project's stored profile.

### “Branch credentials cannot manage branches”

You supplied a temporary child credential to a management command. Branch
runtime credentials are deliberately leaf authority. Unset the override and let
the CLI use the project login key.

### Check the whole branch

```bash
npx ablo branch check feature-order-approval
```

The result distinguishes a missing schema, a branch lifecycle failure, and an
unready connected database. A hosted branch is a valid development state and
is reported explicitly rather than as a missing database.

### The app still reaches another plane

Check for an exported variable:

```bash
env | grep '^ABLO_API_KEY='
```

An exported value wins over `.env.local`. Unset it and restart the application
process so the framework reloads `.env.local`.

### `server_execute_unknown_model`

The active branch does not have the schema containing that model. Keep
`ablo dev` running, or push once:

```bash
npx ablo dev --no-watch
```

Confirm that `--schema` and `--export` point at the module your application
uses.

### Git branch discovery fails

Detached checkouts may not expose a local branch. Pass the intended name:

```bash
npx ablo dev --branch preview-pr-482
```

or set `ABLO_BRANCH` in CI.

## Related guides

- [Quickstart](./quickstart.md) — install, connect, define a schema, and write.
- [CLI](./cli.md) — the complete command surface.
- [Schema Contract](./schema-contract.md) — what the registered schema controls.
- [Connect Your Database](./data-sources.md) — Postgres roles, WAL, and database ownership.
- [Deployment](./deployment.md) — production schema rollout.
