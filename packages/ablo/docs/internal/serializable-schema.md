# A `Schema` is serializable

A `Schema` (output of `defineSchema`) is JSON-serializable except for two
things, both of which are client-only:

- **Zod validators:** `model().schema` / `.shape`, `Schema.validators`. Used
  by the client for type inference + validation. The server never reads them
  (it checks `information_schema.columns` and does no field-shape validation in
  the commit path).

Everything the server reads — `typename`, `tableName`, `mutable`, `load`, the
canonical `tenancy` descriptor (the `policy` authoring option is normalized away
at build), bootstrap hints, `relations` (`foreignKeyColumn`), field names, and
`identityRoles` — is plain data.

## Identity roles are pure data

```ts
interface IdentityRole {
  kind: string;
  template: string;            // 'org:{id}'
  source: IdentityRoleSource;  // { field: 'organizationId', multi: false }
}
```

The runtime behaviour lives in `extractIdentityIds(identity, source)`, a pure
function `composeIdentitySyncGroups` calls once per role. `identityRole({ kind,
template, source, multi? })` is the factory. Absent/falsy fields yield `[]`, so
a role whose field isn't present (a user with no `teamIds`) is a silent no-op —
org-only, org+user, and org+team are just different `identityRoles` arrays, not
different code paths. The engine ships zero prefixes; `org:`/`user:`/`team:`
live only in `ablo.schema.ts`.

## Why this matters

Because a `Schema` carries no closures, the same object works in-process and,
for a hosted multi-tenant server, after being reconstructed from JSON over the
control plane (the GraphQL `printSchema` / `buildSchema` model). One type,
both places — no separate server-side schema type.

`apps/sync-server` reads the live `schema` directly today
(`buildModelMap(schema)`, `composeIdentitySyncGroups` via the `@ablo/schema`
wrapper).

## Trust boundary

Never trust a client-connection schema for authz (Zero/Convex/Instant). A
client connection may carry only the schema **version** for compatibility
gating; the authoritative `Schema` arrives over an authenticated control-plane
path. The identity passed to `composeIdentitySyncGroups` is server-resolved
trusted claims.

## Wire form (`serialize.ts`)

`serializeSchema(schema): string` / `parseSchema(json): Schema` are the
control-plane transport — the GraphQL `printSchema`/`buildSchema` model. The
JSON (`SchemaJSON`, envelope `{ v, models, identityRoles }`) carries every
model's routing/scoping metadata, relations (incl. resolved
`foreignKeyColumn`), field metadata, and identity roles. `parseSchema` rebuilds
each model's Zod permissively from `FieldMeta` (the server does no field-shape
validation) and drops `computed` closures. `schemaHash(schema)` is the stable
FNV-1a content hash used for connect-time gating. Round-trip tested in
`__tests__/serialize.test.ts`.

## Storage + runtime resolution (`apps/sync-server/src/schema/`): built

- **`ablo_schemas` table** (`packages/database/prisma/models/sync.prisma`,
  `SchemaArtifact`) — `(organizationId, version, schemaJson, schemaHash, state,
  error, createdBy, createdAt, activatedAt)`, unique `(orgId, version)`. State
  `pending|validated|active|overwritten|failed`, ≤1 active per tenant (Convex
  `_schemas` machine; Zero's "row in the operational DB"). *Migration written,
  not applied — 0 users, Neon direct-endpoint rule.*
- **`pgSchemaStore` / `memorySchemaStore`** (`schemaStore.ts`) — mirrors
  `pgApiKeyStore`. `insertPending` assigns `MAX(version)+1`; `activate` is a
  transaction that demotes the current active → `overwritten` then promotes the
  target. State-machine invariants tested.
- **`createSchemaRegistry(store)`** (`schemaRegistry.ts`) — `load(orgId)` parses
  the active artifact's `schemaJson` to a `Schema` and caches it (shared
  in-flight promise across concurrent cold loads); `invalidate(orgId)` busts it
  on activation (Convex `schema_registry`). This is the seam that turns the
  boot-time `import { schema }` into per-tenant runtime resolution.

## Push route (`apps/sync-server/src/routes/schema.ts`): built

`POST /api/schema`, mounted in `index.ts` (`schemaRoutes({ provider, store,
registry })`). Auth: secret `sk_` key carrying the `schema:push` scope —
`Identity.scopes` was added and `apiKeyProvider` now populates it from the key
row's `scopes` column (restricted `rk_` keys get no `scopes`, so they're
excluded). Tenant comes from `identity.organizationId`, never the body. Flow:
read `{ schema, force? }` → validate via `parseSchema` (throws → 400) →
authoritative hash via `schemaHash(parsed)` → reject removed-model changes (409)
unless `force` → no-op fast path on identical hash (200) → `insertPending` →
`activate` → `registry.invalidate(org)` → 201 `{ schemaId, version, hash }`. 6
route tests.

## CLI (`packages/ablo-cli`): built

`ablo push` (`src/push.ts`, dispatched from `index.ts`). Imports the
user's `sync/schema.ts` at runtime via tsx's `tsImport` (the real object —
`migrate`'s regex parse can't produce a faithful AST), then `serializeSchema`
+ `schemaHash` and POSTs `{ schema, force, renames }` to `POST /api/schema`
with `Authorization: Bearer $ABLO_API_KEY`. Flags: `--schema`, `--export`,
`--url` (`$ABLO_API_URL`, default `https://api.abloatai.com`), `--force`,
`--rename old:new` (repeatable). The route honors `renames` so a renamed model
isn't flagged as a removed-model incompatibility. `parsePushArgs` unit-tested.

## Schema drift is advisory

Bootstrap includes the tenant's active schema hash. The client compares it to
its built-in hash and warns once when they differ. Hash drift never closes the
WebSocket: an additive rollout must allow old and new clients to overlap while
data is expanded, dual-read/written, backfilled, verified, and finally
contracted. Breaking wire shapes use the protocol-version codec registry
instead.

## Not built yet
- **Switch the hot paths to per-tenant `registry.load(org)`:** boot still does
  the single-tenant `import { schema }`; `buildModelMap`/bootstrap/commit
  reading the registry per request is the final multi-tenant wiring.
