# @abloatai/cli

## 0.43.0

### Minor Changes

- be1a806: Credential lookup follows the order mature CLIs use: the process `ABLO_API_KEY` first, then an explicit `--env-file <path>`, then the stored credential. Read-only diagnostics may inspect `.env.local`; mutations require explicit selection. `logs` follows the branch bound to the key it runs with, which removes `--mode`; `connect rotate` re-keys the existing database roles in place and reuses the replication slot, so recovering a connection never drops roles or touches the database by hand.

### Patch Changes

- @abloatai/transaction@0.43.0
- @abloatai/humans@0.43.0

## 0.42.0

### Minor Changes

- 78b096a: `ablo whoami` answers what a key acts on, server-confirmed. Where `status` is the broad health report and deliberately degrades when the server cannot confirm identity, `whoami` either returns the confirmed organization, project, and branch or fails. Run it before a `connect` or `deregister` instead of inferring a key's scope from a failed mutation.

  Re-pushing an unchanged schema no longer fails. The unchanged-schema fast path now defers provisioning exactly like a changed push, so a second `ablo push` on a plane with nothing to do succeeds instead of being refused.

### Patch Changes

- @abloatai/transaction@0.42.0
- @abloatai/humans@0.42.0

## 0.41.0

### Patch Changes

- 0030974: An unrecognized command now fails with the name it did not recognize and, when a plausible target exists, the command to use: a typo lands on the intended command, and a wrong-but-reasonable name like `disconnect` points at `ablo connect deregister`. It used to print the full help and exit zero.

  `connect apply` consults the locate preflight before touching the database: when another plane already holds the source it refuses with exit 1, names `ablo connect deregister` as the way out, and leaves the customer database untouched. Registering a connection string without a password is refused at the boundary with the field named, rather than failing later as a masked server error.
  - @abloatai/transaction@0.41.0
  - @abloatai/humans@0.41.0

## 0.40.0

### Minor Changes

- 87b9797: Every CLI command that talks to Ablo's control plane now goes through one typed HTTP client, and failures reach you as named `cli_` error codes with plain-language messages instead of raw transport errors: a missing API key says how to log in, an unreachable database says what refused the dial. Setting `ABLO_JSON=1` switches command output to a machine-readable form for agents and scripts.

### Patch Changes

- @abloatai/transaction@0.40.0
- @abloatai/humans@0.40.0

## 0.39.0

### Patch Changes

- @abloatai/transaction@0.39.0
- @abloatai/humans@0.39.0

## 0.38.0

### Minor Changes

- fae876d: Make Ablo branch-first across its transaction API, credentials, CLI, live
  clients, and dashboard. Development and preview work now uses isolated,
  immutable branch identities instead of a shared Sandbox mode. `ablo dev`
  discovers or accepts a branch, ensures it, mints an expiring credential, wires
  the local environment, and pushes the schema.

  Source adapters and PostgreSQL footprint helpers now select immutable branches.
  Callers constructing `FootprintPlane` or `SourceRequestContext` must replace
  `environment`, `mode`, and `sandboxId` with `branchId`.

  Add stable OpenAPI operation names and shared wire schemas as the foundation
  for generated language SDKs. Add explicit PostgreSQL adapter profiles and a
  validated adapter factory for Prisma, Drizzle, and Kysely integrations.

  Add runnable Temporal and Inngest integration examples that keep durable
  workflow execution in those systems while routing shared-data reads, claims,
  idempotent writes, settlement, and observation through Ablo.

  Add `@abloatai/ablo/ai-sdk` model tools for authoritative reads, idempotent
  creates, concurrency-safe updates, and claimed deletes. Remove the previous
  `coordinatedTool` API and narrow the internal agent package to composition and
  perception adapters instead of owning runtimes, sandboxes, prompts, providers,
  or application tools.

### Patch Changes

- Updated dependencies [fae876d]
  - @abloatai/transaction@0.38.0
  - @abloatai/humans@0.38.0

## 0.37.1

### Patch Changes

- Updated dependencies [5344da6]
  - @abloatai/humans@0.37.1
  - @abloatai/transaction@0.37.1

## 0.37.0

### Minor Changes

- f60ed16: Harden browser authentication around one typed credential endpoint contract,
  full-plane persistence isolation, awaited terminal cleanup, actual credential
  expiry, and least-privilege human sessions.

  Human session minting now requires a non-empty schema-typed `can` grant. It
  accepts concrete model operations and has no all-data wildcard. Browser
  credentials remain short-lived, refreshable, and isolated from long-lived
  server secrets.

  Endpoint URLs move from `apiKey` to `authEndpoint`. The canonical session and
  capability mint routes are `/v1/ephemeral_keys` and `/v1/capabilities`; legacy
  route aliases are removed.

  Credential providers now use the `CredentialProvider` type. The former
  `ApiKeySetter` export is removed.

- 08a3cad: Launch the branded Ablo package as the single package application developers
  install. The root serves headless HTTP callers, while `/client` and `/react`
  serve WebSocket-backed reactive applications.

  The public surface now provides:

  - `@abloatai/ablo` for agents, services, workers, jobs, and backend code;
  - `@abloatai/ablo/client` for live local state;
  - `@abloatai/ablo/react` for React bindings;
  - branded schema, source-adapter, server, authorization, coordination, and wire
    subpaths; and
  - `/source/next`, `/source/drizzle`, `/source/kysely`, and
    `/source/conformance` for Data Source integrations.

  Authoritative reads use `model.get({ id })`; reactive snapshots use
  `model.local.get(id)`.

  Ablo is now presented as the transaction and coordination API for state
  operated by humans, services, tools, and AI agents. Realtime synchronization
  remains available as a client capability rather than defining the product.
  Live applications no longer accept HTTP transport configuration, and the old
  sync-engine package and compatibility paths are removed.

  The public repository preserves the workspace structure used for development
  instead of flattening sources into a generated package. The branded banner,
  documentation, examples, license, notices, and release automation remain part
  of the repository.

  The new package pages direct application developers to the branded Ablo
  entrypoints while still documenting where integration authors can find the
  lower-level transaction and interactive-client contracts.

### Patch Changes

- Updated dependencies [f60ed16]
- Updated dependencies [16cc7d1]
- Updated dependencies [08a3cad]
- Updated dependencies [f60ed16]
  - @abloatai/transaction@0.37.0
  - @abloatai/humans@0.37.0
