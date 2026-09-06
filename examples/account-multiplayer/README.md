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
npx ablo dev --no-watch --branch account-multiplayer --schema src/schema.ts
```

Use an isolated branch dedicated to this example. The command pushes the example
schema. It does not migrate your application's tables; use a throwaway hosted
plane, or provision matching tables in your own database before running it.
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
Selectors use the exact conversation ID returned by create. The integrated lane
runs the browser suite twice on the same branch to prove it tolerates prior rows.

The server's existing `subject-authorization` journey suite supplies direct-ID,
list, write and claim denial coverage below the UI. From the monorepo root:

```sh
npm run test:journeys -w @ablo/sync-server -- subject-authorization
```

The browser test cannot replace those adversarial checks: absence from a filtered
UI alone does not prove authorization. Both layers are required before claiming
end-to-end isolation on a target data plane.

The dedicated account-multiplayer CI workflow runs both the fast checks and the
real browser/account-denial lane on pull requests and main pushes:

```sh
# Monorepo root; requires built SDKs, Postgres, Redis and Playwright Chromium.
npm run test:multiplayer --workspace=@ablo/sync-server
```

This lane uses the existing journey harness to boot a real sync server with
temporary Postgres and Redis, create a fresh organization and branch credential,
push this schema, and pass the key directly to the example's server process.
The browser still mints real per-human sessions through the example's auth route.
The same lane runs all three subject-authorization journey suites. No CI secret
or hosted project is needed; missing infrastructure and failed assertions fail
the job. Cleanup closes the server and destroys the temporary database. This
proves the checked-out server with hosted SQL storage, not a deployed fleet.

For a deployed-plane check, `npm run test:browser` still accepts your isolated
branch's `ABLO_API_KEY` and `ABLO_BASE_URL` plus `DEMO_PASSWORD`. Never point the
example at a production branch.

Each agent start returns a run ID. Account-scoped run receipts report status and
execution count for 60 seconds after cleanup completes. They let callers distinguish
contention from a completed run; they are process-local, not a durable job queue.
