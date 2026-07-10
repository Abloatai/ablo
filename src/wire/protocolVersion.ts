/**
 * The sync protocol version — a single integer, increasing over time, that
 * covers everything the client and server must agree on to talk to each other:
 * the WebSocket frame shapes, the HTTP request and response envelopes, and the
 * delta encodings a client replays. It is separate from the app-schema hash
 * (WebSocket close code 4009), which detects drift in your data model; this
 * detects drift in the protocol itself.
 *
 * Deploy ordering: the server is deployed first. It accepts every version in
 * the inclusive range from {@link MIN_SUPPORTED_PROTOCOL_VERSION} to
 * {@link PROTOCOL_VERSION}, and a client is never expected to connect to a
 * server older than itself. If that does happen — for example a partial server
 * rollback — {@link protocolVersionProblem} reports it as `too_new` so the
 * mismatch is visible rather than undefined.
 *
 * To change the protocol:
 *   1. Make the change backward-tolerant where you can. The server ignores
 *      unknown payload keys, so an additive field usually needs no version bump.
 *   2. For a breaking change, bump {@link PROTOCOL_VERSION}, add a changelog
 *      entry below, and keep {@link MIN_SUPPORTED_PROTOCOL_VERSION} low enough
 *      to cover every client still in use; raise it only after a deprecation
 *      window.
 *   3. The protocol-version contract test fails on any bump — update it in the
 *      same change, deliberately.
 *
 * Changelog
 *   v1 (2026-07-03) — the protocol as of this field's introduction: the
 *      sync-request frame (`cursor`, `lastSyncId`, `capabilities`, optional
 *      `protocolVersion`), the commit, mutation, claim, release, ack, and
 *      presence-update frames, the bootstrap and delta batches, and the HTTP
 *      error and list envelopes. A client that predates this field sends no
 *      `protocolVersion` and is treated as v1, since introducing the field
 *      changed no behavior.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest client protocol version this build still serves. Raising it cuts
 * off clients that have not upgraded, so do it only after a deprecation window
 * and with a changelog entry.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * The WebSocket close code the server sends to reject a protocol-version
 * mismatch. It sits alongside the other application close codes (4001 for a
 * credential problem, 4009 for app-schema drift), and its reason string is the
 * error code `protocol_version_unsupported`. A client should treat this close
 * as terminal: reconnecting cannot heal a version mismatch, but upgrading the
 * client or rolling the server forward can.
 */
export const WS_CLOSE_PROTOCOL_VERSION = 4010;

/**
 * Classifies a peer's announced protocol version against what this build
 * supports, returning `'too_old'`, `'too_new'`, or `null` when the versions are
 * compatible. An `undefined` version — a client from before versioning existed
 * — counts as v1. A non-integer value is treated as `'too_old'` so the check
 * fails closed and visibly.
 */
export function protocolVersionProblem(
  announced: number | undefined,
): 'too_old' | 'too_new' | null {
  const v = announced ?? 1;
  if (!Number.isInteger(v) || v < MIN_SUPPORTED_PROTOCOL_VERSION) return 'too_old';
  if (v > PROTOCOL_VERSION) return 'too_new';
  return null;
}

/** The HTTP request header a client uses to announce its protocol version. */
export const PROTOCOL_VERSION_HEADER = 'Ablo-Protocol-Version';
