# Sync engine / Rust assessment — 2026-09-30

**Recommendation: keep the current engine. Do not authorize a rewrite or a
native extraction from this evidence.** The measured client deduplication stage
is too small a share of normal receive work to justify a new runtime boundary.
The authoritative server is outside this repository. **The requested Rust
comparison is incomplete:** the prototype is written, but no Rust compiler was
available and permitted compiler acquisition failed. There are no Rust speedup,
memory, compilation, or differential-parity results in this report.

## Ownership and version

The checkout remote is `https://github.com/Abloatai/ablo.git`.
[CODEMAP.md](../../CODEMAP.md) explicitly excludes the authoritative server;
the repository owns the public SDK, HTTP/WebSocket transport, and reactive
client. The connected-repository catalog exposed only `Abloatai/ablo`, so it
was not possible to inspect or benchmark the server implementation elsewhere.
Public package repository metadata does not establish server ownership.

The originating consumer pins `@abloatai/ablo` 0.66.5, released at
`d6e781d8eb76ae9050fd73a235348f7b8476ad61`. This experiment uses the selected
checkout's 0.66.6 source at `20ef9cec152f1b6fc23900a8b996e1446484178f`.
The delta pipeline is unchanged between those commits. `Database.ts` changed
only connection-close/reopen handling for IndexedDB; the measured in-memory
batch path is unchanged. This is source measurement, not a benchmark of an
installed 0.66.5 package or the originating application.

## Actual flow and chosen candidate

`packages/ablo/src/client.ts` re-exports `packages/humans`. Its composition runs
through `Ablo.ts`, `local/client/reactiveEngine.ts`, `createModelOperations.ts`,
`SyncClient.ts`, and the mutation queue. The authoritative write happens on
the absent server; the confirmed stream returns through the transaction
package's WebSocket transport and the humans `SyncWebSocket` subclass.

Receive processing normalizes and validates each wire delta with
`clientSyncDeltaSchema`, then `persistDeltaFrame` / `enqueueDelta` performs
confirmation bookkeeping. Group changes (`G`/`S`) follow their security path
before ordinary deltas enter the drain. `flushPendingDeltas` detaches one
single-flight batch, deduplicates, calls `Database.processDeltaBatch`, applies
results to the pool with transaction-preserving slices, and only then
acknowledges the persisted cursor. A failed flush restores its batch ahead of
later arrivals; a failed revocation handler clears the pool and reboots.

The candidate is `deduplicateDeltas` in
[`deltaPipeline.ts`](../../packages/humans/src/local/sync/deltaPipeline.ts).
Replay frames require stable sorting, temporary arrays, and a `Set`; this is
an isolated CPU/allocation-sensitive boundary, unlike porting database I/O.
Ordered frames already have a linear, allocation-free fast path. It was a
candidate to measure, **not an established dominant hotspot**.

The Rust prototype reads finite IEEE-754 IDs and returns stable original-array
indexes. It does not copy or interpret row payloads. Adjacent equal IDs in the
stable sorted index array eliminate the hash set. Distinct IDs for the same
entity remain distinct; the first payload for an equal ID survives. Any
nonpositive ID bypasses sorting/deduplication for the entire frame. Ordered,
empty, and single-element arrays return by original-array identity through
the wrapper. Fractional IDs and values beyond the safe-integer boundary are
kept as doubles, matching the existing finite-number contract.

No Rust code is wired into production. Validation, group authorization,
revocation, transaction visibility, persistence, retry, and ack remain JS-owned.
Nonfinite IDs are rejected by both the upstream JS validator and the binary
experiment protocol. The prototype is not a replacement wire parser.

## Reproduce

From the repository root, with dependencies installed:

```sh
npm ci --ignore-scripts
node experiments/rust-sync/run.mjs --baseline-only --check
node experiments/rust-sync/run.mjs --baseline-only
```

With Rust/Cargo installed (Rust >= 1.66 for `std::hint::black_box`):

```sh
node experiments/rust-sync/run.mjs --check
node experiments/rust-sync/run.mjs
```

The latter commands are **prepared but unverified in this environment**. They
run dependency-free `cargo test --release --offline` and
`cargo build --release --offline` with LTO and one codegen unit, then 309
cross-language differential cases. They compare the production JS function
with a persistent Rust worker on identical IDs, measuring kernel time and,
separately, the complete ID projection / pipe transport / index reconstruction
cost. This IPC boundary is an experiment, not a proposed deployment architecture.
Kernel time alone is not a native-extension or WASM performance forecast.

`flow.ts` bundles actual source using the already installed esbuild. Production
files and package manifests are unchanged. Generated bundles/binaries are
ignored. Baseline runs write `baseline-results.json`; Rust-enabled runs write
`results.json`. A failed Rust build does not silently fall back to a baseline.

## Measured baseline

Raw samples, throughput, stage counts, timestamps, and memory are in
[`baseline-results.json`](baseline-results.json). Final recorded run:
2026-09-30 06:51 UTC; Node 24.21.0, V8 13.6.233.17-node.53, Linux
6.1.166-24.303.amzn2023.aarch64, arm64, 8 reported CPUs and 16,832,106,496
reported memory bytes. Node reports CPU model `unknown`; `/proc/cpuinfo`
reports implementer `0x41`, part `0xd40`, variant `0x1`, revision `1`.
Host contention and container resource guarantees are unknown.

Each kernel gets 30 warmup calls and seven samples, with 500 repetitions per
small-frame sample or 20 per large-frame sample. Full-flow timing gets one
entire warmup workload and seven samples. No forced GC, affinity pinning, or
production traffic was used. All rows and inputs are synthetic and deterministic.

| Kernel input | JS median/frame | Sample min–max |
| --- | ---: | ---: |
| 1,300 ordered deltas | 0.0110 ms | 0.0110–0.0145 ms |
| 1,300 unique + 130 shuffled replay deliveries | 0.3450 ms | 0.3447–0.3783 ms |
| 50,000 ordered deltas | 0.4195 ms | 0.4162–0.4209 ms |
| 50,000 unique + 5,000 shuffled replay deliveries | 23.8948 ms | 23.8669–24.5436 ms |

The **full local headless receive baseline** uses 8,000 seeded rows and 40
frames of 1,300 unique updates, with titles, status, organization and creator
fields, sync groups, timestamps, and ten-row transaction IDs. The replay
variant adds 10% equal-ID deliveries and shuffles each frame. Frame size and
row count follow the repository's existing `applyPool.bench.test.ts` workload.

Timing includes JSON decoding, actual transport normalization/validation,
confirmation callbacks, enqueue, dedupe, actual in-memory database writes,
actual model/pool application, slice scheduling, notification, and a local ack
callback. Setup/seeding, fixture serialization, and final assertions are
outside the timer. Every final row is checked in both storage and the pool;
the final applied workload must acknowledge cursor 60,000.

| Full local workload | Median | Sample min–max | Input throughput |
| --- | ---: | ---: | ---: |
| 52,000 ordered updates | 319.99 ms | 317.77–333.74 ms | 162,505/s |
| 57,200 replay deliveries | 363.90 ms | 358.37–391.21 ms | 157,185/s |

Separate instrumented runs avoid charging profiling to those medians. The
profiler's environment flag is set **before module loading**, and the harness
asserts that all 40 batches were recorded.

| Attributed stage | Ordered | Replay |
| --- | ---: | ---: |
| Wire normalization/validation | 137.20 ms | 149.21 ms |
| Deduplication | 1.21 ms | 15.39 ms |
| Local persistence | 30.91 ms | 34.73 ms |
| Pool apply | 100.88 ms | 100.91 ms |
| Entire instrumented flow | 382.70 ms | 419.68 ms |

The remainder includes JSON decoding, enqueue/bookkeeping, scheduling, and
other uninstrumented work. The profiler's `receive` zero means that stage is
not timed here, not that receiving costs nothing. Profiling overhead is
visible; these stage shares are approximate. Deduplication is 0.32% ordered
and 3.67% replay of instrumented wall time. Even removing it entirely with
zero boundary cost gives only about **1.003× / 1.038×** overall speedup for
these workloads. Large replay batches do show tens of milliseconds of sort
work, but that stress case is not evidence that they dominate actual traffic.

Peak process RSS was 625,660 KiB (~611 MiB), including bundled SDKs, fixtures,
two profiling module instances, repeated workloads, GC, and the harness. This
is not retained engine memory. The planned Rust worker holds only IDs while
Node retains payloads; its RSS must not be presented as an equivalent-engine
memory comparison.

## Checks and limits

Observed checks:

- `node experiments/rust-sync/run.mjs --baseline-only`: seven-sample baseline,
  309 JS-versus-independent-reference cases, payload identity/input immutability,
  nonpositive/fractional/large IDs, all action types carried unchanged, malformed
  wire rejection, persistence failure requeue/no ack, and revocation failure
  clear/rebootstrap passed. **Zero Rust differential cases executed.**
- `npm test --workspace=@abloatai/humans -- --runInBand --runTestsByPath`
  with these paths: `src/local/sync/__tests__/deltaPipeline.deduplication.test.ts`,
  `deltaPipeline.revocation.test.ts`, `deltaPipeline.singleFlight.test.ts`,
  `deltaPipeline.sliceApply.test.ts` in that same directory;
  `src/local/__tests__/applyDeltaBatchToPool.atomic.test.ts`,
  `applyDeltaBatchToPool.rowWatermarks.test.ts` in that directory; and
  `src/local/stores/__tests__/bootstrapPersistence.test.ts`:
  **29 tests in seven suites passed** (two invocations: 22 + 7).

This baseline has no real socket, server mutation, permission admission,
PostgreSQL/WAL, network latency, browser IndexedDB, active React view, or
production load distribution. Ack is a local callback. The timed workload is
ordinary updates; group handling is checked separately. It establishes no
server I/O bottleneck or end-to-end server latency. A server-wide full-flow
baseline remains missing because its implementation is unavailable.

Rust/Cargo were absent. The official installer returned HTTP 403; the static
distribution host explicitly returned `blocked-by-allowlist`. System package
installation failed on read-only package-list storage. A scoped Lobby network
access request then failed with `Access requests are unavailable`. These
restrictions were respected. A local Docker inventory had no cached compiler
image. Supply a permitted arm64 Rust toolchain, run the two Rust commands above,
and record compiler version/results before treating the prototype as tested.

## Decision and cost

Keep the existing engine now. First obtain the actual server repository and
run a realistic commit → database confirmation → publication → observer-ack
baseline with stage attribution. CPU profiles should justify any extraction;
an I/O-bound server will not become faster simply by changing its language.
On the measured client, validation and model application deserve investigation
before dedupe; their dynamic JS/Zod/MobX contracts make a Rust port substantially
more involved than this ID-only leaf.

An ID-only extraction would still require a supported N-API or WASM boundary,
cross-platform builds, binary distribution, fallback behavior, IPC/FFI error
handling, and browser compatibility. Test an adjacent-ID JS dedupe optimization
before attributing any future improvement to Rust: the prototype changes both
representation and algorithm (removing a hash set). Do not ship either on this
baseline alone.

A full rewrite additionally moves schema validation, authority, groups,
ordered replay, claims, idempotency, persistence cursors, reconnect/retry,
observability, and rolling protocol compatibility into a second implementation.
It needs differential replay, fault injection, shadow traffic, staged rollout,
rollback, and ongoing Rust operational ownership. With the server absent and
Rust unmeasured, a schedule/cost estimate would be invented. No demonstrated
benefit currently pays for that migration.

Production behavior is unchanged. This is a reviewable partial experiment,
not completion of the requested Rust/server assessment. No merge or deployment
is authorized by this work.
