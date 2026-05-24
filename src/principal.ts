/**
 * Principal constructors — a thin typed façade over the raw
 * `SessionRef` / `AgentRef` shapes so call sites don't have to memorize
 * the discriminated-union tags.
 *
 * ```ts
 * import Ablo, { session } from '@ablo/sync-engine';
 *
 * const ablo = Ablo({ schema, apiKey });
 * const participant = await ablo.participants.join({
 *   type: 'Matter',
 *   id: 'deal-1',
 * });
 * ```
 *
 * Browser-human flows use `session(...)`. Agent-spawn-agent flows use
 * `agent(...)`, but those rarely appear in customer code because the
 * participant layer handles attenuation.
 *
 * These are pure — no I/O, no hidden state. If the shape ever grows a
 * required field (say, a Biscuit scope hint), the helper is the one
 * place to flag migrations.
 */

import type { AgentRef, SessionRef } from './types/streams.js';

/**
 * Build a `SessionRef` from the identifiers your auth system already
 * holds. Typical inputs: the Better Auth session id, the user id, and
 * the organization the session is scoped to.
 */
export function session(params: {
  id: string;
  userId: string;
  organizationId: string;
}): SessionRef {
  return {
    kind: 'session',
    id: params.id,
    userId: params.userId,
    organizationId: params.organizationId,
  };
}

/**
 * Build an `AgentRef` from an agent id + the capability token that
 * authenticates it. Rare in application code — the common path is
 * `participant.join(child)` where the parent's token is attenuated
 * automatically.
 */
export function agent(params: {
  id: string;
  capabilityToken: string;
}): AgentRef {
  return {
    kind: 'agent',
    id: params.id,
    capabilityToken: params.capabilityToken,
  };
}
