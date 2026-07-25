/**
 * Protocol-version contract pin (Zero's `protocol-version.test.ts` pattern).
 *
 * The literal-equality tests are DELIBERATE: if one fails, you changed the
 * protocol contract. That is allowed — but only deliberately: append a
 * changelog entry in `wire/protocolVersion.ts`, verify the deploy contract
 * (server first; MIN_SUPPORTED covers every SDK in the wild), and update the
 * pinned value here in the same change.
 */

import {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WS_CLOSE_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  protocolVersionProblem,
  resolveProtocolVersion,
} from '@abloatai/transaction/wire/protocolVersion';

describe('protocol version contract', () => {
  it('pins the current version — bumping requires a changelog entry', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('pins the support floor — raising it cuts un-upgraded clients', () => {
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe(1);
  });

  it('pins the wire constants the peer sides hard-depend on', () => {
    expect(WS_CLOSE_PROTOCOL_VERSION).toBe(4010);
    expect(PROTOCOL_VERSION_HEADER).toBe('Ablo-Protocol-Version');
  });

  it('the floor never exceeds the current version', () => {
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it('pins the legacy default and explicit codec manifest', () => {
    expect(DEFAULT_PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([1]);
  });

  it('has one concrete version entry for every advertised version', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(
      Array.from(
        { length: PROTOCOL_VERSION - MIN_SUPPORTED_PROTOCOL_VERSION + 1 },
        (_, index) => MIN_SUPPORTED_PROTOCOL_VERSION + index,
      ),
    );
  });
});

describe('protocolVersionProblem', () => {
  it('accepts the full supported range', () => {
    for (let v = MIN_SUPPORTED_PROTOCOL_VERSION; v <= PROTOCOL_VERSION; v++) {
      expect(protocolVersionProblem(v)).toBeNull();
    }
  });

  it('treats an absent version as v1 (pre-versioning SDKs)', () => {
    expect(protocolVersionProblem(undefined)).toBeNull();
    expect(resolveProtocolVersion(undefined)).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it('rejects versions below the floor as too_old', () => {
    expect(protocolVersionProblem(MIN_SUPPORTED_PROTOCOL_VERSION - 1)).toBe('too_old');
    expect(protocolVersionProblem(0)).toBe('too_old');
    expect(protocolVersionProblem(-1)).toBe('too_old');
  });

  it('rejects versions above the current as too_new (rollback visibility)', () => {
    expect(protocolVersionProblem(PROTOCOL_VERSION + 1)).toBe('too_new');
    expect(protocolVersionProblem(999)).toBe('too_new');
  });

  it('fails closed on non-integer garbage', () => {
    expect(protocolVersionProblem(1.5)).toBe('too_old');
    expect(protocolVersionProblem(Number.NaN)).toBe('too_old');
    expect(protocolVersionProblem(Number.POSITIVE_INFINITY)).toBe('too_old');
  });

  it('resolves only versions backed by a codec manifest entry', () => {
    expect(resolveProtocolVersion(PROTOCOL_VERSION)).toBe(PROTOCOL_VERSION);
    expect(resolveProtocolVersion(PROTOCOL_VERSION + 1)).toBeNull();
  });
});
