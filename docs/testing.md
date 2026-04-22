# Testing

How to test apps built on `@ablo/sync-engine`.

## Unit testing React components

Components using sync hooks can be tested with a mock store.

```typescript
import { SyncContext, type SyncStoreContract } from '@ablo/sync-engine/react';
import { render } from '@testing-library/react';

// Create a mock store
const mockStore: SyncStoreContract = {
  findById: jest.fn().mockReturnValue(undefined),
  query: jest.fn().mockReturnValue({ data: [] }),
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
  archive: jest.fn().mockResolvedValue(undefined),
  unarchive: jest.fn().mockResolvedValue(undefined),
};

function renderWithSync(ui: React.ReactElement) {
  return render(
    <SyncContext.Provider value={{ store: mockStore, organizationId: 'test-org' }}>
      {ui}
    </SyncContext.Provider>
  );
}

// Test a component
test('renders task list', () => {
  mockStore.query = jest.fn().mockReturnValue({
    data: [
      { id: '1', title: 'Fix bug', status: 'todo' },
      { id: '2', title: 'Ship feature', status: 'doing' },
    ],
  });

  const { getByText } = renderWithSync(<TaskList />);
  expect(getByText('Fix bug')).toBeTruthy();
});
```

## Unit testing with MobX

If your components use `withSync` (MobX observer), wrap tests in `act()`:

```typescript
import { act } from 'react';

test('task updates reactively', async () => {
  const { getByText, queryByText } = renderWithSync(<TaskList />);

  act(() => {
    // Simulate a delta arriving
    mockStore.query = jest.fn().mockReturnValue({
      data: [{ id: '1', title: 'Updated task', status: 'done' }],
    });
  });

  expect(getByText('Updated task')).toBeTruthy();
});
```

## E2E testing with the sync server

For integration tests that hit the real sync server, use the `TestProvider` auth.

### Server-side setup

Start the Go server with `GO_ENV=test`:

```bash
GO_ENV=test go run cmd/server/main.go
```

In test mode, the server accepts `X-User-Id` and `X-Organization-Id` headers instead of requiring session cookies. No database sessions needed.

### Client-side test

```typescript
const SYNC_URL = 'http://localhost:8080';

test('creates and queries a task', async () => {
  const response = await fetch(`${SYNC_URL}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': 'test-user',
      'X-Organization-Id': 'test-org',
    },
    body: JSON.stringify({
      query: `mutation {
        batchAck(operations: [{
          type: CREATE, model: "task", id: "task-1",
          input: { title: "Test task", status: "todo" }
        }]) { lastSyncId }
      }`,
    }),
  });

  const data = await response.json();
  expect(data.data.batchAck.lastSyncId).toBeGreaterThan(0);
});
```

### WebSocket test

```typescript
test('receives deltas via WebSocket', (done) => {
  const ws = new WebSocket(
    `ws://localhost:8080/api/sync/ws?userId=test-user&organizationId=test-org&lastSyncId=0`
  );

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'delta') {
      expect(msg.payload.modelName).toBe('Task');
      ws.close();
      done();
    }
  };

  ws.onopen = () => {
    // Create a task — the delta should arrive via WebSocket
    fetch(`http://localhost:8080/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': 'test-user',
        'X-Organization-Id': 'test-org',
      },
      body: JSON.stringify({
        query: `mutation { batchAck(operations: [{
          type: CREATE, model: "task", id: "ws-task",
          input: { title: "WS test" }
        }]) { lastSyncId } }`,
      }),
    });
  };
});
```

## Testing agents

```typescript
import { SyncAgent } from '@ablo/sync-engine/agent';

test('agent receives task deltas', async () => {
  const agent = new SyncAgent({
    url: 'http://localhost:8080',
    token: 'test-token',
    agentId: 'test-agent',
    syncGroups: ['org:test-org'],
  });

  const received: unknown[] = [];
  agent.on('tasks', (task) => {
    received.push(task);
  });

  await agent.connect();

  // Create a task via HTTP
  await fetch('http://localhost:8080/api/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': 'test-user',
      'X-Organization-Id': 'test-org',
    },
    body: JSON.stringify({
      query: `mutation { batchAck(operations: [{
        type: CREATE, model: "task", id: "agent-task",
        input: { title: "Agent test" }
      }]) { lastSyncId } }`,
    }),
  });

  // Wait for delta
  await new Promise((r) => setTimeout(r, 500));
  expect(received.length).toBeGreaterThan(0);

  agent.dispose();
});
```
