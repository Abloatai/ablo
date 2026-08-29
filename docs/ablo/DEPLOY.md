# Deploying the Ablo docs (Blume → Vercel)

The `ablo-docs` Vercel project deploys this directory directly from
`Abloatai/monorepo`, with `docs/ablo` configured as its Root Directory. Release
preparation also snapshots the whole project into `Abloatai/ablo` through
`packages/ablo/scripts/build-workspace-mirror.sh`; that public copy preserves
the exact package-and-docs release state, but it is not a second deployment
trigger.

`vercel.json` (next to this file) pins the build: `npm run build` → `dist/`.

## Vercel project setup

1. Connect the Vercel project to `Abloatai/monorepo`, production branch `main`,
   with **Root Directory `docs/ablo`**.
2. Leave the Ignored Build Step disabled. In particular, do not compare only
   `HEAD^..HEAD`: a release can push several commits at once, and an unrelated
   tip commit would hide docs changes made earlier in the same push. Correctness
   takes priority over avoiding no-op static builds.
3. Point the custom domain: add `docs.abloatai.com` to the Vercel project, then
   set DNS `CNAME docs.abloatai.com → cname.vercel-dns.com`. Remove the old
   Mintlify integration/DNS once the Vercel deploy is green.

## Build and deployment

Vercel runs the `buildCommand` in `vercel.json` (`npm run build`, which invokes
`blume build`) and serves `dist/`. Every push to `main` produces a production
deployment; other branches produce previews. To recover a canceled Git
deployment, choose **Redeploy** in Vercel and clear **Use project's Ignore Build
Step**. That preserves the repository-root upload expected by the project's
Root Directory setting.

The public release mirror contains this complete project so its docs inputs can
be reviewed and reproduced from the same release snapshot as the npm packages.

> The collections docs (`docs/collections/`) deploy the same way from their own repo/project —
> give them a separate Vercel project (Root Directory `docs/collections`) and a distinct
> domain or path, since two projects can't both own `docs.abloatai.com`.
