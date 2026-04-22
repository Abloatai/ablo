# Server Setup

The sync server handles real-time data synchronization, delta broadcasting, and offline catch-up. It runs as a Go binary backed by PostgreSQL and Redis.

## Quick Start

### Option A: Docker (recommended)

Create a `sync-schema.json` with your models:

```json
{
  "models": {
    "tasks": {
      "type": "Task",
      "table": "tasks",
      "fields": {
        "title": { "type": "string" },
        "status": { "type": "enum", "enumValues": ["todo", "doing", "done"], "default": "\"todo\"" },
        "projectId": { "type": "string", "optional": true, "column": "project_id" }
      },
      "relations": {
        "project": { "kind": "belongsTo", "model": "projects", "foreignKey": "projectId" }
      },
      "labelField": "title",
      "priority": 20
    },
    "projects": {
      "type": "Project",
      "table": "projects",
      "fields": {
        "name": { "type": "string" },
        "description": { "type": "string", "optional": true }
      },
      "labelField": "name",
      "priority": 10
    }
  }
}
```

Run the server:

```bash
docker run \
  -e DATABASE_URL=postgresql://user:pass@host:5432/mydb \
  -e REDIS_URL=redis://host:6379 \
  -v ./sync-schema.json:/app/config/schema.json \
  -p 8080:8080 \
  ablo/sync-engine:latest
```

### Option B: Go Module

Embed the sync server in your Go application.

```go
package main

import (
    "log"
    "os"

    "github.com/ablo/sync-engine/pkg/syncschema"
    "github.com/ablo/sync-engine/pkg/syncserver"
)

func main() {
    schema := &syncschema.Schema{
        Models: map[string]*syncschema.ModelDef{
            "tasks": {
                Type:       "Task",
                Table:      "tasks",
                LabelField: "title",
                Priority:   20,
                Fields: map[string]*syncschema.FieldDef{
                    "title":  {Type: "string"},
                    "status": {Type: "enum", EnumValues: []string{"todo", "doing", "done"}},
                },
            },
            "projects": {
                Type:       "Project",
                Table:      "projects",
                LabelField: "name",
                Priority:   10,
                Fields: map[string]*syncschema.FieldDef{
                    "name": {Type: "string"},
                },
            },
        },
    }

    server, err := syncserver.New(syncserver.Config{
        DatabaseURL: os.Getenv("DATABASE_URL"),
        RedisURL:    os.Getenv("REDIS_URL"),
        Schema:      schema,
    })
    if err != nil {
        log.Fatal(err)
    }

    log.Println("Sync server listening on :8080")
    log.Fatal(server.ListenAndServe(":8080"))
}
```

## Database Setup

The sync server expects PostgreSQL tables matching your schema. Create them before starting the server.

```sql
-- Required: sync infrastructure tables
CREATE TABLE sync_metadata (
    id TEXT PRIMARY KEY DEFAULT 'primary',
    current_sync_id BIGINT NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sync_deltas (
    id BIGSERIAL PRIMARY KEY,
    action_type VARCHAR(1) NOT NULL,
    model_name VARCHAR(50) NOT NULL,
    model_id TEXT NOT NULL,
    data JSONB NOT NULL,
    previous_data JSONB,
    sync_groups TEXT[] NOT NULL,
    created_by TEXT,
    transaction_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_deltas_model ON sync_deltas (model_name, model_id);
CREATE INDEX idx_sync_deltas_sync_groups ON sync_deltas USING GIN (sync_groups);

-- Your model tables
CREATE TABLE projects (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    description TEXT,
    organization_id TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    project_id TEXT REFERENCES projects(id),
    organization_id TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Schema Configuration

### Model Definition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | No | Model key | GraphQL/sync type name (e.g., `"Task"`) |
| `table` | `string` | No | snake_case of key | PostgreSQL table name |
| `fields` | `object` | Yes | | Field definitions |
| `relations` | `object` | No | `{}` | Relation definitions |
| `labelField` | `string` | No | | SQL expression for display labels |
| `priority` | `number` | No | `10` | Bootstrap/creation order (lower = first) |
| `enabled` | `boolean` | No | `true` | Include in bootstrap |

### Field Definition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | Yes | | `"string"`, `"number"`, `"boolean"`, `"date"`, `"json"`, `"enum"` |
| `column` | `string` | No | snake_case of field name | PostgreSQL column name |
| `optional` | `boolean` | No | `false` | Allow NULL values |
| `default` | `any` | No | | Default value (JSON-encoded) |
| `enumValues` | `string[]` | No | | Valid values for enum fields |
| `indexed` | `boolean` | No | `false` | Create database index |

### Relation Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `string` | Yes | `"belongsTo"`, `"hasMany"`, or `"hasOne"` |
| `model` | `string` | Yes | Target model name |
| `foreignKey` | `string` | Yes | FK column name |
| `onDelete` | `string` | No | `"cascade"`, `"nullify"`, or `"restrict"` |

## Endpoints

The server exposes these HTTP endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/schema` | Schema introspection (returns JSON) |
| `GET` | `/api/models` | List of model names |
| `GET` | `/api/sync/bootstrap` | Initial data snapshot |
| `GET` | `/api/sync/ws` | WebSocket connection |
| `POST` | `/api/graphql` | GraphQL mutations (batchAck) |

## Sync Groups

Sync groups control which clients receive which deltas. They're string tags attached to every delta.

Every entity belongs to sync groups based on its data. The server broadcasts deltas only to clients subscribed to matching groups.

```
Client A subscribes to: ["org:acme", "user:alice"]
Client B subscribes to: ["org:acme", "user:bob"]
Agent C subscribes to: ["org:acme"]

Delta with groups ["org:acme"] → delivered to A, B, and C
Delta with groups ["user:alice"] → delivered to A only
```

Configure sync groups per model in the schema:

```json
{
  "tasks": {
    "syncGroups": ["org:{organizationId}"],
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | | PostgreSQL connection string |
| `REDIS_URL` | No | | Redis URL for delta pub/sub |
| `PORT` | No | `8080` | HTTP listen port |
| `BETTER_AUTH_SECRET` | No | | For session validation |
