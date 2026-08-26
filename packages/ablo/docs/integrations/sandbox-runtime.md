# Anthropic Sandbox Runtime

> Run an Ablo agent with OS-enforced filesystem and network boundaries while its coordinated work remains durable outside the sandbox.

Anthropic Sandbox Runtime and Ablo own different boundaries:

| Concern | Owner |
|---|---|
| Filesystem, network, Unix sockets, process-tree restrictions | Sandbox Runtime |
| Typed reads and writes, claims, fencing, idempotency, confirmation | Ablo |
| Prompts, tools, model calls, and business behavior | Your application |
| Authentication, branch creation, schema push, and database connection | A trusted host workflow |

An **execution sandbox** is the disposable process boundary. An **Ablo branch**
is an isolated data and schema plane. Keep the names and lifecycles separate.

## Use two profiles

Do not give a repository-editing agent the same authority as a runtime agent.

The **integration profile** adapts source code. It receives no Ablo credential,
has no Ablo network access, cannot read real environment files, and writes only
inside the selected application root. It can still read the installed-version
documentation without a network connection:

```bash
npm exec --offline -- ablo docs integration-guide
npm exec --offline -- ablo docs api
npm exec --offline -- ablo setup --plan --json
```

The **runtime profile** executes application work. It receives one short-lived,
branch-bound runtime credential, permits the Ablo API, and normally has no
repository write access. Give it only the model operations and sync groups one
run needs.

Never inject control-plane authority, a database URL, cloud credentials, or an
ambient host environment into either profile.

## Prepare authority outside the sandbox

Run control-plane and database operations in a trusted host workflow. That
workflow prepares the branch, pushes the reviewed schema, and delegates a
per-run `rk_` credential. Management and broad branch credentials are
infrastructure details and never enter the agent-facing launcher:

```bash
# Supplied by trusted CI or a credential broker after branch preparation.
export ABLO_API_KEY=rk_...
npm run sandbox -- agent job_123
```

The sandbox launcher should build an explicit child environment rather than
inherit `process.env`. A runtime credential is not a substitute for process
isolation, and process isolation is not a substitute for a narrowly scoped
credential.

## Keep the repository tree downward

Give the Ablo boundary and agent behavior separate entry points:

```text
src/
  ablo/
    index.ts          schema-backed client boundary
    client.ts
    schema.ts
  agent/
    index.ts          process entry point
    processJob.ts
sandbox/
  index.ts            sanitized launcher and command catalog
  integration.policy.json
  runtime.policy.json
```

The agent enters through `agent/index.ts` and follows dependencies down into
`ablo/index.ts`. Ablo code never imports the agent or sandbox implementation.

## Coordinate effects that outlive the process

A filesystem sandbox cannot prevent two valid agents from overwriting the same
shared row. Read, claim, and write through the schema-backed Ablo client:

```ts
const claim = await ablo.jobs.claim({
  id: jobId,
  description: 'processing in a sandbox',
  ttl: '30s',
  heartbeat: { every: '10s' },
});

try {
  const result = await performWork(claim.data);
  await ablo.jobs.update({
    id: claim.data.id,
    data: { status: 'complete', result },
    claim,
    idempotencyKey: `job:${claim.data.id}:complete`,
  });
} finally {
  await claim.release();
}
```

If the sandbox disappears, its heartbeat stops and the lease expires. A later
holder reads fresh state. If the old process resumes, the checked write is
refused because it no longer owns the claim.

## Start from deny-first policies

Sandbox Runtime denies writes and network access unless they are allowed, but
filesystem reads require explicit deny regions. A practical policy should:

- deny the user's home region, then re-allow the selected repository;
- keep real `.env*`, SSH material, cloud configuration, and credentials denied;
- allow writes only to the selected application root and a dedicated temporary directory;
- allow only `api.abloatai.com:443` for an Ablo runtime agent;
- add a model-provider domain only when the model process itself runs inside the sandbox;
- leave Docker sockets and Apple Events disabled; and
- use resolved literal paths because filesystem globs are not supported on Linux.

Domain allowlists are coarse: an allowed domain can still be an exfiltration
channel. Filesystem isolation, environment sanitation, and least-authority
credentials must be used together.

## Run the complete example

The repository example contains the launcher, both policies, the schema-backed
agent, and boundary tests:

```bash
cd examples/sandboxed-agent
npm install
npm run docs:sandboxed
npm test
npm run typecheck
```

Sandbox Runtime is a beta research preview. Keep it behind the launcher boundary
so policy and API changes do not spread through application or Ablo code.

## References

- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Agents](../agents.md)
- [Branch-first development](../branch-development.md)
- [Coordination](../coordination.md)
