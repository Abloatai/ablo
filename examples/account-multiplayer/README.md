# Account multiplayer

One reference boundary for two authenticated humans, an agent, account isolation,
presence and reconnect. Uses real Ablo sessions and transports. The browser uses memory persistence so each account mount owns a fresh local replica.
No LLM is needed:
the worker simulates cancellable execution for three seconds, then holds its claim
idle for three seconds so the distinction is visible.

Start at `src/index.ts` (server orchestration). Follow `accounts/index.ts` for
identity and grants, `agent/index.ts` for account-scoped run receipts,
`agent/execution.ts` for the claim operation and
`agent/lifetime.ts` for process ownership. `workspace/index.tsx` owns React
lifecycle and presence; `schema.ts` is the shared data contract.

## Run

From this directory, with Node 24 and an authenticated Ablo CLI:

```sh
npm install
DEMO_BRANCH="account-multiplayer-$(date +%s)"
DEMO_EXPIRES_AT="$(node -e 'console.log(new Date(Date.now()+8*60*60*1000).toISOString())')"
npx ablo branch create "$DEMO_BRANCH" --kind test --hosted --expires-at "$DEMO_EXPIRES_AT"
npx ablo dev --no-watch --branch "$DEMO_BRANCH" --schema src/schema.ts
```

This explicitly creates a disposable hosted test branch, then mints its runtime
credential and pushes the example schema. Ordinary `ablo dev` does not create
hosted storage. The test branch expires after eight hours; it is not a production
Postgres integration and does not prove WAL confirmation. To exercise your own
Postgres, use a separate non-production database with matching tables and the
reviewed connection setup instead. Never use a production branch for this app.
When finished, delete the disposable branch with `npx ablo branch delete "$DEMO_BRANCH"`.
Load the generated `.env.local` into the process environment and set a local
`DEMO_PASSWORD`, then:

```sh
node --env-file=.env.local --import tsx src/index.ts
```

Alternatively `npm run dev` uses variables already in the environment.
`ABLO_BASE_URL` optionally selects a local server for the server-side client.
Vite passes only that base URL to the browser client; the API key stays server-side.
Open http://localhost:5173 in separate browser profiles and sign in as `alice`
and `bob` using `DEMO_PASSWORD`. Both belong to alpha. Alice also belongs to beta;
`eve` belongs only to beta. Create a chat and open it in both profiles, run the
agent, leave the chat, disconnect/reconnect, and switch accounts.

The local password/cookie adapter is deliberately small: this server binds only
to loopback. Replace it with your application's authentication and membership
lookup before hosting it. Ablo session grants remain derived on the server.

## Verify

```sh
npm run typecheck
npm test
# No live credential needed; starts the app with an inert dummy key:
npm run test:smoke
# Requires the same isolated branch environment and a Playwright browser:
npx playwright install chromium
npm run test:browser
```

Unit tests cover membership, seven ownership failure/cleanup paths, and completion
after cleanup. The browser
test uses three isolated authenticated contexts and a second tab. It starts two
distinct agent identities on the same row, verifies exactly one execution and
one skipped contender, then verifies acquisition after release. Bob renames the
chat while Alice is offline; Alice must receive that exact title after reconnect.
Selectors use the exact conversation ID returned by create. Run the browser suite against a populated branch when checking repeatability;
a single passing run does not prove repeated-run or production acceptance.

`tests/data-plane.spec.ts` additionally uses public scoped SDK clients directly.
It checks allowed reads and writes, cross-account direct-ID and list isolation,
and denial of cross-account updates, forged creates and claims. A read-only
session must also fail to update its own account. These checks do not rely on
what the UI hides.

### Composed local acceptance

From a repository checkout, build the SDK and CLI, install this example's
dependencies and Chromium, and provide local Postgres 17 and Redis binaries.
Then run from this directory:

```sh
npm run test:acceptance
```

This opt-in command reuses the engine journey harness to start disposable
Postgres, Redis and Rust processes. `ABLO_JOURNEY_SERVER_BIN` can select a native
server built from the candidate source; otherwise the harness resolves its
normal server binary. `ABLO_PG_BIN` can select the directory containing
`initdb` and `pg_ctl`. It requires no hosted credentials or production access.

The first check installs freshly packed public CLI/SDK packages in a temporary
project, pushes the generated schema, and creates, reads, updates and reads back
a row. The second pushes this reference's schema and runs both the direct
authorization checks and the existing multiplayer browser test against the same
local engine. A startup smoke pass alone is not acceptance evidence.

The disposable fixture uses Ablo-owned log storage. It does not prove customer
Postgres/WAL confirmation, production deployment recovery, grant revocation,
field redaction, subscription sharing or a latency target. The password adapter
and simulated agent remain local demonstrations. The command is separate from
the normal journey suite and does not replace a release gate.

The account-multiplayer workflow runs on manual dispatch. It typechecks the
example, runs its unit tests and production build, runs the startup smoke test
in Chromium, and runs the React suites in `@abloatai/humans` that the example
depends on. It does not boot a sync server.

For a deployed-plane check, `npm run test:browser` still accepts your isolated
branch's `ABLO_API_KEY` and `ABLO_BASE_URL` plus `DEMO_PASSWORD`. Never point the
example at a production branch.

Each agent start returns a run ID. Account-scoped run receipts report status and
execution count for 60 seconds after cleanup completes. They let callers distinguish
contention from a completed run; they are process-local, not a durable job queue.
