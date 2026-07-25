<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Coordination infrastructure for humans, agents, and backend systems.</strong>
</p>

<p align="center">
  <a href="https://docs.abloatai.com">Docs</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/quickstart">Quickstart</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/api">API</a> &nbsp;|&nbsp;
  <a href="https://github.com/Abloatai/ablo">GitHub</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@abloatai/ablo"><img src="https://img.shields.io/npm/v/@abloatai/ablo?style=flat-square&color=2563eb" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563eb?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-22c55e?style=flat-square" alt="node >=24" />
  <img src="https://img.shields.io/badge/types-included-2563eb?style=flat-square" alt="types included" />
</p>

---

Ablo is a TypeScript framework and API for applications where AI agents,
people, and backend services work on the same data. It provides typed reads and
writes, claims, safe retries, authoritative confirmation, live updates, and
attribution while your Postgres remains the source of truth.

The SDK is backed by a pure HTTP transaction API, so Ablo works in agents,
servers, jobs, command-line tools, and interactive applications without
requiring a browser or reactive client.

## Why Ablo

Humans coordinate shared work naturally. We see that somebody is editing,
agree on who takes which part, wait our turn, and look again before continuing.

Agents do not have that awareness. Two agents can read the same row, think for
thirty seconds, and overwrite each other. An agent can act on information that
changed while it was reasoning without causing a database conflict at all.

Ablo gives agents the same practical capabilities humans rely on: see who is
working, claim a row or field, wait fairly, receive fresh state, prove what
they may do, and leave an attributed record. Humans and backend services use
the same rules, so there is no separate agent write path.

```ts
await using claim = await ablo.orders.claim({ id: orderId });

const priced = await pricingAgent(claim.data);

await ablo.orders.update({
  id: orderId,
  data: { total: priced.total, status: 'repriced' },
  claim,
  wait: 'confirmed',
});
```

The claim releases automatically. Overlapping work takes turns, stale work is
rejected, retries are safe, and `confirmed` means the authoritative database
reported the change back.

## Start

```sh
npm install @abloatai/ablo
npx ablo init
npx ablo push
```

Use `@abloatai/ablo` for agents and backend code,
`@abloatai/ablo/client` for live applications, and
`@abloatai/ablo/react` for React. All entrypoints share the same schema,
authority, commits, claims, and ordered changes.

Read the [Quickstart](./docs/quickstart.md), browse
[docs.abloatai.com](https://docs.abloatai.com), or run `npx ablo docs`.
Coding agents can read `node_modules/@abloatai/ablo/llms.txt`.

## Contributing

Ablo is free and open source. You can help by
[opening an issue](https://github.com/Abloatai/ablo/issues),
[suggesting a feature](https://github.com/Abloatai/ablo/issues/new), or
[contributing code](https://github.com/Abloatai/ablo/pulls).

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Abloatai/ablo/security/advisories/new).

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
