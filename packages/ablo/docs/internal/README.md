# Internal Architecture Notes

These documents explain implementation and protocol decisions for contributors.
They are not extra public import paths.

The ownership rule is:

- transaction owns transport-neutral and HTTP contracts;
- humans owns reactive state, WebSockets, presence, browser persistence, and React;
- agent owns agent-specific behavior and perception;
- the branded `@abloatai/ablo` package maps stable public entrypoints to those
  owners;
- `apps/sync-server` owns backend execution.

Consumer code should import `@abloatai/ablo` and its documented subpaths.
Contributor code should import the narrow owner package or module it actually
uses. Do not add forwarding compatibility packages or duplicate contract
definitions.
