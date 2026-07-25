# Transaction-core conventions

`@abloatai/transaction` is the settlement core. It defines, authorizes, orders, and
settles changes; it does not materialize a local copy of rows or reconcile an
optimistic client. Apply ADR 0013's five-second test before adding or moving a
module:

> If there were no UI and no offline mode, would this code still need to exist?

Yes belongs here. IndexedDB, local stores, optimistic queues, bootstrap state,
WebSocket lifecycle and reactive snapshots belong in `@abloatai/humans`.

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
belong outside `src/wire/` and `src/transactions/settlement/`, so the two
enforced directories keep a zero baseline rather than an exception list. When a
port and the records crossing it are discovered together, split them: the shape
stays in `settlement/`, the methods move out.

Good definition sites include:

- `src/wire/delta.ts` for the shared, client, and server delta projections.
- `src/transactions/settlement/commitEnvelope.ts` for durable commit identity.
- `src/transactions/settlement/pendingWrite.ts` for the persisted union a
  durable-write adapter stores.
- `src/durableWrites.ts` for the port that stores them — methods, so it lives
  outside the enforced directories.
- `src/transactionLayer.ts` for a behavior contract rather than serialized data.

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
`src/transactions/settlement/`. Those directories have a zero baseline: add a
schema and infer the type instead of adding an exception. The import boundary is
enforced separately by dependency-cruiser.

A shape can also be duplicated without ever declaring a type, by writing a
projection's output out member by member. CI rejects that for the claim locator,
whose four projections live in `src/coordination/locator.ts`: a literal that
assembles a target out of another target instead of spreading `wireTarget`,
`modelTarget`, `streamTarget`, or `subTarget` fails
`npm run check:locator-copies`. Its per-file baseline holds the two partial
locators the projections cannot express, and ratchets down only.

Run the focused checks from the repository root:

```sh
grep -RInE --include='*.ts' \
  '^[[:space:]]*export[[:space:]]+interface[[:space:]]' \
  packages/transaction/src/wire \
  packages/transaction/src/transactions/settlement
npm run check:locator-copies
npm run graph:deps
```

The grep should print nothing; CI turns any match into a failure.
