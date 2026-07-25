# Deploying the Ablo docs (Blume → Vercel)

The docs are authored in this monorepo and snapshotted into the public
`Abloatai/ablo` repo on release by `packages/ablo/scripts/build-workspace-mirror.sh`
(it copies the whole `docs/ablo/` project). Under Mintlify, that push was enough —
Mintlify built and hosted it. Blume produces static output, so `Abloatai/ablo`
now builds and deploys it itself.

`vercel.json` (next to this file) pins the build: `npm run build` → `dist/`.

## One-time setup

1. Create a Vercel project pointed at the `Abloatai/ablo` repo, **Root Directory
   `docs/ablo`**. Grab its `orgId` and `projectId` (`vercel link` writes them to
   `.vercel/project.json`, or read them in the project settings).
2. Add three repo secrets to `Abloatai/ablo` → Settings → Secrets → Actions:
   `VERCEL_TOKEN` (a Vercel access token), `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
3. The release snapshot generates `.github/workflows/deploy-docs.yml` in
   `Abloatai/ablo`; do not maintain a separate copy in the public repository.
4. Point the custom domain: add `docs.abloatai.com` to the Vercel project, then
   set DNS `CNAME docs.abloatai.com → cname.vercel-dns.com`. Remove the old
   Mintlify integration/DNS once the Vercel deploy is green.

## Generated workflow

`packages/ablo/scripts/build-workspace-mirror.sh` owns the workflow alongside
the npm release workflow. This keeps the exact public repository state
reproducible when `sync-mirror.sh` replaces the mirror contents. Until all
three Vercel secrets are configured, the workflow exits successfully with a
warning and does not attempt a deployment.

`vercel build` runs the project's `buildCommand` (installing deps and running
`blume build`) and wraps `dist/` into `.vercel/output`; `vercel deploy --prebuilt`
ships exactly that, so the site never rebuilds on Vercel's side.

> The decks docs (`docs/decks/`) deploy the same way from their own repo/project —
> give them a separate Vercel project (Root Directory `docs/decks`) and a distinct
> domain or path, since two projects can't both own `docs.abloatai.com`.
