import { z } from 'zod';
import {
  AbloAuthenticationError,
  hasWireCode,
  translateHttpError,
} from '../errors.js';
import { effectiveAuthoritySchema } from './capability.js';
import type {
  RotateSessionParams,
  SessionRevocation,
  SessionRotation,
} from '../resources/httpResources.js';

export const sessionRevocationResponseSchema = z.object({
  id: z.string().min(1),
  deleted: z.literal(true),
  activeSessionsClosed: z.number().int().nonnegative(),
});

export const capabilityRotationRequestSchema = z.object({
  graceSeconds: z.number().int().positive().optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

export const capabilityRotationResponseSchema = z.object({
  capabilityId: z.string().min(1),
  token: z.string().trim().min(1),
  expiresAt: z.iso.datetime().nullable(),
  organizationId: z.string().min(1),
  branchRoot: z.boolean().default(false),
  scope: effectiveAuthoritySchema,
  rotatedFrom: z.object({
    capabilityId: z.string().min(1),
    expiresAt: z.iso.datetime(),
  }),
});

interface CapabilityLifecycleContext {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface RevokeCapabilityRequest extends CapabilityLifecycleContext {
  readonly id: string;
}

export interface RotateCapabilityRequest
  extends CapabilityLifecycleContext,
    RotateSessionParams {}

async function requestCapabilityLifecycle(
  options: CapabilityLifecycleContext & {
    readonly id: string;
    readonly method: 'DELETE' | 'POST';
    readonly suffix?: '/rotate';
    readonly body?: Record<string, number>;
  },
): Promise<unknown> {
  if (!options.apiKey) {
    throw new AbloAuthenticationError(
      'Session lifecycle operations require a secret (sk_) API key.',
      { code: 'apikey_missing' },
    );
  }
  if (!options.baseUrl) {
    throw new AbloAuthenticationError(
      'baseUrl is required for session lifecycle operations.',
      { code: 'base_url_missing' },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.baseUrl.replace(/\/+$/, '')}/v1/capabilities/${encodeURIComponent(options.id)}${options.suffix ?? ''}`,
      {
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      },
    );
  } catch (error) {
    throw new AbloAuthenticationError(
      `session lifecycle request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { code: 'exchange_network_error', cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error still receives a stable client-side code below.
    }
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw hasWireCode(body)
      ? translateHttpError(response.status, body, requestId)
      : new AbloAuthenticationError(
          `session lifecycle request rejected (${response.status})`,
          { code: 'exchange_failed', httpStatus: response.status },
        );
  }

  return response.json();
}

export async function revokeCapability(
  options: RevokeCapabilityRequest,
): Promise<SessionRevocation> {
  const raw = await requestCapabilityLifecycle({
    ...options,
    method: 'DELETE',
  });
  const parsed = sessionRevocationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AbloAuthenticationError(
      'Session revoke response was malformed.',
      { code: 'exchange_malformed_response', cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function rotateCapability(
  options: RotateCapabilityRequest,
): Promise<SessionRotation> {
  const body = {
    ...(options.graceSeconds !== undefined
      ? { graceSeconds: options.graceSeconds }
      : {}),
    ...(options.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
  };
  const raw = await requestCapabilityLifecycle({
    ...options,
    method: 'POST',
    suffix: '/rotate',
    ...(Object.keys(body).length > 0 ? { body } : {}),
  });
  const parsed = capabilityRotationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AbloAuthenticationError(
      'Session rotation response was malformed.',
      { code: 'exchange_malformed_response', cause: parsed.error },
    );
  }
  return {
    id: parsed.data.capabilityId,
    token: parsed.data.token,
    expiresAt: parsed.data.expiresAt,
    organizationId: parsed.data.organizationId,
    scope: parsed.data.scope,
    rotatedFrom: {
      id: parsed.data.rotatedFrom.capabilityId,
      expiresAt: parsed.data.rotatedFrom.expiresAt,
    },
  };
}
