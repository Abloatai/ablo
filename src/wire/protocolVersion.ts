/**
 * The sync protocol version — ONE monotonically increasing integer covering
 * everything client and server must agree on to speak: WS frame shapes
 * (hub `ClientMessage`/`ServerMessage`), HTTP request/response envelopes, and
 * the persisted delta encodings a client replays. Zero's recipe: schemaHash
 * (WS close 4009) only detects APP-schema drift; this detects PROTOCOL drift —
 * before it, every main-push deploy was an old-client/new-server encounter
 * with no detector at all.
 *
 * Deploy contract: SERVER DEPLOYS FIRST. The server accepts every version in
 * `[MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION]`; a client never
 * connects to a server older than itself (if it does — a rollback mid-fleet —
 * the too-new rejection below makes it visible instead of undefined behavior).
 *
 * How to change the protocol:
 *   1. Make the wire change backward-tolerant where possible (the server's
 *      `clientMessageSchema` accepts-and-ignores unknown payload keys — an
 *      ADDITIVE field usually needs NO version bump).
 *   2. For a breaking change: bump `PROTOCOL_VERSION`, append a changelog
 *      entry below, and keep `MIN_SUPPORTED_PROTOCOL_VERSION` covering every
 *      SDK version still in the wild; raise it only with a deprecation window.
 *   3. The contract test (`__tests__/protocolVersion.test.ts`) fails on any
 *      bump — update it in the same change, deliberately.
 *
 * CHANGELOG
 *   v1 (2026-07-03) — the protocol as of the version field's introduction:
 *      sync_request{cursor,lastSyncId,capabilities,protocolVersion?},
 *      commit/mutation/claim/release/ack/presence_update frames, bootstrap +
 *      delta batches, HTTP envelopes per `wire/errorEnvelope` +
 *      `wire/listEnvelope`. Clients that predate the field send NO
 *      `protocolVersion` — treated as v1 (the field's introduction changed no
 *      semantics).
 */
export const PROTOCOL_VERSION = 1;

/**
 * Oldest client protocol this build still serves. Raising it is a BREAKING
 * cut for un-upgraded clients — do it only with a deprecation window and a
 * changelog entry.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * WS application close code for a protocol-version rejection (4001 =
 * credential, 4009 = app-schema drift). The reason string is the error code
 * `protocol_version_unsupported`; the SDK treats this close as TERMINAL —
 * reconnecting cannot heal a version mismatch, upgrading the SDK (or rolling
 * the server forward) can.
 */
export const WS_CLOSE_PROTOCOL_VERSION = 4010;

/**
 * Classify a peer's announced protocol version. `undefined` (a pre-versioning
 * client) is v1 by definition. Non-integer garbage classifies as `too_old` —
 * fail closed, visibly.
 */
export function protocolVersionProblem(
  announced: number | undefined,
): 'too_old' | 'too_new' | null {
  const v = announced ?? 1;
  if (!Number.isInteger(v) || v < MIN_SUPPORTED_PROTOCOL_VERSION) return 'too_old';
  if (v > PROTOCOL_VERSION) return 'too_new';
  return null;
}

/** HTTP request header carrying the client's protocol version. */
export const PROTOCOL_VERSION_HEADER = 'Ablo-Protocol-Version';
