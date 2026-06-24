# Projects

A **project** is the isolation unit inside your organization — the shape you
know from Neon or Supabase. Each app you build gets its own project, and each
project gets its own schema, its own sandbox/production data planes, and its
own API keys. Two teams in one org can ship two apps that never see each
other's models, keys, or rows.

```text
organization
├── project: default          ← every org has one; pre-project apps live here
│   ├── schema (sandbox + production artifacts)
│   ├── data planes (registered databases)
│   └── keys (sk_/rk_/ek_/pk_)
└── project: my-app           ← npx ablo init creates this for a new app
    ├── schema
    ├── data planes
    └── keys
```

## The default project

Every organization has a **default** project. If you never create another
one, everything works exactly as if projects didn't exist — your keys, schema
pushes, and registered databases all belong to it. Keys minted before
projects existed are default-project keys automatically.

## Keys belong to exactly one project

A key's project is fixed at mint and can never be changed or overridden —
the same discipline as its sandbox/production mode. Everything a key mints
inherits its project: the short-lived session credentials (`ek_`), agent
keys (`rk_`), everything. There is no way to "switch projects" with an
existing key; you use a key minted for the project you mean.

Schema pushes, database registrations, reads, and writes all act on the
**key's** project:

- `npx ablo push` activates the schema for the pushing key's project — it
  can never demote another project's schema.
- Registering a database (`DATABASE_URL`) attaches it to the key's project
  and environment.
- A write or read against a model that belongs to **another** project in
  your org fails with a typed `project_scope_denied` — never a silent empty
  result, and never the misleading "unknown model, run ablo push".

## Sandboxes belong to a project

Production is singular per project; sandboxes are many. Each sandbox of a
project gets its **own data plane** (its own registered dev database) but
they all share the project's **one** sandbox schema — pushing the same
schema from a second sandbox doesn't create a second artifact, it just
provisions that sandbox's database.

## CLI

`npx ablo init` creates a project for your app automatically (slug derived
from your `package.json` name; `--project <slug>` to choose, `--no-project`
to stay on the org default). Manage projects any time:

```bash
npx ablo projects list             # all projects (default first)
npx ablo projects create my-app    # create one (--name "Display Name")
npx ablo projects use my-app       # set the ACTIVE project locally
npx ablo projects use default      # back to the org default
npx ablo status                    # shows the active project
```

The active project is a local targeting preference (stored next to `mode` in
your CLI config): new keys you mint pick it up. It never changes what an
existing key can reach — a key's project scope is decided server-side at
mint.

## API

Projects are a Stripe-shaped control-plane resource, authenticated with a
secret (`sk_`) key:

```bash
curl https://api.abloatai.com/api/v1/projects \
  -H "Authorization: Bearer $ABLO_API_KEY"            # list

curl https://api.abloatai.com/api/v1/projects \
  -H "Authorization: Bearer $ABLO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"slug": "my-app", "name": "My App"}'           # create
```

A create with a taken slug fails with `project_slug_taken` (409). Reads of
another org's project ids 404 — never confirm existence across orgs.

## Errors

| Code | Status | Meaning |
|------|--------|---------|
| `project_scope_denied` | 403 | The model/resource belongs to another project in your org — use a key minted for that project. |
| `project_slug_taken` | 409 | A project with this slug already exists in the organization. |
