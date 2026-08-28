# Introduction

> Coordination infrastructure for agents, applications, services, and people working on shared state

Ablo is a framework-agnostic coordination layer for agents, applications,
services, and people working on shared state. It provides claims, waiting,
participant identity, stale-work rejection, confirmed writes, and live updates
through one typed interface. Whether you are adding agents to an existing
application or building a new multi-user system, Ablo lets you focus on your
product instead of rebuilding coordination infrastructure.

Ablo works with your existing database, API, authorization, and business logic,
while providing a common coordination model across runtimes and frameworks.

## Features

Ablo provides a comprehensive set of coordination capabilities and a shared
model that can be used across agents, services, applications, and human
interfaces.

<Columns>
  <Card title="Claims and waiting" icon="handshake" href="/coordination">
    Let one participant perform contested work while others wait, skip, or fail according to an explicit policy.
  </Card>

  <Card title="Existing PostgreSQL" icon="database" href="/coordinate-existing-work">
    Keep the authoritative transaction, locks, constraints, and direct SQL paths your application already owns.
  </Card>

  <Card title="Participant identity" icon="fingerprint" href="/identity">
    Give agents, people, and services distinct scoped credentials instead of treating every worker as the same caller.
  </Card>

  <Card title="Crash recovery" icon="rotate-ccw" href="/guarantees">
    Expiring leases and heartbeats let later participants proceed when an owner disappears.
  </Card>

  <Card title="Stale-work rejection" icon="shield-check" href="/concurrency-convention">
    Carry the rows behind a decision into its write and reject the result when those premises changed.
  </Card>

  <Card title="Atomic commits" icon="git-merge" href="/api#atomic-commits">
    Apply several Ablo writes together, with their captured premises, or apply none of them.
  </Card>

  <Card title="Confirmed writes" icon="receipt" href="/guarantees">
    Know when a write reached the authoritative database and why a rejected write did not land.
  </Card>

  <Card title="Humans and agents" icon="users" href="/react">
    Coordinate stateless HTTP workers with live human interfaces over the same shared state.
  </Card>

  <Card title="Audit and visibility" icon="scroll-text" href="/audit">
    Inspect ownership, contention, and committed changes with the responsible participant attached.
  </Card>
</Columns>

...and more.

---

## Get started

- [Installation](./installation.md) — install Ablo, declare the shared models,
  and create a client.
- [Basic usage](./basic-usage.md) — read, write, and coordinate one operation.
- [Comparison](./comparison.md) — see how Ablo relates to PostgreSQL locks,
  Redis reservations, queues, workflow engines, and rolling your own.
- [Choose the Ablo operation](./implement.md) — route an existing use case to
  the smallest correct implementation.

## AI resources

Ablo is designed to be implemented by agents as well as people. Use
[llms.txt](https://docs.abloatai.com/llms.txt) for the public documentation
index, or connect an assistant to the [documentation MCP server](./mcp.md). The
coordination MCP package also ships its agent-facing skill as
`@abloatai/mcp/skill.md`.
