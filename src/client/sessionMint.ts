/**
 * `mintSession` — the ONE implementation behind `sessions.create`, shared by the
 * stateful `Ablo` client and the stateless protocol / HTTP client so the two can
 * never drift on HOW a token is minted.
 *
 * Minting is a pure control-plane HTTP call (no socket, no synced pool): a backend
 * holding a secret `sk_` exchanges it for a short-lived scoped token — `ek_` for an
 * `{ user }` session (full end-user authority) or `rk_` for an `{ agent }` session
 * (scoped to exactly the operations named in `can`). The two arms map to the
 * server's two mint doors:
 *
 *   `{ user }`  → POST /auth/ephemeral-keys → `ek_`. The user-session door;
 *                 routing this arm through /auth/capability is structurally
 *                 impossible — that route rejects participantKind 'user' outright
 *                 (`invalid_participant_kind`, the 2026-06-11 Pulse cascade where
 *                 the SDK's own blessed pattern 403'd and integrators fell back to
 *                 minting humans as agents).
 *   `{ agent }` → POST /auth/capability → scoped `rk_`. `can: { tasks: ['update'] }`
 *                 serializes to the wire allowlist (`tasks.update`); the Hub matches
 *                 it against every registered alias of the model.
 *
 * The caller supplies the resolved control-plane credential + base URL in `ctx`;
 * WHICH key to use (the original `sk_`, never a derived `rk_` the startup exchange
 * may have installed) is the caller's concern — see the two call sites.
 *
 * Type-only imports of `CreateSessionParams` / `AbloSession` keep this module a
 * leaf (no runtime cycle back to `Ablo.ts`): at runtime it depends on `auth` +
 * `schema` only.
 */
import { exchangeApiKey, mintUserSessionKey } from '../auth/index.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { AbloSession, CreateSessionParams } from './Ablo.js';

/** The resolved control-plane context a mint needs. `fetch` is optional — the
 *  auth helpers fall back to the runtime global when omitted. */
export interface MintSessionContext {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

/**
 * Mint a session token from an already-resolved `sk_` credential + base URL.
 * Discriminates the `{ user }` / `{ agent }` union onto the server's two mint
 * doors and reshapes each flat response into the `AbloSession` resource.
 */
export async function mintSession<S extends SchemaRecord>(
  params: CreateSessionParams<S>,
  ctx: MintSessionContext,
): Promise<AbloSession> {
  const { apiKey, baseUrl } = ctx;

  if (params.user) {
    const res = await mintUserSessionKey({
      apiKey,
      baseUrl,
      userId: params.user.id,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.syncGroups ? { syncGroups: [...params.syncGroups] } : {}),
      ttlSeconds: params.ttlSeconds ?? 900,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    return {
      object: 'session',
      id: res.id,
      token: res.token,
      expiresAt: res.expiresAt,
      organizationId: res.organizationId,
      // The ephemeral mint stores scope on the key row; reshape its flat
      // response into the session resource's scope block.
      scope: {
        organizationId: res.organizationId,
        syncGroups: res.syncGroups,
        operations: [],
        participantKind: 'user',
        participantId: res.participantId,
      },
      userMeta: params.userMeta ?? { id: res.participantId },
    };
  }

  const operations = Object.entries(params.can).flatMap(([model, ops]) =>
    (ops ?? []).map((op) => `${model.toLowerCase()}.${op}`),
  );
  const res = await exchangeApiKey({
    apiKey,
    baseUrl,
    participantKind: 'agent',
    participantId: params.agent.id,
    ...(params.syncGroups ? { syncGroups: [...params.syncGroups] } : {}),
    operations,
    ttlSeconds: params.ttlSeconds ?? 900,
    ...(params.userMeta ? { userMeta: params.userMeta } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  return {
    object: 'session',
    id: res.capabilityId,
    token: res.token,
    expiresAt: res.expiresAt,
    organizationId: res.organizationId,
    scope: res.scope,
    userMeta: res.userMeta,
  };
}
