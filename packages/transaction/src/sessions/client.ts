/**
 * Server-side session issuer.
 *
 * This is deliberately separate from `Ablo(...)`: the participant client owns
 * schema model properties, while this client owns credential issuance and
 * lifecycle administration. A schema model named `sessions` therefore remains
 * available as `ablo.sessions` like every other model.
 */

import type { CredentialProvider } from '../auth/credentialResult.js';
import {
  assertBrowserSafety,
  readProcessEnv,
  rejectRemovedDatabaseUrlOption,
  resolveApiKey,
  resolveApiKeyValue,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
  warnIfCliKeyMismatch,
} from '../auth/apiKey.js';
import { modelWireNames } from '../auth/capability.js';
import {
  revokeCapability,
  rotateCapability,
} from '../auth/capabilityLifecycle.js';
import { AbloAuthenticationError } from '../errors.js';
import type { Schema, SchemaRecord } from '../schema/schema.js';
import type {
  AbloSession,
  CreateSessionParams,
  RevokeSessionParams,
  RotateSessionParams,
  SessionRevocation,
  SessionRotation,
} from './contract.js';
import { createSession } from './create.js';
import {
  createSessionHandler,
  type SessionHandler,
  type SessionHandlerOptions,
} from './handler.js';

export interface SessionsOptions<S extends SchemaRecord> {
  readonly schema: Schema<S>;
  readonly apiKey?: string | CredentialProvider | null;
  readonly baseURL?: string | null;
  readonly bootstrapBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly dangerouslyAllowBrowser?: boolean;
}

export interface SessionsClient<S extends SchemaRecord> {
  create(params: CreateSessionParams<S>): Promise<AbloSession>;
  handler<Principal>(options: SessionHandlerOptions<S, Principal>): SessionHandler;
  revoke(params: RevokeSessionParams): Promise<SessionRevocation>;
  rotate(params: RotateSessionParams): Promise<SessionRotation>;
}

/** Construct the server-side issuer for user and agent sessions. */
export function Sessions<const S extends SchemaRecord>(
  options: SessionsOptions<S>,
): SessionsClient<S> {
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  void warnIfCliKeyMismatch(authInput);
  rejectRemovedDatabaseUrlOption(options);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });

  const baseUrl = resolveBootstrapBaseUrl({
    url: resolveBaseURL(authInput),
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  }).replace(/\/+$/, '');
  const modelTypenames = modelWireNames(options.schema.models);

  async function secret(): Promise<string> {
    const apiKey = await resolveApiKeyValue(configuredApiKey);
    if (!apiKey) {
      throw new AbloAuthenticationError(
        'Sessions requires a secret (sk_) API key and must be constructed on the backend.',
        { code: 'apikey_missing' },
      );
    }
    return apiKey;
  }

  async function create(params: CreateSessionParams<S>): Promise<AbloSession> {
    return createSession(params, {
      apiKey: await secret(),
      baseUrl,
      modelTypenames,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  return {
    create,
    handler: (handlerOptions) => createSessionHandler(create, handlerOptions),
    async revoke({ id }) {
      return revokeCapability({
        apiKey: await secret(),
        baseUrl,
        id,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },
    async rotate({ id, graceSeconds, ttlSeconds }) {
      return rotateCapability({
        apiKey: await secret(),
        baseUrl,
        id,
        ...(graceSeconds !== undefined ? { graceSeconds } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },
  };
}
