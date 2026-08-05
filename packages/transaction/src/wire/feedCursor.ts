/**
 * The resume position for `GET /v1/logs`.
 *
 * The feed merges two independently-sequenced sources — the commit log and
 * the claim-event log — so one opaque cursor has to carry two positions. They
 * cannot share a sequence: allocating claim positions from `next_sync_id` would
 * put ephemeral leases into the log that clients materialize rows from and that
 * WAL-echo promotion and compaction operate over, where a claim-churn storm
 * would be indistinguishable from committed change.
 *
 * Encoded `"<log>.<claims>"`, and a bare `"<log>"` still parses — cursors are
 * persisted by callers, and every one issued before this existed is a plain
 * delta id. Those resume at claim position 0, which is correct: a caller who
 * never asked for claim events has no claim position to preserve.
 *
 * **A malformed cursor is an error, never a position.** The previous reader was
 * `parseInt(raw, 10)` with `NaN ? 0 : n`, so a truncated or garbled cursor
 * silently resumed from the beginning of the log and replayed it in full. That
 * is the worst available failure: it looks like a working follow, and the
 * damage scales with how long the log has been running. Parsing returns null
 * and the route answers `invalid_request`.
 */

import { z } from 'zod';

export const feedCursorSchema = z.object({
  /** Last delta id delivered. */
  log: z.number().int().nonnegative(),
  /** Last claim-event seq delivered. */
  claims: z.number().int().nonnegative(),
});
export type FeedCursor = z.infer<typeof feedCursorSchema>;

/**
 * The cursor grammar, in one place, so the parser and the error that rejects a
 * bad one cannot describe it differently. A reader who is told what shape was
 * expected can fix the call; a reader told only that theirs was wrong cannot.
 */
export const FEED_CURSOR_FORMAT = '<log>[.<claims>]';

/** A cursor that shows the grammar rather than only naming it. */
export const FEED_CURSOR_EXAMPLE = '4210.17';

/** The cursor a caller resumes from when they send none. */
export const FEED_CURSOR_START: FeedCursor = { log: 0, claims: 0 };

/**
 * Reads a wire cursor. Returns null when the string is not one — the caller
 * turns that into `invalid_request` rather than guessing a position.
 *
 * Deliberately strict: only digits and at most one separator. `Number()` alone
 * would accept `'1e3'`, `'0x10'`, `' 42 '`, and `''`, each of which would
 * resume somewhere the caller did not ask for.
 */
export function parseFeedCursor(raw: string): FeedCursor | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const parsed = feedCursorSchema.safeParse({
    log: Number(match[1]),
    claims: match[2] === undefined ? 0 : Number(match[2]),
  });
  if (!parsed.success) return null;
  // Beyond 2^53 the positions stop round-tripping through JSON's number type,
  // and a cursor that cannot round-trip is not a cursor.
  if (
    !Number.isSafeInteger(parsed.data.log) ||
    !Number.isSafeInteger(parsed.data.claims)
  ) {
    return null;
  }
  return parsed.data;
}

/** Writes a wire cursor. Always both positions, so the shape never varies. */
export function formatFeedCursor(cursor: FeedCursor): string {
  return `${cursor.log}.${cursor.claims}`;
}

/**
 * Whether `next` is ahead of `prev` on either axis — the guard a follow loop
 * needs so a stale or duplicated page cannot rewind it.
 *
 * It lives here because the alternative is what every caller reaches for first:
 * comparing the cursor STRINGS as numbers. `Number('42.10')` is `42.1`, which
 * compares as *behind* `42.9` and re-serializes as `'42.1'` — a cursor that
 * silently skips eight claim positions and looks like it worked. A cursor is
 * opaque to its holder; only this module takes it apart.
 */
export function feedCursorAdvanced(prev: FeedCursor, next: FeedCursor): boolean {
  return next.log > prev.log || next.claims > prev.claims;
}
