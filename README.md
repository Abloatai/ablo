# Ablo — The Collaboration Layer for AI and Humans

Coordination for multi-agent apps. Presence, intents, scoped capability tokens — agents and humans as first-class peers on the same entity. Drop-in, entity-first, sub-100ms.

Same engine that powers [Ablo](https://ablo.finance) in production.

## Why

**Agents are participants, not clients.** A "DD bot" holds a capability-scoped seat alongside the partner reviewing its output. Both show up in presence. Both declare intents. Both get attributed on every mutation.

**Coordination, not just collaboration.** Real-time cursors are table-stakes. The hard problem is five agents on the same clause. Ablo gives you intents (`writing`/`editing`), stale-context protection (`snapshot.stamp`), and revocable capability tokens — the primitives multi-agent work needs and nothing has shipped.

**Any model, any vendor.** Not a model. Not an agent framework. The substrate under whatever agent you're running — Harvey, Legora, your in-house Claude, a custom tool-using loop.

### Production characteristics

| Operation | Latency |
|---|---|
| Presence broadcast | <50ms cross-region |
| Mutation round-trip | ~340ms |
| Capability revocation (fleet-wide) | <1s |
| Full bootstrap (4MB) | ~4.5s |

## Install

```bash
npm install @ablo/sync-engine
```

Requires Node 22+ and TypeScript 5+.

## Quick look

```ts
import Ablo from '@ablo/sync-engine';

const ablo = new Ablo();

// Agent joins a room. Peers see it immediately.
const agent = await ablo.join('matter-techco', { label: 'DD Bot' });

// Claim what you're about to touch. Other agents back off automatically.
using claim = agent.intents.writing('clause.indemnity-cap', { ttl: '3m' });

// Frozen view + AbortSignal if it moves mid-work.
const snap = await agent.snapshot(['clause.indemnity-cap']);
const body = await yourLLM({ context: snap.data, signal: snap.signal });

// Commit. Attributed as agent, broadcast to peers, rejected on stale.
await agent.commit({ 'clause.indemnity-cap': { body } });
```

No schema. No provider. No typed global. Just `new Ablo()` + `join()`. Two agents in the same room now see each other's presence and intents in real time; a human editing the same clause in a browser gets conflict signals before they collide.

## Documentation

**Start here**

- [Getting Started](docs/getting-started.md) — join, declare intent, coordinate in 5 minutes
- [Mesh](docs/mesh.md) — presence, intents, snapshots, sub-agents, delegation
- [Authentication](docs/auth.md) — capability tokens, API keys, sessions

**Agents**

- [Agents](docs/agent.md) — long-lived, per-matter, and short-lived agent patterns

**Data layer (optional)**

Ablo can also own your app's reactive data — schema-driven queries, optimistic mutations, offline queue, React hooks. Layer this on top of the mesh when you want Ablo as your sync engine too.

- [Schema Definition](docs/schema.md) — Zod models, relations
- [React Hooks](docs/react.md) — `<AbloProvider>` + `useQuery`/`useMutate`
- [Offline & Sync Groups](docs/offline-and-sync-groups.md) — IndexedDB queue, permission scoping
- [Architecture](docs/architecture.md) — delta log, bootstrap, conflict resolution
- [Testing](docs/testing.md) — unit, integration, e2e patterns

For LLM assistants installing this SDK, point them at [AGENTS.md](AGENTS.md). Porting older code? See [docs/migrated.md](docs/migrated.md).

## Hosted service

Ablo is a hosted service. Sign up at [ablo.finance](https://ablo.finance) and the SDK connects automatically — no URL to configure. Self-hosting is a conversation; get in touch.

## Community

- [GitHub issues](https://github.com/Abloatai/ablo/issues) — bugs, feature requests
- [ablo.finance](https://ablo.finance) — docs, blog, updates

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2025-2026 Fablo Innovation AB. "Ablo" is a trademark of Fablo Innovation AB; the license grants rights to the software, not the trademark.
