/**
 * The sync protocol version — a single integer, increasing over time, that
 * covers everything the client and server must agree on to talk to each other:
 * the WebSocket frame shapes, the HTTP request and response envelopes, and the
 * delta encodings a client replays. It is separate from the advisory
 * app-schema hash, which diagnoses data-model drift; this version selects a
 * concrete transport codec.
 *
 * Deploy ordering: the server is deployed first. It accepts every version in
 * {@link SUPPORTED_PROTOCOL_VERSIONS}, and a client is never expected to connect
 * to a server older than itself. If that does happen — for example a partial
 * server rollback — {@link protocolVersionProblem} reports it as `too_new` so
 * the mismatch is visible rather than undefined.
 *
 * To change the protocol:
 *   1. Make the change backward-tolerant where you can. The server ignores
 *      unknown payload keys, so an additive field usually needs no version bump.
 *   2. For a breaking change, bump {@link PROTOCOL_VERSION}, add its codec to
 *      {@link SUPPORTED_PROTOCOL_VERSIONS}, and add a changelog entry below.
 *   3. Keep {@link MIN_SUPPORTED_PROTOCOL_VERSION} low enough to cover every
 *      client still in use; raise it only after a deprecation window.
 *   4. The protocol contract tests fail on a version without a codec and on any
 *      unreviewed bump — update them in the same change, deliberately.
 *
 * Changelog
 *   v1 (2026-07-03) — the protocol as of this field's introduction: the
 *      sync-request frame (`cursor`, `lastSyncId`, `capabilities`, optional
 *      `protocolVersion`), the commit, claim, release, ack, and
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

/** The version used by clients from before the version field existed. */
export const DEFAULT_PROTOCOL_VERSION = 1;

/**
 * Every wire version this build can actually decode. This is intentionally an
 * explicit manifest rather than a computed numeric range: a version is not
 * supported merely because its number falls between two constants. Server
 * codec registries use {@link SupportedProtocolVersion} as their key type, so
 * adding a version here makes a missing decoder a compile error.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export type SupportedProtocolVersion =
  (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export type ProtocolVersionProblem = 'too_old' | 'too_new' | 'codec_missing';

/**
 * The WebSocket close code the server sends to reject a protocol-version
 * mismatch. It sits alongside the other application close codes (4001 for a
 * credential problem), and its reason string is the
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
): ProtocolVersionProblem | null {
  const v = announced ?? DEFAULT_PROTOCOL_VERSION;
  if (!Number.isInteger(v) || v < MIN_SUPPORTED_PROTOCOL_VERSION) return 'too_old';
  if (v > PROTOCOL_VERSION) return 'too_new';
  return SUPPORTED_PROTOCOL_VERSIONS.some((candidate) => candidate === v)
    ? null
    : 'codec_missing';
}

/** Resolve an announced value to a version that has a concrete codec. */
export function resolveProtocolVersion(
  announced: number | undefined,
): SupportedProtocolVersion | null {
  const version = announced ?? DEFAULT_PROTOCOL_VERSION;
  return SUPPORTED_PROTOCOL_VERSIONS.find((candidate) => candidate === version) ?? null;
}

/** The HTTP request header a client uses to announce its protocol version. */
export const PROTOCOL_VERSION_HEADER = 'Ablo-Protocol-Version';
