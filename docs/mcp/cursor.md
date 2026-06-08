# Cursor

## Install

Add the Ablo Sync MCP server to Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "ablo": {
      "transport": "http",
      "url": "https://<your-app>/api/mcp"
    }
  }
}
```

The file lives at `~/.cursor/mcp.json` on macOS / Linux. No auth header is
needed — the endpoint is public and serves only docs, schema lint, and
scaffolds.

Restart Cursor. The Ablo Sync tools appear under the MCP icon in the agent
panel.

## Verify

In Cursor's agent panel, open the MCP tools list. You should see the
Ablo Sync integration tools and their JSON schemas: `search_ablo_docs`,
`get_recipe`, `get_api_surface`, `validate_schema`, `scaffold_app`.

## More

- [MCP overview](/docs/mcp) — what the server exposes and how the transport works.
- [Claude Code setup](/docs/mcp/claude-code) — CLI install.
- [Windsurf setup](/docs/mcp/windsurf) — same JSON shape.
