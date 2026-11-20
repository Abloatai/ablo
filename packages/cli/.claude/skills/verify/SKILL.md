---
name: verify
description: Drive the built ablo CLI end-to-end against a real local sync-server (journey wiring) — use to verify CLI changes (connect/push/status/logs) at their real HTTP surface instead of unit tests.
---

# Verify ablo CLI changes end-to-end

The CLI's surface is the terminal talking HTTP to the sync-server. Verify by
running the **built** CLI against a **real** locally-booted server, never by
importing CLI internals.

## Build the CLI

```sh
cd packages/cli && npm run build   # → dist/cli.cjs
```

## Boot a real server (the engine binary + real api-key auth)

Write a small launch script run with `npx tsx` that uses the test fixtures in
`@ablo/db/testing` (`packages/database/testing/`) and the engine binary:

- `startEphemeralPostgres()` + `startEphemeralRedis()` — control-plane PG (prisma-pushed) and a private Redis
- `seedJourneyOrg(sql, label)` + `mintSecretKey(sql, orgId, 'sandbox', label)` over `connectTestDatabase(pg.url)` — a real `sk_` key
- spawn `experiments/rust-sync/full-server/target/release/server` (`cargo build --release --bin server` there) with `ABLO_NATIVE_DATABASE_URL=<pg.url> ABLO_NATIVE_REDIS_URL=<redis.url> ABLO_NATIVE_PORT=0 AGENT_AUDIT_HMAC_KEY=<any>`; it prints `{"ready":true,"port":N}` on stdout
- hold the process open; kill the server, `redis.stop()` and `pg.stop()` on SIGTERM

`packages/engine-journeys/src/harness/journeyServer.ts` is the same launch inside vitest.

Point the CLI at it with `ABLO_API_URL=http://127.0.0.1:<port> ABLO_API_KEY=<minted>`.

## Customer database for `connect` flows

`connect check/--register` locally probes `DATABASE_URL`, which needs
`wal_level=logical`. Don't touch the user's main Postgres — init a throwaway
cluster in the scratchpad:

```sh
initdb -D $DIR -U cust_owner
pg_ctl -D $DIR -o "-p 55444 -c listen_addresses=127.0.0.1 -c wal_level=logical -c unix_socket_directories='' -F" start
#                                     unix sockets OFF: scratchpad paths exceed the 103-byte socket limit
createdb -h 127.0.0.1 -p 55444 -U cust_owner custdb
psql ... -c "CREATE TABLE t(id text PRIMARY KEY);" -c "CREATE PUBLICATION ablo_publication FOR ALL TABLES;"
```

Gotchas learned the hard way:
- **Host must look public.** Registration's zod shape-check rejects `127.0.0.1`
  (`database_url host must be a public hostname or public IP`). Use
  `db.localtest.me` — public DNS that resolves to 127.0.0.1, so the CLI's local
  preflight AND the server's shape check both pass.
- **Connection string needs a password.** A passwordless URL 500s in
  `replicationSourceRegistry.register` (empty `connectionRef` ZodError). Any
  password works under local trust auth: `postgres://cust_owner:custpw@db.localtest.me:55444/custdb`.

## Useful contrast probe

The server's global not-found envelope is `{"code":"entity_not_found","message":"Not found"}` —
any bare "Not found" from a CLI command means it hit an unmatched route (all
real routes are mounted under `/api`). Curl the suspect path directly to tell
route-miss from data-miss.

## Teardown

Stop the launch-script task (SIGTERM runs its shutdown), `pg_ctl stop` the
customer cluster, delete any file holding the minted key.
