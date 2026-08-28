# Ablo implementation index

> Route an implementation task to the smallest relevant Ablo guide before reading details.

Start with [Introduction](./index.md), then [Choose the Ablo operation](./implement.md). Its one routing table
separates ordinary reads, existing application writes, claims, captured reads,
atomic commits, retries, GraphQL, and external effects. Do not scan every page.

| Your task | Read first |
|---|---|
| Choose among nearby SDK and ownership patterns | [Choose the Ablo operation](./implement.md) |
| Add Ablo to existing work without replacing its API, transaction, filesystem write, or Git merge | [Coordinate existing work](./coordinate-existing-work.md) |
| Install Ablo and create a typed client | [Installation](./installation.md) |
| Read, write, and coordinate shared state | [Basic usage](./basic-usage.md) |
| Choose between a plain read, guarded read, claim, or atomic commit | [Concurrency convention](./concurrency-convention.md) |
| Look up an exact method, option, or error type | [API reference](./api.md) |
| Connect Ablo to an existing Postgres database | [Integration guide](./integration-guide.md) |

Follow links from that page only when its routing rule applies. Examples prove a
specific integration; they are not required reading for a first implementation.
