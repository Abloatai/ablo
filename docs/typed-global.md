# The typed-global pattern

`@ablo/sync-engine` uses TypeScript's declaration-merging mechanism so
consumers can declare their domain ONCE and have every hook, API call,
and helper auto-type against it. No generics at call sites. No `schema`
runtime arg passed to `useQuery`. No imports of the schema module
anywhere except the single augmentation file.

This is the same canonical pattern Next.js uses for `NodeJS.ProcessEnv`,
that CSS Modules use for `declare module '*.module.css'`, and that
Liveblocks uses for `interface Liveblocks`. It's a language feature, not
a library trick.

## The contract

The SDK exposes an empty interface `AbloSync` via a `declare global`
block in `packages/sync-engine/src/types/global.ts`:

```ts
declare global {
  interface AbloSync {}
}
```

You augment it in `ablo.schema.d.ts`, next to `ablo.schema.ts` at your project root:

```ts
// ablo.schema.d.ts
import type { schema } from './ablo.schema';

declare global {
  interface AbloSync {
    Schema: typeof schema;
    Presence: { cursor: { x: number; y: number } | null };
    Intents: { editLayer: { layerId: string } };
    UserMeta: { id: string; email: string };
  }
}
export {};  // makes the file a module
```

The SDK defines four resolver types that read from your augmentation:

- `ResolveSchema` — your schema object
- `ResolvePresence` — your presence shape
- `ResolveIntents` — your intent vocabulary
- `ResolveUserMeta` — your user metadata shape

Every hook reads from these resolvers. You don't interact with them
directly — you declare `AbloSync`, and everything downstream narrows.

## Call-site ergonomics

### Without the global (loose defaults)

Before augmentation, every hook returns `Record<string, unknown>[]`-shaped
results:

```ts
const tasks = useQuery('tasks');
// tasks: Record<string, unknown>[]
tasks[0].title;  // typed as `unknown`
```

This compiles. It just lacks entity-specific types.

### With the global

After declaring `AbloSync['Schema'] = typeof schema`:

```ts
const tasks = useQuery('tasks');
// tasks: Task[]  ← inferred from schema['tasks']
tasks[0].title;  // typed as `string`
```

One `.d.ts`, every hook in every file picks up the concrete entity type.

## What each AbloSync key controls

| Key | Read by | Example |
|---|---|---|
| `Schema` | `useQuery`, `useOne`, `useMutate`, `useReader`, `useMutators`, `useUndoScope` | `useQuery('tasks')` → `Task[]` |
| `Presence` | `usePresence()` | `usePresence()` → your declared shape |
| `Intents` | `useIntent(name)` | `useIntent('editLayer')(claim)` — `claim` typed against `Intents['editLayer']` |
| `UserMeta` | (reserved — future hooks may expose the current user's metadata shape) | — |

## Fallback behavior

If a key is absent from your `AbloSync` declaration, the resolver falls
back to a `DefaultSyncShape`:

| Key | Default fallback |
|---|---|
| `Schema` | `{ models: Record<string, unknown> }` |
| `Presence` | `Record<string, unknown>` |
| `Intents` | `Record<string, unknown>` |
| `UserMeta` | `{ id: string }` |

Partial augmentation works: declaring only `Schema` leaves `Presence` at
its loose default, so `usePresence()` returns `Record<string, unknown>`.
Declare each key you want narrowed; leave out the ones you don't use.

## How it's wired in the SDK (for debugging)

### The hook overload pattern

Each React hook has three overloads, resolved top-to-bottom:

```ts
// 1. Explicit schema — legacy path, full control at the call site
useQuery<S extends Schema, K extends keyof S['models']>(
  schema: S, modelKey: K, options?,
): InferModel<S, K>[];

// 2. Typed-global — zero-arg form; K narrowed to `keyof ResolveSchema['models']`
useQuery<K extends GlobalModelKey>(
  modelKey: K, options?,
): GlobalEntity<K>[];

// 3. Untyped fallback — for arbitrary typename strings
useQuery<T = Record<string, unknown>>(typename: string, options?): T[];
```

When the consumer calls `useQuery('tasks')`:
- Overload 1 doesn't match (first arg is a string, not a schema)
- Overload 2 matches if `'tasks'` is in `ResolveSchema['models']`
- Overload 3 is the fallback if the typed-global path isn't active

This ordering is what makes the zero-arg form typed when you opt in and
loose when you don't — no config changes, no build flags.

### Runtime resolution

`SyncProvider` carries the schema in its context value:

```tsx
<SyncProvider store={store} organizationId={orgId} schema={schema}>
```

Inside each hook body:

```ts
const { store, schema: ctxSchema } = useSyncContext();
const resolvedSchema = typeof firstArg === 'string' ? ctxSchema : firstArg;
```

The compile-time type (`GlobalEntity<K>`) and the runtime lookup
(`ctxSchema.models[key]`) agree because the consumer provides both:
the `.d.ts` declares the type, the `SyncProvider` prop provides the
value. If you forget the provider prop, hooks throw at first call
(`"no schema available"`) — fail-fast rather than silent-empty.

## Can I use the explicit form anyway?

Yes. All three overloads are permanent. Some valid reasons to pass
`schema` explicitly:

- Per-call-site schema override (two schemas in one app)
- Library code that doesn't own the `SyncProvider` wiring
- Migration: adding the typed-global incrementally, file-by-file

Mix freely. `useQuery(schema, 'tasks')` and `useQuery('tasks')` produce
identical runtime behavior and identical return types when the global
declares `Schema: typeof schema`.

## Troubleshooting

### Hooks return `Record<string, unknown>[]` instead of the entity type

The `.d.ts` isn't being picked up by TypeScript. Checks in order:

1. File location — is it inside your `tsconfig.json`'s `include` glob?
2. File name — does it end in `.d.ts`? (pure `.ts` with `declare global` also works if it's a module)
3. Restart the TS server in your editor — augmentations cache aggressively
4. Verify the `import type { schema }` path resolves correctly

### "Cannot find name 'AbloSync'"

Your augmentation is missing the `declare global` wrapper:

```ts
// WRONG — augments module scope, not global
interface AbloSync { Schema: typeof schema }

// RIGHT
declare global { interface AbloSync { Schema: typeof schema } }
export {};
```

### `'editLayer'` isn't autocompleting on `useIntent`

`Intents` isn't declared on your `AbloSync`. Add it:

```ts
declare global {
  interface AbloSync {
    Intents: {
      editLayer: { layerId: string };
      // ...
    };
  }
}
```

### Hook throws "no schema available"

The zero-arg form resolves the schema from `SyncContext`. Wire
`<SyncProvider schema={schema}>` at the root of your app.

## Design notes

- **Empty shell pattern**: declaring `interface AbloSync {}` in the SDK
  is what makes consumer augmentation work. Without the shell, `declare global { interface AbloSync { ... } }` would be a naked identifier
  error in the consumer's build.

- **Compile-time only**: `AbloSync` exists purely in types. It doesn't
  ship any runtime JS. Multi-tenant servers where different orgs have
  different schemas at runtime keep using the imperative
  `createSyncEngine({ schema })` path — the typed-global is per-consumer
  build.

- **Overload order matters**: the typed-global overload sits BEFORE the
  untyped fallback in each hook file. Reversing them would make every
  typed call silently fall through to `Record<string, unknown>[]`. This
  is enforced by convention + commented in each hook file.

- **Why not a config file?** We considered accepting `casing` / schema
  on `createSyncEngine`. But many apps have two consumers of the same
  schema (the web client + a sync-server-in-the-same-repo), and both
  need to agree on identifier casing. Putting `casing` on `defineSchema`
  and the typed global on a `.d.ts` means one source of truth in the
  repo, zero drift.
