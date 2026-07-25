# Environment resolution

The CLI resolves an explicit credential in this order:

1. `ABLO_API_KEY` already exported in the shell
2. `ABLO_API_KEY` in `.env.local`
3. `ABLO_API_KEY` in `.env`
4. the key saved by `ablo login`

An exported shell variable wins over project files. If a shell has an old
`OPENAI_API_KEY` (or another application credential), it can likewise shadow a
new value in `.env.local`; restart the shell or run `unset OPENAI_API_KEY`
before retrying. Do not paste secrets into command output or commit env files.

When a command appears to target the wrong place, run `ablo status`. It reports
the credential source, key environment, local project selection, and—when the
control plane is reachable—the server-confirmed project and plane. The server
confirmed target is authoritative; a local project or mode selection is only a
preference until the credential is checked.
