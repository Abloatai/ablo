# Agent SDK

AI agents as first-class sync participants. Agents connect via WebSocket, subscribe to entity changes, and emit mutations. Every agent action is tracked in the delta log with full attribution.

```typescript
import { SyncAgent } from '@ablo/sync-engine/agent';

const agent = new SyncAgent({
  url: 'wss://api.example.com',
  token: process.env.AGENT_TOKEN,
  agentId: 'reviewer-bot',
  syncGroups: ['org:acme'],
});

agent.on('tasks', { where: { status: 'pending_review' } }, async (task, delta) => {
  const analysis = await llm.analyze(task.title);
  await agent.update('tasks', task.id, {
    status: 'reviewed',
    metadata: { ai_notes: analysis },
  });
});

await agent.connect();
```

Every mutation is attributed as `createdBy: "agent:reviewer-bot"` in the sync delta log. Humans and other agents see who made each change.

## Configuration

```typescript
const agent = new SyncAgent({
  url: 'wss://api.example.com',     // required
  token: 'your-agent-token',        // required
  agentId: 'reviewer-bot',          // required
  syncGroups: ['org:acme'],         // what data the agent sees
  organizationId: 'org_123',       // multi-tenant scope
  autoReconnect: true,              // reconnect on disconnect
  maxReconnectAttempts: 10,         // give up after N failures
  reconnectDelay: 1000,             // base delay (exponential backoff)
});
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `url` | `string` | Yes | | Sync server URL |
| `token` | `string` | Yes | | Auth token for the agent |
| `agentId` | `string` | Yes | | Unique agent identifier |
| `syncGroups` | `string[]` | No | `['default']` | Data visibility scope |
| `organizationId` | `string` | No | `''` | Organization scope |
| `autoReconnect` | `boolean` | No | `true` | Auto-reconnect on disconnect |
| `maxReconnectAttempts` | `number` | No | `10` | Max reconnect attempts |
| `reconnectDelay` | `number` | No | `1000` | Base delay in ms (exponential backoff) |

## Subscribing to Changes

### Subscribe with filter

React to specific entity changes. The handler fires when a delta arrives that matches the filter.

```typescript
agent.on('tasks', { where: { status: 'pending_review' } }, async (task, delta) => {
  // task: the entity data
  // delta: { id, actionType, modelName, modelId, data, createdBy, createdAt }
  console.log(`Task ${task.title} needs review`);
});
```

### Subscribe to all changes on a model

```typescript
agent.on('tasks', async (task, delta) => {
  if (delta.actionType === 'I') {
    console.log('New task created:', task.title);
  }
});
```

### Delta action types

| Type | Meaning |
|------|---------|
| `I` | Insert (new entity created) |
| `U` | Update (entity modified) |
| `D` | Delete (entity removed) |
| `A` | Archive (entity archived) |

### Lifecycle events

```typescript
agent.on('connected', () => console.log('Connected to sync server'));
agent.on('disconnected', ({ code, reason }) => console.log('Disconnected:', reason));
agent.on('error', (err) => console.error('Agent error:', err));
agent.on('delta', (delta) => console.log('Any delta:', delta.modelName));
```

## Mutations

Agents create, update, and delete entities the same way human clients do. Every mutation flows through the sync engine's delta log.

### Create

```typescript
const task = await agent.create('tasks', {
  title: 'Auto-generated from analysis',
  status: 'todo',
  projectId: 'proj_123',
});
console.log(task.id); // auto-generated UUID
```

### Update

```typescript
await agent.update('tasks', 'task_456', {
  status: 'reviewed',
  metadata: { reviewer: 'agent:reviewer-bot', score: 0.95 },
});
```

### Delete

```typescript
await agent.delete('tasks', 'task_789');
```

## Querying Local Cache

The agent maintains an in-memory cache of entities received via the delta stream. Query it for context.

```typescript
const pendingTasks = agent.query('tasks', {
  where: { status: 'pending_review' },
});

console.log(`${pendingTasks.length} tasks awaiting review`);
```

The cache only contains entities visible to the agent's sync groups.

## Sync Groups

Sync groups control what data the agent can see. This is the same permission system used for human clients.

```typescript
const agent = new SyncAgent({
  // ...
  syncGroups: [
    'org:acme',           // see all org data
    'team:engineering',   // see engineering team data
  ],
});
```

Common patterns:

| Pattern | Description |
|---------|-------------|
| `org:{id}` | All data in an organization |
| `team:{id}` | Data scoped to a team |
| `user:{id}` | Data scoped to a specific user |
| `deal:{id}` | Shared deal room (multi-party) |

An agent with `['org:buyer', 'deal:D123']` sees the buyer's org data plus the shared deal room, but not the seller's org data. This is the "counterparty AI" permission model.

## Connection Lifecycle

```typescript
// Connect (returns a Promise)
await agent.connect();

// Disconnect
agent.disconnect();

// Dispose (disconnect + cleanup)
agent.dispose();
```

The agent auto-reconnects with exponential backoff (1s, 2s, 4s, ... up to 30s). After `maxReconnectAttempts` failures, it stops and emits an `error` event.

## Example: Review Bot

A complete agent that reviews tasks and adds AI-generated notes.

```typescript
import { SyncAgent } from '@ablo/sync-engine/agent';
import { analyzeTask } from './llm';

const agent = new SyncAgent({
  url: process.env.SYNC_URL,
  token: process.env.AGENT_TOKEN,
  agentId: 'task-reviewer',
  syncGroups: ['org:acme'],
});

// Subscribe to tasks that need review
agent.on('tasks', { where: { status: 'pending_review' } }, async (task) => {
  try {
    // Run LLM analysis
    const analysis = await analyzeTask(task.title, task.description);

    // Update the task with review results
    await agent.update('tasks', task.id, {
      status: analysis.approved ? 'approved' : 'needs_changes',
      metadata: {
        ai_review: analysis.summary,
        ai_score: analysis.score,
        reviewed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`Failed to review task ${task.id}:`, err);
  }
});

// Handle lifecycle
agent.on('connected', () => console.log('Review bot connected'));
agent.on('error', (err) => console.error('Review bot error:', err));

// Start
await agent.connect();
console.log('Review bot is running');
```
