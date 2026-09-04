import type { PresenceActivity, PresenceSession } from './contract.js';
import type {
  PresenceActivityTombstone,
  PresencePatch,
  PresenceSnapshot,
} from './projections.js';

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function tombstoneById(
  left: PresenceActivityTombstone,
  right: PresenceActivityTombstone,
): number {
  return left.activityId.localeCompare(right.activityId);
}

/** Merge an unordered server patch into one session projection. */
export function applyPresencePatch(
  snapshot: PresenceSnapshot,
  patch: PresencePatch,
): PresenceSnapshot {
  if (patch.presenceSessionId !== snapshot.presenceSessionId) {
    throw new Error('presence patch belongs to a different session');
  }
  const activities = new Map(snapshot.activities.map((activity) => [activity.id, activity]));
  const tombstones = new Map(
    snapshot.tombstones.map((tombstone) => [tombstone.activityId, tombstone]),
  );

  for (const activity of patch.activities ?? []) {
    const current = activities.get(activity.id);
    const tombstone = tombstones.get(activity.id);
    if (tombstone !== undefined && tombstone.version >= activity.version) continue;
    if (current === undefined || activity.version > current.version) {
      activities.set(activity.id, activity);
    }
  }

  for (const tombstone of patch.tombstones ?? []) {
    const current = tombstones.get(tombstone.activityId);
    if (current === undefined || tombstone.version > current.version) {
      tombstones.set(tombstone.activityId, tombstone);
    }
    const activity = activities.get(tombstone.activityId);
    if (activity !== undefined && tombstone.version >= activity.version) {
      activities.delete(tombstone.activityId);
    }
  }

  return {
    ...snapshot,
    activities: [...activities.values()].sort(byId),
    tombstones: [...tombstones.values()].sort(tombstoneById),
  };
}

/** Replace a complete projection only when it is newer for the same session. */
export function applyPresenceSnapshot(
  current: PresenceSnapshot | undefined,
  incoming: PresenceSnapshot,
): PresenceSnapshot {
  if (current === undefined) return incoming;
  if (current.presenceSessionId !== incoming.presenceSessionId) {
    throw new Error('presence snapshot belongs to a different session');
  }
  return incoming.revision >= current.revision ? incoming : current;
}

function canonicalModelName(model: string): string {
  return model.trim().toLowerCase();
}

function filterSession(
  session: PresenceSession,
  model: string,
  recordId?: string,
): PresenceSession | undefined {
  const canonicalModel = canonicalModelName(model);
  const activities = session.activities.filter((activity: PresenceActivity) =>
    canonicalModelName(activity.target.model) === canonicalModel &&
    (recordId === undefined || activity.target.id === recordId));
  return activities.length === 0 ? undefined : { ...session, activities };
}

/** Model-native presence projection. Current and peer sessions are treated alike. */
export function presenceForModel(
  sessions: readonly PresenceSession[],
  model: string,
): PresenceSession[] {
  return sessions.flatMap((session) => {
    const filtered = filterSession(session, model);
    return filtered === undefined ? [] : [filtered];
  });
}

/** Record-native presence projection with exact record identity matching. */
export function presenceForRecord(
  sessions: readonly PresenceSession[],
  model: string,
  recordId: string,
): PresenceSession[] {
  return sessions.flatMap((session) => {
    const filtered = filterSession(session, model, recordId);
    return filtered === undefined ? [] : [filtered];
  });
}
