# Deploying the Ablo docs (Blume → Vercel)

The docs are authored in this monorepo and snapshotted into the public
`Abloatai/ablo` repo on release by `packages/sync-engine/scripts/build-public-mirror.sh`
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
3. Add the workflow below as `.github/workflows/deploy-docs.yml` in `Abloatai/ablo`.
4. Point the custom domain: add `docs.abloatai.com` to the Vercel project, then
   set DNS `CNAME docs.abloatai.com → cname.vercel-dns.com`. Remove the old
   Mintlify integration/DNS once the Vercel deploy is green.

## Workflow — `.github/workflows/deploy-docs.yml` (in Abloatai/ablo)

```yaml
name: Deploy docs (Blume → Vercel)

on:
  push:
    branches: [main]
    paths: ["docs/ablo/**"]
  workflow_dispatch:

concurrency:
  group: deploy-docs
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: docs/ablo
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: docs/ablo/package-lock.json
      - run: npm install --global vercel@latest
      - run: vercel pull --yes --environment=production --token="$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      - run: vercel build --prod --token="$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      - run: vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

`vercel build` runs the project's `buildCommand` (installing deps and running
`blume build`) and wraps `dist/` into `.vercel/output`; `vercel deploy --prebuilt`
ships exactly that, so the site never rebuilds on Vercel's side.

> The decks docs (`docs/decks/`) deploy the same way from their own repo/project —
> give them a separate Vercel project (Root Directory `docs/decks`) and a distinct
> domain or path, since two projects can't both own `docs.abloatai.com`.
