/**
 * Architectural pin: the modern-SDK shape — `import Ablo` and reach
 * every public type via namespace dots.
 *
 * Stripe / OpenAI / Anthropic / Cursor all expose this pattern: one
 * default-import gets the factory + return type + nested type
 * accessors. Consumers don't have to memorize a flat import list.
 *
 * If this test compiles, the shape works. The runtime assertion is
 * trivial — the value matters less than the type-position access.
 */

import { Ablo } from '../../../src/Ablo';
import { describe, it, expect } from '@jest/globals';

describe('Ablo namespace — modern-SDK type access', () => {
  it('exposes multiplayer types via namespace dots', () => {
    // Type-position references — these compile only if the namespace
    // re-exports each type. Pure compile-time check.
    type _Peer = Ablo.Peer;
    // Claims collapsed to a single `Claim` type — there is deliberately no
    // `ActiveClaim`/`ClaimHandle` to disambiguate (see types/streams.ts).
    type _Claim = Ablo.Claim;
    type _ClaimRejection = Ablo.ClaimRejection;
    type _PresenceStream = Ablo.PresenceStream;
    type _ClaimStream = Ablo.ClaimStream;
    type _ParticipantRef = Ablo.Auth.Actor;

    // Suppress "declared but never used" noise — these aliases exist
    // for the compile-check, not runtime.
    const _x: _Peer | undefined = undefined;
    const _y: _Claim | undefined = undefined;
    expect(typeof Ablo).toBe('function');
    expect(_x).toBeUndefined();
    expect(_y).toBeUndefined();
  });
});
