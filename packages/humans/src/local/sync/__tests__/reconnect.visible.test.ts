import {expect, it, jest} from '@jest/globals';
import {performReconnect, type ReconnectHost} from '../reconnect.js';

it('requests catch-up immediately when a visible tab still has an open socket', async () => {
  const requestIncrementalSync = jest.fn<() => Promise<void>>().mockResolvedValue();
  const connect = jest.fn();
  const host = {
    userContext: {},
    dataReady: true,
    checkSyncGroupShrinkage: jest.fn<() => Promise<void>>().mockResolvedValue(),
    database: {requiredBootstrap: jest.fn<() => Promise<{type: string; lastSyncId: number}>>().mockResolvedValue({type: 'partial', lastSyncId: 12})},
    syncWebSocket: {isConnected: () => true, requestIncrementalSync, connect},
    updateSyncStatus: jest.fn(),
  } as ReconnectHost;

  expect(await performReconnect(host)).toBe('success');
  expect(requestIncrementalSync).toHaveBeenCalledTimes(1);
  expect(connect).not.toHaveBeenCalled();
});
