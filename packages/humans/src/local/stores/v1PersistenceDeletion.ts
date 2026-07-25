/**
 * Migration-only knowledge of the removed v1 IndexedDB namespace. Nothing in
 * this module may be used to open or hydrate data; it exists only to find and
 * delete stores created by clients before persistence namespace v2.
 *
 * Remove after the v1 cleanup support window.
 */

export function v1PersistenceDatabaseNameForDeletion(
  participantId: string,
  organizationId: string,
  userVersion: number,
): string {
  const combined = `${participantId}:${organizationId}:${userVersion}`;
  let hash = 0;
  for (let index = 0; index < combined.length; index++) {
    hash = (hash << 5) - hash + combined.charCodeAt(index);
    hash &= hash;
  }
  return `ablo_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}
