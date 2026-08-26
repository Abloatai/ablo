/**
 * Process-local ownership for `ablo dev --local`.
 *
 * The reverse channel has a server-side fence, but the CLI must acquire local
 * ownership before it re-registers (and therefore rotates) the source signing
 * key. Otherwise two processes can invalidate each other's handlers before a
 * WebSocket has enough information to reject either one.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AbloValidationError } from '@abloatai/transaction/errors';

export interface LocalConnectorLease {
  release(): void;
}

interface LeaseRecord {
  readonly pid: number;
  readonly token: string;
}

interface LocalConnectorLeaseOptions {
  readonly directory?: string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** Acquire the one local connector slot for a repository branch. */
export function acquireLocalConnectorLease(
  identity: {
    readonly cwd: string;
    readonly baseUrl: string;
    readonly branch: string;
  },
  options: LocalConnectorLeaseOptions = {},
): LocalConnectorLease {
  const directory = options.directory ?? join(tmpdir(), 'ablo-source-connectors');
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const key = createHash('sha256')
    .update(`${resolve(identity.cwd)}\0${identity.baseUrl}\0${identity.branch}`)
    .digest('hex')
    .slice(0, 24);
  const path = join(directory, `${key}.lock`);
  const token = randomUUID();
  const record: LeaseRecord = { pid, token };

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const current = readLease(path);
            if (current?.token === token) unlinkSync(path);
          } catch {
            // The temp directory may already have been cleaned up at exit.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const owner = readLease(path);
      if (owner && isProcessAlive(owner.pid)) {
        throw new AbloValidationError(
          `Another ablo dev --local process (PID ${owner.pid}) already owns this branch's local Data Source. Stop it before starting another connector.`,
          { code: 'cli_invalid_arguments' },
        );
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (!isMissing(unlinkError)) throw unlinkError;
      }
    }
  }

  throw new AbloValidationError(
    "Could not acquire this branch's local Data Source connector lease. Retry after the other connector exits.",
    { code: 'cli_invalid_arguments' },
  );
}

function readLease(path: string): LeaseRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseRecord>;
    return typeof parsed.pid === 'number' && typeof parsed.token === 'string'
      ? { pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === 'ESRCH';
}
