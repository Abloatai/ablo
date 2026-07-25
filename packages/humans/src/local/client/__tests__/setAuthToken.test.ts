/**
 * Ablo.setAuthToken — the public hook the JWT migration relies on: a refreshed
 * bearer token can be pushed at any point in the engine's lifetime without
 * tearing it down.
 *
 * The behaviour this guards is the "called before connect" path: `<AbloProvider
 * getToken>` resolves the token and calls `setAuthToken` BEFORE `ready()`
 * connects, so at that moment `store.getSyncWebSocket()` is undefined. The
 * implementation optional-chains the WS, so this must be a safe no-throw that
 * still records the token for the upcoming upgrade. Built in-memory (no network)
 * via the same pattern as hydration-chain.test.ts.
 */

import { Ablo, type InternalAbloOptions } from '../../../Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { z } from 'zod';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeEngine() {
  const schema = defineSchema({
    chats: model(
      { title: z.string() },
      { typename: 'Chat' }),
  });
  return Ablo({
    schema,
    baseURL: 'ws://localhost:1234',
    user: { id: 'user-1' },
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<typeof schema.models>);
}

describe('Ablo.setAuthToken', () => {
  it('exposes setAuthToken on the engine', () => {
    const engine = makeEngine();
    expect(typeof engine.setAuthToken).toBe('function');
  });

  it('is a safe no-throw when called before the WebSocket exists (pre-ready)', () => {
    const engine = makeEngine();
    // No connection yet → store.getSyncWebSocket() is undefined. The optional
    // chain must absorb that; only the closure + bootstrap header are updated.
    expect(() => { engine.setAuthToken('jwt-initial'); }).not.toThrow();
  });

  it('is idempotent / safe to call repeatedly (the refresh loop does this)', () => {
    const engine = makeEngine();
    expect(() => {
      engine.setAuthToken('jwt-1');
      engine.setAuthToken('jwt-2');
      engine.setAuthToken('jwt-3');
    }).not.toThrow();
  });
});
