/**
 * Packaged application-integration knowledge for coding agents. Infrastructure
 * remains outside this skill; it owns only repository exploration and edits.
 */

import { createHash } from 'node:crypto';
import {
  SETUP_CONTRACT_VERSION,
  setupAgentBundleSchema,
  setupSkillBundleSchema,
  type SetupAdaptationTask,
  type SetupAgentBundle,
  type SetupSkillBundle,
} from './contracts';

const SKILL_MD = `---
name: integrate-ablo
description: Integrate selected application models with Ablo by exploring and adapting an existing codebase.
---

# Integrate Ablo into an existing application

Follow the supplied record contract. Its discovery hints are optional starting points, not a migration plan. Independently explore the selected application and trace each selected model through schema definitions, repositories, services, route handlers, UI callers, workers, validation, authorization, and tests before editing.

## Hard boundaries

- Work only inside the record's allowed application root.
- Do not read environment values or open real .env files. You may inspect .env.example-style templates.
- Do not run login, branch, connect, push, dev, database, deployment, or production commands.
- Do not change database schema or migrations unless a later human-approved record explicitly authorizes it.
- Preserve existing authorization, validation, transaction behavior, errors, API response contracts, providers, comments, and unrelated code.
- Read every existing file immediately before editing it. Make minimal in-place edits; never replace an occupied application file with a generic template.

## Workflow

1. Read the record and inspect repository conventions, package scripts, framework layout, ORM/schema, auth, and existing Ablo code.
2. Read "references/coordinate-existing-work.md" when the supplied bundle contains it; otherwise run "npx ablo docs coordinate-existing-work". Choose its default existing-operation route unless a concrete condition on that page selects another route. Read only the deeper installed-version pages named by the selected route; do not read the full documentation set or rely on memory or latest-web documentation.
3. Name the existing operation being adapted and record its claim identity, participant credential, decision premises, atomic boundary, persistence owner, failure behavior, and proof. Then map every selected model's meaningful reads and writes. Follow wrappers and call chains; do not stop at discovery hints or grep results.
4. Reconcile or create the Ablo schema and clients without overwriting application-owned wiring. Declare application fields and their real column names normally. Existing-table ownership, database defaults, and identity generation belong to the reviewed database connection, not the model definition; Ablo does not own customer rows or application migrations.
5. Follow the selected persistence boundary. When the existing service remains authoritative, add coordination around its named operation and preserve its Postgres write. When Ablo owns the selected write path, adapt independent writes through "ablo.<model>" methods. Use one "ablo.commits.create(...)" only for dependent Ablo writes that must remain atomic, and correlate returned rows with the operation "transactionId".
6. Preserve the caller's trust boundary: browser code uses the existing session/auth flow; trusted server and worker code may use a server client. Never expose a secret key to browser code.
7. In a Node service, follow the application's existing composition root and shutdown flow. Validate that "ABLO_API_KEY" is present without logging it, create one schema-backed "createTransactionClient(...)" per service or worker authority, await "ready()" before accepting work, and inject the client into stores and workers. Preserve memory-backed test modes. Release held claims in "finally" or with explicit resource management, stop accepting work before shutdown, await active work, then await "dispose()". Do not add hidden global clients or replace the application's signal and exit behavior.
8. Add or update focused tests for the adapted behavior, including startup failure and shutdown during active work when Node lifecycle wiring changes. Run the application's existing typecheck and relevant test commands when available; do not run broad fix/format commands that rewrite unrelated files.
9. Return the required structured handoff. Report changed files, selected-model paths explored, direct-write exceptions, verification commands and outcomes, and unresolved blockers. Never claim database activation or canary success; the deterministic setup kernel verifies those later.
`;

const API_REFERENCE = `# Ablo application API contract

This is a compact orientation for the CLI release that emitted the bundle. Start
with "npx ablo docs coordinate-existing-work". The installed package's
route-specific pages are authoritative if any example differs; do not read
unrelated pages before implementing the selected operation.

- Construct a schema-backed client with "Ablo({ schema, apiKey })" in trusted runtimes or the installed-version browser/session pattern from "npx ablo docs integration-guide".
- For a trusted Node service, use one "createTransactionClient({ schema, apiKey })" owned by the existing application lifecycle. Await "ready()" at startup and "dispose()" only after the service has stopped accepting work and active work has settled. Pass the client as a dependency; do not hide it in module-global state.
- Treat "ABLO_API_KEY" as secret configuration: validate presence through the application's configuration boundary and never print its value. A worker's credential supplies its participant identity; do not invent a second identity option.
- Observe with "ablo.<model>.get({ id })" and "ablo.<model>.list({ where })". When a mutation depends on one row, use "const row = await ablo.<model>.read({ id })" and pass "reads: [row]" to that mutation.
- Create with "ablo.<model>.create({ data })".
- Update with "ablo.<model>.update({ id, data, ...options })".
- Delete with "ablo.<model>.delete({ id, ...options })".
- Logical "id" is the only universal model field. Timestamps, tenancy columns, and attribution columns are ordinary application fields: declare their real type with "field.*().from(column)" or omit them when absent. Ablo coordination never interprets their values.
- The database connection is authoritative for identity type and generation. A returned BIGINT identity becomes the model's canonical string id; the model does not repeat these database facts.
- A database-generated identity is omitted from create input and returned by the same customer database transaction. Correlate it with the operation "transactionId"; do not invent another operation identifier.
- Use "ablo.commits.create({ operations, wait: 'confirmed' })" when multiple rows/models must remain one atomic write. Put an equality predicate in the update operation's "where" object. A predicate miss rejects the entire commit before dependent writes execute.
- Read exact response-time rows from "operationResults" by matching each result's existing "transactionId". Treat those rows as transient response data, not a durable commit-record field.
- When a write depends on earlier state, preserve concurrency intent with a claim, functional update, or a row returned by "read({ id })" in the mutation's "reads" array.
- The customer ORM remains authoritative for tables, columns, constraints, and migrations. Do not introduce a parallel write path for a selected Ablo model.
`;

const HANDOFF_REFERENCE = `# Required completion handoff

Return one JSON object with these keys:

- "outcome": "candidate", "blocked", or "failed" (never "complete"; activation is graded outside the agent).
- "changedFiles": repository-relative paths actually changed.
- "exploredWritePaths": selected model, path, and short semantic role.
- "directWriteExceptions": path and reason for every intentional remaining bypass.
- "verification": command, exit code, and concise result.
- "blockers": unresolved decisions or failures.

The working-tree diff and deterministic graders are authoritative. This handoff is evidence for review, not proof of success.
`;

function skillFile(path: string, content: string) {
  return {
    path,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export function buildSetupSkillBundle(): SetupSkillBundle {
  return setupSkillBundleSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_skill',
    id: 'integrate-ablo',
    version: '1.0.0',
    entrypoint: 'SKILL.md',
    files: [
      skillFile('SKILL.md', SKILL_MD),
      skillFile('references/api-contract.md', API_REFERENCE),
      skillFile('references/completion-handoff.md', HANDOFF_REFERENCE),
    ],
  });
}

export function buildSetupAgentBundle(
  record: SetupAdaptationTask,
  now: () => Date = () => new Date(),
): SetupAgentBundle {
  return setupAgentBundleSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_agent_bundle',
    createdAt: now().toISOString(),
    record,
    skill: buildSetupSkillBundle(),
  });
}
