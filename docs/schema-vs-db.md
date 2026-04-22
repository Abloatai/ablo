# Schema vs. Database

A common first question when adopting `@ablo/sync-engine`:

> "Does `ablo.schema.ts` replace my Prisma / Drizzle / raw SQL migrations?"

**No.** The two live in different layers and solve different problems.

## What `ablo.schema.ts` is

A **client-side type + sync-group contract**. It tells the SDK:

- Which models exist and what shape their rows have (Zod validation)
- Which sync groups carry which rows (`syncGroupFormat`, `parent`)
- Which models are writable (`mutable.*`) vs. server-owned (`readOnly.*`)
- Which relations exist for typed queries

It runs in the browser, in Node agents, in tests. It does **not** create tables, run migrations, or touch your database.

## What your DB migration tool does

Prisma, Drizzle, Atlas, Flyway, Alembic, raw SQL — whichever you use — owns the physical schema:

- Columns, types, indexes, constraints
- Foreign keys and cascades
- Migrations as versioned files
- The actual `CREATE TABLE` / `ALTER TABLE` statements

You keep using your existing tool. The sync engine operates **on top of** the tables your migrations created.

## How they stay in sync

There's no magical bridge. You keep them aligned the same way you keep any two sources of truth aligned — by convention and by tests.

Two rules cover 95% of it:

1. **Model names map to table names.** `mutable({...})` declared as `tasks` in `ablo.schema.ts` maps to the `tasks` table in your database. Case convention matches what your DB driver / ORM uses (snake_case, camelCase — it's consistent with the row shape you hand back from your SQL).

2. **The Zod shape must match the row shape the server returns.** If your DB column is `created_at timestamptz` and your server returns it as `createdAt: string`, your Zod field is `createdAt: z.string()`. Mismatch → validation error at runtime, caught by the sync engine's delta handler.

## When they drift

If you add a column to the DB and forget to add it to `ablo.schema.ts`: the sync engine ignores the column — clients don't see it. No breakage, but the column is invisible.

If you add a field to `ablo.schema.ts` and forget to add it to the DB: validation fails on the next delta; the sync engine logs the bad row and rejects it.

Both are recoverable. Neither corrupts data.

## Why the split

This design mirrors what Prisma itself does internally: `schema.prisma` is the declarative type source, the database migration is a separate artifact (`prisma migrate`). We don't replace Prisma — we complement it.

The alternative — making the sync engine responsible for migrations — would force every customer to abandon their existing migration story on adoption. That's a non-starter. So we draw the line at the wire format: the SDK handles sync, validation, and types; your migration tool handles tables.

## TL;DR

| Layer | Owned by |
|---|---|
| Physical tables, columns, indexes | Your DB migration tool (Prisma / Drizzle / SQL) |
| Row shape as seen by clients | `ablo.schema.ts` (Zod validation) |
| Sync-group membership | `ablo.schema.ts` (`syncGroupFormat`, `parent`) |
| Real-time delivery | Managed sync server (`mesh.ablo.finance`) |
| Mutation attribution & audit | Managed sync server |

Adopt the SDK without changing your DB layer. Keep your migrations.
