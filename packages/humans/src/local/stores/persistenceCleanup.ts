import { AbloConnectionError } from '@ablo/transaction/errors';
import type { DatabaseInfo } from './DatabaseManager.js';
import { deleteIDBWithTimeout } from './openIDBWithTimeout.js';
import { v1PersistenceDatabaseNameForDeletion } from './v1PersistenceDeletion.js';

type DeleteDatabase = (name: string) => Promise<boolean>;

/** Exact data-store names that can contain the current identity's state. */
export function persistenceDatabaseNamesForDeletion(
  current: DatabaseInfo | null,
): string[] {
  if (!current) return ['ablo-sync'];
  return [
    current.name,
    v1PersistenceDatabaseNameForDeletion(
      current.userId,
      current.workspaceId,
      current.userVersion ?? 1,
    ),
    // Retired pre-identity store. It cannot be attributed safely, so any
    // terminal cleanup removes it rather than attempting to reuse its data.
    'ablo-sync',
  ];
}

/** Delete authenticated IndexedDB state after its owners have closed handles. */
export async function purgeIndexedDbPersistence(
  current: DatabaseInfo | null,
  deleteDatabase: DeleteDatabase = deleteIDBWithTimeout,
): Promise<void> {
  const failed = new Set<string>();

  for (const name of persistenceDatabaseNamesForDeletion(current)) {
    if (!(await deleteDatabase(name))) failed.add(name);
  }

  if (failed.size > 0) {
    throw new AbloConnectionError(
      `Could not remove authenticated local data from: ${[...failed].join(', ')}`,
      { code: 'db_cleanup_failed' },
    );
  }
}
