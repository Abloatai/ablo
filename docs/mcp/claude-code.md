# Claude Code

## Install

```bash
claude mcp add --transport http ablo-sync https://<your-app>/api/mcp
```

That's it. The next `/help` in Claude Code will list the Ablo Sync tools.

## With auth

If your deployment requires a scoped bearer token (production setups should):

```bash
claude mcp add --transport http ablo-sync https://<your-app>/api/mcp \
  --header "Authorization=Bearer $ABLO_MCP_TOKEN"
```

Create a session-scoped bearer token from your server or dashboard — see
[MCP overview](/docs/mcp#auth).

## Verify

In Claude Code, run:

```
/mcp list
```

You should see `ablo-sync` with the model tools enumerated.

## Removing

```bash
claude mcp remove ablo-sync
```

## More

- [MCP overview](/docs/mcp) — how the transport works.
- [Cursor setup](/docs/mcp/cursor) — same JSON, different UI.
- [Windsurf setup](/docs/mcp/windsurf) — same JSON, different UI.
