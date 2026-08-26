import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLocalConnectorLease } from '../localConnectorLease';

describe('local connector lease', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ablo-connector-lease-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const identity = {
    cwd: '/workspace/project',
    baseUrl: 'https://api.example',
    branch: 'feature-one',
  };

  it('rejects a second live owner before it can rotate the source key', () => {
    const first = acquireLocalConnectorLease(identity, {
      directory,
      pid: 101,
      isProcessAlive: () => true,
    });

    expect(() =>
      acquireLocalConnectorLease(identity, {
        directory,
        pid: 202,
        isProcessAlive: () => true,
      }),
    ).toThrow(/PID 101.*already owns/);

    first.release();
  });

  it('reclaims a stale owner and releases only its own lease', () => {
    const stale = acquireLocalConnectorLease(identity, {
      directory,
      pid: 101,
      isProcessAlive: () => false,
    });
    const replacement = acquireLocalConnectorLease(identity, {
      directory,
      pid: 202,
      isProcessAlive: (pid) => pid === 202,
    });

    stale.release();
    expect(() =>
      acquireLocalConnectorLease(identity, {
        directory,
        pid: 303,
        isProcessAlive: (pid) => pid === 202,
      }),
    ).toThrow(/PID 202.*already owns/);

    replacement.release();
    expect(() =>
      acquireLocalConnectorLease(identity, {
        directory,
        pid: 303,
        isProcessAlive: () => true,
      }),
    ).not.toThrow();
  });

  it('allows separate branches to run concurrently', () => {
    const first = acquireLocalConnectorLease(identity, {
      directory,
      pid: 101,
      isProcessAlive: () => true,
    });
    const second = acquireLocalConnectorLease(
      { ...identity, branch: 'feature-two' },
      { directory, pid: 202, isProcessAlive: () => true },
    );

    first.release();
    second.release();
  });
});
