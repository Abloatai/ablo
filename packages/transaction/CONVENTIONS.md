# Transaction-core conventions

`@abloatai/transaction` is the confirmation core. It defines, authorizes, orders, and
settles changes; it does not materialize a local copy of rows or reconcile an
optimistic client. Apply ADR 0013's five-second test before adding or moving a
module:

> If there were no UI and no offline mode, would this code still need to exist?

Yes belongs here. IndexedDB, local stores, optimistic queues, bootstrap state,
WebSocket lifecycle and reactive snapshots belong in `@abloatai/humans`.

## Follow the operation tree

The package is organized by the operation a reader is trying to understand,
not by a horizontal implementation layer. Enter through one of these owners and
follow its imports downward:

```text
src/
  client/             public seam, headless runtime, typed model resources
  commit/             lifecycle, confirmation, durable persistence, requests
  claims/             contracts, locators, admission, leases, policy, events
  observation/        deltas, feeds, cursors, delivery, persisted projections
  auth/               credential and session authority
  source/
    endpoint/         signed endpoint serving
    connector/        outbound connector runtime and protocol
    delivery/         push delivery
    adapters/         database adapter contract and implementations
    outbox/           versioned endpoint outbox
  transport/
    http/             stateless HTTP mechanism
    websocket/        stateful socket mechanism
    connection/       shared connection and credential lifecycle
```

The former contract files in `wire/`, flat `transport/` files,
`transactions/confirmation/`, root client/resource files, and flat files under
`source/` were removed when their owners moved. Do not recreate those paths as
compatibility façades. Other `wire/` modules remain authoritative protocol
leaves.

## One definition for boundary data

Any shape that crosses a network boundary or is written to durable storage has
one authoritative Zod schema. Export its TypeScript shape from that schema with
`z.infer`, `z.input`, or `z.output`; do not maintain an unchecked parallel
interface or literal union.

Compose variants from the authoritative schema with Zod's `pick`, `omit`,
`extend`, and unions. A deliberate in-process projection must derive its fields
from the inferred type with `Pick`, `Omit`, or indexed access and document why it
differs. The narrow exception is an import-free type leaf needed to break a
runtime cycle: its one runtime schema must carry a bidirectional exact-type
assertion and its preamble must name the type leaf as the owner. Do not use an
equality assertion to justify two otherwise independent definitions.

Handwritten interfaces remain appropriate for behavior contracts (methods) and
in-process options that are neither parsed from the wire nor persisted. Those
belong outside `src/wire/` and `src/commit/confirmation/`, so the two
enforced directories keep a zero baseline rather than an exception list. When a
port and the records crossing it are discovered together, split them: the shape
stays in `confirmation/`, the methods move out.

Good definition sites include:

- `src/observation/contract.ts` for the shared, client, and server delta projections.
- `src/commit/confirmation/commitEnvelope.ts` for durable commit identity.
- `src/commit/confirmation/pendingWrite.ts` for the persisted union a
  durable-write adapter stores.
- `src/commit/durableWrites.ts` for the port that stores them — methods, so it
  lives outside the enforced confirmation directory.
- `src/client/contract.ts` for the client-facing behavior contract rather than
  serialized data.

## File preambles state ownership

Every boundary module starts with a short preamble that says:

1. what responsibility the module owns;
2. which schema or module is authoritative; and
3. which client/server counterpart consumes it, including any intentional
   compatibility or projection difference.

Comments explain ownership and invariants. They do not repeat the field names
that the schema already makes visible.

## Enforcement

CI rejects exported interfaces in `src/wire/` and
`src/commit/confirmation/`. Those directories have a zero baseline: add a
schema and infer the type instead of adding an exception. The import boundary is
enforced separately by dependency-cruiser.

A shape can also be duplicated without ever declaring a type, by writing a
projection's output out member by member. CI rejects that for the claim locator,
whose four projections live in `src/claims/locator.ts`: a literal that
assembles a target out of another target instead of spreading `wireTarget`,
`modelTarget`, `streamTarget`, or `subTarget` fails
`npm run check:locator-copies`. Its per-file baseline holds the two partial
locators the projections cannot express, and ratchets down only.

Run the focused checks from the repository root:

```sh
grep -RInE --include='*.ts' \
  '^[[:space:]]*export[[:space:]]+interface[[:space:]]' \
  packages/transaction/src/wire \
  packages/transaction/src/commit/confirmation
npm run check:locator-copies
npm run graph:deps
```

The grep should print nothing; CI turns any match into a failure.

## Publish owned boundaries, not filesystem accidents

`package.json` exposes explicit subsystem entry points and narrowly scoped child
patterns for stable leaf contracts. It must not contain a root `"./*"` or flat
`"./source/*"` escape hatch: those turn every file placement into public API and
allow consumers to bypass ownership.

When a new public subpath is needed, add it deliberately under its owning
subsystem. When a module moves, update all repository consumers in the same
change and remove its old export. This keeps the published surface aligned with
the downward tree rather than preserving a second, historical structure.
