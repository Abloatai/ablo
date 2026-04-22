/**
 * E2E test: WebSocket sync against real Go server
 *
 * Requires GO_ENV=test server running:
 *   GO_ENV=test go run cmd/server/main.go
 *
 * Run with:
 *   E2E_TEST=true npx jest __tests__/e2e/websocket-sync.test.ts
 *
 */

import WebSocket from 'ws';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/api/sync/ws';
const HEALTH_URL = SERVER_URL + '/api/health';
const GRAPHQL_URL = SERVER_URL + '/api/graphql';
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('E2E: WebSocket Sync (real server)', () => {
  beforeAll(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(
        `Cannot reach sync server at ${HEALTH_URL}.\n` +
        `Start with: GO_ENV=test go run cmd/server/main.go\n` +
        `Error: ${error instanceof Error ? error.message : error}`
      );
    }
  }, 10000);

  describe('health check', () => {
    it('should return 200 from /api/health', async () => {
      const res = await fetch(HEALTH_URL);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body.status).toBe('healthy');
    });
  });

  describe('WebSocket connection', () => {
    it('should connect to sync WebSocket', (done) => {
      const params = new URLSearchParams({
        userId: USER_ID,
        organizationId: ORG_ID,
      });
      const ws = new WebSocket(`${WS_URL}?${params}`, {
        headers: {
          'X-User-Id': USER_ID,
          'X-Organization-Id': ORG_ID,
        },
      });

      const timeout = setTimeout(() => {
        ws.close();
        done(new Error('WebSocket connection timed out'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        done();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        ws.close();
        done(new Error(`WebSocket error: ${err.message}`));
      });
    }, 10000);
  });

  describe('batchAck mutation', () => {
    it('should POST batchAck and receive lastSyncId > 0', async () => {
      const taskId = `e2e-task-${Date.now()}`;
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': USER_ID,
          'X-Organization-Id': ORG_ID,
        },
        body: JSON.stringify({
          query: `
            mutation BatchAck($operations: [MutationOperation!]!) {
              batchAck(operations: $operations) { lastSyncId }
            }
          `,
          variables: {
            operations: [{
              type: 'CREATE',
              model: 'task',
              id: taskId,
              input: {
                title: 'E2E Test Task',
                status: 'todo',
                organizationId: ORG_ID,
                createdBy: USER_ID,
              },
            }],
          },
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body.data?.batchAck?.lastSyncId).toBeGreaterThan(0);
    });
  });

  describe('delta delivery via WebSocket', () => {
    it('should receive delta after batchAck CREATE', (done) => {
      const params = new URLSearchParams({
        userId: USER_ID,
        organizationId: ORG_ID,
      });
      const ws = new WebSocket(`${WS_URL}?${params}`, {
        headers: {
          'X-User-Id': USER_ID,
          'X-Organization-Id': ORG_ID,
        },
      });

      const taskId = `e2e-delta-${Date.now()}`;
      const timeout = setTimeout(() => {
        ws.close();
        done(new Error('Delta delivery timed out'));
      }, 10000);

      ws.on('open', async () => {
        // Listen for delta
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'delta') {
              const delta = msg.payload;
              if (delta?.modelId === taskId) {
                clearTimeout(timeout);
                expect(delta.actionType).toBe('I');
                expect(delta.modelName).toBe('Task');
                ws.close();
                done();
              }
            }
          } catch {
            // Ignore non-JSON messages
          }
        });

        // Create a task — delta should arrive on WS
        await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': USER_ID,
            'X-Organization-Id': ORG_ID,
          },
          body: JSON.stringify({
            query: `mutation BatchAck($operations: [MutationOperation!]!) {
              batchAck(operations: $operations) { lastSyncId }
            }`,
            variables: {
              operations: [{
                type: 'CREATE',
                model: 'task',
                id: taskId,
                input: {
                  title: 'E2E Delta Test',
                  status: 'todo',
                  organizationId: ORG_ID,
                  createdBy: USER_ID,
                },
              }],
            },
          }),
        });
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        ws.close();
        done(new Error(`WebSocket error: ${err.message}`));
      });
    }, 15000);
  });
});
