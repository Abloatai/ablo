# CLI Reference

The `ablo` CLI sets up and manages your sync engine project.

## Installation

The CLI is included with `@ablo/sync-engine`. No separate install needed.

```bash
npx ablo <command>
```

## Commands

### `npx ablo init`

Set up `@ablo/sync-engine` in your project. Interactive prompts guide you through:

```bash
npx ablo init
```

```
? Found prisma/schema.prisma — import your models? Yes
  ✓ Imported 74 models from Prisma schema

? Framework: Next.js
? Authentication: Clerk
? Include AI agent? No

  ✓ ablo.schema.ts (from Prisma)
  ✓ ablo.schema.d.ts
  ✓ src/ablo.ts
  ✓ .env.local
  ✓ Installing @ablo/sync-engine...

  Done!
```

**What it does:**

1. **Detects existing schemas** — if you have `prisma/schema.prisma`, offers to import your models as Zod schemas automatically. Drizzle support coming soon.

2. **Asks about your stack** — framework (Next.js, Vite, Remix, vanilla), auth provider (Firebase, Auth0, Clerk, Okta, Supabase, Better Auth, or API key only), and whether to include an AI agent example.

3. **Generates files:**
   - `ablo.schema.ts` (at project root) — your data models, pure + declarative
   - `ablo.schema.d.ts` (at project root) — the `AbloSync` global augmentation
   - `src/ablo.ts` — runtime module, `createSyncEngine()` config with your chosen auth
   - `src/TaskList.tsx` — example React component (if using a React framework)
   - `src/agent.ts` — AI agent example (if selected)
   - `.env.local` — `ABLO_SYNC_URL` + `ABLO_API_KEY`

4. **Installs the package** — auto-detects your package manager (npm, pnpm, yarn, bun).

**Prisma import:** The CLI reads your Prisma schema and converts it to Zod:

| Prisma | Zod |
|--------|-----|
| `String` | `z.string()` |
| `Int` | `z.number()` |
| `Float` | `z.number()` |
| `Boolean` | `z.boolean()` |
| `DateTime` | `z.date()` |
| `Json` | `z.record(z.unknown())` |
| `String?` | `z.string().optional()` |
| `@default(false)` | `.default(false)` |
| `@relation(fields: [projectId])` | `relation.belongsTo('projects', 'projectId')` |

Auth-related models (Account, Session, Verification) are excluded automatically.

### `npx ablo migrate`

Generate and apply database migrations from your Zod schema.

```bash
# Preview SQL without executing
npx ablo migrate --dry-run

# Write SQL to file
npx ablo migrate --output migration.sql

# Apply directly to database
DATABASE_URL=postgresql://... npx ablo migrate
```

**What it generates:**

1. **Sync infrastructure tables** — `sync_deltas` (delta log) and `sync_metadata` (sync cursor). These are required for the sync engine to work.

2. **Entity tables** — one table per model in your schema, with:
   - `id TEXT PRIMARY KEY` (UUID auto-generated)
   - Columns matching your Zod fields
   - `organization_id TEXT NOT NULL` (multi-tenant scoping)
   - `created_by TEXT`, `created_at`, `updated_at`
   - Foreign key constraints from relations
   - Enum check constraints from `z.enum()`
   - Indexes on `organization_id`

3. **Row-Level Security** — RLS policies on every table, scoped by `organization_id`. Multi-tenant data isolation out of the box.

**Example output:**

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    priority INTEGER DEFAULT 0,
    project_id TEXT,
    description TEXT,
    organization_id TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_tasks_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_org_isolation ON tasks
    USING (organization_id = current_setting('app.current_org_id', true));
```
