/**
 * The persisted shape of a write awaiting a definitive outcome.
 *
 * Owns one authoritative union over the two durable commit envelopes — the
 * WebSocket envelope and its HTTP counterpart — so an injected store and the
 * engine that reads back from it agree on exactly one set of records. The
 * envelope schemas in this directory remain authoritative for their own fields;
 * this module only unions them.
 *
 * The port that persists these records is a behavior contract, not a persisted
 * shape, so it lives outside this directory in `src/durableWrites.ts`.
 */

import { z } from 'zod';
import { durableCommitEnvelopeSchema } from './commitEnvelope.js';
import { durableHttpCommitEnvelopeSchema } from './httpCommitEnvelope.js';

/** Every write shape that Ablo may ask an injected store to persist. */
export const pendingWriteSchema = z.union([
  durableCommitEnvelopeSchema,
  durableHttpCommitEnvelopeSchema,
]);

export type PendingWrite = z.infer<typeof pendingWriteSchema>;
