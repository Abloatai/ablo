import { errorCodeSpec } from '@abloatai/transaction/errorCodes';
import {
  errorObservationSchema,
  sanitizeObservationValue,
  type ErrorObservation,
} from '@abloatai/transaction/errorObservation';
import { toAbloError } from '@abloatai/transaction/errors';

export interface ErrorContext {
  userId?: string;
  page?: string;
  feature?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  eventId?: string;
  organizationId?: string;
  projectId?: string;
  branchId?: string;
  traceId?: string;
  spanId?: string;
  handled?: boolean;
  fingerprint?: string[];
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
}

function webEventId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replaceAll('-', '');
  return `${Date.now().toString(16).padStart(12, '0')}${Math.random().toString(16).slice(2).padEnd(20, '0')}`.slice(0, 32);
}

/** Runtime-neutral normalizer shared by browser and Next server boundaries. */
export function buildWebErrorObservation(
  error: unknown,
  context: ErrorContext = {},
): ErrorObservation {
  const normalized = toAbloError(error);
  const spec = normalized.code ? errorCodeSpec(normalized.code) : undefined;
  const candidate = sanitizeObservationValue({
    eventId: context.eventId ?? normalized.eventId ?? webEventId(),
    occurredAt: new Date().toISOString(),
    service: 'sync-web',
    stage: process.env.NEXT_PUBLIC_ABLO_STAGE ?? process.env.ABLO_STAGE ?? process.env.NODE_ENV ?? 'unknown',
    ...(process.env.NEXT_PUBLIC_ABLO_RELEASE ?? process.env.ABLO_RELEASE
      ? { release: process.env.NEXT_PUBLIC_ABLO_RELEASE ?? process.env.ABLO_RELEASE }
      : {}),
    severity: context.level ?? spec?.observability.severity ?? 'error',
    channel: typeof window === 'undefined' ? 'http' : 'browser',
    scope: context.feature ?? context.page ?? 'application',
    operation: context.action ?? 'render',
    errorCode: normalized.code ?? 'internal_error',
    errorType: normalized.type,
    category: spec?.category ?? 'client',
    retryable: spec?.retryable ?? false,
    handled: context.handled ?? true,
    publicMessage: normalized.message,
    internalMessage: normalized.message,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
    ...(context.requestId ?? normalized.requestId
      ? { requestId: context.requestId ?? normalized.requestId }
      : {}),
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.branchId ? { branchId: context.branchId } : {}),
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(context.metadata ? { diagnosticContext: context.metadata } : {}),
  });
  return errorObservationSchema.parse(candidate);
}

export const buildBrowserErrorObservation = buildWebErrorObservation;
