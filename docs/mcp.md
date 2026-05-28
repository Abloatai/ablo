# Model Context Protocol

Ablo ships an MCP server at `/api/mcp`. Connect any MCP-compatible AI
assistant — Claude Code, Cursor, Windsurf — and your sync models become
typed, callable tools.

## Install

Pick your client:

- [Claude Code](/docs/mcp/claude-code)
- [Cursor](/docs/mcp/cursor)
- [Windsurf](/docs/mcp/windsurf)

## How it works

Each model you declare becomes one or more MCP tools:

| Model method | MCP tool name | What it does |
|---|---|---|
| `retrieve` | `<model>.retrieve` | Returns the row + a stamp. |
| `list` | `<model>.list` | Cursor-paginated discovery. |
| `update` | `<model>.update` | Write, requires the prior stamp. |
| `<model>.claim` | `claim.create` | Claim a row before writing, then release when held work finishes. |

The assistant gets typed JSON schemas, real argument types, and typed
rejections when it writes stale state. No invention, no hallucinated IDs.

## Auth

The MCP transport uses a scoped bearer token issued by your server. Pass that
token into the MCP client's auth header configuration. See your client's setup
guide for the exact mechanism.

## Limits

The MCP endpoint is rate-limited per token. Read-heavy bursts are fine;
write-heavy bursts get throttled at the dashboard-configured cap.

## More

The [MCP landing page](/mcp) has the product pitch. The route handler
itself is at `apps/sync-web/src/app/api/mcp/route.ts` if you want to read
the implementation.
