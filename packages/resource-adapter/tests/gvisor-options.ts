import assert from 'node:assert/strict';
import test from 'node:test';
import {startResourceAdapter} from '../src/index.js';

const base = {stateDirectory: '/unused', mountpoint: '/unused', socketPath: '/unused', workspaceId: 'unused', workers: []};
test('gVisor requires a trusted cgroup and finite per-command budget before resources are opened', async () => {
  for (const gvisorCgroupRoot of [undefined, '', 'relative', '/jobs\0invalid']) {
    await assert.rejects(startResourceAdapter({...base, gvisorRootfs: '/image', gvisorCgroupRoot}), /gvisorCgroupRoot/);
  }
  for (const gvisorMemoryLimitBytes of [undefined, NaN, Infinity, -1, 0, 1, 1024 * 1024 + 1]) {
    await assert.rejects(startResourceAdapter({...base, gvisorRootfs: '/image', gvisorCgroupRoot: '/sys/fs/cgroup/jobs', gvisorMemoryLimitBytes}), /gvisorMemoryLimitBytes/);
  }
  await assert.rejects(startResourceAdapter({...base, gvisorMemoryLimitBytes: 1024**3}), /requires gvisorRootfs/);
});
