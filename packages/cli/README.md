# @abloatai/cli

The `ablo` command line: set up Ablo, connect your database, and push your schema from the terminal.

```sh
npx ablo init      # scaffold ablo/ with a starter schema
npx ablo login     # authorize in your browser, set up your keys
npx ablo connect   # connect your database
npx ablo push      # upload your schema; your rows stay in your database
npx ablo dev       # push, then keep watching for changes
npx ablo status    # see what your key acts on and whether writes will work
```

Run `npx ablo --help` for the full command list, or `npx ablo docs` to read the guides.

## Installing

`npx ablo` works with nothing installed: it ships inside [`@abloatai/ablo`](https://www.npmjs.com/package/@abloatai/ablo), which resolves this package and fetches it on first run. Add it to a project for pinned, offline runs:

```sh
npm i -D @abloatai/cli
```

## What it does

The CLI drives your Ablo project against the `@abloatai/ablo` SDK. Your schema lives in `ablo/`; `push` and `dev` send it to Ablo, and your rows stay in your own database.
