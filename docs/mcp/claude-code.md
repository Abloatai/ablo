# Claude Code

## Install

```bash
claude mcp add --transport http ablo https://<your-app>/api/mcp
```

That's it — no token or header needed. The endpoint is public and serves
only docs, schema lint, and scaffolds. The next `/help` in Claude Code will
list the Ablo Sync tools.

## Verify

In Claude Code, run:

```
/mcp list
```

You should see `ablo` with the integration tools enumerated:
`search_ablo_docs`, `get_recipe`, `get_api_surface`, `validate_schema`,
`scaffold_app`.

## Removing

```bash
claude mcp remove ablo
```

## More

- [MCP overview](/docs/mcp) — what the server exposes and how the transport works.
- [Cursor setup](/docs/mcp/cursor) — same URL, different UI.
- [Windsurf setup](/docs/mcp/windsurf) — same URL, different UI.
