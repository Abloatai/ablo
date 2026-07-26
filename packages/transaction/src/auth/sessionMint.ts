/**
 * Mints a session token. This is the single implementation behind
 * `sessions.create`, shared by the WebSocket and HTTP clients so the two never
 * disagree on how a token is produced.
 *
 * Minting is a plain control-plane HTTP call — no socket, no synced data. A
 * backend holding a secret key (`sk_`) exchanges it for a short-lived, scoped
 * token whose kind depends on the session requested:
 *
 *   `{ user }`  → POST /v1/ephemeral_keys, returning an `ek_` key carrying the
 *                 explicit grant in `can`. This is the only route that mints a
 *                 user session; the capability route rejects a `user`
 *                 participant with `invalid_participant_kind`.
 *   `{ agent }` → POST /v1/capabilities, returning an `rk_` key scoped to exactly
 *                 the operations named in `can`. For example
 *                 `can: { tasks: ['update'] }` becomes the wire allowlist entry
 *                 `tasks.update`, which the server matches against the model's
 *                 registered names.
 *
 * The caller supplies the already-resolved secret key and base URL in
 * {@link MintSessionContext}. Choosing which key to pass — the original secret
 * key, not a derived key that an earlier exchange may have produced — is the
 * caller's responsibility.
 */
import {
  exchangeApiKey,
  mintUserSessionKey,
} from '../auth/index.js';
import {
  capabilityCanSchemaFor,
  grantedOperations,
} from './capability.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { AbloSession, CreateSessionParams } from '../resources/httpResources.js';

/**
 * The resolved control-plane details a mint needs: a secret key, a base URL,
 * and an optional `fetch`. When `fetch` is omitted, the auth helpers fall back
 * to the runtime's global `fetch`.
 */
export interface MintSessionContext {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /**
   * Each schema key mapped to its wire type name, from
   * {@link modelWireNames} over the client's own schema. Required, and derived
   * rather than assembled: `can` is keyed by schema key while a capability is
   * scoped by the type name the server checks, so
   * `can: { documents: ['update'] }` on a model whose type name is overridden
   * to `Document` must mint `document.update`. A caller who leaves this out
   * mints a grant the server denies on the first write.
   */
  readonly modelTypenames: Readonly<Record<string, string>>;
}

/**
 * Mints a session token from an already-resolved secret key and base URL.
 * Routes the `{ user }` or `{ agent }` request to the matching mint endpoint
 * and reshapes the response into an {@link AbloSession}.
 */
export async function mintSession<S extends SchemaRecord>(
  params: CreateSessionParams<S>,
  ctx: MintSessionContext,
): Promise<AbloSession> {
  const { apiKey, baseUrl } = ctx;
  // Static typing and runtime validation consume the same schema-bound grant
  // contract. This catches JavaScript callers, decoded JSON, and unsafe casts
  // before a credential reaches either mint endpoint.
  const can = capabilityCanSchemaFor(ctx.modelTypenames).parse(params.can);

  if (params.user) {
    const operations = grantedOperations(can, ctx.modelTypenames);
    const res = await mintUserSessionKey({
      apiKey,
      baseUrl,
      userId: params.user.id,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.syncGroups ? { syncGroups: [...params.syncGroups] } : {}),
      operations,
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
        projectId: res.projectId,
        branchId: res.branchId,
        branchRoot: res.branchRoot,
        syncGroups: res.syncGroups,
        operations: res.operations,
        participantKind: 'user',
        participantId: res.participantId,
      },
      userMeta: params.userMeta ?? { id: res.participantId },
    };
  }

  // One translation from the declared grant to the wire allowlist, shared with
  // every other door that mints — see `auth/capability.ts`.
  const operations = grantedOperations(can, ctx.modelTypenames);
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
