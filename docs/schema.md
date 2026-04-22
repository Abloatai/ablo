# Schema Definition

Your schema lives in **`ablo.schema.ts` at your project root** — one file, declarative, safe to import from anywhere. Models are declared with `mutable.*` (writable) or `readOnly.*` (server-owned). Every field is a Zod schema. No codegen, no build step.

> **Is this the same as a database schema?** No. `ablo.schema.ts` is a client-side type + sync-group contract. Your DB migrations (Prisma, Drizzle, raw SQL) still own tables and columns. See [schema-vs-db.md](./schema-vs-db.md).

## The canonical form

```typescript
// ablo.schema.ts
import { defineSchema, mutable, readOnly, z, relation } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  // Writable + loaded at bootstrap (instant is the default)
  projects: mutable(
    {
      name: z.string(),
      description: z.string().optional(),
    },
    {
      syncGroupFormat: 'project:{id}',
      relations: { tasks: relation.hasMany('tasks', 'projectId') },
    },
  ),

  // Writable + fetched on first access (for large child collections)
  tasks: mutable.lazy(
    {
      title: z.string(),
      status: z.enum(['todo', 'doing', 'done']).default('todo'),
      priority: z.number().default(0),
      projectId: z.string().optional(),
      dueDate: z.date().optional(),
    },
    {
      parent: 'projects',
      relations: { project: relation.belongsTo('projects', 'projectId') },
    },
  ),

  // Read-only configuration loaded at bootstrap
  featureFlags: readOnly({ name: z.string(), enabled: z.boolean() }),
});
```

**Verb reading.** `mutable` / `readOnly` tells the caller the safety posture at the call site. The `.lazy` / `.instant` suffix picks the load shape — default is `instant` (bootstrapped) if you omit it. Children of a scope root inherit the scope via `parent`; roots declare `syncGroupFormat`.

## Typed access — via the `AbloSync` global

Once you've declared the `AbloSync` global in `ablo.schema.d.ts`, every hook is zero-generic and every derived type is available through the global. This is the path to use everywhere in application code.

```typescript
// ablo.schema.d.ts — declared once
import type { schema } from './ablo.schema';
declare global { interface AbloSync { Schema: typeof schema } }
export {};
```

```typescript
// Hooks self-type from AbloSync — no generics at the call site
const tasks = useQuery('tasks', { where: { status: 'todo' } });
const mutate = useMutate('tasks');
```

The sugar accepts `syncGroupFormat` (marks an entity as a mesh scope target), `parent` (cascade delete + sync-group derivation), `typename`, `tableName`, and load controls like `bootstrapLimit` / `bootstrapOrderBy`.

## Relations

Relations declare how models connect. They drive create-order priority, cascade deletes, FK indexes, and scope derivation.

### `relation.belongsTo(target, foreignKey)`

This model references another via a foreign key.

```typescript
project: relation.belongsTo('projects', 'projectId')
```

### `relation.hasMany(target, foreignKey)`

Inverse of `belongsTo`.

```typescript
tasks: relation.hasMany('tasks', 'projectId')
```

### `relation.hasOne(target, foreignKey)`

One-to-one on the related model.

```typescript
profile: relation.hasOne('profiles', 'userId')
```

## Load strategies

Not every model should bootstrap. A deck with thousands of slide layers shouldn't load them all up front — fetch them when the user opens a slide. Pick the verb to match: `mutable` / `readOnly` (instant, the default) vs `mutable.lazy` / `readOnly.lazy` vs the `{ load: 'manual' }` escape hatch.

```typescript
const schema = defineSchema({
  // instant (default) — loaded during bootstrap
  slideDecks: mutable({ title: z.string(), layoutId: z.string() }),

  slides: mutable(
    { deckId: z.string(), title: z.string(), order: z.number().default(0) },
    { relations: { deck: relation.belongsTo('slideDecks', 'deckId') } },
  ),

  // lazy — not in bootstrap; fetched per parent id on first access
  slideLayers: mutable.lazy(
    {
      slideId: z.string(),
      type: z.enum(['text', 'image', 'shape', 'chart']),
      zIndex: z.number().default(0),
    },
    { relations: { slide: relation.belongsTo('slides', 'slideId') } },
  ),

  // manual — never auto-loaded; call sync.auditLogs.load() explicitly
  auditLogs: mutable(
    { action: z.string(), entityType: z.string(), entityId: z.string() },
    { load: 'manual' },
  ),
});
```

| Strategy | Bootstrap | First access | Explicit load | Use case |
|----------|-----------|--------------|---------------|----------|
| `'instant'` (default) | yes | — | — | Core models (tasks, projects, users) |
| `'lazy'` | no | yes | — | Parent-keyed collections (slide layers, comments, attachments) |
| `'manual'` | no | no | `sync.model.load()` | Large rarely-needed sets (audit logs, analytics) |

### Bootstrap limits

For instant-loaded models that can grow large, cap how many records bootstrap fetches:

```typescript
activities: mutable(
  {
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
  },
  {
    load: 'instant',
    bootstrapLimit: 200,
    bootstrapOrderBy: 'created_at DESC',
  },
),
```

### How lazy loading works

Lazy fetches only the records the caller asks for, keyed by the FK in `where`. Opening slide A fetches layers for slide A — not all 10,000 layers across every slide.

```typescript
const layersA = sync.slideLayers.findMany({ where: { slideId: 'slide-A' } });
// → fetches layers for slide-A; returns [] initially, re-renders on arrival

const layersB = sync.slideLayers.findMany({ where: { slideId: 'slide-B' } });
// → fetches slide-B layers (A is cached)

const layersA2 = sync.slideLayers.findMany({ where: { slideId: 'slide-A' } });
// → returns cached data immediately
```

Fetched rows land in the ObjectPool (reactive), IndexedDB (survives refresh), and the WebSocket delta stream (real-time updates).

## Casing

When your DB uses snake_case (Postgres convention), set `casing: 'snake_case'` once on `defineSchema` to auto-derive `rel.foreignKeyColumn` from camelCase JS fields at schema-build time.

```typescript
export const schema = defineSchema(
  {
    tasks: mutable({ projectId: z.string() }),
  },
  { casing: 'snake_case' },
);
```

Field-name rule: use standard camelCase only. `contentJSON` (double uppercase) fails at schema-build because it can't round-trip through `snake_case ↔ camelCase`. Use `contentJson`.

## Complex graphs

Real-world schemas nest deep. A deck app with themes, layouts, slides, and layers:

```typescript
const schema = defineSchema({
  themes: mutable({ name: z.string(), themeCSS: z.string().default('') }),

  layouts: mutable({ name: z.string(), deckId: z.string().optional() }),

  slideDecks: mutable(
    {
      title: z.string().default('Untitled Deck'),
      layoutId: z.string(),
      themeId: z.string().optional(),
    },
    {
      syncGroupFormat: 'deck:{id}',
      relations: {
        layout: relation.belongsTo('layouts', 'layoutId'),
        theme: relation.belongsTo('themes', 'themeId'),
        slides: relation.hasMany('slides', 'deckId'),
      },
    },
  ),

  slides: mutable(
    {
      deckId: z.string(),
      title: z.string().default('Untitled Slide'),
      order: z.number().default(0),
    },
    {
      parent: 'slideDecks',
      relations: {
        deck: relation.belongsTo('slideDecks', 'deckId'),
        layers: relation.hasMany('slideLayers', 'slideId'),
      },
    },
  ),

  slideLayers: mutable.lazy(
    {
      slideId: z.string(),
      type: z.enum(['text', 'image', 'shape', 'chart']),
      zIndex: z.number().default(0),
      visible: z.boolean().default(true),
    },
    {
      parent: 'slides',
      relations: { slide: relation.belongsTo('slides', 'slideId') },
    },
  ),
});
```

The `belongsTo` declarations tell the sync engine:

- **Create order** — themes/layouts before decks, decks before slides, slides before layers.
- **Cascade** — deleting a deck cancels pending transactions for its slides and layers.
- **FK indexes** — `slideLayers.slideId` gets an O(1) lookup index automatically.

## Base fields

Every model includes these automatically — you don't declare them.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | UUID v4, auto-generated (override by passing `id` at create time). |
| `createdAt` | `Date` | Set on create. |
| `updatedAt` | `Date` | Set on create, refreshed on update. |
| `organizationId` | `string?` | Multi-tenant scope. |
| `createdBy` | `string?` | User or agent that created the row. |

## `field` / `indexed` helpers (advanced)

The schema package re-exports `field`, `indexed`, and `getFieldMeta` for rare cases where you need to attach metadata to a Zod field (e.g. marking a column indexed). They wrap a Zod schema, not replace it.

```typescript
import { z, indexed } from '@ablo/sync-engine/schema';

slug: indexed(z.string())   // indexed in the ObjectPool for O(1) FK lookups
```

For ordinary use, lean on Zod directly and the `mutable` / `readOnly` sugar.

## Queries DSL

`query` / `defineQueries` let you declare reusable parameterized reads. See [`queries.md`](./queries.md) or the TSDoc on `defineQueries` for the full shape.

## Reference: alternative forms

The 80% path above uses `mutable.*` / `readOnly.*` plus the `AbloSync` global. The following forms exist for edge cases — typing a utility outside React, writing a CLI script against the schema, or building generic tooling. **Prefer the canonical form for application code.**

### `model(shape, opts)`

The neutral declaration — no safety posture, no load-shape verb. `mutable.*` and `readOnly.*` are thin wrappers over `model`. Shown here only because you may see it in older examples.

```typescript
import { model } from '@ablo/sync-engine/schema';

tasks: model({ title: z.string() }, { /* opts */ });
```

### `InferModel<Schema, 'name'>` / `InferCreate<Schema, 'name'>`

Direct type extraction that doesn't require the `AbloSync` global. Useful in utility code, test fixtures, or anywhere outside React where the global isn't in scope.

```typescript
import type { InferModel, InferCreate } from '@ablo/sync-engine/schema';

type Task = InferModel<typeof schema, 'tasks'>;
type CreateTaskInput = InferCreate<typeof schema, 'tasks'>;
```

### `typeof schema.$Infer.Models.tasks`

Short-form extraction exposed directly on the schema object. Same types as `InferModel`, shorter to write when you already have `schema` in scope.

```typescript
type Task = typeof schema.$Infer.Models.tasks;
```

In application code, prefer `useQuery('tasks')` — the return type is already `Task[]`, no extraction needed.
