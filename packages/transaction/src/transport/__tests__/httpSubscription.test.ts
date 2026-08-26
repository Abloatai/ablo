import { reconnectDelayMs } from '../http/subscription.js';
import { createHttpTransport } from '../http/transport.js';

describe('HTTP stale-context reconnect', () => {
  it('uses full jitter with an exponential cap', () => {
    expect(reconnectDelayMs(1, () => 0.5)).toBe(2_500);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(5_000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(10_000);
    expect(reconnectDelayMs(4, () => 0.5)).toBe(15_000);
    expect(reconnectDelayMs(20, () => 0.5)).toBe(15_000);
  });

  it('resolves identity before routing the held response to its delivery owner', async () => {
    const requested: URL[] = [];
    const transport = createHttpTransport({
      apiKey: 'sk_test_subscription_partition',
      baseURL: 'https://api.example.test',
      dangerouslyAllowBrowser: true,
      fetch: (input) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        requested.push(url);
        if (url.pathname.endsWith('/auth/identity')) {
          return Promise.resolve(new Response(JSON.stringify({
            participantKind: 'agent',
            participantId: 'agent-1',
            accountScope: 'org-1',
            projectId: 'project-1',
            branchId: 'branch-1',
            branchRoot: false,
            syncGroups: ['org:org-1'],
            deliveryPartition: { index: 3, count: 8 },
            authority: {
              organizationId: 'org-1',
              projectId: 'project-1',
              branchId: 'branch-1',
              syncGroups: ['org:org-1'],
              operations: ['records.read'],
              participantKind: 'agent',
              participantId: 'agent-1',
              deliveryPartition: { index: 3, count: 8 },
            },
            userMeta: {},
          }), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (url.pathname.endsWith('/v1/subscriptions')) {
          return Promise.resolve(new Response(
            'event: stale_context\n' +
              'data: {"type":"AbloStaleContextError","code":"stale_context","message":"changed"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ));
        }
        return Promise.reject(new Error(`Unexpected request: ${url.pathname}`));
      },
    });

    const changed = new Promise((resolve) => {
      transport.onChange(
        [{ model: 'records', id: 'record-1', readAt: 17 }],
        resolve,
      );
    });
    await changed;

    expect(requested.map((url) => url.pathname)).toEqual([
      '/api/auth/identity',
      '/api/v1/subscriptions',
    ]);
    expect(requested[1]?.searchParams.get('deliveryPartition')).toBe('3-8');
    await transport.dispose();
  });
});
