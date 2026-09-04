import { presenceActivitySchema, type PresenceActivity } from './contract.js';
import { presenceCommandSchema, type PresenceCommand } from './commands.js';
import {
  presencePatchSchema,
  presenceSnapshotSchema,
  type PresencePatch,
  type PresenceSnapshot,
} from './projections.js';

export function parsePresenceCommand(input: unknown): PresenceCommand {
  return presenceCommandSchema.parse(input);
}

export function parsePresenceSnapshot(input: unknown): PresenceSnapshot {
  return presenceSnapshotSchema.parse(input);
}

export function parsePresencePatch(input: unknown): PresencePatch {
  return presencePatchSchema.parse(input);
}

/** Strip internal routing or producer fields before exposing an activity. */
export function redactPresenceActivity(input: unknown): PresenceActivity {
  const publicShape = presenceActivitySchema.strip();
  return publicShape.parse(input);
}
