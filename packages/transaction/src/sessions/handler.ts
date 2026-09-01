/**
 * Server-owned browser session exchange.
 *
 * Authentication providers prove who is calling; this boundary converts that
 * proof into the one Ablo session resource consumed by browser clients. It
 * owns the HTTP protocol so applications do not repeat origin, cache, status,
 * or credential-envelope handling in every framework route.
 */

import type { SchemaRecord } from '../schema/schema.js';
import type {
  AbloSession,
  CreateSessionParams,
} from './contract.js';
import {
  credentialEndpointErrorSchema,
  credentialEndpointSuccessSchema,
} from '../auth/credentialEndpointProtocol.js';
import { classifyCredentialKind } from '../auth/credentialKind.js';

export interface SessionHandlerOptions<
  S extends SchemaRecord,
  Principal,
> {
  /** Verify the application's cookie, bearer, or framework auth session. */
  authenticate(request: Request): Principal | null | Promise<Principal | null>;
  /** Derive Ablo identity, groups, and access exclusively on the server. */
  grant(input: {
    readonly principal: Principal;
    readonly request: Request;
  }): CreateSessionParams<S> | null | Promise<CreateSessionParams<S> | null>;
}

export type SessionHandler = (request: Request) => Promise<Response>;

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    credentialEndpointErrorSchema.parse({ error: { code, message } }),
    { status, headers: NO_STORE_HEADERS },
  );
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** Build a framework-neutral POST handler around one authenticated session grant. */
export function createSessionHandler<S extends SchemaRecord, Principal>(
  create: (params: CreateSessionParams<S>) => Promise<AbloSession>,
  options: SessionHandlerOptions<S, Principal>,
): SessionHandler {
  return async (request) => {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Use POST to create a session.');
    }
    if (!isSameOrigin(request)) {
      return errorResponse(403, 'origin_mismatch', 'Cross-origin session creation rejected.');
    }

    const principal = await options.authenticate(request);
    if (principal === null) {
      return errorResponse(401, 'session_expired', 'Sign in again.');
    }

    const grant = await options.grant({ principal, request });
    if (grant === null) {
      return errorResponse(403, 'policy_denied', 'This identity is not authorized.');
    }

    const session = await create(grant);
    const credentialKind = classifyCredentialKind(session.token);
    if (credentialKind !== 'ephemeral' && credentialKind !== 'restricted') {
      throw new Error('sessions.create returned a credential that cannot authenticate a session.');
    }
    return Response.json(
      credentialEndpointSuccessSchema.parse({
        token: session.token,
        expiresAt: session.expiresAt,
        credentialKind,
      }),
      { headers: NO_STORE_HEADERS },
    );
  };
}
