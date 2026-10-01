# Sync engine / Rust assessment — 2026-09-30

**Recommendation: fix the repeated expiry scan in JavaScript before considering
an engine rewrite. The requested Rust kernels have now been compiled and run.**
The current algorithm is faster in Rust, but retaining the same repeated scan
retains quadratic burst work. The comparison below separates changing the
language from skipping work whose expiry condition cannot yet be true.
This is a client hot-path experiment, not a full Rust engine or server test.

## Completed Rust comparison

Measured on Apple M1 (arm64), Node v24.18.0,
rustc 1.98.1 (48a229cea 2026-09-01). Seven samples per variant, rotating execution order,
after warmup. The final complete run is in [tracking-results.json](tracking-results.json);
an earlier complete run is retained in [tracking-first-results.json](tracking-first-results.json).
Background browser/editor/system activity caused substantial variance. For the
8k current algorithm, JS medians were 445 and 269 ms; Rust medians were 99 and
57 ms across those runs. These are local directional measurements, not capacity
or latency guarantees. No unrelated applications were stopped.

**Identical tracking workload in both languages, median milliseconds:**

| Additions | Current JS | Same algorithm, Rust | Expiry gate, JS | Same expiry gate, Rust |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 7.18 | 1.45 | 0.59 | 0.71 |
| 4,000 | 89.92 | 18.29 | 2.73 | 3.10 |
| 8,000 | 269.38 | 57.37 | 4.82 | 4.78 |

The Rust port preserves the full repeated scan. Both current kernels visit
31,998,950 entries for the 8k fixed-clock burst. Rust is approximately 4.7x
faster on that workload; the optimized kernels have similar 8k medians, with
no demonstrated material Rust advantage after removing redundant scans.
The gate tracks a conservative minimum timestamp and scans only when an
entry can be older than one second. It preserves the exact `> 1000` expiry,
truthy timestamp / `< 50` rapid-add check, live-instance rejection, delta
history comparison and clearing on removal. Removing or overwriting the
minimum may trigger an extra scan, but cannot delay expiry; backwards time
changes also retain the production decisions. No cleanup is disabled.
The gate is a benchmark-only prototype, not a production patch.

**Actual InstanceCache.add with preconstructed models, median milliseconds:**

| Additions | Current cache | JS cache with expiry gate |
| --- | ---: | ---: |
| 1,000 | 22.81 | 2.17 |
| 4,000 | 100.56 | 6.93 |
| 8,000 | 248.27 | 11.42 |

The 8k actual-cache improvement is about 22x, including normal MobX/index/view
notification work with no active subscribers. This confirms that the algorithm
change helps the real method. It is not a full Rust cache comparison: the
Rust kernel excludes models, payloads, observability, views, eviction and
WeakRefs. Tracking inputs are the same precomputed timestamps/IDs/actions;
source clocks are fixed during parity and pool timings to represent the
sub-second burst and make the exact work independent of machine contention.
Kernel timings include map construction, insertion, duplicate checks and
expiry; snapshot sorting/encoding, input parsing, file transfer and process
startup are excluded in both languages. Rust state destruction is included;
JS garbage collection follows V8's normal schedule. Rust HashMap iteration
order differs, but only final membership and decisions are observable here.
There is no equivalent whole-engine memory comparison.

**Correctness and replay checks:**

- 171 cases compare the projection with the actual production cache, both
  Rust algorithms and the JavaScript expiry gate. Every prefix of the boundary
  fixture checks the 49/50 ms duplicate boundary, 1000/1001 ms expiry boundary,
  timestamp zero, same/older/newer sync IDs, disposed models, removal/re-add,
  backwards clocks and final retained history. Fifty seeded random sequences
  exercise combinations. The unoptimized variants also match exact scan counts.
- One release Rust unit check and 309 delta-dedupe differential cases passed,
  including payload identity, ordering, bypass behavior and invalid input.
  Actual JavaScript persistence-failure and revocation-failure checks passed.
- The original replay experiment now runs in Rust: a 1,430-delta replay kernel
  measured JS 0.349 ms / Rust 0.0206 ms / Rust plus IPC 0.155 ms. For 55k replay
  deltas: JS 28.457 ms / Rust 1.558 ms / Rust plus IPC 11.207 ms. This candidate
  also changes algorithm/representation, so its ratio is not a pure language
  comparison. Ordered 1,300-delta frames cost JS 0.0104 ms versus 0.0406 ms with
  Rust IPC, illustrating the boundary cost. Raw results are in
  [results.json](results.json).
- The complete **JavaScript** local receive/persist/apply/ack baseline measured
  239.89 ms ordered (52k deltas) and 287.22 ms replay (57.2k deltas), checking all
  8,000 final rows. These are not complete Rust-pipeline measurements. Profiled
  dedupe contributed 1.24 ms / 14.54 ms respectively. Browser IndexedDB,
  real networking, active UI and authoritative-server execution are excluded.

Reproduce from the repository root after `npm ci --ignore-scripts` with `rustc`
and `cargo` on PATH:

```sh
node experiments/rust-sync/tracking.mjs
node experiments/rust-sync/run.mjs --check
node experiments/rust-sync/run.mjs
```

On this machine, also set
`SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk`.
The tracking executable compiles with `rustc -O`; the replay executable uses
Cargo release optimization/LTO with no external dependencies. Tracking fixtures
are passed through an ignored temporary file because a repeat using Node's
synchronous stdin pipe stalled; that incomplete repeat was stopped and its
samples are excluded. The file-input rerun completed all checks and samples.
The scripts fail on compilation/parity errors and never substitute JS for Rust.

The authoritative-server source is locally present in a separate monorepo,
but this completed comparison does not benchmark it. These results justify a
focused JavaScript expiry fix and its integration tests, not a server rewrite.


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

The latter commands were **compiled and executed locally on macOS**. They
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

## Initial JavaScript baseline (historical)

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
is not retained engine memory. The measured Rust worker holds only IDs while
Node retains payloads; its RSS must not be presented as an equivalent-engine
memory comparison.

## Checks and limits

Observed checks:

- `node experiments/rust-sync/run.mjs --baseline-only`: seven-sample baseline,
  309 JS-versus-independent-reference cases, payload identity/input immutability,
  nonpositive/fractional/large IDs, all action types carried unchanged, malformed
  wire rejection, persistence failure requeue/no ack, and revocation failure
  clear/rebootstrap passed. The original restricted environment executed zero Rust cases; the completed local run below executed all 309.
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

Rust/Cargo were absent in the original Lobby environment, whose downloads
and access requests were blocked. The local follow-up installed the official
minimal toolchain under temporary storage, without changing shell profiles or
system packages. Rust 1.98.1 compiled and executed the prototypes. The default
macOS 27 SDK did not link with the installed linker; selecting the existing
macOS 15.4 SDK resolved this. No Rust dependencies were downloaded for either
prototype.

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
rollback, and ongoing Rust operational ownership. These measurements do not establish a server migration cost or benefit.
The full server remains unmeasured. The client tracking results favor removing
repeated scans before introducing a Rust runtime boundary.

Production behavior is unchanged. The Rust tracking and replay comparisons
are completed; a full server rewrite assessment remains outside these measurements.
No merge or deployment is authorized by this work.

## Follow-up: broader hot-path investigation

The original cold-update baseline cannot rule out severe behavior with active
consumers, create bursts, or backlog. Two additional probes expose that gap.

The existing benchmark was run with:

```sh
npm test --workspace=@abloatai/humans -- --runInBand --silent=false --runTestsByPath __tests__/unit/applyPool.bench.test.ts
```

Both tests passed. In this **single diagnostic run** (not a repeated estimate),
104,000 updates took 2,970.9 ms with activated models versus 598.9 ms cold:
approximately 5x. Activating 8,000 models cost another 834.3 ms once. This is
an isolated pool test, not a React/browser or server latency result.
Its at-cap CREATE result (23.1 ms) is particularly misleading as a general
throughput number: `wireAddRetentionLimit` admits zero fresh rows into a full,
unsubscribed headless cache. With subscribers/views, that limit is disabled.
The benchmark's reported input count is not the number of materialized rows.

The new focused probe runs the real `InstanceCache` on unique preconstructed
rows, checks every retained object by identity, and measures seven samples
after warmup. It excludes construction, WeakRefs, eviction and subscribers.

```sh
node experiments/rust-sync/hotpath.mjs
```

Raw results are in [hotpath-results.json](hotpath-results.json), with source
commit and runtime metadata. Single/batch timing order alternates; the
cleanup-disabled diagnostic runs last, so its ratio is indicative rather than
a rigorously randomized causal estimate.

| Unique rows | Single `add` median | `addBatch` median | Single add, cleanup disabled |
| --- | ---: | ---: | ---: |
| 1,000 | 8.07 ms | 0.93 ms | 1.71 ms |
| 4,000 | 70.86 ms | 2.83 ms | 5.59 ms |
| 8,000 | 251.50 ms | 5.91 ms | 12.10 ms |

**Concrete scaling defect:** after 100 tracked additions, each single `add`
calls `cleanupTracking`, which scans the entire map to expire entries older
than one second. During a sub-second unique-row burst, it repeatedly scans
entries that cannot yet expire. A separate fixed-clock structural check
asserts exactly `n * (n + 1) / 2 - 5050` visits: 495,450 at 1k, 7,996,950 at
4k, and **31,998,950 at 8k**. Those fixed-clock runs are excluded from timing.
The real-clock measurements also complete within one second at all sizes.

This single-add path is reached from `createModelOperations` → `SyncClient.add`
→ `InstanceCache.add`, and from custom-entity delivery in `deltaPipeline`.
Ordinary received deltas generally use batch pool operations, so this finding
must not be attributed to every incoming frame or to the absent server.

Disabling cleanup is an experimental ablation, **not a fix**: expiry and rapid
re-add deduplication must remain correct. Likewise `addBatch` is a useful
comparison for unique rows, not a semantics-equivalent substitute for arbitrary
single adds. A follow-up fix should amortize expiry work (for example, ordered
expiry pruning) and test the 50 ms re-add window, one-second expiry, deletes,
and clock behavior. A Rust port preserving the repeated full scan would still
retain its quadratic burst work.

No production code was changed. These are reproducible client-side findings,
not proof of the cause of a live incident. Incident symptoms, affected clients,
workload and server traces are still needed to establish that connection.
